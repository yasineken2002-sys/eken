#!/usr/bin/env node
/**
 * SKANNERNS KANARIEFÅGLAR MÅSTE KUNNA FÄLLA — ett läge i taget.
 *
 * ── VARFÖR DEN FINNS ────────────────────────────────────────────────────────
 *
 * `scripts/lib/source-scan.mjs` är rot-nivå: 27 vaktskript förbehandlar sin
 * indata med den, och var och en kör dess `kanariefåglar()` i sitt självtest.
 * Hela den kedjan vilar på att kanariefåglarna kan bli RÖDA.
 *
 * Det kunde de inte. Uppmätt mot main `4dfefbc`, genom att neutralisera ett läge
 * i taget:
 *
 *     lägen som slapp igenom oupptäckt:  7 av 12
 *
 * Bland dem REGEX-läget. Med `REGEX_LÄGE = /QQ_ALDRIG/` — regex-igenkänningen
 * helt avstängd, alltså defekt 1 i skannerns egen huvudkommentar återinförd —
 * var alla sju kanariefåglarna GRÖNA, medan 14 854 tecken i `apps/api/src`
 * slutade maskeras och stod kvar som om de vore kod. Exakt EN av de tio nyss
 * migrerade vakterna fångade det.
 *
 * Det är samma defekt som R5, en våning ner: regeln fungerade, men mängden den
 * prövades mot var tom. Här var provet grönt av sin egen FORMATERING —
 * `ZZTRÄFF` stod på nästa rad, och en oterminerad sträng bryts vid radslut.
 *
 * ── VAD REGELN FRÅGAR ───────────────────────────────────────────────────────
 *
 * Inte "finns det kanariefåglar" utan "kan de fälla". För varje läge i skannern
 * skrivs en muterad kopia som neutraliserar just det läget, kopian importeras,
 * och dess EGNA `kanariefåglar()` måste rapportera minst ett fel.
 *
 * ── PARITET ÅT BÅDA HÅLLEN ──────────────────────────────────────────────────
 *
 * Samma form som kvitteringsfilerna på andra håll i kodbasen:
 *
 *   • ett läge i `KANARIEFÅGEL_LÄGEN` utan mutation → RÖTT (obevisat prov)
 *   • en mutation vars läge inte finns i listan     → RÖTT (mutation utan prov)
 *   • en mutation vars ankare inte matchar exakt EN gång → RÖTT
 *
 * Det sista är det som gör riggen ärlig. Ett ankare som slutat matcha efter en
 * omskrivning skulle annars ge en mutation som inte muterar något — och en
 * kopia som är identisk med originalet är förstås grön. Tystnad, inte fel.
 *
 * Kör:        node apps/api/scripts/check-source-scan-canaries.mjs
 * Självtest:  node apps/api/scripts/check-source-scan-canaries.mjs --self-test
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { kanariefåglar, KANARIEFÅGEL_LÄGEN } from '../../../scripts/lib/source-scan.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const SKANNER = resolve(HERE, '..', '..', '..', 'scripts', 'lib', 'source-scan.mjs')

/**
 * En mutation per LÄGE i skannern. `från` måste förekomma exakt en gång.
 *
 * Mutationerna neutraliserar läget — de gör det inte "lite sämre". Poängen är
 * att svara på frågan "om det här läget slutade fungera helt, skulle någon
 * märka det?". Blir svaret nej är provet pynt.
 */
export const MUTATIONER = [
  {
    läge: 'regex',
    vad: 'regex-läget känns aldrig igen (defekt 1 återinförd)',
    från: 'const REGEX_LÄGE = /^$|[(,=:[!&|?{};+\\-*%~^<>]|`|\\breturn$',
    till: 'const REGEX_LÄGE = /QQ_ALDRIG_MATCHA$|[(]|\\breturn$',
  },
  {
    läge: 'regex',
    vad: 'regexSlut hittar aldrig slutet (andra halvan av samma läge)',
    från: 'function regexSlut(text, start, till) {',
    till: 'function regexSlut(text, start, till) {\n  if (true) return -1',
  },
  {
    läge: 'sträng',
    vad: 'strängar tokeniseras aldrig',
    från: "    // Enkel-/dubbelciterad sträng\n    if (c === \"'\" || c === '\"') {",
    till: '    // Enkel-/dubbelciterad sträng\n    if (false) {',
  },
  {
    läge: 'mallsträng',
    vad: 'mallsträngar tokeniseras aldrig',
    från: "    if (c === '`') {\n      const { slut, exprs, inre } = mallSlut(text, i, till)",
    till: "    if (false) {\n      const { slut, exprs, inre } = mallSlut(text, i, till)",
  },
  {
    läge: 'radkommentar',
    vad: 'radkommentarer känns aldrig igen',
    från: "    if (c === '/' && text[i + 1] === '/') {\n      const n = text.indexOf('\\n', i)",
    till: "    if (false) {\n      const n = text.indexOf('\\n', i)",
  },
  {
    läge: 'blockkommentar',
    vad: 'blockkommentarer känns aldrig igen',
    från: "    if (c === '/' && text[i + 1] === '*') {\n      const n = text.indexOf('*/', i + 2)\n      const slut = n === -1 || n + 2 > till ? till : n + 2\n      ut.push({ kind: 'block-comment'",
    till: "    if (false) {\n      const n = text.indexOf('*/', i + 2)\n      const slut = n === -1 || n + 2 > till ? till : n + 2\n      ut.push({ kind: 'block-comment'",
  },
  {
    läge: 'escape i sträng',
    vad: 'backslash-hoppet i strängskannern tas bort',
    från: "      while (j < till && text[j] !== c) {\n        if (text[j] === '\\\\') { j += 2; continue }",
    till: '      while (j < till && text[j] !== c) {\n        if (false) { j += 2; continue }',
  },
  {
    läge: 'escape i mallsträng',
    vad: 'backslash-hoppet i mallskannern tas bort',
    från: "    if (c === '\\\\') { j += 2; continue }\n    if (c === '`') return { slut: j + 1, exprs, inre }",
    till: "    if (false) { j += 2; continue }\n    if (c === '`') return { slut: j + 1, exprs, inre }",
  },
  {
    läge: '${}-tokenisering',
    vad: 'uttrycksSlut blir en naiv klammerräkning utan strängkännedom',
    från: '    const t = enTokenVid(text, i, till)\n    if (t) { i = t.end; continue }',
    till: '    if (false) { i = 0; continue }',
  },
  {
    läge: 'SQL-radkommentar',
    vad: 'SQL-dialekten tappar sin radkommentar',
    från: "  if (dialect === 'sql') return tokenizeBlockOnly(text, { radkommentar: '--' })",
    till: "  if (dialect === 'sql') return tokenizeBlockOnly(text, { radkommentar: null })",
  },
  {
    läge: 'CSS-dialekt',
    vad: 'CSS mappas till SQL — den uppmätta allowlist-incidenten',
    från: "  if (dialect === 'css') return tokenizeBlockOnly(text, { radkommentar: null })",
    till: "  if (dialect === 'css') return tokenizeBlockOnly(text, { radkommentar: '--' })",
  },
  {
    läge: 'removeImports',
    vad: 'removeImports slutar undanta literaler',
    från: '    if (inutiLiteral(m.index)) continue',
    till: '    if (false) continue',
  },
]

/** Skriv en muterad kopia, importera den, och kör DESS egna kanariefåglar. */
export async function prövaMutation(bas, mutation, dir, nr) {
  const träffar = bas.split(mutation.från).length - 1
  if (träffar !== 1) {
    return {
      ...mutation,
      utfall: 'ANKARE',
      detalj: `ankaret matchade ${träffar} ställen (väntade exakt 1) — mutationen muterar inget`,
    }
  }
  const fil = join(dir, `skanner-${nr}.mjs`)
  writeFileSync(fil, bas.replace(mutation.från, mutation.till))
  let fel
  try {
    fel = (await import(pathToFileURL(fil).href)).kanariefåglar()
  } catch (e) {
    // En kopia som inte ens laddar är ett giltigt "rött" — men säg vilket.
    return { ...mutation, utfall: 'RÖD', detalj: `kopian kastade: ${e.message}` }
  }
  return {
    ...mutation,
    utfall: fel.length ? 'RÖD' : 'GRÖN',
    detalj: fel.length ? fel.slice(0, 2).join(' | ') : 'kanariefåglarna märkte ingenting',
  }
}

export async function körAlla(mutationer = MUTATIONER, källa = SKANNER) {
  const bas = readFileSync(källa, 'utf8')
  const dir = mkdtempSync(join(tmpdir(), 'source-scan-mut-'))
  try {
    const ut = []
    for (const [i, m] of mutationer.entries()) ut.push(await prövaMutation(bas, m, dir, i))
    return ut
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Paritet: varje läge har en mutation, varje mutation har ett läge. */
export function paritet(lägen, mutationer) {
  const problem = []
  const muterade = new Set(mutationer.map((m) => m.läge))
  for (const l of lägen) {
    if (!muterade.has(l)) {
      problem.push(
        `läget "${l}" har ett prov men INGEN mutation — provet är obevisat. ` +
          'Lägg till en mutation som neutraliserar läget i MUTATIONER.',
      )
    }
  }
  const kända = new Set(lägen)
  for (const l of muterade) {
    if (!kända.has(l)) {
      problem.push(
        `mutationen för "${l}" pekar på ett läge som inte finns i KANARIEFÅGEL_LÄGEN — ` +
          'antingen har läget döpts om, eller så saknas provet.',
      )
    }
  }
  return problem
}

function rapportera(rader, parProblem) {
  const trasiga = rader.filter((r) => r.utfall !== 'RÖD')
  for (const r of rader) {
    const märke = r.utfall === 'RÖD' ? '✅' : '❌'
    console.warn(`${märke} ${r.läge.padEnd(20)} ${r.utfall.padEnd(6)} ${r.vad}`)
    if (r.utfall !== 'RÖD') console.warn(`     ${r.detalj}`)
  }
  for (const p of parProblem) console.error(`❌ PARITET: ${p}`)
  return trasiga.length + parProblem.length
}

async function kör() {
  const rader = await körAlla()
  const parProblem = paritet(KANARIEFÅGEL_LÄGEN, MUTATIONER)
  const fel = rapportera(rader, parProblem)
  if (fel > 0) {
    console.error(
      '\n=== SKANNERNS KANARIEFÅGLAR KAN INTE FÄLLA (CI-guard) ===\n\n' +
        'Ett läge vars kanariefågel är GRÖN med läget avstängt är pynt — och pyntet\n' +
        'är farligare än inget prov alls, eftersom 27 vaktskript kör den funktionen\n' +
        'och tror att grönt betyder att skannern fungerar.\n\n' +
        'Skriv ett prov i LÄGESPROV i scripts/lib/source-scan.mjs som FALLER när\n' +
        'läget neutraliseras. Sonden måste stå på SAMMA RAD som det som ska\n' +
        'överleva — annars blir provet grönt av sin egen formatering.\n',
    )
    process.exit(1)
  }
  console.warn(
    `\n✅ Skannerns kanariefåglar fäller varje läge — ${rader.length} mutationer över ` +
      `${KANARIEFÅGEL_LÄGEN.length} lägen, alla RÖDA, och paritet åt båda hållen.`,
  )
}

// ── självtest ────────────────────────────────────────────────────────────────
async function självtest() {
  let fel = 0
  const t = (namn, ok, extra = '') => {
    console.warn(`${ok ? '✅' : '❌'} ${namn}${extra ? '  → ' + extra : ''}`)
    if (!ok) fel++
  }

  // (0) Den delade skannerns kanariefåglar — kravet metavakten (R2) ställer.
  const skanner = kanariefåglar()
  t('delad skanner: kanariefåglarna gröna i baslinjen', skanner.length === 0, skanner.join(' | '))

  // (1) Baslinjen: varje mutation är röd, pariteten hel.
  const rader = await körAlla()
  const ej = rader.filter((r) => r.utfall !== 'RÖD')
  t('varje mutation fäller kanariefåglarna', ej.length === 0,
    ej.map((r) => `${r.läge}=${r.utfall}`).join(', '))
  t('paritet läge ↔ mutation', paritet(KANARIEFÅGEL_LÄGEN, MUTATIONER).length === 0,
    paritet(KANARIEFÅGEL_LÄGEN, MUTATIONER).join(' | '))

  // (2) META-KANARIEFÅGEL: riggen måste kunna säga GRÖN.
  //
  // En rigg som rapporterar RÖD för allt bevisar ingenting — den hade varit
  // grön i CI oavsett vad skannern gör. En NO-OP-mutation ändrar ingenting och
  // MÅSTE därför ge GRÖN.
  const noop = await körAlla([
    { läge: 'zz-noop', vad: 'ingen ändring alls', från: 'export function tokenize(', till: 'export function tokenize(' },
  ])
  t('META: en NO-OP-mutation rapporteras som GRÖN (riggen säger inte rött om allt)',
    noop[0].utfall === 'GRÖN', `${noop[0].utfall} — ${noop[0].detalj}`)

  // (3) Ett ankare som inte matchar ska SÄGAS IFRÅN, inte hoppas över tyst.
  const dött = await körAlla([
    { läge: 'zz-dött', vad: 'ankare som inte finns', från: 'QQ_ANKARE_SOM_INTE_FINNS', till: 'x' },
  ])
  t('ett ankare som inte matchar rapporteras som ANKARE', dött[0].utfall === 'ANKARE', dött[0].detalj)

  const dubbelt = await körAlla([
    { läge: 'zz-dubbelt', vad: 'ankare som matchar flera gånger', från: 'const', till: 'const' },
  ])
  t('ett ankare som matchar flera gånger rapporteras som ANKARE', dubbelt[0].utfall === 'ANKARE',
    dubbelt[0].detalj)

  // (4) OMFÅNG: mutationslistan får inte krympa tyst. Golv MÄTT vid införandet:
  // 12 mutationer över 11 lägen.
  const MIN_MUTATIONER = 12
  const MIN_LÄGEN = 11
  t(`omfång: ${MUTATIONER.length} mutationer (golv ${MIN_MUTATIONER})`,
    MUTATIONER.length >= MIN_MUTATIONER)
  t(`omfång: ${KANARIEFÅGEL_LÄGEN.length} lägen med prov (golv ${MIN_LÄGEN})`,
    KANARIEFÅGEL_LÄGEN.length >= MIN_LÄGEN, KANARIEFÅGEL_LÄGEN.join(', '))

  // (5) Pariteten måste kunna fälla åt BÅDA hållen — annars är den dekoration.
  t('PARITET fäller ett läge utan mutation',
    paritet([...KANARIEFÅGEL_LÄGEN, 'zz-prov-utan-mutation'], MUTATIONER).length === 1)
  t('PARITET fäller en mutation utan läge',
    paritet(KANARIEFÅGEL_LÄGEN, [...MUTATIONER, { läge: 'zz-mutation-utan-prov' }]).length === 1)

  console.warn(fel === 0 ? '\n✅ Självtest OK.' : `\n❌ Självtest: ${fel} fallerade.`)
  process.exit(fel === 0 ? 0 : 1)
}

const körsDirekt = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (!körsDirekt) {
  // importerad — exportera bara
} else if (process.argv.includes('--self-test')) await självtest()
else await kör()
