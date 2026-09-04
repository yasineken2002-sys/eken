#!/usr/bin/env node
/**
 * VARJE SJÄLVTEST MÅSTE KUNNA FÄLLA — bevisat, inte antaget.
 *
 * ── VARFÖR DEN FINNS ────────────────────────────────────────────────────────
 *
 * Fyrtiotre vaktskript har ett `--self-test`, och varje sådant är ett löfte:
 * "går den här vakten sönder blir CI rött". Löftet vilar på att ett rapporterat
 * fel faktiskt når EXITKODEN. Gör det inte det skriver självtestet ❌ på stderr
 * och avslutar med 0 — och CI-steget är grönt om en vakt som slutat mäta.
 *
 * Formen är inte hypotetisk. Den skrevs i den här kodbasen 2026-09-04:
 *
 *     const f = (m) => { console.error(`❌ ${m}`); process.exitCode = 1 }
 *     …
 *     process.exit(ok ? 0 : 1)        // `ok` rörs aldrig av f()
 *
 * `process.exit(kod)` skriver ALLTID över `process.exitCode`, oavsett argument.
 * Kanariefåglarna skrev alltså ❌ utan att fälla körningen, och det upptäcktes
 * bara för att någon läste exitkoden för hand.
 *
 * ── VAD REGELN FRÅGAR ───────────────────────────────────────────────────────
 *
 * Inte "finns det ett självtest" utan "kan det fälla". För varje vakt:
 * injicera ETT garanterat fallande kanariefall i självtestets PRIMÄRA
 * rapportväg, kör, och kräv exitkod ≠ 0.
 *
 * ── ALDRIG I TRÄDET ─────────────────────────────────────────────────────────
 *
 * Mutationen sker i en kopia under `os.tmpdir()`. Men en vakt härleder sin rot
 * ur `import.meta.url`, så en naken kopia hittar varken schema, källfiler eller
 * den delade skannern. Kopian läggs därför i ett SKUGGTRÄD: katalogkedjan ner
 * till vaktens katalog byggs på riktigt, och allt annat symlänkas till repot.
 * Node löser symlänkar till sin realpath, så kedjan hittar tillbaka.
 *
 * Trädet rörs alltså inte alls — inte ens tillfälligt. Det är bärande: en
 * mätning som muterar trädet kan lämna det trasigt om den avbryts.
 *
 * ── VAD DEN INTE KAN SE ─────────────────────────────────────────────────────
 *
 *   • BARA DEN PRIMÄRA RAPPORTVÄGEN. Injektionen går via den först härledda
 *     mekanismen (`fail`, `t`, `ok`, en räknare, en array). En vakt kan ha en
 *     ANDRA rapportväg som inte når exitkoden, och den syns inte här. Det var
 *     just en sådan andra väg som bar felet 2026-09-04 — den statiska
 *     förkontrollen nedan finns för att täcka den luckan, men den är en
 *     heuristik, inte ett bevis.
 *   • ATT PROVEN MÄTER RÄTT SAK. En vakt kan fälla på en injicerad kanariefågel
 *     och ändå ha prov som inte prövar något verkligt. Det ägs av varje vakts
 *     egna kanariefåglar.
 *   • EN VAKT UTAN `--self-test` fälls som SAKNAD, inte som tyst. Det är
 *     avsiktligt: ett löfte som inte finns går inte att pröva.
 *
 * Kör:        node apps/api/scripts/check-self-tests-fail.mjs
 * Självtest:  node apps/api/scripts/check-self-tests-fail.mjs --self-test
 */
import { execFile } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { blankComments, codeMask, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROT = resolve(HERE, '..', '..', '..')
const KATALOGER = ['apps/api/scripts', 'scripts']

/** Golv, mätt mot 5517967: 43 vaktskript, alla med --self-test. */
const MIN_VAKTER = 40

// ── läsning ─────────────────────────────────────────────────────────────────

/** Alla check-*.mjs under KATALOGER, rot-relativa. */
export function allaVakter(rot = ROT) {
  const ut = []
  for (const kat of KATALOGER) {
    for (const namn of readdirSync(join(rot, kat))) {
      if (namn.startsWith('check-') && namn.endsWith('.mjs')) ut.push(`${kat}/${namn}`)
    }
  }
  return ut.sort()
}

/** Brace-matcha framåt från `{` vid `öppna`. Läses ur KODVYN. */
function block(kod, öppna) {
  let djup = 0
  for (let i = öppna; i < kod.length; i++) {
    if (kod[i] === '{') djup++
    else if (kod[i] === '}') {
      djup--
      if (!djup) return i
    }
  }
  return kod.length
}

/**
 * Dispatchen som kör självtestet, och namnet på funktionen den anropar.
 *
 * ⚠️ SÖKS I STRÄNGVYN, INTE I KODVYN. Villkoret innehåller STRÄNGEN
 * '--self-test', och codeMask blankar stränginnehåll — i kodvyn står det
 * `process.argv.includes('           ')` och inget mönster kan matcha. Det var
 * det första felet i instrumentet den här vakten bygger på, och det gav
 * "ingen dispatch hittad" för samtliga vakter.
 *
 * Sex former finns i trädet, inklusive en FLERRADIG och en INDIREKT via en
 * variabel. Den indirekta prövar ALLA `const … = process.argv[n]`, inte den
 * första: check-transaction-limits har `körsDirekt` före `arg`.
 */
export function dispatch(kod, rå) {
  // ── TVÅ VYER, OCH BÅDA BEHÖVS ────────────────────────────────────────────
  //
  // STRUKTUREN söks i KODVYN: `process.argv.includes(` är ett anrop, och i
  // kodvyn är stränginnehåll blankat — så vaktformad kod som står INUTI en
  // sträng (den här filens egna fixturer!) är osynlig. Söker man i strängvyn
  // hittar man i stället fixturens dispatch och läser fel funktionsnamn.
  // Uppmätt: metavakten flaggade SIG SJÄLV som "ingen rapportmekanism".
  //
  // FLAGGANS TEXT bekräftas mot RÅTEXTEN på samma index. Den är stränginnehåll
  // och finns per definition inte i kodvyn — codeMask bevarar längd och
  // radbrytningar, så indexen pekar på samma ställe i båda.
  const strukturell =
    /process\s*\.\s*argv\s*(?:\.\s*includes\s*\(\s*'[^']*'\s*\)|\[\s*\d+\s*\]\s*===\s*'[^']*')\s*\)/gu
  let m = null
  for (const kand of kod.matchAll(strukturell)) {
    if (rå.slice(kand.index, kand.index + kand[0].length).includes('--self-test')) {
      m = kand
      break
    }
  }
  if (!m) {
    // INDIREKT form: `const arg = process.argv[2]` … `if (arg === '--self-test')`.
    // Alla kandidater prövas, inte den första: check-transaction-limits har
    // `körsDirekt` före `arg`.
    for (const v of kod.matchAll(/const\s+([\p{L}\p{N}_$]+)\s*=\s*process\s*\.\s*argv\s*\[\s*\d+\s*\]/gu)) {
      const re = new RegExp(
        `(?<![\\p{L}\\p{N}_$])${v[1]}(?![\\p{L}\\p{N}_$])\\s*===\\s*'[^']*'\\s*\\)`,
        'gu',
      )
      for (const kand of kod.matchAll(re)) {
        if (rå.slice(kand.index, kand.index + kand[0].length).includes('--self-test')) {
          m = kand
          break
        }
      }
      if (m) break
    }
  }
  if (!m) return null

  const efter = m.index + m[0].length
  const radslut = kod.indexOf('\n', efter)
  let svans = kod.slice(efter, radslut === -1 ? kod.length : radslut)
  if (/^\s*\{\s*$/.test(svans)) {
    const öppna = kod.indexOf('{', efter)
    svans = kod.slice(öppna + 1, block(kod, öppna))
  }
  const iExit = /process\s*\.\s*exit\s*\(/.test(svans)
  const inre = /process\s*\.\s*exit\s*\(\s*([\p{L}\p{N}_$]+)\s*\(/u.exec(svans)
  const rakt = /(?:return\s+)?([\p{L}\p{N}_$]+)\s*\(/u.exec(svans.replace(/^\s*\{?\s*/, ''))
  return { namn: iExit ? (inre ? inre[1] : null) : rakt ? rakt[1] : null, iExit }
}

/** Kroppen för `function <namn>(` i kodvyn: [öppnaKlammer, stängKlammer]. */
export function funktionskropp(kod, namn) {
  const m = new RegExp(`function\\s+${namn}\\s*\\(`, 'u').exec(kod)
  if (!m) return null
  const öppna = kod.indexOf('{', m.index + m[0].length - 1)
  return öppna === -1 ? null : [öppna, block(kod, öppna)]
}

// ── injektionen ─────────────────────────────────────────────────────────────

/**
 * Rapportmekanismerna, i den ordning de prövas. Den FÖRST hittade används.
 * Formerna är härledda ur trädet, inte gissade.
 */
const MEKANISMER = [
  [/const\s+fail\s*=/u, () => `fail('ZZ-METAVAKT')`, 'fail()'],
  [/const\s+kräv\s*=/u, () => `kräv('ZZ-METAVAKT', false)`, 'kräv(,false)'],
  [/const\s+t\s*=/u, () => `t('ZZ-METAVAKT', false)`, 't(,false)'],
  [/let\s+ok\s*=\s*true/u, () => `ok = false`, 'ok=false'],
  [/let\s+(fel|failed|antalFel)\s*=\s*0/u, (n) => `${n}++`, 'räknare++'],
  [/const\s+(fel|problem|brott)\s*=\s*\[\]/u, (n) => `${n}.push('ZZ-METAVAKT')`, 'array.push'],
]

/**
 * Slutet på HELA deklarationen, inte på dess första rad.
 *
 * ⚠️ DET HÄR ÄR DEN TREDJE AV TRE INSTRUMENTFEL som gjordes 2026-09-04, och den
 * dyraste. Första versionen injicerade på NÄSTA RAD, och för en FLERRADIG
 * hjälpare —
 *
 *     const fail = (m) => {
 *       ok = false
 *       console.error(`❌ ${m}`)
 *     }
 *
 * — hamnade injektionen INUTI `fail`, där den aldrig kördes. Mätningen sa då
 * TIGER om TIO vakter som i själva verket fäller. Kanariefixturerna var
 * ENRADIGA och prövade aldrig den formen: en sond som bara sett det ena fallet
 * är inte bevisad. Båda formerna står som fixturer i självtestet.
 */
function slutPåDeklaration(kod, från) {
  const radslut = kod.indexOf('\n', från)
  const rad = kod.slice(från, radslut === -1 ? kod.length : radslut)
  const iKlammer = rad.indexOf('{')
  if (iKlammer === -1) return radslut === -1 ? kod.length : radslut + 1
  const slut = block(kod, från + iKlammer)
  const r = kod.indexOf('\n', slut)
  return r === -1 ? kod.length : r + 1
}

/**
 * DIREKT-EXIT: ett självtest UTAN räknare, där varje rapportväg ÄR ett
 * `console.error(...)` följt av `process.exit(...)`.
 *
 * `check-generated-knowledge-sync` har den formen. Där finns ingen flagga att
 * korrumpera — det går alltså inte att injicera ett fel som RAPPORTERAS men
 * inte fäller, för rapporteringen och avslutet är samma sats. Formen är säker
 * av konstruktion, och det är ett STRUKTURELLT bevis, inte ett dynamiskt.
 *
 * Kravet är att det gäller VARJE `console.error` i kroppen. En enda som saknar
 * sitt `process.exit` är precis den tysta rapportvägen vakten letar efter, och
 * då är formen inte längre säker.
 */
export function direktExit(rå) {
  const kod = codeMask(rå)
  const d = dispatch(kod, rå)
  if (!d || !d.namn) return null
  const kb = funktionskropp(kod, d.namn)
  if (!kb) return null
  const kropp = kod.slice(kb[0], kb[1])
  // Finns en räknare/flagga är det INTE den här formen — då ska den mätas
  // dynamiskt som alla andra.
  if (MEKANISMER.some(([re]) => re.test(kropp))) return null
  const fel = []
  for (const m of kropp.matchAll(/console\s*\.\s*error\s*\(/g)) {
    const efter = kropp.slice(m.index, m.index + 600)
    if (!/process\s*\.\s*exit\s*\(\s*[^0)\s]/.test(efter))
      fel.push(rå.slice(0, kb[0] + m.index).split('\n').length)
  }
  return { rapportvägar: [...kropp.matchAll(/console\s*\.\s*error\s*\(/g)].length, utanExit: fel }
}

/** Injektionspunkt och -text för en vakts primära rapportväg, eller null. */
export function väljInjektion(rå) {
  const kod = codeMask(rå)
  const d = dispatch(kod, rå)
  if (!d || !d.namn) return null
  const kb = funktionskropp(kod, d.namn)
  if (!kb) return null
  const kropp = kod.slice(kb[0], kb[1])
  for (const [re, bygg, etikett] of MEKANISMER) {
    const m = re.exec(kropp)
    if (!m) continue
    const namn = m[1] ?? null
    return { pos: slutPåDeklaration(kod, kb[0] + m.index), text: `  ${bygg(namn)}\n`, etikett }
  }
  return null
}

// ── statisk förkontroll ─────────────────────────────────────────────────────

/**
 * FLAGGA A: `process.exitCode` sätts, och ett SENARE `process.exit(…)` skriver
 * över den.
 *
 * VILLKORET ÄR INTE "exit(0)". `process.exit(kod)` skriver alltid över
 * exitCode, oavsett argument. Felet 2026-09-04 hade `process.exit(ok ? 0 : 1)`,
 * alltså varken tomt eller noll — en flagga som bara letat efter dem hade
 * missat precis den formen.
 *
 * Det här är en SNABB FÖRKONTROLL, inte beviset. Den kan se en andra
 * rapportväg som den dynamiska mätningen inte rör, och den kan flagga en form
 * som i praktiken aldrig nås.
 */
export function statiskFlaggaA(rå) {
  const kod = codeMask(rå)
  const d = dispatch(kod, rå)
  if (!d || !d.namn) return []
  const kb = funktionskropp(kod, d.namn)
  if (!kb) return []
  const kropp = kod.slice(kb[0], kb[1])
  const rad = (i) => rå.slice(0, kb[0] + i).split('\n').length
  const exitCode = [...kropp.matchAll(/process\s*\.\s*exitCode\s*=/g)]
  const exits = [...kropp.matchAll(/process\s*\.\s*exit\s*\(([^)]*)\)/g)]
  const ut = []
  for (const ec of exitCode) {
    const senare = exits.find((e) => e.index > ec.index)
    if (senare)
      ut.push(
        `process.exitCode sätts på rad ${rad(ec.index)}, men process.exit(${senare[1].trim()}) på ` +
          `rad ${rad(senare.index)} skriver över den — allt som rapporteras via exitCode blir tyst.`,
      )
  }
  return ut
}

// ── skuggträdet ─────────────────────────────────────────────────────────────

/**
 * Bygg ett skuggträd i tmpdir där `vaktRel` är en RIKTIG (muterad) fil och allt
 * annat symlänkas till `rot`. Returnerar sökvägen till kopian.
 */
export function byggSkugga(rot, vaktRel, innehåll) {
  const tmp = mkdtempSync(join(tmpdir(), 'sjalvtest-'))
  const kedja = []
  const delar = dirname(vaktRel).split('/')
  for (let i = 0; i < delar.length; i++) kedja.push(delar.slice(0, i + 1).join('/'))
  mkdirSync(join(tmp, dirname(vaktRel)), { recursive: true })
  // ⚠️ MÅLFILEN MÅSTE UNDANTAS FRÅN SYMLÄNKNINGEN. Utan den raden blir
  // <tmp>/<vaktRel> en LÄNK till den riktiga filen, och writeFileSync FÖLJER
  // länken — mutationen hamnar då i trädet, precis det som aldrig får hända.
  // Uppmätt: första körningen ändrade 42 spårade filer.
  const byggda = new Set([...kedja, vaktRel])
  for (const dir of ['', ...kedja]) {
    for (const namn of readdirSync(join(rot, dir))) {
      const rel = dir ? `${dir}/${namn}` : namn
      if (byggda.has(rel)) continue
      try {
        symlinkSync(join(rot, dir, namn), join(tmp, dir, namn))
      } catch {
        // en redan existerande länk är ofarlig
      }
    }
  }
  const mål = join(tmp, vaktRel)
  // Bälte OCH hängslen: en kvarbliven länk ska ge ett KAST, inte en tyst
  // skrivning i trädet. `wx` vägrar skriva om filen finns — och en symlänk
  // räknas som att den finns.
  writeFileSync(mål, innehåll, { flag: 'wx' })
  return { tmp, fil: mål }
}

const kör = (fil, extraEnv = {}) =>
  new Promise((klar) => {
    execFile(
      'node',
      [fil, '--self-test'],
      { timeout: 180000, env: { ...process.env, ...extraEnv } },
      (err) => klar(err ? (err.code ?? -1) : 0),
    )
  })

/**
 * REKURSIONEN, och varför den måste brytas.
 *
 * Metavakten mäter ALLA vakter — inklusive sig själv. Den muterade kopian kör
 * då sitt EGET svep över alla fyrtiofyra, och var och en av dem kör sitt
 * självtest. Uppmätt: 180 av 204 sekunder gick åt till just den kopian, alltså
 * 88 % av körtiden för EN av fyrtiofyra mätningar.
 *
 * Att undanta sig själv ur korpusen hade varit billigare och FEL: en vakt som
 * inte granskar sig själv har sin blinda fläck precis där den är mest sannolik.
 * I stället får barnet `METAVAKT_KORT=1`, som begränsar dess svep till två
 * vakter. Den injicerade kanariefågeln måste fortfarande fälla — det är det
 * mätningen frågar — men svepet under den behöver inte vara fullständigt två
 * gånger.
 */
const KORT = process.env.METAVAKT_KORT === '1'

/**
 * KÖRTIDEN, mätt och inte antagen.
 *
 * Kravet var under en minut. Mätningarna, i ordning:
 *
 *   seriellt, med rekursionen kvar          143,9 s
 *   2 samtidiga, med rekursionen kvar       195,6 s   ← PARALLELLT BLEV SÄMRE
 *   seriellt, rekursionen bruten             24,7 s
 *   2 samtidiga, rekursionen bruten          24,5 s
 *
 * TVÅ SAKER ATT LÄSA UR DEN TABELLEN. Kostnaden låg inte i parallelliteten utan
 * i att metavakten mätte SIG SJÄLV rekursivt — 180 av 204 sekunder i en enda av
 * fyrtiofyra mätningar. Och parallellt gav ingenting: arbetet är CPU-bundet
 * (varje vakt maskerar och läser källtext), inte I/O-bundet, och maskinen har
 * två kärnor. Jag skrev först motsatsen i den här kommentaren; mätningen sa
 * annat.
 *
 * Poolen står kvar därför att den kostar noll här och kan ge något på en runner
 * med fler kärnor. Taket är `availableParallelism()` och inte ett tal — ett
 * hårdkodat värde blir fel på den ena av de två maskinerna. Taket 8 hindrar att
 * fyrtiofyra nodprocesser startas samtidigt på en stor maskin.
 */
const SAMTIDIGA = Math.min(8, Math.max(2, availableParallelism()))

async function poolMap(poster, arbete) {
  const ut = new Array(poster.length)
  let nästa = 0
  const arbetare = Array.from({ length: Math.min(SAMTIDIGA, poster.length) }, async () => {
    for (;;) {
      const i = nästa++
      if (i >= poster.length) return
      ut[i] = await arbete(poster[i])
    }
  })
  await Promise.all(arbetare)
  return ut
}

/** Mät EN vakt. Trädet rörs aldrig. */
export async function mät(vaktRel, rot = ROT) {
  const rå = readFileSync(join(rot, vaktRel), 'utf8')
  if (!dispatch(codeMask(rå), rå))
    return { vakt: vaktRel, utfall: 'SAKNAR-SJÄLVTEST', detalj: 'ingen --self-test-dispatch' }
  const inj = väljInjektion(rå)
  if (!inj) {
    const de = direktExit(rå)
    if (de && de.rapportvägar > 0)
      return de.utanExit.length === 0
        ? { vakt: vaktRel, mekanism: 'direkt-exit', utfall: 'FÄLLER-STRUKTURELLT', rapportvägar: de.rapportvägar, statiskA: statiskFlaggaA(rå) }
        : { vakt: vaktRel, mekanism: 'direkt-exit', utfall: 'TIGER', detalj: `console.error utan process.exit på rad ${de.utanExit.join(', ')}`, statiskA: [] }
    return { vakt: vaktRel, utfall: 'OKÄND', detalj: 'ingen rapportmekanism härledd' }
  }

  const muterad = rå.slice(0, inj.pos) + inj.text + rå.slice(inj.pos)
  const { tmp, fil } = byggSkugga(rot, vaktRel, muterad)
  try {
    const kod = await kör(fil, { METAVAKT_KORT: '1' })
    return {
      vakt: vaktRel,
      mekanism: inj.etikett,
      exitkod: kod,
      utfall: kod === 0 ? 'TIGER' : 'FÄLLER',
      statiskA: statiskFlaggaA(rå),
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ── kärnan ──────────────────────────────────────────────────────────────────

export async function evaluate(vakter = allaVakter(), rot = ROT) {
  const problem = []
  const mätta = await poolMap(vakter, (v) => mät(v, rot))
  for (const m of mätta) {
    if (m.utfall === 'SAKNAR-SJÄLVTEST')
      problem.push(
        `${m.vakt} — SAKNAR --self-test. Ett löfte som inte finns går inte att pröva; ` +
          'ge vakten ett självtest med kanariefåglar och ett eget CI-steg.',
      )
    else if (m.utfall === 'OKÄND')
      problem.push(
        `${m.vakt} — ingen rapportmekanism kunde härledas ur självtestets kropp. ` +
          'Antingen är formen ny (lägg till den i MEKANISMER) eller så rapporterar ' +
          'självtestet inga fel alls, vilket är värre.',
      )
    else if (m.utfall === 'TIGER')
      problem.push(
        `${m.vakt} — självtestet RAPPORTERAR ett fel men avslutar med 0. ` +
          `Mekanism: ${m.mekanism}.${m.detalj ? ` ${m.detalj}.` : ''} ` +
          'Ett grönt CI-steg säger då ingenting om vakten.',
      )
    for (const a of m.statiskA ?? []) problem.push(`${m.vakt} — ${a}`)
  }
  if (mätta.length < MIN_VAKTER)
    problem.push(`omfång: ${mätta.length} vaktskript hittade, golv ${MIN_VAKTER} — läser vakten rätt kataloger?`)
  return { problem, mätta }
}

// ── självtest ───────────────────────────────────────────────────────────────

const FIXTURER = {
  // Enradig hjälpare. Rapportvägen sätter process.exitCode, som skrivs över.
  'fore-enradig': `function selfTest() {
  let ok = true
  const fail = (m) => { console.error(\`FEL \${m}\`); process.exitCode = 1 }
  if (!/x/.test('x')) fail('händer inte i baslinjen')
  process.exit(ok ? 0 : 1)
}
if (process.argv.includes('--self-test')) selfTest()
`,
  'efter-enradig': `function selfTest() {
  let ok = true
  const fail = (m) => { ok = false; console.error(\`FEL \${m}\`) }
  if (!/x/.test('x')) fail('händer inte i baslinjen')
  process.exit(ok ? 0 : 1)
}
if (process.argv.includes('--self-test')) selfTest()
`,
  // FLERRADIG hjälpare — formen som lurade instrumentets första version.
  'fore-flerradig': `function selfTest() {
  let ok = true
  const fail = (m) => {
    console.error(\`FEL \${m}\`)
    process.exitCode = 1
  }
  if (!/x/.test('x')) fail('händer inte i baslinjen')
  process.exit(ok ? 0 : 1)
}
if (process.argv.includes('--self-test')) selfTest()
`,
  'efter-flerradig': `function selfTest() {
  let ok = true
  const fail = (m) => {
    ok = false
    console.error(\`FEL \${m}\`)
  }
  if (!/x/.test('x')) fail('händer inte i baslinjen')
  process.exit(ok ? 0 : 1)
}
if (process.argv.includes('--self-test')) selfTest()
`,
}

async function självtest() {
  const fel = []
  const kräv = (namn, villkor, detalj) => {
    console.warn(`${villkor ? '✅' : '❌'} ${namn}${detalj ? `  → ${detalj}` : ''}`)
    if (!villkor) fel.push(namn)
  }

  for (const f of kanariefåglar()) fel.push(`delad skanner: ${f}`)
  kräv('delad skanner: kanariefåglarna gröna', kanariefåglar().length === 0)

  // ── FIXTURERNA: före/efter, enradig och FLERRADIG ────────────────────────
  //
  // Den flerradiga är inte dekoration. Instrumentets första version injicerade
  // på nästa rad och hamnade INUTI hjälparen — mätningen sa då TIGER om tio
  // vakter som fäller. Utan en flerradig fixtur är provet blint för exakt det.
  const tmpBas = mkdtempSync(join(tmpdir(), 'metavakt-fixtur-'))
  try {
    for (const [namn, kod] of Object.entries(FIXTURER)) {
      const fil = join(tmpBas, `${namn}.mjs`)
      writeFileSync(fil, kod)
      const inj = väljInjektion(kod)
      kräv(`fixtur ${namn}: injektionspunkt hittad`, Boolean(inj), inj ? inj.etikett : 'ingen')
      if (!inj) continue
      const muterad = kod.slice(0, inj.pos) + inj.text + kod.slice(inj.pos)
      const muteradFil = join(tmpBas, `${namn}-muterad.mjs`)
      writeFileSync(muteradFil, muterad)
      const baslinje = await kör(fil)
      const efter = await kör(muteradFil)
      const väntat = namn.startsWith('fore') ? 0 : 1
      kräv(
        `fixtur ${namn}: baslinjen grön`,
        baslinje === 0,
        `exitkod ${baslinje} — en fixtur som redan är röd mäter ingenting`,
      )
      kräv(
        `fixtur ${namn}: muterad ger exitkod ${väntat} (${väntat ? 'FÄLLER' : 'TIGER'})`,
        efter === väntat,
        `fick ${efter}`,
      )
      // Och den statiska flaggan ska peka åt samma håll som mätningen.
      const a = statiskFlaggaA(kod)
      kräv(
        `fixtur ${namn}: statisk flagga A ${namn.startsWith('fore') ? 'sätts' : 'sätts inte'}`,
        namn.startsWith('fore') ? a.length === 1 : a.length === 0,
        JSON.stringify(a).slice(0, 80),
      )
    }
  } finally {
    rmSync(tmpBas, { recursive: true, force: true })
  }

  // ── SKUGGTRÄDET: en kopia i tmpdir ska kunna läsa repot ──────────────────
  {
    const vakt = 'apps/api/scripts/check-resumption-shadow.mjs'
    const rå = readFileSync(join(ROT, vakt), 'utf8')
    const { tmp, fil } = byggSkugga(ROT, vakt, rå)
    try {
      kräv('skuggträdet: en OMUTERAD kopia i tmpdir kör grönt', (await kör(fil)) === 0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
    kräv('skuggträdet: trädet är orört', readFileSync(join(ROT, vakt), 'utf8') === rå)
  }

  // ── OMFÅNGET ────────────────────────────────────────────────────────────
  const alla = allaVakter()
  kräv(`omfång: ${alla.length} vaktskript (golv ${MIN_VAKTER})`, alla.length >= MIN_VAKTER)
  // I KORT LÄGE mäts bara två vakter, och aldrig metavakten själv — se
  // kommentaren vid KORT. Golvet ovan prövas ändå mot HELA mängden, så en
  // krympt korpus syns även i barnet.
  const vakter = KORT ? alla.filter((v) => !v.endsWith('check-self-tests-fail.mjs')).slice(0, 2) : alla

  // ── BASLINJEN ───────────────────────────────────────────────────────────
  const { problem, mätta } = await evaluate(vakter)
  kräv('baslinjen är grön', problem.length === 0, problem.slice(0, 2).join(' | '))
  kräv(
    `alla ${mätta.length} fäller`,
    mätta.every((m) => m.utfall === 'FÄLLER' || m.utfall === 'FÄLLER-STRUKTURELLT'),
    mätta
      .filter((m) => m.utfall !== 'FÄLLER' && m.utfall !== 'FÄLLER-STRUKTURELLT')
      .map((m) => `${m.vakt}:${m.utfall}`)
      .join(', '),
  )

  if (fel.length) {
    console.error(`\n❌ Självtestet föll på ${fel.length} punkt(er).`)
    process.exit(1)
  }
  console.warn(
    `\n✅ Självtest OK — ${Object.keys(FIXTURER).length} fixturer (enradig och flerradig, före och efter), ` +
      `skuggträdet läser repot, ${mätta.length} vakter mätta och alla fäller.`,
  )
}

// Importerad? Kör ingenting. Utan den här raden kör varje `import` av modulen
// hela svepet — vilket kostar två minuter och skriver en grön rad som ser ut
// som ett resultat.
const KÖRS_DIREKT = process.argv[1]?.endsWith('check-self-tests-fail.mjs') ?? false

if (!KÖRS_DIREKT) {
  // importerad — exportera bara
} else if (process.argv.includes('--self-test')) await självtest()
else {
  const start = Date.now()
  const { problem, mätta } = await evaluate()
  const sek = ((Date.now() - start) / 1000).toFixed(1)
  if (problem.length > 0) {
    console.error('\n=== ETT SJÄLVTEST KAN INTE FÄLLA ===\n')
    for (const p of problem) console.error(`  • ${p}\n`)
    console.error(
      'Ett självtest som rapporterar ett fel utan att avsluta med nollskild exitkod gör\n' +
        'sitt CI-steg grönt om en vakt som slutat mäta. Låt rapportvägen skriva den\n' +
        'flagga eller räknare som exitbeslutet läser — process.exit(kod) skriver ALLTID\n' +
        'över process.exitCode.\n',
    )
    process.exit(1)
  }
  console.log(
    `✅ Alla ${mätta.length} självtester fäller på en injicerad kanariefågel ` +
      `(${sek} s, ${SAMTIDIGA} samtidiga, mutationen sker i tmpdir — trädet rörs aldrig).`,
  )
}
