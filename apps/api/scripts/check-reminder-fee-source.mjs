#!/usr/bin/env node
/**
 * CI-guard (G2 + G3) — skyddar BELOPPET på påminnelseavgiften.
 *
 * Två regler avgör vad som får krävas, och båda bor i `resolveReminderFee`
 * (apps/api/src/accounting/reminder-fee.ts):
 *
 *   AVTALSGRUND  — avgift får inte debiteras utan avtalsvillkor, och villkoret
 *                  binder bara framåt (2 § lagen 1981:739). Regeln själv bor i
 *                  `isReminderFeeContractuallyAllowed`.
 *   TAKET        — beloppet är lagstadgat och tvingande, också mot
 *                  näringsidkare (4 § och 6 § 1 st). Talet bor i
 *                  `REMINDER_FEE_MAX_SEK`.
 *
 * ── VARFÖR TYPSYSTEMET INTE RÄCKER ──────────────────────────────────────────
 *
 * `bookReminderFee` kräver `debtOrigin: DebtOriginDate | null` och `termsFrom`,
 * så BOKFÖRINGSSIDAN är skyddad av kompilatorn: en anropare som glömmer dem
 * kompilerar inte. Den klampar dessutom mot taket.
 *
 * Men avgiften skrivs på FLER ställen än verifikatet, och reskontran skrivs
 * FÖRST — utan att gå via `bookReminderFee`:
 *
 *   RentNotice.reminderFeeAmount   avi-vägens anspråk
 *   PaymentReminder.feeAmount      fakturavägens anspråk. Summeras rakt in i
 *                                  inkassounderlagets avgiftskolumn
 *                                  (collection-export.service.ts) — alltså ett
 *                                  krav mot hyresgästen, inte en notering.
 *   avgiftsraden på fakturan       det hyresgästen ser och ska betala
 *
 * En anropare som skriver något av dessa utan resolvern får ingen varning alls.
 * Utan avtalsgrund kräver reskontran en avgift huvudboken inte bär; utan
 * klampning kräver den ETT ANNAT BELOPP än huvudboken bokför. Båda är samma
 * divergens som #357 stängde, med omvänt tecken — den andra var mätt i en
 * bevisrigg innan resolvern fanns.
 *
 * ── VARFÖR RESOLVERN OCH INTE PREDIKATET ────────────────────────────────────
 *
 * Guarden krävde tidigare `isReminderFeeContractuallyAllowed`. Det kravet var
 * uppfyllt av en anropare som frågade om avtalsgrunden men skrev ett oklampat
 * belopp — vilket är precis vad båda anroparna gjorde. Att kräva resolvern är
 * strikt starkare: den anropar predikatet internt, så avtalsgrunden är kvar,
 * och den bär dessutom taket. En regel, ett anrop, en kontroll.
 *
 * Guarden matchar HOTET, inte en exakt sträng:
 *   • `rentNotice.create/createMany/update/updateMany/upsert` vars data sätter
 *     `reminderFeeAmount:` → MÅSTE föregås av `resolveReminderFee(`.
 *   • `paymentReminder.<samma verb>` vars data sätter `feeAmount:` → samma krav.
 *   • `invoiceLine.create/createMany` vars data bär
 *     `REMINDER_FEE_LINE_DESCRIPTION` → samma krav.
 *   • rå SQL som rör något av avgiftsfälten → kan inte verifieras statiskt.
 *
 * NOLLSTÄLLNING ÄR ALLTID TILLÅTEN. Att sätta avgiften till 0 kan aldrig
 * överdebitera någon — det är refuseringsvägen, annulleringens nollning
 * (`avisering.service.ts`) och de påminnelsetyper som aldrig bär avgift
 * (REMINDER_FRIENDLY, READY_FOR_COLLECTION). `: 0`, `new Prisma.Decimal(0)`
 * och `'0'` passerar därför utan resolver.
 *
 * ── VAD GUARDEN INTE TÄCKER ─────────────────────────────────────────────────
 *
 * Fakturans `total`-uppräkning granskas inte. Den sker med
 * `total: { increment: … }`, ett uttryck som används legitimt på flera håll, och
 * en generell regel där hade gett falsklarm utan att fånga något guarden inte
 * redan tar via avgiftsraden — uppräkningen ligger alltid i samma block som
 * raden. Skrivs total upp UTAN en avgiftsrad är det ett annat fel (total ≠ Σ
 * rader) och hör inte hemma här.
 *
 * Rent statiskt (fs-only, inga beroenden, ingen DB) → eget CI-steg utan databas.
 * Lokalt:      node apps/api/scripts/check-reminder-fee-source.mjs
 * Självtest:   node apps/api/scripts/check-reminder-fee-source.mjs --self-test
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = join(HERE, '..', 'src')

const RESOLVER = 'resolveReminderFee'
const FEE_LINE_CONST = 'REMINDER_FEE_LINE_DESCRIPTION'
// Hur långt före skrivningen resolvern måste synas (samma tx/funktionsblock).
//
// MÄTT, INTE GISSAT. Avståndet hos de tre legitima skrivarna:
//   avi-sidan        (rent-reminder.service.ts)        ~700 tecken
//   fakturamarkören  (payment-reminder.service.ts)    ~1 900 tecken
//   avgiftsraden     (payment-reminder.service.ts)    ~4 600 tecken
//
// Avgiftsradens avstånd är stort för att beloppet måste avgöras FÖRE anspråket
// medan raden skrivs EFTER det, med utförliga kommentarblock däremellan. 6000
// ger marginal utan att spänna över en typisk funktionsgräns — vid 4000 föll
// den legitima skrivaren, vilket är hur siffran hittades.
//
// ⚠️ VAD NÄRHETSKONTROLLEN INTE KAN — LÄS INNAN DU LITAR PÅ DEN.
//
// Regeln är "resolvern syns någonstans i de föregående 6000 tecknen", inte
// "resolverns svar styr just den här skrivningen". Den har därför en
// FALSK-GODKÄNN-RIKTNING: en skrivare som kringgår resolvern men råkar ligga
// inom fönstret från ett ORELATERAT resolver-anrop passerar tyst.
//
// Vakten fångar alltså FÖRBISEENDET — någon lägger till en avgiftsskrivning i
// en ny fil eller ett nytt block och glömmer beloppsreglerna. Den fångar inte
// ett kringgående som råkar hamna nära ett befintligt anrop, och den är inget
// skydd mot uppsåt. Samma avgränsning som brandet på DebtOriginDate: skydd mot
// misstaget, inte mot avsikten.
//
// ⚠️ VILL NÅGON HÖJA TALET ÄR DET ETT SYMTOM, INTE EN LÖSNING. Växer avståndet
// mellan resolvern och skrivningen betyder det att de glidit isär i koden —
// och ju större fönstret blir, desto fler orelaterade anrop kan råka godkänna
// en skrivning. Flytta koden så att beslutet och skrivningen står nära
// varandra. Höj inte fönstret för att slippa göra det.
const PRECEDING_WINDOW = 6000 // tecken

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
  return text.slice(openParenIdx)
}

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length

/** Sätts avgiften till noll? Då kan den aldrig överdebitera. */
function isZeroing(call, field) {
  return (
    new RegExp(`\\b${field}\\s*:\\s*0\\b`).test(call) ||
    new RegExp(`\\b${field}\\s*:\\s*new\\s+Prisma\\.Decimal\\(\\s*0\\s*\\)`).test(call) ||
    new RegExp(`\\b${field}\\s*:\\s*['"]0(\\.0+)?['"]`).test(call)
  )
}

/**
 * Reskontraskrivningarna: modell + fält som bär ett avgiftsbelopp.
 *
 * `true` i `select`/`include` matchar samma fältnamn men står aldrig i en
 * skrivnings `data` — och en läsning kan inte överdebitera. Träffas ändå ett
 * `select` inne i en `update`-call räddas den av nollställningsregeln bara om
 * värdet är 0; annars är det ett falsklarm att fixa här, inte att tysta.
 */
const LEDGER_WRITES = [
  {
    model: 'rentNotice',
    field: 'reminderFeeAmount',
    detail:
      'Avgiften får inte krävas i reskontran utan avtalsgrund, och aldrig med ett ' +
      'belopp över det lagstadgade taket — grinden i bookReminderFee hinner inte ' +
      'stoppa det, markeringen skrivs före bokföringen.',
  },
  {
    model: 'paymentReminder',
    field: 'feeAmount',
    detail:
      'PaymentReminder.feeAmount summeras rakt in i inkassounderlagets ' +
      'avgiftskolumn (collection-export.service.ts) — det är ett krav mot ' +
      'hyresgästen och måste bära samma belopp som verifikatet.',
  },
]

/**
 * Skanna EN källfils text → lista med regelbrott. Exporterad så självtestet kör
 * exakt samma kod som CI.
 */
export function scanSource(text, relPath) {
  const violations = []
  let m

  // (1) reskontramarkeringarna på avin och på påminnelsen.
  for (const { model, field, detail } of LEDGER_WRITES) {
    const re = new RegExp(`\\b${model}\\s*\\.\\s*(create|createMany|update|updateMany|upsert)\\s*\\(`, 'g')
    while ((m = re.exec(text))) {
      const method = m[1]
      const openParen = text.indexOf('(', m.index + m[0].length - 1)
      const call = sliceCall(text, openParen)
      if (!new RegExp(`\\b${field}\\s*:`).test(call)) continue
      if (isZeroing(call, field)) continue

      const before = text.slice(Math.max(0, m.index - PRECEDING_WINDOW), m.index)
      if (!before.includes(`${RESOLVER}(`)) {
        violations.push({
          line: lineOf(text, m.index),
          rule: `${model}.${method}() sätter ${field} utan ${RESOLVER}(...)`,
          detail,
        })
      }
    }
  }

  // (2) avgiftsraden på fakturan.
  const lineRe = /\binvoiceLine\s*\.\s*(create|createMany)\s*\(/g
  while ((m = lineRe.exec(text))) {
    const method = m[1]
    const openParen = text.indexOf('(', m.index + m[0].length - 1)
    const call = sliceCall(text, openParen)
    if (!call.includes(FEE_LINE_CONST)) continue

    const before = text.slice(Math.max(0, m.index - PRECEDING_WINDOW), m.index)
    if (!before.includes(`${RESOLVER}(`)) {
      violations.push({
        line: lineOf(text, m.index),
        rule: `invoiceLine.${method}() skriver avgiftsraden utan ${RESOLVER}(...)`,
        detail:
          'Fakturan får inte kräva en påminnelseavgift utan avtalsgrund, och aldrig ' +
          'ett belopp över taket. Låt resolvern avgöra beloppet före anspråket.',
      })
    }
  }

  // (3) rå SQL som rör något av avgiftsfälten.
  const rawFields = LEDGER_WRITES.map((w) => w.field.toLowerCase())
  text.split('\n').forEach((ln, i) => {
    const lower = ln.toLowerCase()
    if (
      /\$(executeRaw|executeRawUnsafe|queryRaw|queryRawUnsafe)/.test(ln) &&
      rawFields.some((f) => lower.includes(f))
    ) {
      violations.push({
        line: i + 1,
        rule: 'rå SQL mot ett avgiftsfält',
        detail: 'Rå SQL kan inte verifieras statiskt — gå via Prisma och resolvern.',
      })
    }
  })

  return violations.map((v) => ({ ...v, file: relPath }))
}

function* walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) yield* walk(p)
    else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.spec.ts')) yield p
  }
}

// ── självtest ────────────────────────────────────────────────────────────────
const GOOD = [
  [
    'avi-markering med resolvern före',
    `const safeFee = ${RESOLVER}(fee, debtOrigin, termsFrom).amount\n` +
      `await tx.rentNotice.updateMany({ where: { id }, data: { reminderFeeAmount: new Prisma.Decimal(safeFee.toFixed(2)) } })`,
  ],
  [
    'påminnelsemarkör med resolvern före',
    `const safeFee = ${RESOLVER}(fee, debtOrigin, termsFrom).amount\n` +
      `await tx.paymentReminder.createMany({ data: [{ invoiceId, type: 'REMINDER_FORMAL', feeAmount: new Prisma.Decimal(safeFee.toFixed(2)) }] })`,
  ],
  [
    'avgiftsrad med resolvern före',
    `const safeFee = ${RESOLVER}(fee, debtOrigin, termsFrom).amount\n` +
      `await tx.invoiceLine.create({ data: { description: ${FEE_LINE_CONST}, total: safeFee } })`,
  ],
  [
    'nollställning utan resolver (kan aldrig överdebitera)',
    `await tx.rentNotice.updateMany({ where: { id }, data: { reminderFeeAmount: 0 } })`,
  ],
  [
    'nollställning via Decimal',
    `await tx.rentNotice.update({ where: { id }, data: { reminderFeeAmount: new Prisma.Decimal(0) } })`,
  ],
  [
    'påminnelse utan avgift (REMINDER_FRIENDLY)',
    `await this.prisma.paymentReminder.create({ data: { invoiceId, type: 'REMINDER_FRIENDLY', feeAmount: 0 } })`,
  ],
  [
    'läsning av avgiften',
    `const fee = Number(notice.reminderFeeAmount)\nselect: { reminderFeeAmount: true }`,
  ],
  [
    'annan avi-skrivning utan avgiften',
    `await tx.rentNotice.updateMany({ where: { id }, data: { status: 'CANCELLED' } })`,
  ],
  [
    'leveranskorrelation utan avgiften',
    `await this.prisma.paymentReminder.updateMany({ where: { invoiceId }, data: { emailMessageId: key } })`,
  ],
  [
    'annan fakturarad',
    `await tx.invoiceLine.create({ data: { description: 'Hyra juli', total: 7355 } })`,
  ],
]

const BAD = [
  [
    'avi-markering utan resolver',
    `await tx.rentNotice.updateMany({ where: { id }, data: { collectionStage: 'REMINDED', reminderFeeAmount: new Prisma.Decimal(60) } })`,
  ],
  [
    'avi-create med avgift utan resolver',
    `await tx.rentNotice.create({ data: { reminderFeeAmount: fee, totalAmount } })`,
  ],
  [
    'påminnelsemarkör med avgift utan resolver',
    `await tx.paymentReminder.createMany({ data: [{ invoiceId, type: 'REMINDER_FORMAL', feeAmount: new Prisma.Decimal(fee) }] })`,
  ],
  [
    'avgiftsrad utan resolver',
    `await tx.invoiceLine.create({ data: { description: ${FEE_LINE_CONST}, total: fee } })`,
  ],
  [
    'rå SQL mot avi-avgiften',
    `await this.prisma.$executeRawUnsafe('UPDATE "RentNotice" SET "reminderFeeAmount" = 60')`,
  ],
  [
    'rå SQL mot påminnelseavgiften',
    `await this.prisma.$executeRawUnsafe('UPDATE "PaymentReminder" SET "feeAmount" = 500')`,
  ],
  [
    // Kärnan i G3: predikatet ensamt räckte förr, och just den formen skrev
    // reskontran med ett oklampat belopp. Den får inte passera igen.
    'predikatet ensamt — avtalsgrund utan tak',
    `const safeFee = isReminderFeeContractuallyAllowed(debtOrigin, termsFrom) ? begärd : 0\n` +
      `await tx.rentNotice.updateMany({ where: { id }, data: { reminderFeeAmount: new Prisma.Decimal(safeFee) } })`,
  ],
]

function selfTest() {
  let ok = true
  for (const [label, code] of GOOD) {
    const v = scanSource(code, `good:${label}`)
    if (v.length !== 0) {
      ok = false
      console.error(`✗ GOOD "${label}" gav ${v.length} falsklarm:`, v)
    }
  }
  for (const [label, code] of BAD) {
    const v = scanSource(code, `bad:${label}`)
    if (v.length === 0) {
      ok = false
      console.error(`✗ BAD "${label}" fångades INTE — guarden har inga tänder där`)
    }
  }
  if (!ok) process.exit(1)
  console.log(`✓ självtest: ${GOOD.length} tillåtna, ${BAD.length} otillåtna — alla klassade rätt`)
}

if (process.argv.includes('--self-test')) {
  selfTest()
} else {
  const alla = []
  for (const file of walk(SRC_DIR)) {
    alla.push(...scanSource(readFileSync(file, 'utf8'), relative(join(HERE, '..', '..', '..'), file)))
  }
  if (alla.length > 0) {
    console.error('\nPÅMINNELSEAVGIFT MED OPRÖVAT BELOPP — skrivare som kringgår resolvern:\n')
    for (const v of alla) {
      console.error(`  ${v.file}:${v.line}\n    ${v.rule}\n    ${v.detail}\n`)
    }
    console.error(
      `Avgiftens belopp ska alltid komma ur ${RESOLVER}(...) — den bär både\n` +
        'avtalsgrunden (2 §) och det lagstadgade taket (4 §, 6 § 1 st).\n' +
        'Reglerna bor i apps/api/src/accounting/reminder-fee.ts och ska bara uttryckas där.\n',
    )
    process.exit(1)
  }
  console.log('✓ varje skrivare av påminnelseavgiften går genom resolvern (avtalsgrund + tak)')
}
