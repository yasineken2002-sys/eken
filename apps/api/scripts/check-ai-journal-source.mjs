#!/usr/bin/env node
/**
 * CI-vakt — AI-verifikatens idempotensnyckel, och det ärliga svaret när en
 * bekräftelse är förbrukad.
 *
 * ── DEFEKT A: SPÄRREN FANNS, AI-VÄGEN FÖLL UTANFÖR ──────────────────────────
 *
 * `JournalEntry` bär `@@unique([organizationId, source, sourceId])`. Den är i
 * drift och den fäller. Mätt mot riktig PG 18.6:
 *
 *     source='INVOICE', sourceId='inv-1'  → andra insert AVVISAD
 *     source='AI',      sourceId=NULL     → 3 identiska verifikat TILLÅTNA
 *
 * Postgres behandlar NULL som distinkt, så ett index med en nullbar kolumn
 * spärrar ingenting för de rader som lämnar kolumnen tom. De två AI-verktyg som
 * skriver verifikat gjorde precis det.
 *
 * R1 kräver därför att VARJE `journalEntry.create` sätter `sourceId`. Regeln är
 * på FORMEN, inte en uppräkning av kända skrivare: en fjärde skrivväg ärver
 * kravet utan att någon lägger till den i en lista.
 *
 * R2 kräver dessutom att en AI-skriven post får sin nyckel ur
 * `aiJournalSourceId(` och inte ur en handrullad sträng — två definitioner av
 * "samma åtgärd" glider isär, och då slutar nyckeln vara idempotent utan att
 * något blir rött.
 *
 * ── DEFEKT B: "KONSUMERAT" ÄR INTE "UTFÖRT" ─────────────────────────────────
 *
 * `consumePendingAction` committar anspråket, `executeTool` körs som ett separat
 * steg efteråt. Kraschar processen emellan är anspråket förbrukat utan att något
 * utfördes — och svaret sa ändå "Åtgärden är redan utförd". Mätt:
 *
 *     anspråk committat → krasch → nytt försök
 *       → 'already-consumed', AiToolExecution 0 rader, JournalEntry 0 rader
 *
 * R3 kräver att grenen frågar efter en körning INNAN den påstår att åtgärden
 * utfördes, och att det finns en utgång som INTE gör det påståendet.
 *
 * ── VARFÖR DEN LÄSER VIA DEN DELADE SKANNERN ────────────────────────────────
 *
 * En vakt i det här repot mättes grön av en KOMMENTAR som nämnde det identifier
 * den letade efter (`check-transaction-limits`, isolerat till en variabel). Den
 * här läser `withoutComments(...)` från `scripts/lib/source-scan.mjs` — samma
 * skanner som `check-guard-preprocessors` kräver — så prosa aldrig kan uppfylla
 * en regel.
 *
 * Självtest (kanariefåglar):
 *     node apps/api/scripts/check-ai-journal-source.mjs --self-test
 */
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withoutComments, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')
const ROT = join(HERE, '..', '..', '..')

const SKAPARE = /\bjournalEntry\s*\.\s*(create|createMany|upsert)\s*\(/g
const NYCKELFUNKTION = 'aiJournalSourceId('
const CONFIRM_FIL = 'src/ai/ai-assistant.service.ts'

/** Index för den parentes/klammer som stänger den som öppnas på `start`. */
function matchaSlut(text, start, öppna, stäng) {
  let djup = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === öppna) djup++
    else if (text[i] === stäng) {
      djup--
      if (djup === 0) return i
    }
  }
  return -1
}

const radAv = (text, idx) => text.slice(0, idx).split('\n').length

/**
 * R1 + R2 på EN fils kodtext (kommentarer redan bortplockade).
 * Exporterad så självtestet kör exakt samma kod som CI.
 */
export function scanSkapare(kod, relPath) {
  const brott = []
  SKAPARE.lastIndex = 0
  let m
  while ((m = SKAPARE.exec(kod)) !== null) {
    const öppen = kod.indexOf('(', m.index + m[0].length - 1)
    const slut = matchaSlut(kod, öppen, '(', ')')
    const anrop = slut === -1 ? kod.slice(öppen) : kod.slice(öppen, slut + 1)
    const rad = radAv(kod, m.index)

    // R1 — nyckeln måste sättas, och inte till null.
    // Både `sourceId: x`, `sourceId,` och shorthand sist i objektet (`sourceId }`).
    // Kanariefågeln fällde den första varianten som bara kände de två första.
    const harNyckel = /\bsourceId\s*(?::|,|\})/.test(anrop)
    const nullNyckel = /\bsourceId\s*:\s*null\b/.test(anrop)
    if (!harNyckel || nullNyckel) {
      brott.push({
        rad,
        regel: 'R1',
        text: nullNyckel
          ? 'journalEntry.create sätter sourceId: null'
          : 'journalEntry.create utan sourceId',
        detalj:
          'Det unika indexet (organizationId, source, sourceId) spärrar ingenting ' +
          'när sourceId är NULL — Postgres räknar NULL som distinkt. Sätt en ' +
          'deterministisk nyckel; för AI-vägen: aiJournalSourceId().',
      })
      continue
    }

    // R2 — en AI-post ska hämta nyckeln ur den delade funktionen.
    if (/\bsource\s*:\s*'AI'/.test(anrop)) {
      // Nyckeln tilldelas ofta i en variabel strax före anropet.
      const före = kod.slice(Math.max(0, m.index - 4000), m.index)
      if (!före.includes(NYCKELFUNKTION) && !anrop.includes(NYCKELFUNKTION)) {
        brott.push({
          rad,
          regel: 'R2',
          text: "source: 'AI' med en handrullad sourceId",
          detalj:
            'Nyckeln måste komma ur aiJournalSourceId() så att den bygger på ' +
            'SAMMA kanonisering som bekräftelsens hash. Två definitioner av ' +
            '"samma åtgärd" glider isär tyst.',
        })
      }
    }
  }
  return brott.map((b) => ({ ...b, fil: relPath }))
}

/**
 * R3 på confirm-vägens kodtext.
 * Kravet är STRUKTURELLT: inne i `already-consumed`-grenen ska en fråga mot
 * `aiToolExecution` komma FÖRE påståendet om att åtgärden är utförd, och det
 * ska finnas en utgång däremellan.
 */
export function scanConfirm(kod) {
  const brott = []
  const grenIdx = kod.indexOf("consumed.status === 'already-consumed'")
  if (grenIdx === -1) {
    return [{ regel: 'R3', text: "hittar inte grenen already-consumed i confirm-vägen", detalj: 'Har den bytt namn? Vakten måste följa med.' }]
  }
  const blockStart = kod.indexOf('{', grenIdx)
  const blockSlut = matchaSlut(kod, blockStart, '{', '}')
  const gren = blockSlut === -1 ? kod.slice(blockStart) : kod.slice(blockStart, blockSlut + 1)

  const fråganIdx = gren.search(/aiToolExecution\s*\.\s*findFirst\s*\(/)
  const påståendeIdx = gren.indexOf('redan utförd')
  if (fråganIdx === -1) {
    brott.push({
      regel: 'R3',
      text: 'already-consumed påstår utförande utan att fråga efter en körning',
      detalj:
        'Anspråket committas före executeTool. Kraschar processen emellan är ' +
        'anspråket förbrukat utan att något utfördes — mätt: 0 AiToolExecution, ' +
        '0 JournalEntry. Fråga efter körningen först.',
    })
  } else if (påståendeIdx !== -1 && fråganIdx > påståendeIdx) {
    brott.push({
      regel: 'R3',
      text: 'frågan om körningen ställs EFTER påståendet om utförande',
      detalj: 'Ordningen är lastbärande — påståendet måste vara villkorat av svaret.',
    })
  }
  // Det måste finnas en utgång mellan frågan och påståendet: annars är svaret
  // detsamma oavsett vad frågan gav.
  if (fråganIdx !== -1 && påståendeIdx !== -1) {
    // Mät till SATSENS början, inte till strängen. 'redan utförd' står inuti
    // `throw new ConflictException('…redan utförd…')`, så ett fönster som
    // slutar vid strängen innehåller alltid det `throw` regeln letar efter —
    // och regeln blir alltid grön. Kanariefågeln "fråga utan utgång" fällde
    // exakt den varianten.
    const satsStart = Math.max(
      gren.lastIndexOf('throw', påståendeIdx),
      gren.lastIndexOf('return', påståendeIdx),
    )
    const emellan = gren.slice(fråganIdx, satsStart === -1 ? påståendeIdx : satsStart)
    if (!/\bthrow\b|\breturn\b/.test(emellan)) {
      brott.push({
        regel: 'R3',
        text: 'ingen egen utgång för fallet "ingen körning finns"',
        detalj:
          'Frågan ställs men svaret ändrar ingenting — grenen säger "redan ' +
          'utförd" i båda fallen. Det är defekten, inte en delvis fix.',
      })
    }
  }
  return brott.map((b) => ({ ...b, fil: CONFIRM_FIL, rad: radAv(kod, grenIdx) }))
}

function* vandra(dir) {
  for (const namn of readdirSync(dir)) {
    const p = join(dir, namn)
    if (statSync(p).isDirectory()) yield* vandra(p)
    else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) yield p
  }
}

/** Alla filer + deras kodtext. Mängden härleds ur trädet, aldrig ur en lista. */
function källor() {
  const ut = []
  for (const abs of vandra(SRC)) {
    const rel = relative(ROT, abs).replaceAll('\\', '/')
    ut.push({ abs, rel, kod: withoutComments(readFileSync(abs, 'utf8')) })
  }
  return ut
}

function kör() {
  const filer = källor()
  const brott = []
  let skapare = 0

  for (const f of filer) {
    SKAPARE.lastIndex = 0
    skapare += (f.kod.match(SKAPARE) ?? []).length
    brott.push(...scanSkapare(f.kod, f.rel))
  }

  const confirm = filer.find((f) => f.rel.endsWith(CONFIRM_FIL))
  if (!confirm) {
    brott.push({ regel: 'R3', fil: CONFIRM_FIL, rad: 0, text: 'filen hittades inte', detalj: 'Har den flyttat? Vakten måste följa med.' })
  } else {
    brott.push(...scanConfirm(confirm.kod))
  }

  // FÖRUTSÄTTNINGSVAKT. Hittar vakten noll skrivare har den slutat mäta —
  // ett tomt svep ser ut precis som ett rent svep.
  if (skapare === 0) {
    console.error('❌ Vakten hittade NOLL journalEntry-skrivare. Den mäter inget längre.')
    process.exit(1)
  }

  if (brott.length > 0) {
    console.error('❌ AI-verifikatens idempotensnyckel / confirm-svarets sanning\n')
    for (const b of brott) {
      console.error(`  ${b.regel} ${b.fil}:${b.rad} — ${b.text}`)
      console.error(`     ${b.detalj}\n`)
    }
    process.exit(1)
  }
  console.error(`✅ ${skapare} journalEntry-skrivare, alla med deterministisk sourceId; confirm-vägen skiljer "utfört" från "kan inte bekräftas".`)
}

function självtest() {
  const fel = []
  const t = (namn, villkor, detalj) => { if (!villkor) fel.push(`${namn}${detalj ? ` — ${detalj}` : ''}`) }

  // ── KANARIEFÅGLAR MOT ETT TAL SOM HÄRLEDS UR KÄLLAN ────────────────────────
  //
  // "fler än noll" mäter ingenting. Antalet skrivare räknas här med en
  // OBEROENDE metod (rå textsökning i filerna) och jämförs med vad vaktens
  // egen svepning ser. Skiljer de sig har en av dem slutat läsa.
  const filer = källor()
  let vaktensAntal = 0
  for (const f of filer) {
    SKAPARE.lastIndex = 0
    vaktensAntal += (f.kod.match(SKAPARE) ?? []).length
  }
  let råttAntal = 0
  for (const abs of vandra(SRC)) {
    const rå = readFileSync(abs, 'utf8')
    råttAntal += (rå.match(/\bjournalEntry\s*\.\s*(create|createMany|upsert)\s*\(/g) ?? []).length
  }
  t('KANARIE 0 (vakten ser lika många skrivare som en rå sökning)',
    vaktensAntal === råttAntal,
    `vakten ${vaktensAntal}, rå sökning ${råttAntal}`)
  t('KANARIE 0 (antalet är inte noll)', vaktensAntal > 0, 'svepningen hittar inga skrivare alls')

  // R1 — utan sourceId ska ge EXAKT ett brott, med ska ge EXAKT noll.
  const utan = `await tx.journalEntry.create({ data: { organizationId, source: 'AI', date } })`
  const med = `const sourceId = aiJournalSourceId('x', i)\nawait tx.journalEntry.create({ data: { organizationId, source: 'AI', sourceId, date } })`
  t('KANARIE R1 (utan sourceId → exakt 1 brott)', scanSkapare(utan, 'p.ts').length === 1,
    `${scanSkapare(utan, 'p.ts').length} brott`)
  t('KANARIE R1 (med sourceId → exakt 0 brott)', scanSkapare(med, 'p.ts').length === 0,
    JSON.stringify(scanSkapare(med, 'p.ts')))
  const nullad = `await tx.journalEntry.create({ data: { organizationId, source: 'AI', sourceId: null } })`
  t('KANARIE R1 (sourceId: null → exakt 1 brott)', scanSkapare(nullad, 'p.ts').length === 1)

  // R2 — handrullad AI-nyckel ska fällas.
  const handrullad = `const sourceId = \`ai:\${id}\`\nawait tx.journalEntry.create({ data: { organizationId, source: 'AI', sourceId } })`
  const r2 = scanSkapare(handrullad, 'p.ts')
  t('KANARIE R2 (handrullad AI-nyckel → exakt 1 brott)', r2.length === 1 && r2[0].regel === 'R2',
    JSON.stringify(r2))

  // R3 — de tre lägena.
  const r3Ok = `if (consumed.status === 'already-consumed') {
    const k = await this.prisma.aiToolExecution.findFirst({ where: {} })
    if (!k) { throw new ConflictException('kan inte bekräftas') }
    throw new ConflictException('Åtgärden är redan utförd.')
  }`
  const r3UtanFråga = `if (consumed.status === 'already-consumed') {
    throw new ConflictException('Åtgärden är redan utförd.')
  }`
  const r3UtanUtgång = `if (consumed.status === 'already-consumed') {
    const k = await this.prisma.aiToolExecution.findFirst({ where: {} })
    throw new ConflictException('Åtgärden är redan utförd.')
  }`
  t('KANARIE R3 (rätt form → 0 brott)', scanConfirm(r3Ok).length === 0, JSON.stringify(scanConfirm(r3Ok)))
  t('KANARIE R3 (ingen fråga → 1 brott)', scanConfirm(r3UtanFråga).length === 1, JSON.stringify(scanConfirm(r3UtanFråga)))
  t('KANARIE R3 (fråga utan utgång → 1 brott)', scanConfirm(r3UtanUtgång).length === 1, JSON.stringify(scanConfirm(r3UtanUtgång)))

  // KOMMENTARER FÅR INTE UPPFYLLA EN REGEL. Defekten i check-transaction-limits.
  const baraKommentar = withoutComments(
    `// aiJournalSourceId( och sourceId: nämns bara i prosa här\nawait tx.journalEntry.create({ data: { source: 'AI' } })`,
  )
  t('KANARIE (kommentar uppfyller INTE R1)', scanSkapare(baraKommentar, 'p.ts').length === 1,
    'en kommentar som nämner sourceId gjorde vakten grön — samma defekt som check-transaction-limits')

  // Den DELADE skannerns egna kanariefåglar.
  for (const f of kanariefåglar()) fel.push(`delad skanner: ${f}`)

  if (fel.length) {
    console.error('❌ Självtestet föll:')
    for (const f of fel) console.error(`   • ${f}`)
    process.exit(1)
  }
  console.error(`✅ Självtest grönt (${vaktensAntal} skrivare sedda, lika många som en rå sökning).`)
}

if (process.argv.includes('--self-test')) självtest()
else kör()
