#!/usr/bin/env node
/**
 * CI-guard (G2) — skyddar AVTALSGRUNDEN för påminnelseavgiften.
 *
 * Påminnelseavgift får inte debiteras utan avtalsvillkor (2 § lagen 1981:739),
 * och villkoret binder bara framåt. Regeln bor i
 * `isReminderFeeContractuallyAllowed` (apps/api/src/accounting/debt-origin.ts).
 *
 * ── VARFÖR TYPSYSTEMET INTE RÄCKER ──────────────────────────────────────────
 *
 * `bookReminderFee` kräver `debtOrigin: DebtOriginDate | null` och `termsFrom`,
 * så BOKFÖRINGSSIDAN är skyddad av kompilatorn: en anropare som glömmer dem
 * kompilerar inte.
 *
 * Men avgiften tas på TVÅ ställen. Vid sidan av verifikatet skrivs en markering
 * i RESKONTRAN — `RentNotice.reminderFeeAmount` på avi-sidan, en avgiftsrad på
 * fakturan — och den skrivningen går inte via `bookReminderFee`. En framtida
 * anropare som sätter `reminderFeeAmount` utan att fråga predikatet får ingen
 * varning alls, och då kräver avin 60 kr som huvudboken inte bär. Det är exakt
 * den divergens mellan reskontra och huvudbok som #357 stängde, med omvänt
 * tecken.
 *
 * Guarden matchar HOTET, inte en exakt sträng:
 *   • `rentNotice.create/createMany/update/updateMany/upsert` vars data sätter
 *     `reminderFeeAmount:` → MÅSTE föregås av `isReminderFeeContractuallyAllowed(`.
 *   • `invoiceLine.create/createMany` vars data bär
 *     `REMINDER_FEE_LINE_DESCRIPTION` → samma krav.
 *   • rå SQL som rör `reminderFeeAmount` → kan inte verifieras statiskt.
 *
 * NOLLSTÄLLNING ÄR ALLTID TILLÅTEN. Att sätta avgiften till 0 kan aldrig
 * överdebitera någon — det är refuseringsvägen och den kommande
 * rättelsefunktionen (G4). `reminderFeeAmount: 0` och `new Prisma.Decimal(0)`
 * passerar därför utan predikat.
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
 * Lokalt:      node apps/api/scripts/check-reminder-fee-terms-source.mjs
 * Självtest:   node apps/api/scripts/check-reminder-fee-terms-source.mjs --self-test
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = join(HERE, '..', 'src')

const PREDICATE = 'isReminderFeeContractuallyAllowed'
const FEE_LINE_CONST = 'REMINDER_FEE_LINE_DESCRIPTION'
// Hur långt före skrivningen predikatet måste synas (samma tx/funktionsblock).
//
// MÄTT, INTE GISSAT. Avståndet hos de två legitima skrivarna:
//   avi-sidan      (rent-reminder.service.ts)     ~700 tecken
//   fakturasidan   (payment-reminder.service.ts)  4 240 tecken
//
// Fakturasidans avstånd är stort för att predikatet måste ligga FÖRE anspråket
// medan raden skrivs EFTER det, med utförliga kommentarblock däremellan. 6000
// ger marginal utan att spänna över en typisk funktionsgräns — vid 4000 föll
// den legitima skrivaren, vilket är hur siffran hittades.
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
function isZeroing(call) {
  return (
    /\breminderFeeAmount\s*:\s*0\b/.test(call) ||
    /\breminderFeeAmount\s*:\s*new\s+Prisma\.Decimal\(\s*0\s*\)/.test(call) ||
    /\breminderFeeAmount\s*:\s*['"]0(\.0+)?['"]/.test(call)
  )
}

/**
 * Skanna EN källfils text → lista med regelbrott. Exporterad så självtestet kör
 * exakt samma kod som CI.
 */
export function scanSource(text, relPath) {
  const violations = []

  // (1) reskontramarkeringen på avin.
  const noticeRe = /\brentNotice\s*\.\s*(create|createMany|update|updateMany|upsert)\s*\(/g
  let m
  while ((m = noticeRe.exec(text))) {
    const method = m[1]
    const openParen = text.indexOf('(', m.index + m[0].length - 1)
    const call = sliceCall(text, openParen)
    if (!/\breminderFeeAmount\s*:/.test(call)) continue
    if (isZeroing(call)) continue

    const before = text.slice(Math.max(0, m.index - PRECEDING_WINDOW), m.index)
    if (!before.includes(`${PREDICATE}(`)) {
      violations.push({
        line: lineOf(text, m.index),
        rule: `rentNotice.${method}() sätter reminderFeeAmount utan ${PREDICATE}(...)`,
        detail:
          'Avgiften får inte krävas i reskontran utan avtalsgrund — och grinden i ' +
          'bookReminderFee hinner inte stoppa det, markeringen skrivs före bokföringen.',
      })
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
    if (!before.includes(`${PREDICATE}(`)) {
      violations.push({
        line: lineOf(text, m.index),
        rule: `invoiceLine.${method}() skriver avgiftsraden utan ${PREDICATE}(...)`,
        detail:
          'Fakturan får inte kräva en påminnelseavgift utan avtalsgrund. Fråga ' +
          'predikatet före anspråket och klampa avgiften till 0 när svaret är nej.',
      })
    }
  }

  // (3) rå SQL som rör avgiftsmarkeringen.
  text.split('\n').forEach((ln, i) => {
    if (
      /\$(executeRaw|executeRawUnsafe|queryRaw|queryRawUnsafe)/.test(ln) &&
      /reminderfeeamount/i.test(ln)
    ) {
      violations.push({
        line: i + 1,
        rule: 'rå SQL mot reminderFeeAmount',
        detail: 'Rå SQL kan inte verifieras statiskt — gå via Prisma och predikatet.',
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
    'avi-markering med predikat före',
    `const safeFee = ${PREDICATE}(debtOrigin, termsFrom) ? begärd : 0\n` +
      `await tx.rentNotice.updateMany({ where: { id }, data: { reminderFeeAmount: new Prisma.Decimal(safeFee.toFixed(2)) } })`,
  ],
  [
    'avgiftsrad med predikat före',
    `const safeFee = ${PREDICATE}(debtOrigin, termsFrom) ? begärd : 0\n` +
      `await tx.invoiceLine.create({ data: { description: ${FEE_LINE_CONST}, total: safeFee } })`,
  ],
  [
    'nollställning utan predikat (kan aldrig överdebitera)',
    `await tx.rentNotice.updateMany({ where: { id }, data: { reminderFeeAmount: 0 } })`,
  ],
  [
    'nollställning via Decimal',
    `await tx.rentNotice.update({ where: { id }, data: { reminderFeeAmount: new Prisma.Decimal(0) } })`,
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
    'annan fakturarad',
    `await tx.invoiceLine.create({ data: { description: 'Hyra juli', total: 7355 } })`,
  ],
]

const BAD = [
  [
    'avi-markering utan predikat',
    `await tx.rentNotice.updateMany({ where: { id }, data: { collectionStage: 'REMINDED', reminderFeeAmount: new Prisma.Decimal(60) } })`,
  ],
  [
    'avi-create med avgift utan predikat',
    `await tx.rentNotice.create({ data: { reminderFeeAmount: fee, totalAmount } })`,
  ],
  [
    'avgiftsrad utan predikat',
    `await tx.invoiceLine.create({ data: { description: ${FEE_LINE_CONST}, total: fee } })`,
  ],
  [
    'rå SQL mot avgiften',
    `await this.prisma.$executeRawUnsafe('UPDATE "RentNotice" SET "reminderFeeAmount" = 60')`,
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
    console.error('\nPÅMINNELSEAVGIFT UTAN AVTALSGRUND — skrivare som kringgår predikatet:\n')
    for (const v of alla) {
      console.error(`  ${v.file}:${v.line}\n    ${v.rule}\n    ${v.detail}\n`)
    }
    console.error(
      `Avgiften får bara krävas när ${PREDICATE}(debtOrigin, termsFrom) är sann.\n` +
        'Regeln bor i apps/api/src/accounting/debt-origin.ts och ska bara uttryckas där.\n',
    )
    process.exit(1)
  }
  console.log('✓ varje skrivare av påminnelseavgiften går genom avtalsgrunds-predikatet')
}
