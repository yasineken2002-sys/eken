#!/usr/bin/env node
/**
 * Ingen vakt får läsa källkod på egen hand.
 *
 * ── VARFÖR ──────────────────────────────────────────────────────────────────
 *
 * Tre varianter av samma defekt mättes på en dag, av tre olika händer: en
 * skanner som läste `"` i `.replace(/"/g, …)` som strängstart och blankade
 * 11 629 tecken; fyra vakter som strippade kommentarer utan strängkännedom; en
 * mätsond som desynkade och rapporterade 36 filer i stället för 30.
 *
 * ── VARFÖR REGELN SKREVS OM (#582 + red team-revisionen) ────────────────────
 *
 * Den första versionen förbjöd FEM NAMNGIVNA `.replace(…)`-former. Det mätte
 * "gjorde det på ett av fem kända sätt", inte "gjorde det själv" — och
 * skillnaden är inte teoretisk. `check-transaction-limits` skrev en egen
 * TECKENVANDRARE (`matchParen` + `hoppaSträng`) som skötte kommentarer och
 * strängar för hand. Den gjorde exakt det den här vakten finns för att stoppa,
 * och passerade i två år, eftersom en vandrare inte är en `.replace`.
 *
 * Kostnaden är uppmätt: vakten blev grön av en KOMMENTAR som nämnde den
 * identifierare den letade efter. Och defekten går åt BÅDA hållen — en mätning
 * i samma revision visade att `check-period-lookup-source` FÄLLER på ett
 * kodexempel som står i en kommentar:
 *
 *     brottet i KOD        → RÖD   (rätt)
 *     samma brott i PROSA  → RÖD   (falskt larm)
 *
 * En regel formulerad som en uppräkning av former kan bara växa i efterhand,
 * en form i taget, efter varje ny incident. Nästa författare uppfinner ett
 * sjätte sätt.
 *
 * ── VAD REGELN FRÅGAR I STÄLLET ─────────────────────────────────────────────
 *
 * INTE "hur gjorde du det" utan "gjorde du det själv":
 *
 *   rör skriptet filsystemet?  →  då måste det gå via den delade skannern,
 *                                  eller bära en KVITTERING med skäl.
 *
 * Triggern är `import … from 'node:fs'`. Det är strukturellt och har ingen
 * klassificering i sig — vakten avgör inte om innehållet "är källkod", för
 * varje sådan bedömning är en heuristik som kan ha fel utan att någon märker
 * det. En handskriven teckenvandrare, en regexfamilj vi inte tänkt på och en
 * tredje variant ingen uppfunnit än fälls alla av samma regel, därför att alla
 * tre kräver att skriptet läser filer på egen hand.
 *
 * De fem formerna står KVAR, men som djupförsvar och inte som regeln: en
 * KVITTERAD vakt får läsa filer själv, men den får ändå inte skriva en känd
 * lexer-form. Kvitteringen ursäktar "går inte via skannern", inte "skriver
 * en egen tokenizer".
 *
 * Kör med `--self-test` för kanariefåglarna.
 */
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import {
  blankRegions,
  withoutComments,
  kanariefåglar,
  KANARIEFÅGEL_LÄGEN,
} from '../../../scripts/lib/source-scan.mjs'

const ROT = resolve(new URL('../../..', import.meta.url).pathname)
const KATALOGER = ['apps/api/scripts', 'scripts']
const DELAD = 'scripts/lib/source-scan.mjs'

/**
 * Handrullad förbehandling. Formen, inte ett filnamn — en ny vakt som skriver
 * sin egen fälls utan att någon behöver kvittera den.
 */
const FÖRBJUDNA_FORMER = [
  [/\.replace\(\s*\/\\\/\\\*/, 'blockkommentar-strippning med en naken regex'],
  [/\.replace\(\s*\/\\\/\\\//, 'radkommentar-strippning med en naken regex'],
  [/\.replace\(\s*\/--/, 'SQL-radkommentar-strippning med en naken regex'],
  [/\.indexOf\(\s*['"]\*\/['"]\s*\)/, 'handrullad blockkommentar-sökning'],
  [/\.replace\(\s*\/\^import\\s/, 'handrullad import-strippning'],
]

/** Rör skriptet filsystemet? Triggern — strukturell, ingen bedömning. */
const RÖR_FS = /from\s+['"](?:node:)?fs(?:\/promises)?['"]/
/** Går det via den delade skannern? */
const ANVÄNDER_DELAD = /from\s+['"][^'"]*source-scan\.mjs['"]/

const ACK_PATH = join(new URL('.', import.meta.url).pathname, 'guard-preprocessors.ack.json')
const MIN_SKÄL = 40

export function loadAck() {
  return JSON.parse(readFileSync(ACK_PATH, 'utf8'))
}

/**
 * Kärnan, matbar med SYNTETISK indata så kanariefåglarna kan pröva former som
 * inte finns i repot. `evaluate` läser disk och delegerar hit.
 */
export function evaluateTexts(poster, ack = { files: {} }) {
  const fel = []
  const konsumenter = []
  const kräverKvittering = []
  let former = 0

  for (const { rel, text } of poster) {
    if (rel === DELAD) continue
    // R1 läser koden med STRÄNGINNEHÅLL blankat men REGEX-LITERALER intakta.
    // Skälet är mätt: självtestets egna provsträngar ("x.replace(/\\/\\*…")
    // fällde vakten om sin egen kanariefågel. Regexkropparna måste stå kvar —
    // det är just dem R1 känner igen.
    const kod = blankRegions(text, ['string', 'template'], { del: 'body' })

    // ── OCH IMPORTERNA LÄSES UR EN ANNAN MASK ────────────────────────────────
    //
    // `kod` ovan blankar STRÄNGKROPPAR — i den masken är `from 'node:fs'` bara
    // `from '      '`, och triggern hade aldrig matchat. Jag skrev först precis
    // det felet; regeln hade blivit tyst grön för allt.
    //
    // Importer avgörs därför mot `withoutComments`: kommentarer bort, strängar
    // intakta. Då kan varken en kommentar som NÄMNER `node:fs` utlösa regeln,
    // eller en riktig import undgå den. Det är samma skillnad som #582:s
    // defekt, fast åt båda hållen — därför två masker och inte en.
    const importer = withoutComments(text)

    // ── R1 — GJORDE DU DET SJÄLV? ──────────────────────────────────────────
    //
    // Formen, inte fem mönster. Rör skriptet filsystemet ska det gå via den
    // delade skannern, annars kvitteras med skäl. Kvitteringen fäller åt BÅDA
    // hållen (se diffAck).
    const rörFs = RÖR_FS.test(importer)
    const delad = ANVÄNDER_DELAD.test(importer)
    if (rörFs && !delad) {
      kräverKvittering.push(rel)
      const post = (ack.files ?? {})[rel]
      if (!post) {
        fel.push(
          `R1 ${rel} — läser filer på egen hand utan scripts/lib/source-scan.mjs. ` +
            'Gå via den delade skannern, eller kvittera filen med ett skäl i ' +
            'guard-preprocessors.ack.json. En handskriven teckenvandrare, en ' +
            'regexfamilj vi inte tänkt på och en variant ingen uppfunnit än fälls ' +
            'alla här — regeln frågar OM du gör det själv, inte HUR.',
        )
      } else if ((post.reason ?? '').trim().length < MIN_SKÄL) {
        fel.push(
          `R1 ${rel} — kvitteringen har ett skäl på ${(post.reason ?? '').trim().length} ` +
            `tecken; minst ${MIN_SKÄL} krävs. Skriv VAD filen läser och varför den inte ` +
            'kan gå via skannern.',
        )
      }
    }

    // ── R1b — DJUPFÖRSVAR: kända lexer-former är förbjudna ÄVEN i en kvitterad
    // fil. Kvitteringen ursäktar "går inte via skannern", inte "skriver en egen
    // tokenizer".
    for (const [re, vad] of FÖRBJUDNA_FORMER) {
      if (re.test(kod)) {
        former++
        const rad = kod.slice(0, kod.search(re)).split('\n').length
        fel.push(
          `R1b ${rel}:${rad} — ${vad}. Använd scripts/lib/source-scan.mjs. ` +
            'En naken regex kan inte strängar: ett `//` i en literal äter resten av raden, ' +
            'och ett `"` i en regex-literal blankar allt fram till nästa citattecken.',
        )
      }
    }

    // R2 — den som använder den delade ska köra dess kanariefåglar i sitt
    // självtest. Bryts skannern blir VARJE konsument röd, inte bara en spec.
    if (!ANVÄNDER_DELAD.test(importer)) continue
    konsumenter.push(rel)
    const harSjälvtest = /--self-test/.test(text)
    if (harSjälvtest && !/kanariefåglar\(\)/.test(text)) {
      fel.push(
        `R2 ${rel} — använder den delade skannern men kör inte dess kanariefåglar i sitt ` +
          'självtest. Går skannern sönder ska den här vakten bli röd, inte tyst fortsätta mäta fel.',
      )
    }
  }

  // R3 — den delade skannern klarar de mönster som bevisligen lurat oss.
  for (const f of kanariefåglar()) fel.push(`R3 delad skanner: ${f}`)

  if (konsumenter.length === 0) {
    fel.push('R2 — ingen vakt använder den delade skannern. Vakten mäter ingenting.')
  }

  // ── KVITTERINGEN FÄLLER ÅT BÅDA HÅLLEN ────────────────────────────────────
  //
  // En kvittering som inte längre motsvarar något i koden är lika röd som en
  // saknad. Annars överlever listan sin egen sanning: en vakt som migrerats
  // till den delade skannern skulle stå kvar som "får läsa själv" för alltid.
  const kvitterade = Object.keys(ack.files ?? {})
  for (const rel of kvitterade) {
    if (!kräverKvittering.includes(rel)) {
      fel.push(
        `R1 ${rel} — kvitterad men behöver det inte: filen rör inte filsystemet ` +
          'på egen hand längre (eller finns inte). Ta bort posten ur ' +
          'guard-preprocessors.ack.json.',
      )
    }
  }

  return {
    fel,
    mätt: {
      skript: poster.length,
      konsumenter: konsumenter.length,
      förbjudnaFormer: former,
      kräverKvittering: kräverKvittering.length,
      kvitterade: kvitterade.length,
    },
  }
}

export function evaluate(filer, ack = loadAck()) {
  const poster = filer.map((abs) => ({
    rel: relative(ROT, abs).replaceAll('\\', '/'),
    text: readFileSync(abs, 'utf8'),
  }))
  return evaluateTexts(poster, ack)
}

function allaSkript() {
  const ut = []
  for (const kat of KATALOGER) {
    const bas = join(ROT, kat)
    const stack = [bas]
    while (stack.length) {
      const d = stack.pop()
      for (const n of readdirSync(d)) {
        const p = join(d, n)
        if (statSync(p).isDirectory()) stack.push(p)
        else if (n.endsWith('.mjs')) ut.push(p)
      }
    }
  }
  return ut
}

function självtest() {
  const fel = []
  const bas = evaluate(allaSkript())
  if (bas.fel.length) fel.push(`baslinjen är inte grön:\n    ${bas.fel.join('\n    ')}`)

  // KANARIE A — R1 fäller varje form. Töms FÖRBJUDNA_FORMER, eller trasigas en
  // regex, blir vakten grön för allt — det tysta läget.
  const prov = [
    ["x.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '')", 'blockkommentar-strippning med en naken regex'],
    ["x.replace(/\\/\\/[^\\n]*/g, '')", 'radkommentar-strippning med en naken regex'],
    ["x.replace(/--[^\\n]*/g, ' ')", 'SQL-radkommentar-strippning med en naken regex'],
    ["t.indexOf('*/')", 'handrullad blockkommentar-sökning'],
    ["x.replace(/^import\\s+[\\s\\S]*?from/gm, '')", 'handrullad import-strippning'],
  ]
  for (const [kod, vad] of prov) {
    if (!FÖRBJUDNA_FORMER.some(([re, v]) => v === vad && re.test(kod))) {
      fel.push(`KANARIE A: formen "${vad}" fälls inte av sitt eget mönster (prov: ${kod})`)
    }
  }

  // ── KANARIE F — FORMREGELN, INTE FEM MÖNSTER ──────────────────────────────
  //
  // DET HÄR ÄR HELA POÄNGEN MED OMSKRIVNINGEN. Den gamla regeln fällde fem
  // namngivna `.replace(…)`-former. `check-transaction-limits` skrev i stället
  // en TECKENVANDRARE och passerade i två år.
  //
  // Proven nedan matar in fyra sätt att läsa filer själv där INGET är en
  // `.replace` och bara ett är en vandrare. Fälls de inte har regeln lärt sig
  // de fall vi känner i stället för formen.
  const utanAck = { files: {} }
  const prövaR1 = (namn, text) =>
    evaluateTexts([{ rel: `apps/api/scripts/${namn}`, text }], utanAck).fel.filter((f) =>
      f.startsWith('R1 '),
    )

  const varianter = [
    [
      'teckenvandrare (formen som slank igenom i två år)',
      `import { readFileSync } from 'node:fs'
       function hoppaSträng(t, i) { const q = t[i]; i++; while (i < t.length) { if (t[i] === q) return i + 1; i++ } return t.length }
       const src = readFileSync('x.ts', 'utf8')`,
    ],
    [
      'split/join i stället för replace',
      `import { readFileSync } from 'node:fs'
       const utan = readFileSync('x.ts', 'utf8').split('/*').map((d, i) => (i ? d.slice(d.indexOf('*/') + 2) : d)).join('')`,
    ],
    [
      'tredjeparts-parser — varken regex eller vandrare',
      `import { readFileSync } from 'node:fs'
       import { parse } from 'acorn'
       const ast = parse(readFileSync('x.ts', 'utf8'), { ecmaVersion: 2022 })`,
    ],
    [
      'radvis filtrering utan någon strängkännedom alls',
      `import { readFileSync } from 'node:fs'
       const rader = readFileSync('x.ts', 'utf8').split('\\n').filter((r) => !r.trimStart().startsWith('//'))`,
    ],
  ]
  for (const [vad, kod] of varianter) {
    if (prövaR1(`zz-prov-${vad.length}.mjs`, kod).length !== 1) {
      fel.push(
        `KANARIE F: \"${vad}\" fälls INTE av R1 — regeln mäter fortfarande former, inte formen.`,
      )
    }
  }

  // Och motsatsen: den som GÅR VIA skannern ska inte fällas, annars fäller
  // regeln allt och betyder lika lite.
  const viaSkannern = `import { readFileSync } from 'node:fs'
     import { codeMask } from '../../../scripts/lib/source-scan.mjs'
     const kod = codeMask(readFileSync('x.ts', 'utf8'))`
  if (prövaR1('zz-prov-ok.mjs', viaSkannern).length !== 0) {
    fel.push('KANARIE F: en vakt som GÅR VIA skannern fälls ändå — regeln fäller allt.')
  }

  // En KOMMENTAR som nämner node:fs får inte utlösa regeln. Samma defekt som
  // #582, fast åt andra hållet (falskt larm i stället för tyst grön).
  const baraProsa = `// den här läser inget, men nämner import { readFileSync } from 'node:fs'
     export const x = 1`
  if (prövaR1('zz-prov-prosa.mjs', baraProsa).length !== 0) {
    fel.push(
      'KANARIE F: en KOMMENTAR som nämner node:fs utlöste regeln — importerna läses inte ur rätt mask.',
    )
  }

  // KVITTERINGEN FÄLLER ÅT BÅDA HÅLLEN.
  const medAck = { files: { 'apps/api/scripts/zz-prov-ack.mjs': { reason: 'x'.repeat(60) } } }
  const kvitterad = evaluateTexts(
    [{ rel: 'apps/api/scripts/zz-prov-ack.mjs', text: varianter[0][1] }],
    medAck,
  ).fel.filter((f) => f.startsWith('R1 '))
  if (kvitterad.length !== 0) fel.push('KANARIE F: en KVITTERAD fil fälls ändå av R1.')

  const stale = evaluateTexts([{ rel: 'apps/api/scripts/zz-prov-ok.mjs', text: viaSkannern }], {
    files: { 'apps/api/scripts/zz-prov-ok.mjs': { reason: 'x'.repeat(60) } },
  }).fel.filter((f) => f.startsWith('R1 '))
  if (stale.length !== 1)
    fel.push(
      'KANARIE F: en kvittering UTAN motsvarighet i koden fälls inte — listan överlever sin egen sanning.',
    )

  const kortSkäl = evaluateTexts(
    [{ rel: 'apps/api/scripts/zz-prov-kort.mjs', text: varianter[0][1] }],
    { files: { 'apps/api/scripts/zz-prov-kort.mjs': { reason: 'kort' } } },
  ).fel.filter((f) => f.startsWith('R1 '))
  if (kortSkäl.length !== 1) fel.push('KANARIE F: en kvittering med för tunt skäl släpps igenom.')

  // R1b står kvar som djupförsvar: en KVITTERAD fil får ändå inte skriva en
  // känd lexer-form.
  const ackMedForm = evaluateTexts(
    [
      {
        rel: 'apps/api/scripts/zz-prov-form.mjs',
        text: `import { readFileSync } from 'node:fs'\nconst y = x.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '')`,
      },
    ],
    { files: { 'apps/api/scripts/zz-prov-form.mjs': { reason: 'x'.repeat(60) } } },
  ).fel.filter((f) => f.startsWith('R1b'))
  if (ackMedForm.length !== 1)
    fel.push('KANARIE F: en kvitterad fil får skriva en känd lexer-form — djupförsvaret saknas.')

  // KANARIE B — den delade skannern ANVÄNDS av mer än en vakt. Ett fynd på
  // noll konsumenter vore grönt utan att betyda något.
  if (bas.mätt.konsumenter < 4) {
    fel.push(
      `KANARIE B: bara ${bas.mätt.konsumenter} vakter använder den delade skannern — förväntat minst 4.`,
    )
  }

  // KANARIE C — R3 vidarebefordrar den delade skannerns egna fel. Går den
  // sönder ska DEN HÄR vakten falla, inte bara source-scan.mjs egen körning.
  const antal = kanariefåglar().length
  if (antal !== 0)
    fel.push(`KANARIE C: den delade skannern rapporterar ${antal} fel redan i baslinjen.`)

  if (fel.length) {
    console.error('SJÄLVTEST RÖTT:\n  ' + fel.join('\n  '))
    process.exit(1)
  }
  console.warn(
    `SJÄLVTEST GRÖNT — ${bas.mätt.skript} skript, ${bas.mätt.konsumenter} via skannern, ` +
      `${bas.mätt.kvitterade} kvitterade; formregeln prövad mot fyra ICKE-.replace-varianter ` +
      `plus 5 kända former och skannerns kanariefåglar över ${KANARIEFÅGEL_LÄGEN.length} lägen.`,
  )
}

const KÖRS_DIREKT = process.argv[1]?.endsWith('check-guard-preprocessors.mjs') ?? false
if (!KÖRS_DIREKT) {
  // importerad — kör ingenting
} else if (process.argv.includes('--self-test')) självtest()
else {
  const { fel, mätt } = evaluate(allaSkript())
  if (fel.length) {
    console.error('Handrullad förbehandling i en vakt:\n  ' + fel.join('\n  '))
    process.exit(1)
  }
  console.warn(
    `Förbehandling är delad — ${mätt.skript} skript granskade, ${mätt.konsumenter} via ` +
      `scripts/lib/source-scan.mjs, ${mätt.kvitterade} kvitterade (läser själva, med skäl), ` +
      '0 handrullade lexer-former.',
  )
}
