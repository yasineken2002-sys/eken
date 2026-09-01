#!/usr/bin/env node
/**
 * CI-guard (T5 / FAR-uppföljning) — skyddar SANNINGSKÄLLAN för
 * PlatformInvoice.invoiceNumber.
 *
 * Plattforms-fakturanumret allokeras race-säkert via den delade
 * `allocatePlatformInvoiceNumber(tx, ...)` (atomär increment-UPSERT mot
 * PlatformInvoiceNumberSequence, i samma transaktion som fakturan skapas). Om en
 * framtida kodväg skapar en PlatformInvoice med ett invoiceNumber UTAN att gå via
 * den funktionen återuppstår racet som denna fix eliminerade: två fakturor kan få
 * samma nummer, eller en legitim skrivare kraschar på P2002. (Exakt det FAR
 * fångade: buyCredits() hade en egen count()+1-numrering vid sidan av.)
 *
 * Guarden matchar HOTET, inte en exakt sträng — den fångar alla sätt att lägga ett
 * värde i PlatformInvoice.invoiceNumber:
 *   • row-skapande mutatorer  platformInvoice.create / createMany / upsert
 *       → MÅSTE föregås av allocatePlatformInvoiceNumber( (annars: hand-rullat nr).
 *   • omnumrerande updates     platformInvoice.update / updateMany som sätter
 *       invoiceNumber: i sin data → förbjudet (numret ska aldrig skrivas om).
 *   • rå SQL                    INSERT INTO "PlatformInvoice" / $executeRaw m.fl.
 *       som rör PlatformInvoice → kringgår sekvensen, kan ej verifieras statiskt.
 *
 * Falsklarm undviks: läsningar (row.invoiceNumber, map(), mejl/OCR-mallar) rör
 * inga mutatorer; PlatformInvoiceNumberSequence-upserten i allokeringsfunktionen
 * är en ANNAN modell (\bplatformInvoice\. matchar inte ...NumberSequence.); och
 * *.spec.ts undantas (tester simulerar medvetet).
 *
 * ── TVÅ MASKER, INTE RÅTEXT ─────────────────────────────────────────────────
 *
 * Guarden gick tidigare på råtexten. Två defekter följde av det, båda av den
 * familj som gjorde check-transaction-limits blind:
 *
 *   • `before.includes('allocatePlatformInvoiceNumber(')` kunde uppfyllas av en
 *     KOMMENTAR. En refaktorering som tar bort allokeringen men behåller raden
 *     som förklarar den hade släppts igenom — regeln frågade prosa.
 *   • `sliceCall` räknar parenteser. Ett `')'` i en stränglitteral stänger
 *     anropet för tidigt, och `invoiceNumber:` efter den punkten försvinner ur
 *     `call`.
 *
 * Därför två masker ur scripts/lib/source-scan.mjs, med olika semantik:
 *
 *   kod            = codeMask(text)       kommentarer OCH stränginnehåll blankade
 *                                         → regel (1) och (2): anrop, parenteser,
 *                                           `invoiceNumber:` som KOD.
 *   utanKommentarer = blankComments(text) kommentarer blankade, STRÄNGAR KVAR
 *                                         → regel (3): rå SQL BOR i en sträng.
 *                                           codeMask hade blankat bort hela
 *                                           regeln — den hade sett modern ut och
 *                                           mätt ingenting.
 *
 * Båda bevarar längd och radbrytningar, så radnumren pekar på råfilen.
 *
 * Rent statiskt (fs-only, inga beroenden, ingen DB) → eget CI-steg utan databas.
 * Lokalt:      node apps/api/scripts/check-platform-invoice-number-source.mjs
 * Självtest:   node apps/api/scripts/check-platform-invoice-number-source.mjs --self-test
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeMask, blankComments, kanariefåglar, KANARIEFÅGEL_LÄGEN } from '../../../scripts/lib/source-scan.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = join(HERE, '..', 'src')

const ALLOCATOR = 'allocatePlatformInvoiceNumber'
// Hur långt före en create/createMany/upsert vi kräver att allokeraren syns
// (samma tx/funktionsblock). Båda legitima skrivarna har den 1 rad före.
const PRECEDING_WINDOW = 1200 // tecken

// ── balanserad () -extraktion från metod-anropets inledande parentes ─────────
//
// Körs ENBART mot codeMask-utdata. Där är stränginnehåll blankat men
// avgränsarna kvar, så en parentes i en literal kan inte längre stänga anropet.
// Att räkna parenteser i en maskerad källa är det codeMask finns till för; att
// göra det i råtext är att skriva sin egen förbehandlare.
function sliceCall(text, openParenIdx) {
  let depth = 0
  for (let i = openParenIdx; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return text.slice(openParenIdx, i + 1)
    }
  }
  return text.slice(openParenIdx) // obalanserat (syntaxfel) — ta resten
}

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length

/**
 * Skanna EN källfils text → lista med regelbrott. Exporterad logik så självtestet
 * kör exakt samma kod som CI.
 */
export function scanSource(text, relPath) {
  const violations = []

  // Se huvudkommentaren: två masker med olika semantik, båda positionsbevarande.
  const kod = codeMask(text)
  const utanKommentarer = blankComments(text)

  // (1) + (2) mutatorer på platformInvoice-modellen (ej ...NumberSequence).
  const mutatorRe = /\bplatformInvoice\s*\.\s*(create|createMany|upsert|update|updateMany)\s*\(/g
  let m
  while ((m = mutatorRe.exec(kod))) {
    const method = m[1]
    const openParen = kod.indexOf('(', m.index + m[0].length - 1)
    const call = sliceCall(kod, openParen)
    const line = lineOf(kod, m.index)

    if (method === 'create' || method === 'createMany' || method === 'upsert') {
      // invoiceNumber är obligatoriskt (NOT NULL, ingen default) → varje
      // radskapande MÅSTE numrera. Kräv allokeraren i föregående fönster —
      // i KOD, så att raden som bara FÖRKLARAR allokeringen inte räcker.
      const before = kod.slice(Math.max(0, m.index - PRECEDING_WINDOW), m.index)
      if (!before.includes(`${ALLOCATOR}(`)) {
        violations.push({
          line,
          rule: `platformInvoice.${method}() utan föregående ${ALLOCATOR}(...)`,
          detail: 'Ett radskapande MÅSTE hämta invoiceNumber från den delade sekvensen.',
        })
      }
    } else {
      // update/updateMany får ALDRIG sätta invoiceNumber (omnumrering).
      if (/\binvoiceNumber\s*:/.test(call)) {
        violations.push({
          line,
          rule: `platformInvoice.${method}() sätter invoiceNumber:`,
          detail: 'Numret sätts en gång vid skapande via sekvensen och skrivs aldrig om.',
        })
      }
    }
  }

  // (3) rå SQL mot PlatformInvoice (kringgår Prisma + sekvensen helt).
  //
  // MÅSTE läsa strängar: `INSERT INTO "PlatformInvoice"` står per definition i
  // en literal. Därför blankComments och inte codeMask — men kommentarerna bort,
  // så ett exempel i prosa inte fäller vakten.
  utanKommentarer.split('\n').forEach((ln, i) => {
    if (/insert\s+into\s+["'`]?platforminvoice\b/i.test(ln)) {
      violations.push({
        line: i + 1,
        rule: 'rå INSERT INTO PlatformInvoice',
        detail: 'Rå insert kringgår allokeringssekvensen — numret blir icke-atomärt.',
      })
    }
    if (/\$(executeRaw|executeRawUnsafe|queryRaw|queryRawUnsafe)/.test(ln) && /platforminvoice\b/i.test(ln)) {
      violations.push({
        line: i + 1,
        rule: 'rå $executeRaw/$queryRaw mot PlatformInvoice',
        detail: 'Rå SQL kan ej verifieras statiskt — gå via allocatePlatformInvoiceNumber i en $transaction.',
      })
    }
  })

  return violations.map((v) => ({ ...v, file: relPath }))
}

// ── fil-traversering ─────────────────────────────────────────────────────────
function* walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) yield* walk(p)
    else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.spec.ts')) yield p
  }
}

// ── självtest ────────────────────────────────────────────────────────────────
const GOOD = [
  ['create via allokerare', `const invoiceNumber = await allocatePlatformInvoiceNumber(tx, 'AI_CREDITS')\nreturn tx.platformInvoice.create({ data: { invoiceNumber, amount } })`],
  ['sekvens-upsert (annan modell)', `const row = await tx.platformInvoiceNumberSequence.upsert({ where: { scope }, update: { lastNumber: { increment: 1 } } })`],
  ['läsning av invoiceNumber', `const n = row.invoiceNumber\nconst ocr = generatePlatformOcr(inv.invoiceNumber)`],
  ['update utan invoiceNumber', `await this.prisma.platformInvoice.update({ where: { id }, data: { status: 'PAID', paidAt } })`],
  ['map-retur (läsning)', `return { invoiceNumber: row.invoiceNumber, amount: row.amount }`],
]
// Mask-specifika prov. Var och en är RÖD i den gamla råtextversionen eller
// GRÖN där den inte skulle vara — de mäter migreringen, inte bara regeln.
const MASK_GOOD = [
  [
    'allokerare + `)` i en stränglitteral inuti anropet',
    `const invoiceNumber = await allocatePlatformInvoiceNumber(tx, 'AI_CREDITS')\n` +
      `return tx.platformInvoice.create({ data: { label: 'krediter (paket)', invoiceNumber, amount } })`,
  ],
  [
    'rå INSERT som står i en KOMMENTAR (prosa är inte kod)',
    `// historiskt gjorde vi: INSERT INTO "PlatformInvoice" (invoiceNumber) VALUES ($1)\n` +
      `const n = row.invoiceNumber`,
  ],
  [
    'update vars invoiceNumber: står i en STRÄNG, inte i data',
    `await this.prisma.platformInvoice.update({ where: { id }, data: { note: 'sätt invoiceNumber: manuellt' } })`,
  ],
]
const BAD = [
  ['create utan allokerare', `return this.prisma.platformInvoice.create({ data: { invoiceNumber: 'CR-202607-0001', amount } })`],
  ['createMany utan allokerare', `await this.prisma.platformInvoice.createMany({ data: [{ invoiceNumber: 'X-1' }] })`],
  ['upsert utan allokerare', `await this.prisma.platformInvoice.upsert({ where: { id }, create: { invoiceNumber: 'X-1' }, update: {} })`],
  ['update som omnumrerar', `await this.prisma.platformInvoice.update({ where: { id }, data: { invoiceNumber: 'X-2' } })`],
  ['rå INSERT', `await this.prisma.$executeRawUnsafe('INSERT INTO "PlatformInvoice" (invoiceNumber) VALUES ($1)', n)`],
  // ── de tre som RÅTEXTVERSIONEN missade ────────────────────────────────────
  [
    'allokeraren nämns bara i en KOMMENTAR före create()',
    `// numret kommer från allocatePlatformInvoiceNumber(tx, type) i anroparen\n` +
      `return tx.platformInvoice.create({ data: { invoiceNumber: n, amount } })`,
  ],
  [
    'omnumrering efter en sträng som innehåller `)`',
    `await this.prisma.platformInvoice.update({ where: { id }, data: { label: 'x) y', invoiceNumber: 'X-2' } })`,
  ],
  [
    'rå INSERT efter en regex-literal med citattecken',
    `const esc = s.replace(/"/g, '&quot;')\n` +
      `await this.prisma.$executeRawUnsafe('INSERT INTO "PlatformInvoice" (invoiceNumber) VALUES ($1)', n)`,
  ],
]

// ── OMFÅNGSKANARIEFÅGEL ─────────────────────────────────────────────────────
//
// Lärdomen av R5: regeln kan fungera medan mängden den prövas mot är tom. Den
// här vakten har TVÅ mängder som kan krympa tyst — filerna som `walk` hittar,
// och de anropsställen reglerna alls har att säga något om. Blir någon av dem
// noll är vakten grön för alltid, och ser precis lika grön ut som idag.
//
// Golven är MÄTTA mot e9aea18: 447 filer, 9 mutatoranrop, 3 allokeraranrop.
// De ligger med marginal under, så normal utveckling inte fäller dem — men
// långt över noll, vilket är det enda tal som betyder "mäter ingenting".
const MIN_FILER = 300
const MIN_MUTATORER = 4
const MIN_ALLOKERARE = 2

function omfångskanariefågel() {
  const fel = []
  let filer = 0
  let mutatorer = 0
  let allokerare = 0
  for (const f of walk(SRC_DIR)) {
    filer++
    const kod = codeMask(readFileSync(f, 'utf8'))
    mutatorer += (
      kod.match(/\bplatformInvoice\s*\.\s*(create|createMany|upsert|update|updateMany)\s*\(/g) ?? []
    ).length
    allokerare += (kod.match(new RegExp(`\\b${ALLOCATOR}\\(`, 'g')) ?? []).length
  }
  if (filer < MIN_FILER) fel.push(`omfång: ${filer} filer skannade, golv ${MIN_FILER}`)
  if (mutatorer < MIN_MUTATORER)
    fel.push(`omfång: ${mutatorer} platformInvoice-mutatoranrop i KOD, golv ${MIN_MUTATORER}`)
  if (allokerare < MIN_ALLOKERARE)
    fel.push(`omfång: ${allokerare} ${ALLOCATOR}-anrop i KOD, golv ${MIN_ALLOKERARE}`)
  return { fel, mätt: { filer, mutatorer, allokerare } }
}

function selfTest() {
  let ok = true

  // (0) DEN DELADE SKANNERNS KANARIEFÅGLAR. Går source-scan.mjs sönder ska DEN
  // HÄR vakten bli röd — inte tyst fortsätta mäta fel. Kravet metavakten (R2)
  // ställer på varje konsument.
  const skanner = kanariefåglar()
  if (skanner.length) {
    ok = false
    console.error(`❌ DEN DELADE SKANNERN ÄR TRASIG:\n   ${skanner.join('\n   ')}`)
  } else console.log(`✅ delad skanner: kanariefåglarna gröna över ${KANARIEFÅGEL_LÄGEN.length} lägen`)

  for (const [label, code] of [...GOOD, ...MASK_GOOD]) {
    const v = scanSource(code, `good:${label}`)
    if (v.length !== 0) {
      ok = false
      console.error(`❌ FALSKLARM på legitim kod: "${label}" → ${v.map((x) => x.rule).join(', ')}`)
    } else console.log(`✅ inget falsklarm: ${label}`)
  }
  for (const [label, code] of BAD) {
    const v = scanSource(code, `bad:${label}`)
    if (v.length === 0) {
      ok = false
      console.error(`❌ MISSADE kringgång: "${label}" flaggades inte`)
    } else console.log(`✅ fångad kringgång: ${label} (${v[0].rule})`)
  }
  // (N) OMFÅNGET. Sist, för att talen ska stå i utskriften.
  const omf = omfångskanariefågel()
  if (omf.fel.length) {
    ok = false
    console.error(`❌ OMFÅNGET HAR KRYMPT:\n   ${omf.fel.join('\n   ')}`)
  } else {
    console.log(
      `✅ omfång: ${omf.mätt.filer} filer (golv ${MIN_FILER}), ` +
        `${omf.mätt.mutatorer} mutatoranrop (golv ${MIN_MUTATORER}), ` +
        `${omf.mätt.allokerare} allokeraranrop (golv ${MIN_ALLOKERARE})`,
    )
  }

  console.log(ok ? '\n✅ Självtest OK.' : '\n❌ Självtest misslyckades.')
  process.exit(ok ? 0 : 1)
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  if (process.argv.includes('--self-test')) return selfTest()

  const failures = []
  for (const file of walk(SRC_DIR)) {
    failures.push(...scanSource(readFileSync(file, 'utf8'), relative(join(HERE, '..', '..', '..'), file)))
  }

  if (failures.length > 0) {
    console.error('\n=== PLATTFORMS-FAKTURANUMMER: SANNINGSKÄLLA KRINGGÅNGEN (CI-guard) ===\n')
    for (const f of failures) {
      console.error(`❌ ${f.file}:${f.line}\n   ${f.rule}\n   ${f.detail}`)
    }
    console.error(
      `\nÅtgärd: allokera numret via ${ALLOCATOR}(tx, type) inuti samma\n` +
        'this.prisma.$transaction() som platformInvoice.create() — se\n' +
        'PlatformInvoicesService.create() eller AiUsagePageService.buyCredits().\n' +
        'PlatformInvoiceNumberSequence ska vara ENDA källan till invoiceNumber.\n',
    )
    process.exit(1)
  }

  console.log('✅ PlatformInvoice.invoiceNumber allokeras uteslutande via', `${ALLOCATOR}(). Inga kringgångar.`)
}

main()
