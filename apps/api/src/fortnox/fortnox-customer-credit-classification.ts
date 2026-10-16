import { Prisma } from '@prisma/client'
import {
  CustomerCreditRefundBookedDebitSchema,
  customerCreditRefundBankProofHash,
} from '../customer-credit/customer-credit-refund-bank.port'
import { customerCreditSourceProof } from '../customer-credit/customer-credit-source-proof'
import { stockholmCivilDate } from '../common/time/stockholm-period'
import { iKontoklass } from './fortnox-kontomappning'
import type { Klassning, Radklass, Verifikat } from './fortnox-radklass'
import type { CustomerCreditExportAnchor } from './fortnox-customer-credit.types'

const journalInclude = {
  lines: { include: { account: true } },
  reversedBy: { select: { id: true } },
} satisfies Prisma.JournalEntryInclude
type Journal = Prisma.JournalEntryGetPayload<{ include: typeof journalInclude }>
type Line = Journal['lines'][number]

const stopped = (skal: string): Klassning => ({ ok: false, kod: 'EVENT_UNSUPPORTED', skal })
const validMoney = (n: Prisma.Decimal) =>
  n.isFinite() && n.gt(0) && n.lte('99999999.99') && n.decimalPlaces() <= 2
const side = (line: Line, which: 'debit' | 'credit', amount: Prisma.Decimal) =>
  line[which]?.eq(amount) === true &&
  (line[which === 'debit' ? 'credit' : 'debit'] === null ||
    line[which === 'debit' ? 'credit' : 'debit']?.isZero() === true)

function pair(
  journal: Journal,
  amount: Prisma.Decimal,
  debit: (l: Line) => boolean,
  credit: (l: Line) => boolean,
) {
  if (!validMoney(amount) || journal.lines.length !== 2) return null
  const deb = journal.lines.find((l) => debit(l) && side(l, 'debit', amount))
  const cre = journal.lines.find((l) => credit(l) && side(l, 'credit', amount))
  return deb && cre && deb.id !== cre.id ? { deb, cre } : null
}

async function journal(
  db: Prisma.TransactionClient,
  organizationId: string,
  source: 'PAYMENT' | 'INVOICE',
  sourceId: string,
) {
  const row = await db.journalEntry.findFirst({
    where: { organizationId, source, sourceId },
    include: journalInclude,
  })
  if (
    !row ||
    row.reversedBy ||
    row.reversalOfEntryId ||
    row.lines.some((l) => l.account.organizationId !== organizationId)
  )
    return null
  return row
}

/** Input kommer från byggaren, men klassningen godtar inte en annan radmängd än den lagrade. */
function sameJournal(input: Verifikat, stored: Journal) {
  return (
    input.id === stored.id &&
    input.source === stored.source &&
    input.sourceId === stored.sourceId &&
    !input.reversalOfEntryId &&
    input.lines.length === stored.lines.length &&
    new Set(input.lines.map((line) => line.id)).size === input.lines.length &&
    input.lines.every((line) =>
      stored.lines.some(
        (s) =>
          s.id === line.id &&
          s.account.number === line.account.number &&
          s.account.type === line.account.type &&
          (s.debit === null ? line.debit === null : line.debit?.eq(s.debit)) &&
          (s.credit === null ? line.credit === null : line.credit?.eq(s.credit)),
      ),
    )
  )
}

/**
 * Läsande exportklassning av redan bokförda fakta. Den skapar aldrig tillgodo,
 * betalning eller verifikat och använder inte dagens aktiveringspolicy som
 * bevis för en historisk händelse. Originalens Fortnox-bevis prövas separat.
 */
export async function klassaKundtillgodo(
  db: Prisma.TransactionClient,
  organizationId: string,
  input: Verifikat,
): Promise<Klassning> {
  const match = /^customer-credit-(receipt|application|refund):([^:]+)$/.exec(input.sourceId ?? '')
  if (!match || input.source !== 'PAYMENT' || input.reversalOfEntryId)
    return stopped('Kundtillgodots verifikat har en okänd källa')
  const kind = match[1]!
  const eventId = match[2]!
  const application =
    kind === 'application'
      ? await db.customerCreditApplication.findFirst({
          where: { id: eventId, organizationId },
          include: { rentNotice: true, payment: true },
        })
      : null
  const refund =
    kind === 'refund'
      ? await db.customerCreditRefund.findFirst({
          where: { id: eventId, organizationId },
        })
      : null
  const creditId = kind === 'receipt' ? eventId : (application?.creditId ?? refund?.creditId)
  if (!creditId) return stopped('Kundtillgodots händelse saknas i organisationen')
  const credit = await db.customerCredit.findFirst({
    where: { id: creditId, organizationId },
    include: {
      sourceRentNotice: true,
      sourceBankTransaction: { include: { rentNoticePayments: { select: { id: true } } } },
      sourcePayment: true,
      liabilityAccount: true,
      lease: { select: { organizationId: true, tenantId: true } },
    },
  })
  if (!credit) return stopped('Kundtillgodot saknas i organisationen')
  const bank = credit.sourceBankTransaction
  const notice = credit.sourceRentNotice
  const payment = credit.sourcePayment
  if (
    !validMoney(credit.amount) ||
    !validMoney(payment.amount) ||
    credit.liabilityAccount.organizationId !== organizationId ||
    credit.liabilityAccount.type !== 'LIABILITY' ||
    !iKontoklass('KUNDTILLGODOSKULD', credit.liabilityAccount.number) ||
    credit.lease.organizationId !== organizationId ||
    credit.lease.tenantId !== credit.tenantId ||
    notice.organizationId !== organizationId ||
    notice.tenantId !== credit.tenantId ||
    notice.leaseId !== credit.leaseId ||
    notice.type !== 'RENT' ||
    notice.origin !== 'EVENO' ||
    bank.organizationId !== organizationId ||
    bank.status !== 'MATCHED' ||
    bank.matchedRentNoticeId !== notice.id ||
    bank.invoiceId !== null ||
    bank.rentNoticePayments.length !== 1 ||
    bank.rentNoticePayments[0]?.id !== payment.id ||
    payment.rentNoticeId !== notice.id ||
    payment.bankTransactionId !== bank.id ||
    payment.source !== 'BANK_RECONCILIATION' ||
    !bank.amount.eq(payment.amount.plus(credit.amount)) ||
    customerCreditSourceProof(bank, notice, payment) !== credit.sourceProofHash
  )
    return stopped('Kundtillgodots frysta källunderlag stämmer inte med den bokförda skulden')

  const sourcePayment = await journal(
    db,
    organizationId,
    'PAYMENT',
    `rent-notice-bank-payment:${payment.id}`,
  )
  const receipt = await journal(
    db,
    organizationId,
    'PAYMENT',
    `customer-credit-receipt:${credit.id}`,
  )
  const sourceAccrual = await journal(db, organizationId, 'INVOICE', `rent-notice:${notice.id}`)
  if (!sourcePayment || !receipt || receipt.id !== credit.journalEntryId || !sourceAccrual)
    return stopped(
      'Kundtillgodots källbetalning, mottagning eller hyresfordran saknar levande verifikat',
    )
  const incoming = pair(
    sourcePayment,
    payment.amount,
    (l) => l.account.number === 1930 && l.account.type === 'ASSET',
    (l) => l.account.number === 1510 && l.account.type === 'ASSET',
  )
  const received = pair(
    receipt,
    credit.amount,
    (l) => l.account.number === 1930 && l.account.type === 'ASSET',
    (l) => l.accountId === credit.liabilityAccountId && l.account.type === 'LIABILITY',
  )
  if (!incoming || !received || incoming.deb.accountId !== received.deb.accountId)
    return stopped('Mottagningen motsvarar inte den faktiska bank- och skuldbokföringen')

  const rader = new Map<string, Radklass>()
  const anchors: CustomerCreditExportAnchor[] = []
  const bind = (line: Line, origin: Journal, originLine: Line, role: Radklass['roll']) => {
    rader.set(line.id, { roll: role, behandling: 'EJ_TILLAMPLIG' })
    anchors.push({
      journalEntryLineId: line.id,
      originJournalEntryId: origin.id,
      originJournalEntryLineId: originLine.id,
      role,
    })
  }
  let handelse: string
  let current: Journal
  if (kind === 'receipt') {
    current = receipt
    bind(received.deb, sourcePayment, incoming.deb, 'LIKVID')
    rader.set(received.cre.id, { roll: 'KUNDTILLGODOSKULD', behandling: 'EJ_TILLAMPLIG' })
    handelse = 'mottaget kundtillgodo'
  } else if (kind === 'application' && application) {
    const target = application.rentNotice
    const applied = application.payment
    const entry = await journal(
      db,
      organizationId,
      'PAYMENT',
      `customer-credit-application:${application.id}`,
    )
    const accrual = await journal(db, organizationId, 'INVOICE', `rent-notice:${target.id}`)
    if (
      !entry ||
      entry.id !== application.journalEntryId ||
      !accrual ||
      application.creditId !== credit.id ||
      target.organizationId !== organizationId ||
      target.tenantId !== credit.tenantId ||
      target.leaseId !== credit.leaseId ||
      target.type !== 'RENT' ||
      target.origin !== 'EVENO' ||
      !applied ||
      applied.rentNoticeId !== target.id ||
      applied.customerCreditApplicationId !== application.id ||
      applied.source !== 'CUSTOMER_CREDIT' ||
      applied.bankTransactionId !== null ||
      !applied.amount.eq(application.amount) ||
      !validMoney(application.amount) ||
      application.amount.gt(credit.amount)
    )
      return stopped('Tillgodoavdragets händelse, betalningsrad och målavi stämmer inte överens')
    const rows = pair(
      entry,
      application.amount,
      (l) => l.accountId === credit.liabilityAccountId && l.account.type === 'LIABILITY',
      (l) => l.account.number === 1510 && l.account.type === 'ASSET',
    )
    const receivables = accrual.lines.filter(
      (l) =>
        l.account.number === 1510 &&
        l.account.type === 'ASSET' &&
        side(l, 'debit', target.totalAmount),
    )
    if (!rows || receivables.length !== 1 || rows.cre.accountId !== receivables[0]!.accountId)
      return stopped('Tillgodoavdragets bokföring motsvarar inte skulden och målaviens fordran')
    current = entry
    bind(rows.deb, receipt, received.cre, 'KUNDTILLGODOSKULD')
    bind(rows.cre, accrual, receivables[0]!, 'KUNDFORDRAN')
    handelse = 'kundtillgodo använt på hyresavi'
  } else if (kind === 'refund' && refund) {
    const entry = await journal(
      db,
      organizationId,
      'PAYMENT',
      `customer-credit-refund:${refund.id}`,
    )
    const parsed = CustomerCreditRefundBookedDebitSchema.safeParse(refund.bankEvidence)
    if (
      !entry ||
      refund.state !== 'SETTLED' ||
      refund.journalEntryId !== entry.id ||
      !refund.settledAt ||
      !refund.bankConfirmedAt ||
      !refund.bankBookedAt ||
      refund.creditId !== credit.id ||
      refund.tenantId !== credit.tenantId ||
      refund.leaseId !== credit.leaseId ||
      refund.liabilityAccountId !== credit.liabilityAccountId ||
      refund.bankAccountId !== bank.bankAccountId ||
      refund.bankLedgerAccountId !== received.deb.accountId ||
      refund.currency !== 'SEK' ||
      !validMoney(refund.amount) ||
      refund.amount.gt(credit.amount) ||
      !parsed.success
    )
      return stopped('Återbetalningen saknar slutlig bokföring och verifierat bankunderlag')
    const proof = parsed.data
    const bankDay = stockholmCivilDate(proof.bankBookedAt)
    const eventDay = stockholmCivilDate(entry.eventDate ?? entry.date)
    if (
      proof.instructionId !== refund.id ||
      proof.instructionHash !== refund.instructionHash ||
      proof.organizationId !== organizationId ||
      proof.tenantId !== credit.tenantId ||
      proof.bankAccountId !== refund.bankAccountId ||
      proof.provider !== refund.provider ||
      proof.providerAccountRef !== refund.providerAccountRef ||
      proof.recipientRef !== refund.recipientRef ||
      proof.amount !== refund.amount.toFixed(2) ||
      proof.currency !== refund.currency ||
      proof.providerTransferId !== refund.providerTransferId ||
      proof.bankTransactionId !== refund.bankTransactionId ||
      proof.bankBookedAt.getTime() !== refund.bankBookedAt.getTime() ||
      refund.bankProofKey !==
        JSON.stringify([proof.provider, proof.providerAccountRef, proof.bankTransactionId]) ||
      customerCreditRefundBankProofHash(proof) !== refund.bankProofHash ||
      bankDay.year !== eventDay.year ||
      bankDay.month !== eventDay.month ||
      bankDay.day !== eventDay.day
    )
      return stopped('Återbetalningens sparade bankbevis motsvarar inte den bokförda händelsen')
    const rows = pair(
      entry,
      refund.amount,
      (l) => l.accountId === refund.liabilityAccountId && l.account.type === 'LIABILITY',
      (l) => l.accountId === refund.bankLedgerAccountId && l.account.type === 'ASSET',
    )
    if (!rows) return stopped('Återbetalningens verifikatrader motsvarar inte den frysta ordern')
    current = entry
    bind(rows.deb, receipt, received.cre, 'KUNDTILLGODOSKULD')
    bind(rows.cre, receipt, received.deb, 'LIKVID')
    handelse = 'bankbekräftad återbetalning av kundtillgodo'
  } else return stopped('Kundtillgodots händelse saknas')

  if (!sameJournal(input, current))
    return stopped('Kundtillgodots verifikat är inte den exakta journal som domänhändelsen binder')
  return {
    ok: true,
    handelse,
    rader,
    rattelseAv: null,
    kundtillgodo: {
      kind: kind === 'receipt' ? 'RECEIPT' : kind === 'application' ? 'APPLICATION' : 'REFUND',
      creditId: credit.id,
      eventId,
      anchors,
    },
  }
}
