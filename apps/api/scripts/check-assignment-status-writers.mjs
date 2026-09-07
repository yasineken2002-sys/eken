#!/usr/bin/env node
/**
 * CI-VAKT — DE TRE UTFÖRANDESTATUSARNA HAR EXAKT EN SKRIVARE.
 *
 * ── VAKTEN HAR VÄNT, OCH DET VAR MENINGEN ───────────────────────────────────
 *
 * Fram till etapp 9 krävde den här filen NOLL skrivare. `AiAssignmentStatus`
 * fick `EXECUTED`, `FAILED` och `LAPSED` i etapp 8, innan skrivaren byggdes, och
 * undantaget godtogs på ETT villkor: att statusarna bevisligen inte kunde uppstå
 * i drift. Vakten var det beviset.
 *
 * Dess egen felutskrift sa vad som skulle hända sedan: *"Bygger du utföraren:
 * byt den här vakten mot en som KRÄVER att skrivaren finns."* Det är den här
 * versionen. Att den MÅSTE röras när utföraren byggs var själva poängen — en
 * vakt som hade fortsatt vara grön efter etapp 9 hade inte mätt något.
 *
 * ── REGELN, NU I TVÅ HALVOR ─────────────────────────────────────────────────
 *
 * R1  Statusarna får skrivas i EXAKT EN produktionsfil, och det är
 *     `SKRIVARE`. En andra skrivare är det som ska fällas: två vägar som sätter
 *     samma terminalstatus är två uppfattningar om när ett uppdrag är klart.
 * R2  Den filen MÅSTE skriva alla tre. Utan den halvan hade en refaktorering
 *     som tappade `LAPSED` — den som bara uppstår när en delegation försvinner
 *     mellan dom och effekt — lämnat vakten grön och statusen död.
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

/** De tre utförandestatusarna. Läses av regeln OCH av självtestet. */
export const UTFÖRANDESTATUSAR = ['EXECUTED', 'FAILED', 'LAPSED']

/**
 * Den ENDA fil som får sätta dem.
 *
 * En sökväg och inte ett klassnamn: regeln handlar om var koden BOR, och en
 * omdöpt klass i samma fil är inte en ny skrivare. Flyttas filen ska raden
 * ändras i samma PR — och att den måste ändras är avsikten, inte en olägenhet.
 */
export const SKRIVARE = 'apps/api/src/ai/execution/agent-execution.service.ts'

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
export function evaluate({ källor, skrivare = SKRIVARE }) {
  const problem = []
  const hittade = new Set()
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
        for (const s of UTFÖRANDESTATUSAR) {
          const m = new RegExp(`status\\s*:\\s*['"\`]${s}['"\`]`).exec(kropp)
          if (m) {
            const rad = kod.slice(0, start + m.index).split('\n').length
            if (fil === skrivare) hittade.add(s)
            else problem.push({ regel: 'R1', fil, rad, status: s })
          }
        }
        i = kod.indexOf(nål, j)
      }
    }
  }
  // R2: SKRIVAREN MÅSTE SKRIVA ALLA TRE. En saknad status är en gren som tappats
  // — och `LAPSED` är den mest tappbara, eftersom den bara uppstår när en
  // delegation försvinner mellan domen och effekten.
  const saknade = UTFÖRANDESTATUSAR.filter((s) => !hittade.has(s))
  for (const s of saknade) problem.push({ regel: 'R2', fil: skrivare, rad: 0, status: s })

  return { problem, prövadeAnrop, hittade: [...hittade].sort() }
}

function läsKorpus() {
  return filer(join(ROT, KORPUS)).map((p) => ({
    fil: relative(ROT, p),
    text: readFileSync(p, 'utf8'),
  }))
}

function kör() {
  const { problem, prövadeAnrop, hittade } = evaluate({ källor: läsKorpus() })

  // OMFÅNGSKONTROLL: hittar vi inga skrivanrop alls mätte vi ingenting, och en
  // nolla betyder då "svepet tittade på fel sak" i stället för "ingen väg finns".
  if (prövadeAnrop === 0) {
    console.error('❌ NOLL aiAssignment-skrivanrop hittades — vakten mäter ingenting.')
    process.exit(1)
  }

  if (problem.length > 0) {
    const r1 = problem.filter((p) => p.regel === 'R1')
    const r2 = problem.filter((p) => p.regel === 'R2')
    if (r1.length > 0) {
      console.error(`❌ ${r1.length} produktionsväg(ar) UTANFÖR skrivaren sätter en status:\n`)
      for (const p of r1) console.error(`  ${p.fil}:${p.rad}  status: '${p.status}'`)
      console.error(
        `\nDe tre utförandestatusarna får sättas på EXAKT ETT ställe: ${SKRIVARE}.\n` +
          'Två vägar som sätter samma terminalstatus är två uppfattningar om när ett\n' +
          'uppdrag är klart, och de glider isär utan att något blir rött.\n',
      )
    }
    if (r2.length > 0) {
      console.error(`❌ Skrivaren sätter INTE ${r2.map((p) => p.status).join('/')}.\n`)
      console.error(
        `Alla tre måste sättas i ${SKRIVARE}. En status utan skrivare är död kod som\n` +
          'ser ut som täckning — och `LAPSED` är den mest tappbara, eftersom den bara\n' +
          'uppstår när en delegation försvinner mellan domen och effekten.\n',
      )
    }
    process.exit(1)
  }

  console.warn(
    `✅ ${prövadeAnrop} aiAssignment-skrivanrop prövade — ${hittade.join('/')} sätts ` +
      `av exakt en fil (${SKRIVARE}).`,
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

  /** En korpus där SKRIVAREN sätter alla tre — utgångsläget för proven nedan. */
  const skrivarkälla = (fil = SKRIVARE) => ({
    fil,
    text: UTFÖRANDESTATUSAR.map(
      (s) => `await this.prisma.aiAssignment.update({ where: { id }, data: { status: '${s}' } })`,
    ).join('\n'),
  })

  // KANARIEFÅGEL 1 — en riktig skrivning MÅSTE hittas. Utan den här kan
  // resultatet i den skarpa körningen inte skiljas från ett svep som läser fel
  // sak.
  for (const s of UTFÖRANDESTATUSAR) {
    const r = evaluate({
      källor: [
        skrivarkälla(),
        {
          fil: 'sond.ts',
          text: `await this.prisma.aiAssignment.update({ where: { id }, data: { status: '${s}' } })`,
        },
      ],
    })
    const r1 = r.problem.filter((p) => p.regel === 'R1')
    t(`KANARIEFÅGEL R1: en ANDRA skrivare av ${s} fälls`, r1.length === 1, `${r1.length}`)
  }

  // KANARIEFÅGEL R1b — SKRIVAREN SJÄLV fäller INTE. Utan den här hade regeln
  // kunnat vara "ingen får skriva" och sett likadan ut i utfallet ovan.
  const baraSkrivaren = evaluate({ källor: [skrivarkälla()] })
  t(
    'skrivaren själv fäller INTE',
    baraSkrivaren.problem.length === 0,
    `${baraSkrivaren.problem.length} problem, hittade ${baraSkrivaren.hittade.join('/')}`,
  )

  // KANARIEFÅGEL R2 — EN TAPPAD STATUS FÄLLS. Det här är halvan som gör att
  // vakten inte kan bli grön av att skrivaren krymper: tar någon bort `LAPSED`
  // ska det bli rött, inte tyst.
  for (const tappad of UTFÖRANDESTATUSAR) {
    const kvar = UTFÖRANDESTATUSAR.filter((x) => x !== tappad)
    const r = evaluate({
      källor: [
        {
          fil: SKRIVARE,
          text: kvar
            .map(
              (x) =>
                `await this.prisma.aiAssignment.update({ where: { id }, data: { status: '${x}' } })`,
            )
            .join('\n'),
        },
      ],
    })
    const r2 = r.problem.filter((p) => p.regel === 'R2')
    t(
      `KANARIEFÅGEL R2: en skrivare UTAN ${tappad} fälls`,
      r2.length === 1 && r2[0].status === tappad,
      `${r2.length}`,
    )
  }

  // KANARIEFÅGEL 2 — VYN. Samma sträng i en KOMMENTAR får inte fälla, och samma
  // sträng i KOD måste fälla. Ett prov som bara visar det ena skiljer inte en
  // läsande regel från en blind.
  const iKommentar = evaluate({
    källor: [
      skrivarkälla(),
      {
        fil: 'sond.ts',
        text: `// här skrivs status: 'EXECUTED' av utföraren\nawait this.prisma.aiAssignment.update({ where: { id }, data: { status: 'APPROVED' } })`,
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
      skrivarkälla(),
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
  // …och den fäller dessutom på R2, vilket är rätt: en korpus utan skrivare är
  // exakt det tillstånd vakten numera finns för att förbjuda.
  t('en TOM korpus fäller R2 (skrivaren saknas)', tom.problem.length === 3)

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
