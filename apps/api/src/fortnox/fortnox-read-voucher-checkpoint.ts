import { ConflictException } from '@nestjs/common'
import { Prisma, type FortnoxReadManifestPage, type FortnoxReadRun } from '@prisma/client'
import {
  checkpointDigest,
  ManifestEntriesSchema,
  NormalizedVoucherSchema,
} from './fortnox-read-checkpoint-context'
import {
  isPosInt,
  validateLedgerVoucher,
  voucherKey,
  type ValidatedLedgerVoucher,
} from './fortnox-ledger-validation'
import type { FortnoxVoucher } from './fortnox.types'

type Tx = Prisma.TransactionClient
export type VoucherManifestPage = {
  page: number
  totalPages: number
  totalResources: number
  itemCount: number
  entries: Array<{ key: string; digest: string }>
  digest: string
}
export type VoucherManifestReceipt = {
  runId: string
  pageId: string
  page: number
  digest: string
}
export type ManifestRunScope = Pick<
  FortnoxReadRun,
  'id' | 'organizationId' | 'financialYearId' | 'phase' | 'nextManifestPage'
>
export type ManifestAppendResult =
  | { kind: 'REPLAY'; receipt: VoucherManifestReceipt }
  | {
      kind: 'APPENDED'
      receipt: VoucherManifestReceipt
      progress: { phase: 'MANIFEST' | 'DETAILS' | 'READY_TO_REDUCE'; nextManifestPage: number }
    }
  | { kind: 'CONFLICT' }
  | { kind: 'WRONG_POSITION' }
export type VoucherDetailReceipt = {
  runId: string
  checkpointId: string
  key: string
  detailDigest: string
}
export type VoucherDetailAppendResult =
  | { kind: 'REPLAY'; receipt: VoucherDetailReceipt }
  | {
      kind: 'WRITTEN'
      receipt: VoucherDetailReceipt
      nextPhase: 'DETAILS' | 'READY_TO_REDUCE'
    }
  | { kind: 'CONFLICT' }
  | { kind: 'MISSING' }
  | { kind: 'WRONG_POSITION' }
type VoucherFinancialYear = Parameters<typeof validateLedgerVoucher>[2]
type DetailRow = { key: string; detailDigest: string | null; validated: Prisma.JsonValue | null }
export type ValidatedVoucherPageResult =
  | { kind: 'VALID'; items: ValidatedLedgerVoucher[] }
  | { kind: 'INVALID' }

/** V1:s befintliga parser. Behåller metadataregler och hela listobjektets hash. */
export function parseVoucherManifestPage(
  envelope: unknown,
  financialYearId: number,
): VoucherManifestPage | null {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null
  const body = envelope as Record<string, unknown>
  const meta = body.MetaInformation
  if (
    !meta ||
    typeof meta !== 'object' ||
    Array.isArray(meta) ||
    !Array.isArray(body.Vouchers) ||
    body.Vouchers.length > 100
  )
    return null
  const metadata = meta as Record<string, unknown>
  const page = metadata['@CurrentPage'],
    totalPages = metadata['@TotalPages'],
    totalResources = metadata['@TotalResources']
  if (
    !isPosInt(page) ||
    !isPosInt(totalPages) ||
    !isPosInt(totalResources) ||
    !Number.isSafeInteger(page) ||
    !Number.isSafeInteger(totalPages) ||
    !Number.isSafeInteger(totalResources) ||
    page < 1
  )
    return null
  if (
    totalPages === 0
      ? !(page === 1 && totalResources === 0 && body.Vouchers.length === 0)
      : page > totalPages
  )
    return null
  const entries: Array<{ key: string; digest: string }> = []
  for (const raw of body.Vouchers) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const key = voucherKey(raw as FortnoxVoucher)
    if (!key || Number(key.split('|')[0]) !== financialYearId) return null
    entries.push({ key, digest: checkpointDigest(raw) })
  }
  if (!ManifestEntriesSchema.safeParse(entries).success) return null
  const normalized = { page, totalPages, totalResources, itemCount: entries.length, entries }
  return { ...normalized, digest: checkpointDigest(normalized) }
}

function storedPageValid(row: FortnoxReadManifestPage): boolean {
  const entries = ManifestEntriesSchema.safeParse(row.entries)
  return (
    entries.success &&
    row.itemCount === entries.data.length &&
    row.digest ===
      checkpointDigest({
        page: row.page,
        totalPages: row.totalPages,
        totalResources: row.totalResources,
        itemCount: row.itemCount,
        entries: row.entries,
      })
  )
}

function receipt(
  run: ManifestRunScope,
  pageId: string,
  page: number,
  digest: string,
): VoucherManifestReceipt {
  return { runId: run.id, pageId, page, digest }
}

/** Caller håller run/fence. Bara barnskrivningar; run-progress ägs av serviceversionen. */
export async function appendVoucherManifestPage(
  tx: Tx,
  run: ManifestRunScope,
  page: VoucherManifestPage,
): Promise<ManifestAppendResult> {
  const previous = await tx.fortnoxReadManifestPage.findUnique({
    where: {
      runId_page: { runId: run.id, page: page.page },
      organizationId: run.organizationId,
    },
  })
  if (previous) {
    if (
      !storedPageValid(previous) ||
      previous.itemCount !== page.entries.length ||
      previous.digest !== page.digest
    )
      return { kind: 'CONFLICT' }
    return { kind: 'REPLAY', receipt: receipt(run, previous.id, previous.page, previous.digest) }
  }
  if (run.phase !== 'MANIFEST' || run.nextManifestPage !== page.page)
    return { kind: 'WRONG_POSITION' }
  const first = await tx.fortnoxReadManifestPage.findUnique({
    where: { runId_page: { runId: run.id, page: 1 }, organizationId: run.organizationId },
  })
  if (
    first &&
    (first.totalPages !== page.totalPages || first.totalResources !== page.totalResources)
  )
    return { kind: 'CONFLICT' }
  // Alla innehållskonflikter kontrolleras före INSERT, högst100 inkommande poster.
  const unique = new Map<string, string>()
  for (const entry of page.entries) {
    const duplicate = unique.get(entry.key)
    if (duplicate && duplicate !== entry.digest) return { kind: 'CONFLICT' }
    unique.set(entry.key, entry.digest)
  }
  const existing = await tx.fortnoxReadVoucherCheckpoint.findMany({
    where: {
      organizationId: run.organizationId,
      runId: run.id,
      key: { in: [...unique.keys()] },
    },
    select: { key: true, manifestDigest: true },
  })
  if (existing.some((entry) => unique.get(entry.key) !== entry.manifestDigest))
    return { kind: 'CONFLICT' }
  const existingKeys = new Set(existing.map((entry) => entry.key))
  const added = [...unique].filter(([key]) => !existingKeys.has(key))
  const last = page.totalPages === 0 || page.page === page.totalPages
  if (last) {
    const stored = await tx.fortnoxReadVoucherCheckpoint.count({
      where: { organizationId: run.organizationId, runId: run.id },
    })
    if (stored + added.length !== page.totalResources) return { kind: 'CONFLICT' }
  }
  const created = await tx.fortnoxReadManifestPage.create({
    data: {
      organizationId: run.organizationId,
      runId: run.id,
      ...page,
      entries: page.entries as Prisma.InputJsonValue,
    },
    select: { id: true },
  })
  if (added.length)
    await tx.fortnoxReadVoucherCheckpoint.createMany({
      data: added.map(([key, manifestDigest]) => ({
        organizationId: run.organizationId,
        runId: run.id,
        key,
        manifestDigest,
      })),
    })
  return {
    kind: 'APPENDED',
    receipt: receipt(run, created.id, page.page, page.digest),
    progress: {
      nextManifestPage: page.page + 1,
      phase: last ? (page.totalResources === 0 ? 'READY_TO_REDUCE' : 'DETAILS') : 'MANIFEST',
    },
  }
}

/** Faktiskt lagringskvitto; ingen nyckelinfogning eller aktuell-cursorregel på replay. */
export async function readVoucherManifestReceipt(
  tx: Tx,
  run: ManifestRunScope,
  page: number,
  expectedDigest: string,
): Promise<VoucherManifestReceipt> {
  const row = await tx.fortnoxReadManifestPage.findUnique({
    where: { runId_page: { runId: run.id, page }, organizationId: run.organizationId },
  })
  if (
    !row ||
    row.organizationId !== run.organizationId ||
    row.runId !== run.id ||
    row.page !== page ||
    !storedPageValid(row) ||
    row.digest !== expectedDigest
  )
    throw new ConflictException('Sparat manifestunderlag är ofullständigt eller ogiltigt')
  return receipt(run, row.id, row.page, row.digest)
}

export async function nextVoucherKey(tx: Tx, run: ManifestRunScope): Promise<string | null> {
  const [next] = await tx.$queryRaw<
    Array<{ key: string }>
  >`SELECT "key" FROM "FortnoxReadVoucherCheckpoint" WHERE "organizationId" = ${run.organizationId} AND "runId" = ${run.id} AND "detailDigest" IS NULL ORDER BY "key" COLLATE "C" ASC LIMIT 1`
  return next?.key ?? null
}

/** V1:s detaljvalidering, före lookup/position och utan DB-arbete i catch. */
export function parseVoucherDetail(
  key: string,
  voucher: FortnoxVoucher | undefined,
  financialYear: VoucherFinancialYear,
): ValidatedLedgerVoucher | null {
  try {
    return NormalizedVoucherSchema.parse(validateLedgerVoucher(key, voucher, financialYear))
  } catch {
    return null
  }
}

function detailReceipt(
  run: ManifestRunScope,
  checkpointId: string,
  key: string,
  detailDigest: string,
): VoucherDetailReceipt {
  return { runId: run.id, checkpointId, key, detailDigest }
}

/** Normalformen, inte manifestets rålistdigest, är identitet vid detaljreplay. */
export async function appendVoucherDetail(
  tx: Tx,
  run: ManifestRunScope,
  validated: ValidatedLedgerVoucher,
  now: Date,
): Promise<VoucherDetailAppendResult> {
  const key = validated.key
  const detailDigest = checkpointDigest(validated)
  const checkpoint = await tx.fortnoxReadVoucherCheckpoint.findUnique({
    where: { runId_key: { runId: run.id, key }, organizationId: run.organizationId },
  })
  if (!checkpoint) return { kind: 'MISSING' }
  if (checkpoint.detailDigest !== null) {
    if (
      !NormalizedVoucherSchema.safeParse(checkpoint.validated).success ||
      checkpoint.detailDigest !== detailDigest ||
      checkpointDigest(checkpoint.validated) !== detailDigest
    )
      return { kind: 'CONFLICT' }
    return {
      kind: 'REPLAY',
      receipt: detailReceipt(run, checkpoint.id, key, detailDigest),
    }
  }
  if (run.phase !== 'DETAILS' || (await nextVoucherKey(tx, run)) !== key)
    return { kind: 'WRONG_POSITION' }
  const written = await tx.fortnoxReadVoucherCheckpoint.update({
    where: { id: checkpoint.id, organizationId: run.organizationId },
    data: { validated: validated as Prisma.InputJsonValue, detailDigest, observedAt: now },
    select: { id: true },
  })
  const next = await nextVoucherKey(tx, run)
  return {
    kind: 'WRITTEN',
    receipt: detailReceipt(run, written.id, key, detailDigest),
    nextPhase: next ? 'DETAILS' : 'READY_TO_REDUCE',
  }
}

function checkedDetail(
  row: DetailRow,
  financialYear: VoucherFinancialYear,
): ValidatedLedgerVoucher | null {
  const detail = NormalizedVoucherSchema.safeParse(row.validated)
  if (
    !detail.success ||
    detail.data.key !== row.key ||
    Number(row.key.split('|')[0]) !== financialYear.id ||
    detail.data.date < financialYear.fromDate ||
    detail.data.date > financialYear.toDate ||
    row.detailDigest !== checkpointDigest(detail.data)
  )
    return null
  return detail.data
}

/** Separat DB-kvitto över den verkliga raden, även efter replay/ny lease. */
export async function readVoucherDetailReceipt(
  tx: Tx,
  run: ManifestRunScope,
  financialYear: VoucherFinancialYear,
  key: string,
  expectedDigest: string,
): Promise<VoucherDetailReceipt> {
  const row = await tx.fortnoxReadVoucherCheckpoint.findUnique({
    where: { runId_key: { runId: run.id, key }, organizationId: run.organizationId },
  })
  if (
    !row ||
    row.organizationId !== run.organizationId ||
    row.runId !== run.id ||
    row.key !== key ||
    row.detailDigest !== expectedDigest ||
    !(row.observedAt instanceof Date) ||
    !Number.isFinite(row.observedAt.getTime()) ||
    !checkedDetail(row, financialYear)
  )
    throw new ConflictException('Sparat detaljunderlag är ofullständigt eller ogiltigt')
  return detailReceipt(run, row.id, row.key, expectedDigest)
}

/** Caller validerar options/fas och äger fence samt policy för lagringskorruption. */
export async function readValidatedVoucherPage(
  tx: Tx,
  run: ManifestRunScope,
  financialYear: VoucherFinancialYear,
  options: { afterKey?: string | undefined; limit?: number | undefined },
): Promise<ValidatedVoucherPageResult> {
  const afterKey = options.afterKey ?? null
  const limit = options.limit ?? 100
  const rows = await tx.$queryRaw<DetailRow[]>`
    SELECT "key", "detailDigest", "validated" FROM "FortnoxReadVoucherCheckpoint"
    WHERE "organizationId" = ${run.organizationId} AND "runId" = ${run.id}
      ${afterKey === null ? Prisma.empty : Prisma.sql`AND "key" COLLATE "C" > ${afterKey}::text COLLATE "C"`}
    ORDER BY "key" COLLATE "C" ASC LIMIT ${limit}`
  const items: ValidatedLedgerVoucher[] = []
  for (const row of rows) {
    const detail = checkedDetail(row, financialYear)
    if (!detail) return { kind: 'INVALID' }
    items.push(detail)
  }
  return { kind: 'VALID', items }
}
