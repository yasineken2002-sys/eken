import { BadRequestException, ConflictException, Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { Prisma, type FortnoxConnection, type FortnoxReadRun } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { kallkonton } from './fortnox-read-provenance'
import {
  isPosInt,
  validateLedgerVoucher,
  voucherKey,
  type ValidatedLedgerVoucher,
} from './fortnox-ledger-validation'
import type { FortnoxVoucher } from './fortnox.types'
import {
  canonicalCheckpointInput,
  checkpointDigest,
  CheckpointCatalogSchema,
  CheckpointContextSchema,
  CheckpointReadPageSchema,
  ManifestEntriesSchema,
  NormalizedVoucherSchema,
  type CheckpointCatalog,
  type StartCheckpointInput,
} from './fortnox-read-checkpoint-context'

export type { StartCheckpointInput } from './fortnox-read-checkpoint-context'
export interface CheckpointLease {
  organizationId: string
  runId: string
  claimVersion: number
  claimToken: string
}
export type CheckpointStep =
  | { phase: 'CATALOG' }
  | { phase: 'MANIFEST'; page: number }
  | { phase: 'DETAILS'; key: string }
  | { phase: 'READY_TO_REDUCE' }

const REASONS = {
  CONNECTION_CHANGED: 'Fortnox-anslutningen har ändrats; starta en ny läsning.',
  INVALID_CONTEXT: 'Sparat läsunderlag är ogiltigt; starta en ny läsning.',
  CATALOG_CONFLICT: 'Katalogunderlaget ändrades under läsningen.',
  MANIFEST_CONFLICT: 'Verifikationslistan är ofullständig eller ändrades under läsningen.',
  DETAIL_CONFLICT: 'Verifikationsdetaljen är ogiltig eller ändrades under läsningen.',
  AUTH_LOST: 'Fortnox-inloggningen har upphört; anslut igen.',
  WRONG_COMPANY: 'Fortnox svarade för ett annat företag.',
  TRANSIENT: 'Läsningen väntar efter ett tillfälligt fel.',
  RATE_LIMITED: 'Läsningen väntar på Fortnox anropsgräns.',
} as const
type TerminalReason = Exclude<keyof typeof REASONS, 'TRANSIENT' | 'RATE_LIMITED'>
type Tx = Prisma.TransactionClient
type ConnectionBinding = Pick<
  FortnoxConnection,
  'id' | 'organizationId' | 'status' | 'generation' | 'fortnoxDatabaseNumber' | 'fortnoxOrgNumber'
>
type Locked = { run: FortnoxReadRun; connection: ConnectionBinding | null; now: Date }
const LEASE_MS = 60_000
const json = (value: unknown) => value as Prisma.InputJsonValue
const date = (value: string) => new Date(`${value}T00:00:00Z`)

/**
 * En lokal checkpointkärna utan HTTP-, kö- eller modulkoppling. Samordnar bara
 * workVersion=1; den äldre endpointens samtidighet och tidsgräns är oförändrade.
 * Inga token, fria API-kroppar eller ekonomiska delsummeringar lagras här.
 */
@Injectable()
export class FortnoxReadCheckpointService {
  constructor(private readonly prisma: PrismaService) {}

  async start(organizationId: string, userId: string | null, input: StartCheckpointInput) {
    let canonical: StartCheckpointInput
    try {
      canonical = canonicalCheckpointInput(input)
    } catch {
      throw new BadRequestException('Ogiltigt urval för Fortnox-läsning')
    }
    const requestHash = checkpointDigest(canonical)
    return this.prisma.$transaction(async (tx) => {
      const connection = await this.lockConnection(tx, organizationId)
      if (!connection || connection.status !== 'ACTIVE')
        throw new ConflictException('Ingen aktiv Fortnox-anslutning')
      const now = await this.databaseNow(tx)
      const existing = await tx.fortnoxReadRun.findFirst({
        where: { organizationId, workVersion: 1, status: 'RUNNING' },
      })
      if (existing) {
        await tx.$queryRaw`SELECT "id" FROM "FortnoxReadRun" WHERE "id" = ${existing.id} AND "organizationId" = ${organizationId} FOR UPDATE`
        if (!this.sameConnection(existing, connection)) {
          await this.terminal(tx, existing, now, 'CONNECTION_CHANGED')
        } else if (!this.validContext(existing)) {
          await this.terminal(tx, existing, now, 'INVALID_CONTEXT')
        } else {
          if (existing.requestHash !== requestHash)
            throw new ConflictException('En annan Fortnox-läsning pågår redan')
          return existing
        }
      }

      const mappings = await tx.fortnoxDimensionMapping.findMany({
        where: { organizationId, property: { organizationId } },
        select: {
          dimensionType: true,
          code: true,
          propertyId: true,
          property: { select: { name: true } },
        },
        orderBy: [{ dimensionType: 'asc' }, { code: 'asc' }],
      })
      const exported = await tx.fortnoxVoucherExport.findMany({
        where: {
          organizationId,
          state: 'CONFIRMED',
          journalEntry: { organizationId },
          fortnoxDatabaseNumber: connection.fortnoxDatabaseNumber,
          externalYear: canonical.financialYearId,
          externalSeries: { not: null },
          externalNumber: { not: null },
        },
        select: {
          externalYear: true,
          externalSeries: true,
          externalNumber: true,
          journalEntryId: true,
          draft: true,
        },
        orderBy: { id: 'asc' },
      })
      const frozenContext = CheckpointContextSchema.parse({
        version: 1,
        input: canonical,
        mappings: mappings.map((m) => ({
          type: m.dimensionType,
          code: m.code,
          propertyId: m.propertyId,
          propertyName: m.property.name,
        })),
        ownExports: exported.map((e) => {
          const source = kallkonton(e.draft)
          return {
            voucher: `${e.externalYear}|${e.externalSeries}|${e.externalNumber}`,
            journalEntryId: e.journalEntryId,
            revision: source.revision,
            perMal: [...source.perMal].map(([account, sources]) => ({ account, sources })),
          }
        }),
      })
      return tx.fortnoxReadRun.create({
        data: {
          organizationId,
          connectionId: connection.id,
          connectionGeneration: connection.generation,
          fortnoxDatabaseNumber: connection.fortnoxDatabaseNumber,
          fortnoxOrgNumber: connection.fortnoxOrgNumber,
          workVersion: 1,
          phase: 'CATALOG',
          requestHash,
          frozenContext: json(frozenContext),
          financialYearId: canonical.financialYearId,
          periodFrom: date(canonical.periodFrom),
          periodTo: date(canonical.periodTo),
          costAccounts: canonical.costAccounts,
          triggeredByUserId: userId,
          checkpointUpdatedAt: now,
        },
      })
    }, PRISMA_DEFAULT_TX_LIMITS)
  }

  async claim(organizationId: string, runId: string): Promise<CheckpointLease | null> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lockRun(tx, organizationId, runId)
      const { run, connection, now } = locked
      if (run.status !== 'RUNNING' || run.workVersion !== 1) return null
      if (!this.sameConnection(run, connection)) {
        await this.terminal(tx, run, now, 'CONNECTION_CHANGED')
        return null
      }
      if (!this.validContext(run)) {
        await this.terminal(tx, run, now, 'INVALID_CONTEXT')
        return null
      }
      if (
        (run.leaseUntil && run.leaseUntil > now) ||
        (run.nextAttemptAt && run.nextAttemptAt > now)
      )
        return null
      const updated = await tx.fortnoxReadRun.update({
        where: { id: run.id, organizationId },
        data: {
          claimVersion: { increment: 1 },
          claimToken: randomUUID(),
          leaseUntil: new Date(now.getTime() + LEASE_MS),
          nextAttemptAt: null,
          reason: null,
          checkpointUpdatedAt: now,
        },
      })
      return {
        organizationId,
        runId,
        claimVersion: updated.claimVersion,
        claimToken: updated.claimToken!,
      }
    }, PRISMA_DEFAULT_TX_LIMITS)
  }

  async commitCatalog(lease: CheckpointLease, input: unknown): Promise<FortnoxReadRun> {
    return this.withLease(lease, async (tx, { run, now }) => {
      const parsed = CheckpointCatalogSchema.safeParse(input)
      if (!parsed.success || !this.catalogMatches(run, parsed.data))
        return this.terminal(tx, run, now, 'CATALOG_CONFLICT')
      if (run.catalog !== null) {
        if (checkpointDigest(run.catalog) !== checkpointDigest(parsed.data))
          return this.terminal(tx, run, now, 'CATALOG_CONFLICT')
        return run
      }
      if (run.phase !== 'CATALOG')
        throw new ConflictException('Katalogen hör inte till aktuellt lässteg')
      return tx.fortnoxReadRun.update({
        where: { id: run.id, organizationId: run.organizationId },
        data: {
          catalog: json(parsed.data),
          phase: 'MANIFEST',
          financialYearStart: date(parsed.data.financialYear.fromDate),
          financialYearEnd: date(parsed.data.financialYear.toDate),
          checkpointUpdatedAt: now,
        },
      })
    })
  }

  async commitVoucherPage(lease: CheckpointLease, envelope: unknown): Promise<FortnoxReadRun> {
    return this.withLease(lease, async (tx, { run, now }) => {
      const page = this.normalizePage(envelope, run.financialYearId)
      if (!page) return this.terminal(tx, run, now, 'MANIFEST_CONFLICT')
      const previous = await tx.fortnoxReadManifestPage.findUnique({
        where: {
          runId_page: { runId: run.id, page: page.page },
          organizationId: run.organizationId,
        },
      })
      if (previous) {
        if (
          !ManifestEntriesSchema.safeParse(previous.entries).success ||
          previous.itemCount !== page.entries.length ||
          previous.digest !==
            checkpointDigest({
              page: previous.page,
              totalPages: previous.totalPages,
              totalResources: previous.totalResources,
              itemCount: previous.itemCount,
              entries: previous.entries,
            }) ||
          previous.digest !== page.digest
        )
          return this.terminal(tx, run, now, 'MANIFEST_CONFLICT')
        return run
      }
      if (run.phase !== 'MANIFEST' || run.nextManifestPage !== page.page)
        throw new ConflictException('Verifikationssidan hör inte till aktuellt lässteg')
      const first = await tx.fortnoxReadManifestPage.findUnique({
        where: { runId_page: { runId: run.id, page: 1 }, organizationId: run.organizationId },
      })
      if (
        first &&
        (first.totalPages !== page.totalPages || first.totalResources !== page.totalResources)
      )
        return this.terminal(tx, run, now, 'MANIFEST_CONFLICT')
      // Kontrollera alla konflikter innan någon barnrad skrivs. Högst 100 objekt.
      const unique = new Map<string, string>()
      for (const entry of page.entries) {
        const duplicate = unique.get(entry.key)
        if (duplicate && duplicate !== entry.digest)
          return this.terminal(tx, run, now, 'MANIFEST_CONFLICT')
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
      if (existing.some((e) => unique.get(e.key) !== e.manifestDigest))
        return this.terminal(tx, run, now, 'MANIFEST_CONFLICT')
      const existingKeys = new Set(existing.map((e) => e.key))
      const added = [...unique].filter(([key]) => !existingKeys.has(key))
      const last = page.totalPages === 0 || page.page === page.totalPages
      if (last) {
        const stored = await tx.fortnoxReadVoucherCheckpoint.count({
          where: { organizationId: run.organizationId, runId: run.id },
        })
        if (stored + added.length !== page.totalResources)
          return this.terminal(tx, run, now, 'MANIFEST_CONFLICT')
      }
      await tx.fortnoxReadManifestPage.create({
        data: {
          organizationId: run.organizationId,
          runId: run.id,
          ...page,
          entries: json(page.entries),
        },
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
      return tx.fortnoxReadRun.update({
        where: { id: run.id, organizationId: run.organizationId },
        data: {
          nextManifestPage: page.page + 1,
          phase: last ? (page.totalResources === 0 ? 'READY_TO_REDUCE' : 'DETAILS') : 'MANIFEST',
          checkpointUpdatedAt: now,
        },
      })
    })
  }

  async commitVoucherDetail(
    lease: CheckpointLease,
    key: string,
    voucher: FortnoxVoucher | undefined,
  ): Promise<FortnoxReadRun> {
    return this.withLease(lease, async (tx, { run, now }) => {
      const catalog = CheckpointCatalogSchema.parse(run.catalog)
      let validated
      try {
        validated = NormalizedVoucherSchema.parse(
          validateLedgerVoucher(key, voucher, catalog.financialYear),
        )
      } catch {
        return this.terminal(tx, run, now, 'DETAIL_CONFLICT')
      }
      const detailDigest = checkpointDigest(validated)
      const checkpoint = await tx.fortnoxReadVoucherCheckpoint.findUnique({
        where: { runId_key: { runId: run.id, key }, organizationId: run.organizationId },
      })
      if (!checkpoint) throw new ConflictException('Verifikatet saknas i det sparade manifestet')
      if (checkpoint.detailDigest !== null) {
        if (
          !NormalizedVoucherSchema.safeParse(checkpoint.validated).success ||
          checkpoint.detailDigest !== detailDigest ||
          checkpointDigest(checkpoint.validated) !== detailDigest
        )
          return this.terminal(tx, run, now, 'DETAIL_CONFLICT')
        return run
      }
      if (run.phase !== 'DETAILS' || (await this.nextKey(tx, run)) !== key)
        throw new ConflictException('Verifikatet hör inte till aktuellt lässteg')
      await tx.fortnoxReadVoucherCheckpoint.update({
        where: { id: checkpoint.id, organizationId: run.organizationId },
        data: { validated: json(validated), detailDigest, observedAt: now },
      })
      const next = await this.nextKey(tx, run)
      return tx.fortnoxReadRun.update({
        where: { id: run.id, organizationId: run.organizationId },
        data: { phase: next ? 'DETAILS' : 'READY_TO_REDUCE', checkpointUpdatedAt: now },
      })
    })
  }

  async nextStep(lease: CheckpointLease): Promise<CheckpointStep> {
    return this.withLease(lease, async (tx, { run }) => {
      if (run.phase === 'CATALOG') return { phase: 'CATALOG' }
      if (run.phase === 'MANIFEST') return { phase: 'MANIFEST', page: run.nextManifestPage }
      if (run.phase === 'READY_TO_REDUCE') return { phase: 'READY_TO_REDUCE' }
      const key = await this.nextKey(tx, run)
      if (!key) throw new ConflictException('Sparat detaljsteg saknar nästa verifikat')
      return { phase: 'DETAILS', key }
    })
  }

  /** En avgränsad, verifierad lässida för en senare reducerare; ingen publicering. */
  async readValidatedPage(
    lease: CheckpointLease,
    options: { afterKey?: string; limit?: number } = {},
  ): Promise<ValidatedLedgerVoucher[]> {
    const parsed = CheckpointReadPageSchema.safeParse(options)
    if (!parsed.success) throw new BadRequestException('Ogiltig detaljsida')
    const afterKey = parsed.data.afterKey ?? null
    const limit = parsed.data.limit ?? 100
    const result = await this.withLease(lease, async (tx, { run, now }) => {
      if (run.phase !== 'READY_TO_REDUCE')
        throw new ConflictException('Alla detaljer är inte sparade')
      const catalog = CheckpointCatalogSchema.parse(run.catalog)
      const rows = await tx.$queryRaw<
        Array<{ key: string; detailDigest: string | null; validated: Prisma.JsonValue | null }>
      >`
        SELECT "key", "detailDigest", "validated" FROM "FortnoxReadVoucherCheckpoint"
        WHERE "organizationId" = ${run.organizationId} AND "runId" = ${run.id}
          AND (${afterKey}::text IS NULL OR "key" COLLATE "C" > ${afterKey}::text COLLATE "C")
        ORDER BY "key" COLLATE "C" ASC LIMIT ${limit}`
      const items: ValidatedLedgerVoucher[] = []
      for (const row of rows) {
        const detail = NormalizedVoucherSchema.safeParse(row.validated)
        if (
          !detail.success ||
          detail.data.key !== row.key ||
          Number(row.key.split('|')[0]) !== catalog.financialYear.id ||
          detail.data.date < catalog.financialYear.fromDate ||
          detail.data.date > catalog.financialYear.toDate ||
          row.detailDigest !== checkpointDigest(detail.data)
        ) {
          await this.terminal(tx, run, now, 'INVALID_CONTEXT')
          return { valid: false as const }
        }
        items.push(detail.data)
      }
      return { valid: true as const, items }
    })
    if (!result.valid) throw new ConflictException(REASONS.INVALID_CONTEXT)
    return result.items
  }

  async release(lease: CheckpointLease): Promise<void> {
    await this.withLease(lease, async (tx, { run, now }) => {
      await tx.fortnoxReadRun.update({
        where: { id: run.id, organizationId: run.organizationId },
        data: { claimToken: null, leaseUntil: null, checkpointUpdatedAt: now },
      })
    })
  }

  async suspend(
    lease: CheckpointLease,
    reason: 'TRANSIENT' | 'RATE_LIMITED',
    retryAt: Date,
  ): Promise<void> {
    if (
      !['TRANSIENT', 'RATE_LIMITED'].includes(reason) ||
      !(retryAt instanceof Date) ||
      !Number.isFinite(retryAt.getTime())
    )
      throw new BadRequestException('Ogiltig återupptagningstid')
    await this.withLease(lease, async (tx, { run, now }) => {
      if (retryAt <= now) throw new BadRequestException('Återupptagningstiden måste ligga framåt')
      await tx.fortnoxReadRun.update({
        where: { id: run.id, organizationId: run.organizationId },
        data: {
          reason: REASONS[reason],
          claimToken: null,
          leaseUntil: null,
          nextAttemptAt: retryAt,
          checkpointUpdatedAt: now,
        },
      })
    })
  }

  async invalidate(
    lease: CheckpointLease,
    reason: 'AUTH_LOST' | 'WRONG_COMPANY' | 'INVALID_CONTEXT',
  ): Promise<void> {
    if (!['AUTH_LOST', 'WRONG_COMPANY', 'INVALID_CONTEXT'].includes(reason))
      throw new BadRequestException('Ogiltig slutorsak')
    await this.withLease(lease, async (tx, { run, now }) => {
      await this.terminal(tx, run, now, reason)
    })
  }

  private async withLease<T>(
    lease: CheckpointLease,
    action: (tx: Tx, locked: Locked) => Promise<T>,
  ): Promise<T> {
    const result = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockRun(tx, lease.organizationId, lease.runId)
      const { run, connection, now } = locked
      // Fencing kontrolleras även före identisk replay och före terminalmarkering.
      if (
        run.workVersion !== 1 ||
        run.status !== 'RUNNING' ||
        run.claimVersion !== lease.claimVersion ||
        run.claimToken !== lease.claimToken ||
        !run.leaseUntil ||
        run.leaseUntil <= now
      )
        throw new ConflictException('Läsanspråket har upphört')
      const reason = !this.sameConnection(run, connection)
        ? 'CONNECTION_CHANGED'
        : !this.validContext(run)
          ? 'INVALID_CONTEXT'
          : null
      if (reason) {
        await this.terminal(tx, run, now, reason)
        return { ok: false as const, reason }
      }
      return { ok: true as const, value: await action(tx, locked) }
    }, PRISMA_DEFAULT_TX_LIMITS)
    // Kasta först efter commit så det varaktiga stoppet inte rullas tillbaka.
    if (!result.ok) throw new ConflictException(REASONS[result.reason])
    return result.value
  }

  private async lockConnection(tx: Tx, organizationId: string) {
    await tx.$queryRaw`SELECT "id" FROM "FortnoxConnection" WHERE "organizationId" = ${organizationId} FOR UPDATE`
    return tx.fortnoxConnection.findUnique({
      where: { organizationId },
      select: {
        id: true,
        organizationId: true,
        status: true,
        generation: true,
        fortnoxDatabaseNumber: true,
        fortnoxOrgNumber: true,
      },
    })
  }

  private async lockRun(tx: Tx, organizationId: string, runId: string): Promise<Locked> {
    const connection = await this.lockConnection(tx, organizationId)
    await tx.$queryRaw`SELECT "id" FROM "FortnoxReadRun" WHERE "id" = ${runId} AND "organizationId" = ${organizationId} FOR UPDATE`
    const run = await tx.fortnoxReadRun.findUnique({ where: { id: runId, organizationId } })
    if (!run) throw new ConflictException('Läsningen finns inte i organisationen')
    return { run, connection, now: await this.databaseNow(tx) }
  }

  private async databaseNow(tx: Tx): Promise<Date> {
    const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`
    if (!row) throw new Error('Databasklockan saknas')
    return row.now
  }

  private sameConnection(run: FortnoxReadRun, connection: ConnectionBinding | null): boolean {
    return (
      connection !== null &&
      connection.status === 'ACTIVE' &&
      connection.organizationId === run.organizationId &&
      connection.id === run.connectionId &&
      connection.generation === run.connectionGeneration &&
      connection.fortnoxDatabaseNumber === run.fortnoxDatabaseNumber &&
      connection.fortnoxOrgNumber === run.fortnoxOrgNumber
    )
  }

  private validContext(run: FortnoxReadRun): boolean {
    if (
      run.workVersion !== 1 ||
      !['CATALOG', 'MANIFEST', 'DETAILS', 'READY_TO_REDUCE'].includes(run.phase ?? '') ||
      !Number.isSafeInteger(run.nextManifestPage) ||
      run.nextManifestPage < 1 ||
      !Number.isSafeInteger(run.claimVersion) ||
      run.claimVersion < 0 ||
      run.summary !== null ||
      run.rows !== null
    )
      return false
    const parsed = CheckpointContextSchema.safeParse(run.frozenContext)
    if (!parsed.success) return false
    const input = parsed.data.input
    if (
      checkpointDigest(canonicalCheckpointInput(input)) !== run.requestHash ||
      input.financialYearId !== run.financialYearId ||
      input.periodFrom !== run.periodFrom.toISOString().slice(0, 10) ||
      input.periodTo !== run.periodTo.toISOString().slice(0, 10) ||
      checkpointDigest(input.costAccounts) !== checkpointDigest(run.costAccounts)
    )
      return false
    if (run.catalog === null) return run.phase === 'CATALOG'
    const catalog = CheckpointCatalogSchema.safeParse(run.catalog)
    return (
      run.phase !== 'CATALOG' &&
      catalog.success &&
      this.catalogMatches(run, catalog.data) &&
      run.financialYearStart?.toISOString().slice(0, 10) === catalog.data.financialYear.fromDate &&
      run.financialYearEnd?.toISOString().slice(0, 10) === catalog.data.financialYear.toDate
    )
  }

  private catalogMatches(run: FortnoxReadRun, catalog: CheckpointCatalog): boolean {
    const context = CheckpointContextSchema.parse(run.frozenContext)
    const input = context.input
    const year = catalog.financialYear
    if (
      catalog.companyDatabaseNumber !== run.fortnoxDatabaseNumber ||
      year.id !== run.financialYearId ||
      year.fromDate > year.toDate ||
      input.periodFrom < year.fromDate ||
      input.periodTo > year.toDate ||
      (input.financialYearStart !== undefined && input.financialYearStart !== year.fromDate) ||
      (input.financialYearEnd !== undefined && input.financialYearEnd !== year.toDate)
    )
      return false
    const accounts = new Set(catalog.accounts.map((a) => a.number))
    if (
      accounts.size !== catalog.accounts.length ||
      accounts.size !== run.costAccounts.length ||
      run.costAccounts.some((a) => !accounts.has(a)) ||
      catalog.accounts.some((a) => a.active === false)
    )
      return false
    for (const [type, coverage] of [
      ['COST_CENTER', catalog.coverage.costCenters],
      ['PROJECT', catalog.coverage.projects],
    ] as const) {
      const codes = catalog.dimensions.filter((d) => d.type === type).map((d) => d.code)
      if (!coverage) {
        if (codes.length || context.mappings.some((m) => m.type === type)) return false
        continue
      }
      if (
        new Set(codes).size !== codes.length ||
        coverage.totalResources !== codes.length ||
        coverage.itemsSeen < codes.length ||
        coverage.pages !== Math.max(1, coverage.totalPages) ||
        (coverage.totalPages === 0 && (coverage.totalResources !== 0 || coverage.itemsSeen !== 0))
      )
        return false
    }
    return true
  }

  private normalizePage(envelope: unknown, financialYearId: number) {
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

  private async nextKey(tx: Tx, run: FortnoxReadRun): Promise<string | null> {
    const [next] = await tx.$queryRaw<
      Array<{ key: string }>
    >`SELECT "key" FROM "FortnoxReadVoucherCheckpoint" WHERE "organizationId" = ${run.organizationId} AND "runId" = ${run.id} AND "detailDigest" IS NULL ORDER BY "key" COLLATE "C" ASC LIMIT 1`
    return next?.key ?? null
  }

  private terminal(
    tx: Tx,
    run: FortnoxReadRun,
    now: Date,
    reason: TerminalReason,
  ): Promise<FortnoxReadRun> {
    const status =
      reason === 'AUTH_LOST'
        ? 'AUTH_LOST'
        : reason === 'WRONG_COMPANY'
          ? 'WRONG_COMPANY'
          : reason === 'CONNECTION_CHANGED' || reason === 'INVALID_CONTEXT'
            ? 'FAILED'
            : 'PARTIAL'
    return tx.fortnoxReadRun.update({
      where: { id: run.id, organizationId: run.organizationId },
      data: {
        status,
        reason: REASONS[reason],
        completedAt: now,
        claimToken: null,
        leaseUntil: null,
        nextAttemptAt: null,
        checkpointUpdatedAt: now,
        summary: Prisma.DbNull,
        rows: Prisma.DbNull,
      },
    })
  }
}
