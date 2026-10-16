import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import type {
  CustomerCreditExportAnchor,
  CustomerCreditExportOrigins,
} from './fortnox-customer-credit.types'
import { klassaVerifikat } from './fortnox-radklass'

type JournalForEvidence = {
  id: string
  organizationId: string
  date: Date
  eventDate: Date | null
  description: string
  reference: string | null
  source: string
  sourceId: string | null
  aiToolExecutionId: string | null
  fiscalYear: number
  series: string
  verNumber: number
  reversalOfEntryId: string | null
  lines: Array<{
    id: string
    journalEntryId: string
    accountId: string
    debit: Prisma.Decimal | null
    credit: Prisma.Decimal | null
    description: string | null
    account: { id: string; organizationId: string; number: number; type: string }
  }>
}

export interface CustomerCreditVerifiedExportAnchor extends CustomerCreditExportAnchor {
  originExportId: string
  originDraftHash: string
  sentPayloadHash: string
  originDraftDigest: string
  localAccountId: string
  localAccountNumber: number
  amountOre: string
  side: 'Debit' | 'Credit'
  targetAccountNumber: number
  voucherIdentity: { databaseNumber: number; year: number; series: string; number: number }
  mappingRevision: { id: string; revision: number; contentSha256: string }
  mappingRow: {
    id: string
    snapshot: {
      namn: string | null
      aktiv: boolean | null
      momskod: string | null
      ar: number | null
    }
  }
}

/** Endast bokföringsidentiteter och kontomål, aldrig bankreferenser eller mottagaruppgifter. */
export interface CustomerCreditExportEvidence {
  version: 1
  kind: CustomerCreditExportOrigins['kind']
  creditId: string
  eventId: string
  origins: CustomerCreditExportAnchor[]
  anchors: CustomerCreditVerifiedExportAnchor[]
  journalDigest: string
  digest: string
}

export class CustomerCreditExportEvidenceError extends Error {
  readonly code = 'CUSTOMER_CREDIT_ORIGIN_UNVERIFIED'
}

function reject(): never {
  throw new CustomerCreditExportEvidenceError(
    'Kundtillgodots originalexport saknar ett entydigt, bekräftat underlag i samma Fortnox-företag',
  )
}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject()
  return value as Record<string, unknown>
}
const nonempty = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) return reject()
  return value
}
const integer = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return reject()
  return value
}
const sha = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return reject()
  return value
}

/** JSONB kan ändra nyckelordningen. Hashen är därför oberoende av objektens insättningsordning. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    )
  }
  return value
}
const digest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')

/** Alla lokala fält som formar payload/klassning; nätläsningens tidsstämplar ingår inte. */
export function customerCreditJournalDigest(entry: JournalForEvidence): string {
  return digest({
    id: entry.id,
    organizationId: entry.organizationId,
    date: entry.date.toISOString(),
    eventDate: entry.eventDate?.toISOString() ?? null,
    description: entry.description,
    reference: entry.reference,
    source: entry.source,
    sourceId: entry.sourceId,
    aiToolExecutionId: entry.aiToolExecutionId,
    fiscalYear: entry.fiscalYear,
    series: entry.series,
    verNumber: entry.verNumber,
    reversalOfEntryId: entry.reversalOfEntryId,
    lines: entry.lines
      .map((line) => ({
        id: line.id,
        journalEntryId: line.journalEntryId,
        accountId: line.accountId,
        debit: line.debit?.toString() ?? null,
        credit: line.credit?.toString() ?? null,
        description: line.description,
        account: {
          id: line.account.id,
          organizationId: line.account.organizationId,
          number: line.account.number,
          type: line.account.type,
        },
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  })
}

function amount(value: unknown): Prisma.Decimal {
  if (typeof value !== 'number' && typeof value !== 'string') return reject()
  try {
    const n = new Prisma.Decimal(value)
    if (!n.isFinite() || n.lt(0) || n.decimalPlaces() > 2 || n.gt('99999999.99')) return reject()
    return n
  } catch {
    return reject()
  }
}

function snapshot(value: unknown): CustomerCreditVerifiedExportAnchor['mappingRow']['snapshot'] {
  const v = record(value)
  if (
    (v.namn !== null && typeof v.namn !== 'string') ||
    (v.aktiv !== null && typeof v.aktiv !== 'boolean') ||
    (v.momskod !== null && typeof v.momskod !== 'string') ||
    (v.ar !== null && (typeof v.ar !== 'number' || !Number.isSafeInteger(v.ar)))
  )
    return reject()
  return {
    namn: v.namn as string | null,
    aktiv: v.aktiv as boolean | null,
    momskod: v.momskod as string | null,
    ar: v.ar as number | null,
  }
}

function mappingRevision(value: unknown): CustomerCreditVerifiedExportAnchor['mappingRevision'] {
  const v = record(value)
  return { id: nonempty(v.id), revision: integer(v.revision), contentSha256: sha(v.contentSha256) }
}

/**
 * DB-only. Varje ankarerad måste finnas exakt en gång i originalets verkliga
 * journal, payload, proveniens och kontomappning. Ett CONFIRMED-statusfält ensamt
 * eller en dagens mappningsrad är inte ett bevis för det exporterade kontot.
 */
export async function readCustomerCreditExportEvidence(
  db: Pick<Prisma.TransactionClient, 'fortnoxVoucherExport'>,
  input: {
    organizationId: string
    databaseNumber: number
    organizationNumber: string
    origins: CustomerCreditExportOrigins
    journal: JournalForEvidence
  },
): Promise<CustomerCreditExportEvidence> {
  const { organizationId, databaseNumber, organizationNumber, origins } = input
  if (
    input.journal.organizationId !== organizationId ||
    origins.anchors.length !== (origins.kind === 'RECEIPT' ? 1 : 2) ||
    new Set(origins.anchors.map((a) => a.journalEntryLineId)).size !== origins.anchors.length
  )
    return reject()
  const anchors: CustomerCreditVerifiedExportAnchor[] = []
  const ordered = [...origins.anchors].sort((a, b) =>
    a.journalEntryLineId < b.journalEntryLineId
      ? -1
      : a.journalEntryLineId > b.journalEntryLineId
        ? 1
        : 0,
  )
  for (const anchor of ordered) {
    if (!input.journal.lines.some((l) => l.id === anchor.journalEntryLineId)) return reject()
    const original = await db.fortnoxVoucherExport.findFirst({
      where: {
        organizationId,
        journalEntryId: anchor.originJournalEntryId,
        state: 'CONFIRMED',
        fortnoxDatabaseNumber: databaseNumber,
      },
      include: {
        journalEntry: {
          include: { lines: { include: { account: true } }, reversedBy: { select: { id: true } } },
        },
      },
    })
    if (
      !original ||
      !original.confirmedAt ||
      original.journalEntry.organizationId !== organizationId ||
      original.journalEntry.reversalOfEntryId ||
      original.journalEntry.reversedBy ||
      original.draftHash !== original.sentPayloadHash
    )
      return reject()
    const draft = record(original.draft)
    const provenance = record(draft.provenance)
    const company = record(provenance.externalCompany)
    const payload = record(record(draft.payload).Voucher)
    const query = record(draft.query)
    const mapping = record(draft.kontomappning)
    if (
      provenance.organizationId !== organizationId ||
      provenance.journalEntryId !== anchor.originJournalEntryId ||
      company.databaseNumber !== databaseNumber ||
      company.organizationNumber !== organizationNumber ||
      provenance.source !== original.journalEntry.source ||
      provenance.sourceId !== original.journalEntry.sourceId ||
      provenance.reversalOfEntryId !== null ||
      provenance.bookingDate !== original.journalEntry.date.toISOString().slice(0, 10) ||
      payload.TransactionDate !== provenance.bookingDate ||
      query.financialyear !== original.externalYear ||
      payload.VoucherSeries !== original.externalSeries ||
      !Array.isArray(provenance.lines) ||
      !Array.isArray(payload.VoucherRows) ||
      !Array.isArray(mapping.rader) ||
      provenance.lines.length !== original.journalEntry.lines.length ||
      payload.VoucherRows.length !== provenance.lines.length ||
      mapping.rader.length !== provenance.lines.length
    )
      return reject()
    const ids = new Set<string>()
    let anchored: CustomerCreditVerifiedExportAnchor | undefined
    let totalDebit = new Prisma.Decimal(0)
    let totalCredit = new Prisma.Decimal(0)
    for (let index = 0; index < provenance.lines.length; index++) {
      const p = record(provenance.lines[index])
      const row = record(payload.VoucherRows[index])
      const lineId = nonempty(p.journalEntryLineId)
      if (ids.has(lineId)) return reject()
      ids.add(lineId)
      const local = original.journalEntry.lines.find((l) => l.id === lineId)
      const kmRows = mapping.rader.map(record).filter((r) => r.journalEntryLineId === lineId)
      if (!local || kmRows.length !== 1) return reject()
      const km = kmRows[0]!
      // Toppnivån anger exportens aktuella godkännanderevision. En fryst rad
      // kan bära en äldre revision, också när originalet självt är tillgodo.
      // Äldre vanliga exporter saknar radfältet och har en gemensam revision.
      const creditOrigin = original.journalEntry.sourceId?.startsWith('customer-credit-') === true
      if (creditOrigin && km.mappingRevision === undefined) return reject()
      const revision =
        km.mappingRevision === undefined
          ? mappingRevision({
              id: mapping.revisionId,
              revision: mapping.revision,
              contentSha256: mapping.contentSha256,
            })
          : mappingRevision(km.mappingRevision)
      const debit = local.debit ?? new Prisma.Decimal(0)
      const credit = local.credit ?? new Prisma.Decimal(0)
      const side =
        debit.gt(0) && credit.isZero() ? 'Debit' : credit.gt(0) && debit.isZero() ? 'Credit' : null
      const money = side === 'Debit' ? debit : credit
      if (
        !side ||
        local.account.organizationId !== organizationId ||
        p.localAccountId !== local.accountId ||
        p.localAccountNumber !== local.account.number ||
        p.debit !== (local.debit?.toString() ?? null) ||
        p.credit !== (local.credit?.toString() ?? null) ||
        p.side !== side ||
        p.amountOre !== money.mul(100).toFixed(0) ||
        !amount(row.Debit ?? 0).eq(debit) ||
        !amount(row.Credit ?? 0).eq(credit) ||
        row.Account !== p.externalAccountNumber ||
        km.kallkonto !== local.account.number ||
        km.malkonto !== p.externalAccountNumber ||
        row.CostCenter ||
        row.Project ||
        row.Removed === true
      )
        return reject()
      const dimensions = record(p.dimensionDecision)
      if (dimensions.costCenter !== null || dimensions.project !== null) return reject()
      integer(p.externalAccountNumber)
      totalDebit = totalDebit.plus(debit)
      totalCredit = totalCredit.plus(credit)
      if (lineId === anchor.originJournalEntryLineId) {
        if (km.roll !== anchor.role || km.behandling !== 'EJ_TILLAMPLIG') return reject()
        anchored = {
          ...anchor,
          originExportId: original.id,
          originDraftHash: sha(original.draftHash),
          sentPayloadHash: sha(original.sentPayloadHash),
          originDraftDigest: digest(draft),
          localAccountId: local.accountId,
          localAccountNumber: local.account.number,
          amountOre: money.mul(100).toFixed(0),
          side,
          targetAccountNumber: integer(p.externalAccountNumber),
          voucherIdentity: {
            databaseNumber,
            year: integer(original.externalYear),
            series: nonempty(original.externalSeries),
            number: integer(original.externalNumber),
          },
          mappingRevision: revision,
          mappingRow: { id: nonempty(km.mappningsradId), snapshot: snapshot(km.ogonblick) },
        }
      }
    }
    if (
      !anchored ||
      !totalDebit.gt(0) ||
      !totalDebit.eq(totalCredit) ||
      provenance.totalDebitOre !== totalDebit.mul(100).toFixed(0) ||
      provenance.totalCreditOre !== totalCredit.mul(100).toFixed(0)
    )
      return reject()
    anchors.push(anchored)
  }
  const evidence = {
    version: 1 as const,
    kind: origins.kind,
    creditId: origins.creditId,
    eventId: origins.eventId,
    origins: ordered,
    anchors,
    journalDigest: customerCreditJournalDigest(input.journal),
  }
  return { ...evidence, digest: digest(evidence) }
}

/**
 * Samma domänlåsordning som mottagning/avräkning/återbetalning. Först därefter
 * låses journaler och exporter. Allt sker före SENDING-CAS; ingen nät-I/O i tx.
 * Domänens beständiga rättelsespärrar bevarar använda källor även efter claim.
 */
export async function recheckCustomerCreditExportInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string
    journalEntryId: string
    databaseNumber: number
    organizationNumber: string
    expected: unknown
    draft: Record<string, unknown>
    connectionId: string
    generation: number
  },
): Promise<void> {
  const { organizationId } = input
  const expected = record(input.expected)
  const creditId = nonempty(expected.creditId)
  const eventId = nonempty(expected.eventId)
  const credit = await tx.customerCredit.findFirst({
    where: { id: creditId, organizationId },
    select: { leaseId: true, sourceBankTransactionId: true, sourceRentNoticeId: true },
  })
  if (!credit) return reject()
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`customer-credit:${organizationId}:${credit.leaseId}`}, 0))`
  await tx.$queryRaw`SELECT id FROM "Lease" WHERE id = ${credit.leaseId} AND "organizationId" = ${organizationId} FOR UPDATE`
  await tx.$queryRaw`SELECT id FROM "BankTransaction" WHERE id = ${credit.sourceBankTransactionId} AND "organizationId" = ${organizationId} FOR UPDATE`
  const noticeIds = [credit.sourceRentNoticeId]
  if (expected.kind === 'APPLICATION') {
    const application = await tx.customerCreditApplication.findFirst({
      where: { id: eventId, organizationId, creditId },
      select: { rentNoticeId: true },
    })
    if (!application) return reject()
    noticeIds.push(application.rentNoticeId)
  }
  for (const id of [...new Set(noticeIds)].sort()) {
    await tx.$queryRaw`SELECT id FROM "RentNotice" WHERE id = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`
  }
  await tx.$queryRaw`SELECT id FROM "CustomerCredit" WHERE id = ${creditId} AND "organizationId" = ${organizationId} FOR UPDATE`
  if (expected.kind === 'REFUND') {
    await tx.$queryRaw`SELECT id FROM "CustomerCreditRefund" WHERE id = ${eventId} AND "organizationId" = ${organizationId} AND "creditId" = ${creditId} FOR UPDATE`
  }
  if (!Array.isArray(expected.origins)) return reject()
  const originIds = expected.origins.map((value) => nonempty(record(value).originJournalEntryId))
  for (const id of [...new Set([input.journalEntryId, ...originIds])].sort()) {
    await tx.$queryRaw`SELECT id FROM "JournalEntry" WHERE id = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`
  }
  // Journalraden är FK-förälder: nya rader/rättelser väntar också på dess lås.
  // Befintliga rader/konton låses separat så omkontering inte passerar återläsningen.
  const ids = [...new Set([input.journalEntryId, ...originIds])].sort()
  await tx.$queryRaw`SELECT line.id FROM "JournalEntryLine" line JOIN "JournalEntry" journal ON journal.id = line."journalEntryId" WHERE journal."organizationId" = ${organizationId} AND journal.id IN (${Prisma.join(ids)}) ORDER BY line.id FOR UPDATE OF line`
  await tx.$queryRaw`SELECT account.id FROM "Account" account WHERE account."organizationId" = ${organizationId} AND account.id IN (SELECT line."accountId" FROM "JournalEntryLine" line JOIN "JournalEntry" journal ON journal.id = line."journalEntryId" WHERE journal."organizationId" = ${organizationId} AND journal.id IN (${Prisma.join(ids)})) ORDER BY account.id FOR UPDATE`
  for (const id of ids) {
    await tx.$queryRaw`SELECT id FROM "FortnoxVoucherExport" WHERE "journalEntryId" = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`
  }
  const entry = await tx.journalEntry.findFirst({
    where: { id: input.journalEntryId, organizationId },
    include: { lines: { include: { account: true } }, reversedBy: { select: { id: true } } },
  })
  if (!entry || entry.reversedBy) return reject()
  const klass = await klassaVerifikat(tx, organizationId, entry, input.databaseNumber)
  if (
    !klass.ok ||
    !klass.kundtillgodo ||
    klass.frystaMal ||
    klass.rattelseAv ||
    klass.kundtillgodo.creditId !== creditId
  )
    return reject()
  const current = await readCustomerCreditExportEvidence(tx, {
    organizationId,
    databaseNumber: input.databaseNumber,
    organizationNumber: input.organizationNumber,
    origins: klass.kundtillgodo,
    journal: entry,
  })
  if (digest(current) !== digest(expected)) return reject()
  // För mottagningens nya skuldrad används en aktuell revision. Kontrollera
  // även den och anslutningsvalen under claim, utan att läsa Fortnox i tx.
  const mapping = record(input.draft.kontomappning)
  const revisionId = nonempty(mapping.revisionId)
  await tx.$queryRaw`SELECT id FROM "FortnoxConnection" WHERE id = ${input.connectionId} AND "organizationId" = ${organizationId} FOR UPDATE`
  await tx.$queryRaw`SELECT id FROM "FortnoxAccountMappingRevision" WHERE id = ${revisionId} AND "organizationId" = ${organizationId} FOR UPDATE`
  const conn = await tx.fortnoxConnection.findUnique({ where: { organizationId } })
  const revision = await tx.fortnoxAccountMappingRevision.findFirst({
    where: { id: revisionId, organizationId, status: 'APPROVED' },
    include: { rows: true },
  })
  const query = record(input.draft.query)
  const voucher = record(record(input.draft.payload).Voucher)
  const provenance = record(input.draft.provenance)
  if (
    !conn ||
    conn.id !== input.connectionId ||
    conn.status !== 'ACTIVE' ||
    conn.generation !== input.generation ||
    conn.fortnoxDatabaseNumber !== input.databaseNumber ||
    conn.fortnoxOrgNumber !== input.organizationNumber ||
    conn.exportVoucherSeries !== voucher.VoucherSeries ||
    !conn.exportOmitDimensionsAt ||
    !conn.exportOmitDimensionsBy ||
    !revision ||
    revision.connectionId !== conn.id ||
    revision.connectionGeneration !== conn.generation ||
    revision.fortnoxDatabaseNumber !== conn.fortnoxDatabaseNumber ||
    revision.fortnoxOrgNumber !== conn.fortnoxOrgNumber ||
    revision.financialYearId !== query.financialyear ||
    revision.contentSha256 !== mapping.contentSha256 ||
    revision.revision !== mapping.revision ||
    !Array.isArray(mapping.rader) ||
    !Array.isArray(provenance.lines)
  )
    return reject()
  const dimensionRef = `kundbeslut:utan-dimension:${conn.exportOmitDimensionsBy}@${conn.exportOmitDimensionsAt.toISOString()}`
  if (
    provenance.lines.some(
      (line) => !nonempty(record(line).dimensionEvidenceRef).startsWith(dimensionRef),
    )
  )
    return reject()
  for (const line of entry.lines) {
    if (current.anchors.some((a) => a.journalEntryLineId === line.id)) continue
    const rows = mapping.rader.map(record).filter((m) => m.journalEntryLineId === line.id)
    if (rows.length !== 1) return reject()
    const frozen = rows[0]!
    const rowRevision = mappingRevision(frozen.mappingRevision)
    const selected = revision.rows.find((r) => r.id === frozen.mappningsradId)
    if (
      !selected ||
      rowRevision.id !== revision.id ||
      rowRevision.revision !== revision.revision ||
      rowRevision.contentSha256 !== revision.contentSha256 ||
      selected.role !== frozen.roll ||
      selected.vatTreatment !== frozen.behandling ||
      selected.sourceAccountNumber !== frozen.kallkonto ||
      selected.targetAccountNumber !== frozen.malkonto ||
      digest({
        namn: selected.targetName,
        aktiv: selected.targetActive,
        momskod: selected.targetVatCode,
        ar: selected.targetYear,
      }) !== digest(frozen.ogonblick)
    )
      return reject()
  }
  const org = await tx.organization.findUnique({
    where: { id: organizationId },
    select: { billingCutoverDate: true },
  })
  if (!org || (org.billingCutoverDate && entry.date < org.billingCutoverDate)) return reject()
}
