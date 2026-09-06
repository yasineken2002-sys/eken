#!/usr/bin/env node
/**
 * CI-VAKT — DE TRE UTFÖRANDESTATUSARNA FÅR INTE UPPSTÅ FÖRRÄN UTFÖRAREN FINNS.
 *
 * ── DEFEKTEN DEN FINNS FÖR ──────────────────────────────────────────────────
 *
 * `AiAssignmentStatus` fick `EXECUTED`, `FAILED` och `LAPSED` i etapp 8, INNAN
 * skrivaren byggdes. Planens Del 12 sa uttryckligen att de skulle läggas till av
 * den PR som bygger det som skriver dem — regeln finns därför att ett enumvärde
 * utan skrivare är ett löfte: läsytan måste hantera en status som aldrig
 * uppstår, och död kod ser ut som täckning.
 *
 * Undantaget godtogs på ETT villkor: att statusarna bevisligen inte kan uppstå i
 * drift. Den här vakten är det beviset. Utan den är schemats docblock ett
 * påstående ingen mäter.
 *
 * ── REGELN ──────────────────────────────────────────────────────────────────
 *
 * R1  INGEN produktionsfil får skriva `EXECUTED`, `FAILED` eller `LAPSED` som
 *     status på en `AiAssignment`. Mätt som: ett `status:`-fält vars värde är en
 *     av de tre strängarna, inuti ett `aiAssignment.<skrivmetod>(`-anrop.
 *
 * ── VILKEN VY, OCH VARFÖR JUST DEN ─────────────────────────────────────────
 *
 * `blankComments` — INTE `codeMask`. Det jag letar efter BOR I EN STRÄNG
 * (`status: 'EXECUTED'`), och `codeMask` blankar per konstruktion allt
 * stränginnehåll. En vakt byggd på `codeMask` hade varit grön för alltid utan
 * att kunna falla, vilket är precis den blindhet CLAUDE.md:s "EN VY PER FRÅGA"
 * beskriver.
 *
 * Kommentarer blankas däremot, så en förklarande rad som NÄMNER `'EXECUTED'`
 * inte räknas som en skrivning. Kanariefågeln nedan kräver att just den
 * skillnaden går att mäta.
 *
 * ── VAD DEN INTE KAN SE ─────────────────────────────────────────────────────
 *
 * En skrivning som bygger statussträngen dynamiskt (`status: nyStatus`) eller
 * går via rå SQL. Den formen finns inte i kodbasen i dag — varje
 * `aiAssignment`-statusskrivning är en literal — och att den skulle införas
 * samtidigt som någon vill kringgå den här vakten är inte det hot regeln finns
 * för. Vakten mäter att ingen VÄG BYGGS, inte att ingen kan skriva rå SQL.
 *
 * Kör:        node apps/api/scripts/check-assignment-status-writers.mjs
 * Självtest:  node apps/api/scripts/check-assignment-status-writers.mjs --self-test
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { blankComments, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const ROT = resolve(new URL('../../..', import.meta.url).pathname)
const KORPUS = 'apps/api/src'

/** Statusarna som ännu inte får skrivas. Läses av regeln OCH av självtestet. */
export const FÖRBJUDNA = ['EXECUTED', 'FAILED', 'LAPSED']

/** Prisma-metoder som SKRIVER. `findMany` m.fl. får nämna statusarna fritt. */
const SKRIVMETODER = ['create', 'createMany', 'update', 'updateMany', 'upsert']

function filer(dir) {
  const ut = []
  for (const namn of readdirSync(dir)) {
    const p = join(dir, namn)
    if (statSync(p).isDirectory()) {
      ut.push(...filer(p))
      continue
    }
    if (!namn.endsWith('.ts')) continue
    // SPECAR ÄR UNDANTAGNA MED FLIT: proven för utföraren skriver statusarna för
    // att kunna pröva dem, och det är hela poängen med att de finns i enumen.
    if (/\.spec\.ts$/.test(namn) || /\.db\.spec\.ts$/.test(namn)) continue
    ut.push(p)
  }
  return ut
}

/**
 * Hittar `status: '<förbjuden>'` inuti ett `aiAssignment.<skrivmetod>(`-anrop.
 *
 * Fönstret avgränsas av anropets EGEN parentesbalans — inte av en delsträng.
 * En avgränsare som är innehållslig (t.ex. "leta till nästa `status:`") hade
 * kunnat sluta inuti det som söks; se CLAUDE.md om fönsteravgränsare.
 */
export function evaluate({ källor }) {
  const problem = []
  let prövadeAnrop = 0

  for (const { fil, text } of källor) {
    const kod = blankComments(text)
    for (const metod of SKRIVMETODER) {
      const nål = `aiAssignment.${metod}(`
      let i = kod.indexOf(nål)
      while (i !== -1) {
        const start = i + nål.length - 1
        let djup = 0
        let j = start
        for (; j < kod.length; j++) {
          const c = kod[j]
          if (c === '(') djup++
          else if (c === ')') {
            djup--
            if (djup === 0) break
          }
        }
        const kropp = kod.slice(start, j + 1)
        prövadeAnrop++
        for (const s of FÖRBJUDNA) {
          const m = new RegExp(`status\\s*:\\s*['"\`]${s}['"\`]`).exec(kropp)
          if (m) {
            const rad = kod.slice(0, start + m.index).split('\n').length
            problem.push({ regel: 'R1', fil, rad, status: s })
          }
        }
        i = kod.indexOf(nål, j)
      }
    }
  }
  return { problem, prövadeAnrop }
}

function läsKorpus() {
  return filer(join(ROT, KORPUS)).map((p) => ({
    fil: relative(ROT, p),
    text: readFileSync(p, 'utf8'),
  }))
}

function kör() {
  const { problem, prövadeAnrop } = evaluate({ källor: läsKorpus() })

  // OMFÅNGSKONTROLL: hittar vi inga skrivanrop alls mätte vi ingenting, och en
  // nolla betyder då "svepet tittade på fel sak" i stället för "ingen väg finns".
  if (prövadeAnrop === 0) {
    console.error('❌ NOLL aiAssignment-skrivanrop hittades — vakten mäter ingenting.')
    process.exit(1)
  }

  if (problem.length > 0) {
    console.error(`❌ ${problem.length} produktionsväg(ar) sätter en utförandestatus:\n`)
    for (const p of problem) console.error(`  ${p.fil}:${p.rad}  status: '${p.status}'`)
    console.error(
      '\nDe tre statusarna får inte uppstå i drift förrän utföraren finns. Bygger du ' +
        'utföraren: byt den här vakten mot en som KRÄVER att skrivaren finns.\n',
    )
    process.exit(1)
  }

  console.warn(
    `✅ ${prövadeAnrop} aiAssignment-skrivanrop prövade — ingen sätter ` +
      `${FÖRBJUDNA.join('/')}.`,
  )
}

function selfTest() {
  let fel = 0
  const t = (namn, ok, detalj) => {
    if (ok) console.warn(`  ✅ ${namn}${detalj ? ` — ${detalj}` : ''}`)
    else {
      fel++
      console.error(`  ❌ ${namn}${detalj ? ` — ${detalj}` : ''}`)
    }
  }

  console.warn('\nSJÄLVTEST: check-assignment-status-writers\n')

  // KANARIEFÅGEL 1 — en riktig skrivning MÅSTE hittas. Utan den här kan nollan
  // i den skarpa körningen inte skiljas från ett svep som läser fel sak.
  for (const s of FÖRBJUDNA) {
    const r = evaluate({
      källor: [
        {
          fil: 'sond.ts',
          text: `await this.prisma.aiAssignment.update({ where: { id }, data: { status: '${s}' } })`,
        },
      ],
    })
    t(`KANARIEFÅGEL: en skrivning av ${s} fälls`, r.problem.length === 1, `${r.problem.length}`)
  }

  // KANARIEFÅGEL 2 — VYN. Samma sträng i en KOMMENTAR får inte fälla, och samma
  // sträng i KOD måste fälla. Ett prov som bara visar det ena skiljer inte en
  // läsande regel från en blind.
  const iKommentar = evaluate({
    källor: [
      {
        fil: 'sond.ts',
        text: `// den dag utföraren finns skrivs status: 'EXECUTED' här\nawait this.prisma.aiAssignment.update({ where: { id }, data: { status: 'APPROVED' } })`,
      },
    ],
  })
  t('en KOMMENTAR som nämner EXECUTED fäller INTE', iKommentar.problem.length === 0)

  // KANARIEFÅGEL 3 — VYVALET. `codeMask` hade blankat stränginnehållet och gjort
  // regeln stum. Provet visar att den vy vakten faktiskt använder bevarar det.
  const bevarat = blankComments("const x = { status: 'EXECUTED' }").includes('EXECUTED')
  t('vyn BEVARAR stränginnehåll (blankComments, inte codeMask)', bevarat)

  // KANARIEFÅGEL 4 — LÄSNINGAR är inte skrivningar.
  const läsning = evaluate({
    källor: [
      {
        fil: 'sond.ts',
        text: `await this.prisma.aiAssignment.findMany({ where: { status: 'EXECUTED' } })`,
      },
    ],
  })
  t('en LÄSNING på EXECUTED fäller inte', läsning.problem.length === 0)

  // KANARIEFÅGEL 5 — omfånget. En tom korpus ska inte kunna se grön ut.
  const tom = evaluate({ källor: [] })
  t('en TOM korpus ger noll prövade anrop', tom.prövadeAnrop === 0)

  for (const f of kanariefåglar()) {
    fel++
    console.error(`  ❌ delad källskanner: ${f}`)
  }

  if (fel > 0) {
    console.error(`\nSJÄLVTEST: ${fel} kontroll(er) FÖLL.\n`)
    process.exit(1)
  }
  console.warn('\n✅ Självtest grönt.\n')
}

const ÄR_PROGRAM = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (ÄR_PROGRAM) {
  if (process.argv.includes('--self-test')) selfTest()
  else kör()
}
