import { BadRequestException, ConflictException, Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { Prisma, type FortnoxReadRun } from '@prisma/client'
import { z } from 'zod'
import { PrismaService } from '../common/prisma/prisma.service'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import {
  canonicalCheckpointInput,
  checkpointDigest,
  CheckpointCatalogSchema,
  CheckpointContextSchema,
  CheckpointReadPageSchema,
  type CheckpointCatalog,
  type StartCheckpointInput,
} from './fortnox-read-checkpoint-context'
import { checkpointCatalogMatches } from './fortnox-read-catalog-contract'
import type { ValidatedLedgerVoucher } from './fortnox-ledger-validation'
import { createLedgerAccumulator, LedgerAmountOverflow } from './fortnox-ledger-reducer'
import {
  appendReductionMappings,
  appendReductionOwnExports,
  buildReductionConfig,
  createFrozenReductionMaps,
  DetailReductionProof,
  finishReducedLedger,
  ManifestReductionProof,
  type FrozenReductionMaps,
  type ReadyLedgerReduction,
  type ReductionProof,
} from './fortnox-read-reduction'
export type { ReadyLedgerReduction, ReductionProof } from './fortnox-read-reduction'
import { encodeLedgerPublication, PublicationFormatError } from './fortnox-read-publication-format'
import {
  insertLedgerPublication,
  readStoredLedgerPublication,
  checkedPublicationReceipt,
  type PublicationReceipt,
} from './fortnox-read-publication'
export type { PublicationReceipt } from './fortnox-read-publication'
import type { FortnoxVoucher } from './fortnox.types'
import {
  appendVoucherDetail,
  appendVoucherManifestPage,
  nextVoucherKey,
  parseVoucherDetail,
  parseVoucherManifestPage,
  readValidatedVoucherPage,
  readVoucherDetailReceipt,
  readVoucherManifestReceipt,
  readVoucherManifestPageForReduction,
  type VoucherDetailReceipt,
  type VoucherManifestReceipt,
} from './fortnox-read-voucher-checkpoint'
export type {
  VoucherDetailReceipt,
  VoucherManifestReceipt,
} from './fortnox-read-voucher-checkpoint'
import {
  captureCheckpointSource,
  readCheckpointSourceHeader,
  readCheckpointSourceMappingPage,
  readCheckpointSourceExportPage,
} from './fortnox-read-source-capture'
import {
  normalizeCheckpointPage,
  parseNormalizationPosition,
  parseNormalizedPagePosition,
  prepareNormalizationStage,
  readNormalizationStagePage,
  readCompletedNormalizationStage,
  type NormalizationPage,
  type NormalizationPageReceipt,
  type NormalizationPosition,
  type NormalizationProgress,
  type NormalizedPagePosition,
} from './fortnox-read-normalization-stage'

import { CheckpointContextDigest } from './fortnox-read-context-digest'
import {
  CONTEXT_KINDS,
  CONTEXT_PAGE_SIZE,
  contextBindingDigest,
  contextInitialRoot,
  contextExtendRoot,
  type ContextHeader,
  type ContextKind,
} from './fortnox-read-context-format'
import {
  normalizedContextBinding,
  assertSameNormalizedContextBinding,
  findNormalizedContextHeader,
  assertNormalizedContextHeader,
  NormalizedContextPlanBuilder,
  copyNormalizedContextPages,
  sealNormalizedContext,
  readNormalizedContextPage,
  normalizedContextReceipt,
  invalidNormalizedContext,
  type NormalizedContextBinding,
  type NormalizedContextReceipt,
} from './fortnox-read-normalized-context'

export type { NormalizedContextReceipt } from './fortnox-read-normalized-context'

export type {
  NormalizationPage,
  NormalizationPageReceipt,
  NormalizationPosition,
  NormalizationProgress,
  NormalizedPagePosition,
} from './fortnox-read-normalization-stage'

type Tx = Prisma.TransactionClient
type SourceHeader = Awaited<ReturnType<typeof readCheckpointSourceHeader>>
export type SourceRunLease = {
  organizationId: string
  runId: string
  claimVersion: number
  claimToken: string
  leaseUntil: Date
}
export type SourceRunPageInput = {
  kind: 'MAPPINGS' | 'OWN_EXPORTS'
  afterOrdinal: bigint
}
export type SourceRunPage =
  | Awaited<ReturnType<typeof readCheckpointSourceMappingPage>>
  | Awaited<ReturnType<typeof readCheckpointSourceExportPage>>
export type SourceCatalogStep =
  | {
      kind: 'READ_CATALOG'
      input: StartCheckpointInput
      databaseNumber: number
      readProjects: boolean
    }
  | { kind: 'MANIFEST'; catalog: CheckpointCatalog; nextManifestPage: number }
export type SourceCatalogReceipt = {
  runId: string
  catalogDigest: string
}
export type SourceVoucherStep =
  | { phase: 'MANIFEST'; page: number }
  | { phase: 'DETAILS'; key: string }
  | { phase: 'READY_TO_REDUCE' }
type HeldContextLease = { value: SourceRunLease }
type CatalogContext = {
  held: HeldContextLease
  binding: NormalizedContextBinding
  header: ContextHeader
  hasProjectMapping: boolean
}
const reductionManifestSelect = {
  id: true,
  organizationId: true,
  runId: true,
  page: true,
  totalPages: true,
  totalResources: true,
  itemCount: true,
  digest: true,
} as const satisfies Prisma.FortnoxReadManifestPageSelect
type ReductionManifestHeader = Prisma.FortnoxReadManifestPageGetPayload<{
  select: typeof reductionManifestSelect
}>
type ReductionManifest = {
  pageCount: number
  totalPages: number
  totalResources: number
  nextManifestPage: number
  first: ReductionManifestHeader
  last: ReductionManifestHeader
}
type ReductionBinding = {
  context: NormalizedContextBinding
  header: ContextHeader
  catalog: CheckpointCatalog
  catalogDigest: string
  manifest: ReductionManifest
}
const invalidReduction = () =>
  new ConflictException('Underlaget för reducering är ofullständigt eller ändrades under läsningen')
const MAX_CLAIM_VERSION = 2_147_483_647
const leaseSchema = z
  .object({
    organizationId: z.string().min(1),
    runId: z.string().min(1),
    claimVersion: z.number().int().min(1).max(MAX_CLAIM_VERSION),
    claimToken: z.string().uuid(),
    leaseUntil: z.date(),
  })
  .strict()
const pageSchema = z
  .object({
    kind: z.enum(['MAPPINGS', 'OWN_EXPORTS']),
    afterOrdinal: z.bigint().min(0n),
  })
  .strict()
const connectionSelect = {
  id: true,
  organizationId: true,
  status: true,
  generation: true,
  fortnoxDatabaseNumber: true,
  fortnoxOrgNumber: true,
} as const satisfies Prisma.FortnoxConnectionSelect
type Connection = Prisma.FortnoxConnectionGetPayload<{ select: typeof connectionSelect }>
const conflict = () => new ConflictException('En annan Fortnox-läsning pågår redan')
const invalid = () => new ConflictException('Körningen saknar ett giltigt fryst källunderlag')
const expired = () => new ConflictException('Läsanspråket har upphört')
const CONNECTION_CHANGED = 'Fortnox-anslutningen har ändrats; starta en ny läsning.'
const INVALID_SOURCE = 'Det frysta källunderlaget kan inte normaliseras; starta en ny läsning.'
const CATALOG_CONFLICT = 'Katalogunderlaget ändrades under läsningen.'
const MANIFEST_CONFLICT = 'Verifikationslistan är ofullständig eller ändrades under läsningen.'
const DETAIL_CONFLICT = 'Verifikationsdetaljen är ogiltig eller ändrades under läsningen.'
const INVALID_CONTEXT = 'Sparat läsunderlag är ogiltigt; starta en ny läsning.'
const wrongVoucherStep = () =>
  new ConflictException('Verifikationssidan hör inte till aktuellt lässteg')
const wrongDetailStep = () => new ConflictException('Verifikatet hör inte till aktuellt lässteg')
const wrongCatalogStep = () => new ConflictException('Katalogen hör inte till aktuellt lässteg')
const date = (value: string) => new Date(`${value}T00:00:00Z`)

function canonicalInput(input: StartCheckpointInput): StartCheckpointInput {
  try {
    const { financialYearStart, financialYearEnd, ...required } = canonicalCheckpointInput(input)
    // Samma beständiga JSON-form som capture-helpern, även vid uttryckligt undefined.
    return {
      ...required,
      ...(financialYearStart === undefined ? {} : { financialYearStart }),
      ...(financialYearEnd === undefined ? {} : { financialYearEnd }),
    }
  } catch {
    throw new BadRequestException('Ogiltigt urval för Fortnox-läsning')
  }
}

function sameConnection(run: FortnoxReadRun, connection: Connection | null): boolean {
  return (
    connection !== null &&
    connection.status === 'ACTIVE' &&
    run.organizationId === connection.organizationId &&
    run.connectionId === connection.id &&
    run.connectionGeneration === connection.generation &&
    run.fortnoxDatabaseNumber === connection.fortnoxDatabaseNumber &&
    run.fortnoxOrgNumber === connection.fortnoxOrgNumber
  )
}

function checkLeaseShape(run: FortnoxReadRun): void {
  if (
    !Number.isSafeInteger(run.claimVersion) ||
    run.claimVersion < 0 ||
    run.claimVersion > MAX_CLAIM_VERSION
  )
    throw invalid()
  if (run.claimToken === null && run.leaseUntil === null) return
  if (
    !leaseSchema.safeParse({
      organizationId: run.organizationId,
      runId: run.id,
      claimVersion: run.claimVersion,
      claimToken: run.claimToken,
      leaseUntil: run.leaseUntil,
    }).success
  )
    throw invalid()
}

function checkBinding(run: FortnoxReadRun, header: SourceHeader, requestHash: string): void {
  // Ägarskap får vara aktivt, utgånget eller frigivet vid startreplay. Formen
  // är strikt, men tidsmässig giltighet bedöms bara av operativa lease-metoder.
  checkLeaseShape(run)
  const input = header.input
  if (
    run.workVersion !== 2 ||
    run.status !== 'RUNNING' ||
    !['SOURCE_CAPTURED', 'MANIFEST', 'DETAILS', 'READY_TO_REDUCE'].includes(run.phase ?? '') ||
    run.id !== header.id ||
    run.sourceCaptureId !== header.id ||
    run.organizationId !== header.organizationId ||
    run.connectionId !== header.connectionId ||
    run.connectionGeneration !== header.connectionGeneration ||
    run.fortnoxDatabaseNumber !== header.fortnoxDatabaseNumber ||
    run.fortnoxOrgNumber !== header.fortnoxOrgNumber ||
    run.requestHash !== requestHash ||
    header.requestHash !== requestHash ||
    run.financialYearId !== input.financialYearId ||
    run.periodFrom.toISOString().slice(0, 10) !== input.periodFrom ||
    run.periodTo.toISOString().slice(0, 10) !== input.periodTo ||
    checkpointDigest(run.costAccounts) !== checkpointDigest(input.costAccounts) ||
    run.frozenContext !== null ||
    run.summary !== null ||
    run.rows !== null ||
    run.completedAt !== null ||
    run.checkpointUpdatedAt === null ||
    run.reason !== null ||
    run.coverage === null ||
    typeof run.coverage !== 'object' ||
    Array.isArray(run.coverage) ||
    Object.keys(run.coverage).length !== 0 ||
    !Array.isArray(run.uncertainties) ||
    run.uncertainties.length !== 0 ||
    run.nextAttemptAt !== null ||
    !Number.isSafeInteger(run.nextManifestPage) ||
    run.nextManifestPage < 1
  )
    throw invalid()
  if (run.phase === 'SOURCE_CAPTURED') {
    if (
      run.nextManifestPage !== 1 ||
      run.catalog !== null ||
      run.financialYearStart !== null ||
      run.financialYearEnd !== null
    )
      throw invalid()
  } else {
    // Billig återställning: djup projektpolicy prövas mot snapshotens samtliga
    // mapping-sidor i katalogsteget, inte vid varje leaseoperation.
    checkedRunCatalog(run, input, false)
  }
}

function checkedRunCatalog(
  run: FortnoxReadRun,
  input: StartCheckpointInput,
  hasProjectMapping: boolean,
): CheckpointCatalog {
  const parsed = CheckpointCatalogSchema.safeParse(run.catalog)
  if (
    !['MANIFEST', 'DETAILS', 'READY_TO_REDUCE'].includes(run.phase ?? '') ||
    !parsed.success ||
    !run.financialYearStart ||
    !run.financialYearEnd ||
    run.financialYearStart.toISOString().slice(0, 10) !== parsed.data.financialYear.fromDate ||
    run.financialYearEnd.toISOString().slice(0, 10) !== parsed.data.financialYear.toDate ||
    !checkpointCatalogMatches(input, run.fortnoxDatabaseNumber, hasProjectMapping, parsed.data)
  )
    throw invalid()
  return parsed.data
}

/**
 * Inert start för v2: en liten körning binds atomiskt till komplett råkälla.
 * SOURCE_CAPTURED innebär ännu ingen validerad kontext eller ekonomiskt resultat.
 * En lease styr råkällsläsning och separata normaliseringssteg. SOURCE_CAPTURED
 * ändrar inte betydelse när en stage blir NORMALIZED; inget resultat publiceras.
 * Ingen HTTP-, kö- eller providerkoppling finns här.
 */
@Injectable()
export class FortnoxReadSourceRunService {
  constructor(private readonly prisma: PrismaService) {}

  async start(
    organizationId: string,
    userId: string | null,
    input: StartCheckpointInput,
  ): Promise<FortnoxReadRun> {
    const canonical = canonicalInput(input)
    const requestHash = checkpointDigest(canonical)
    let run: FortnoxReadRun
    try {
      run = await this.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "FortnoxConnection"
          WHERE "organizationId" = ${organizationId} FOR UPDATE`
          const connection = await tx.fortnoxConnection.findUnique({
            where: { organizationId },
            select: connectionSelect,
          })
          if (!connection || connection.status !== 'ACTIVE')
            throw new ConflictException('Ingen aktiv Fortnox-anslutning')

          const existing = await tx.fortnoxReadRun.findFirst({
            where: { organizationId, workVersion: { in: [1, 2] }, status: 'RUNNING' },
            select: { id: true, workVersion: true, requestHash: true },
          })
          if (existing) {
            await tx.$queryRaw`SELECT "id" FROM "FortnoxReadRun"
            WHERE "id" = ${existing.id} AND "organizationId" = ${organizationId} FOR UPDATE`
            // En annan version ska varken adopteras eller terminaliseras här.
            if (existing.workVersion !== 2) throw conflict()
            if (!existing.requestHash) throw invalid()
            // Även en äldre anslutningsbindning måste vara historiskt giltig.
            // Korruption får inte behandlas som en legitim generationsrotation.
            const previous = await this.readBoundRun(
              tx,
              organizationId,
              existing.id,
              existing.requestHash,
            )
            if (!sameConnection(previous, connection)) {
              await this.stopChangedConnection(tx, previous, await this.databaseNow(tx))
            } else {
              if (existing.requestHash !== requestHash) throw conflict()
              return previous
            }
          }

          const id = randomUUID()
          // Inga caller-valda källidentiteter: varje ny körning skapar sin egen
          // kopia i samma transaktion. Fel efter seal rullar även tillbaka kopian.
          const source = await captureCheckpointSource(tx, organizationId, id, canonical)
          const created = await tx.fortnoxReadRun.create({
            data: {
              id,
              organizationId,
              sourceCaptureId: source.id,
              workVersion: 2,
              phase: 'SOURCE_CAPTURED',
              connectionId: source.connectionId,
              connectionGeneration: source.connectionGeneration,
              fortnoxDatabaseNumber: source.fortnoxDatabaseNumber,
              fortnoxOrgNumber: source.fortnoxOrgNumber,
              requestHash: source.requestHash,
              financialYearId: canonical.financialYearId,
              periodFrom: date(canonical.periodFrom),
              periodTo: date(canonical.periodTo),
              costAccounts: canonical.costAccounts,
              triggeredByUserId: userId,
              checkpointUpdatedAt: source.createdAt,
            },
          })
          checkBinding(created, source, requestHash)
          return created
        },
        {
          ...PRISMA_DEFAULT_TX_LIMITS,
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        },
      )
    } catch (error) {
      // RR kan ha tagit sin snapshot före väntan på anslutningslåset. Det
      // gemensamma unique-indexet stoppar även en då osynlig konkurrents commit.
      // Ingen omläsning eller retry i samma snapshot; nytt anrop kräver ny hel Tx.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new ConflictException(
          'En Fortnox-läsning startades samtidigt; läs om och försök igen',
        )
      throw error
    }

    // Prisma 5.22 kan rapportera fulfilled trots en deferred COMMIT-rollback.
    // En ny databastransaktion måste se den beständiga kopplingen före retur.
    // En senare anslutningsändring bedöms av framtida claim, inte retroaktivt här.
    return this.prisma.$transaction(
      (tx) => this.readBoundRun(tx, organizationId, run.id, requestHash),
      {
        ...PRISMA_DEFAULT_TX_LIMITS,
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      },
    )
  }

  /** Serverpolicy, ingen begärandeparameter. Kortare intervall kan provas i en subclass. */
  protected leaseDurationMs(): number {
    return 60_000
  }

  async claim(organizationId: string, runId: string): Promise<SourceRunLease | null> {
    this.checkIdentity(organizationId, runId)
    const duration = this.checkedLeaseDuration()
    return this.prisma.$transaction(async (tx) => {
      const { run, connection, now } = await this.lockRun(tx, organizationId, runId)
      if (run.workVersion !== 2 || run.status !== 'RUNNING') return null
      await this.checkBoundRun(tx, run)
      // En ny claimant får inte stoppa en ännu giltig ägares körning.
      if (run.leaseUntil && run.leaseUntil > now) return null
      if (!sameConnection(run, connection)) {
        await this.stopChangedConnection(tx, run, now)
        return null
      }
      if (run.claimVersion === MAX_CLAIM_VERSION) throw invalid()
      const updated = await tx.fortnoxReadRun.update({
        where: { id: run.id, organizationId },
        data: {
          claimVersion: { increment: 1 },
          claimToken: randomUUID(),
          leaseUntil: new Date(now.getTime() + duration),
          checkpointUpdatedAt: now,
        },
        select: { claimVersion: true, claimToken: true, leaseUntil: true },
      })
      return this.toLease(run, updated)
    }, PRISMA_DEFAULT_TX_LIMITS)
  }

  async renew(lease: SourceRunLease): Promise<SourceRunLease> {
    const duration = this.checkedLeaseDuration()
    return this.withLease(lease, async (tx, run, now) => {
      const next = new Date(now.getTime() + duration)
      // Samma millisekund kan ge samma deadline. Behåll då den giltiga leasen
      // utan UPDATE; aldrig förkorta den eller överskrida serverns maxintervall.
      if (run.leaseUntil && next <= run.leaseUntil) return this.toLease(run, run)
      const updated = await tx.fortnoxReadRun.update({
        where: {
          id: run.id,
          organizationId: run.organizationId,
          claimVersion: run.claimVersion,
          claimToken: run.claimToken,
        },
        data: { leaseUntil: next, checkpointUpdatedAt: now },
        select: { claimVersion: true, claimToken: true, leaseUntil: true },
      })
      return this.toLease(run, updated)
    })
  }

  async release(lease: SourceRunLease): Promise<void> {
    await this.withLease(lease, async (tx, run, now) => {
      await tx.fortnoxReadRun.update({
        where: {
          id: run.id,
          organizationId: run.organizationId,
          claimVersion: run.claimVersion,
          claimToken: run.claimToken,
        },
        data: { claimToken: null, leaseUntil: null, checkpointUpdatedAt: now },
        select: { id: true },
      })
    })
  }

  async readSourcePage(lease: SourceRunLease, input: SourceRunPageInput): Promise<SourceRunPage> {
    const parsed = pageSchema.safeParse(input)
    if (!parsed.success)
      throw new BadRequestException('Ogiltig position i det frysta källunderlaget')
    return this.withLease(lease, async (tx, run) => {
      if (!run.sourceCaptureId) throw invalid()
      const after = parsed.data.afterOrdinal
      return parsed.data.kind === 'MAPPINGS'
        ? readCheckpointSourceMappingPage(tx, run.organizationId, run.sourceCaptureId, after)
        : readCheckpointSourceExportPage(tx, run.organizationId, run.sourceCaptureId, after)
    })
  }

  async prepareNormalization(lease: SourceRunLease): Promise<NormalizationProgress> {
    return this.withLease(lease, (tx, run, now, source) => {
      if (run.phase !== 'SOURCE_CAPTURED') throw invalid()
      return prepareNormalizationStage(tx, run, source, now)
    })
  }

  async normalizePage(
    lease: SourceRunLease,
    input: NormalizationPosition,
  ): Promise<NormalizationPageReceipt> {
    const expected = parseNormalizationPosition(input)
    const result = await this.withLease(lease, async (tx, run, _now, source) => {
      if (run.phase !== 'SOURCE_CAPTURED') throw invalid()
      const outcome = await normalizeCheckpointPage(tx, run, source, expected)
      if (outcome.kind === 'INVALID_SOURCE') {
        // Normalisering sker före INSERT. Bara den fortfarande giltiga ägaren
        // får stoppa runen; råkälls-/DB-/fencefel kommer aldrig hit som rådatafel.
        const now = await this.databaseNow(tx)
        if (!run.leaseUntil || run.leaseUntil <= now) throw expired()
        await tx.fortnoxReadRun.update({
          where: {
            id: run.id,
            organizationId: run.organizationId,
            claimVersion: run.claimVersion,
            claimToken: run.claimToken,
          },
          data: {
            status: 'FAILED',
            reason: INVALID_SOURCE,
            completedAt: now,
            checkpointUpdatedAt: now,
            claimToken: null,
            leaseUntil: null,
          },
          select: { id: true, status: true },
        })
      }
      return outcome
    })
    // Throw inne i callbacken skulle rulla tillbaka den avsiktliga terminalen.
    if (result.kind === 'INVALID_SOURCE') throw new ConflictException(INVALID_SOURCE)
    return result.receipt
  }

  async readNormalizedPage(
    lease: SourceRunLease,
    input: NormalizedPagePosition,
  ): Promise<NormalizationPage> {
    const position = parseNormalizedPagePosition(input)
    return this.withLease(lease, (tx, run, _now, source) =>
      readNormalizationStagePage(tx, run, source, position),
    )
  }

  /** En aktuell manifestposition eller första väntande C-sorterade nyckel. */
  async getVoucherStep(lease: SourceRunLease): Promise<SourceVoucherStep> {
    return this.withLease(lease, async (tx, run) => {
      let step: SourceVoucherStep
      if (run.phase === 'MANIFEST') {
        step = { phase: 'MANIFEST', page: run.nextManifestPage }
      } else if (run.phase === 'DETAILS') {
        const key = await nextVoucherKey(tx, run)
        if (!key) throw invalid()
        step = { phase: 'DETAILS', key }
      } else if (run.phase === 'READY_TO_REDUCE') {
        step = { phase: 'READY_TO_REDUCE' }
      } else {
        throw wrongVoucherStep()
      }
      await this.assertContextLeaseTime(tx, run)
      return step
    })
  }

  async commitVoucherPage(
    lease: SourceRunLease,
    envelope: unknown,
  ): Promise<VoucherManifestReceipt> {
    const result = await this.withLease(lease, async (tx, run) => {
      // Ingen providersida får stoppa en körning som ännu saknar katalog.
      // Parsern körs efter aktuell fence, även för feltypade envelopes.
      if (run.phase === 'SOURCE_CAPTURED') throw wrongVoucherStep()
      const page = parseVoucherManifestPage(envelope, run.financialYearId)
      if (!page) {
        await this.stopVoucherConflict(tx, run, MANIFEST_CONFLICT)
        return { ok: false as const }
      }
      await tx.$executeRaw`SET CONSTRAINTS "fortnox_manifest_page_must_advance" DEFERRED`
      const appended = await appendVoucherManifestPage(tx, run, page)
      if (appended.kind === 'CONFLICT') {
        // Helpern har kontrollerat alla innehållskonflikter före barnINSERT.
        // DB-/timeout-/fencefel fångas aldrig som providersvar.
        await this.stopVoucherConflict(tx, run, MANIFEST_CONFLICT)
        return { ok: false as const }
      }
      if (appended.kind === 'WRONG_POSITION') throw wrongVoucherStep()
      if (appended.kind === 'APPENDED') {
        const now = await this.assertContextLeaseTime(tx, run)
        await tx.fortnoxReadRun.update({
          where: {
            id: run.id,
            organizationId: run.organizationId,
            claimVersion: run.claimVersion,
            claimToken: run.claimToken,
          },
          data: { ...appended.progress, checkpointUpdatedAt: now },
          select: { id: true },
        })
      }
      await tx.$executeRaw`SET CONSTRAINTS "fortnox_manifest_page_must_advance" IMMEDIATE`
      await this.assertContextLeaseTime(tx, run)
      return { ok: true as const, receipt: appended.receipt }
    })
    // Den avsiktliga terminalen ska bestå även när caller får ett maskerat fel.
    if (!result.ok) throw new ConflictException(MANIFEST_CONFLICT)

    // Ny TX läser det verkliga lagringskvittot, också efter identisk replay.
    // En senare fence/expiry kan neka kvittot utan att påstå att commit saknas.
    return this.withLease(lease, async (tx, run) => {
      if (run.phase === 'SOURCE_CAPTURED' || run.nextManifestPage <= result.receipt.page)
        throw invalid()
      const observed = await readVoucherManifestReceipt(
        tx,
        run,
        result.receipt.page,
        result.receipt.digest,
      )
      if (observed.pageId !== result.receipt.pageId || observed.runId !== result.receipt.runId)
        throw invalid()
      await this.assertContextLeaseTime(tx, run)
      return observed
    })
  }

  async commitVoucherDetail(
    lease: SourceRunLease,
    key: string,
    voucher: FortnoxVoucher | undefined,
  ): Promise<VoucherDetailReceipt> {
    const result = await this.withLease(lease, async (tx, run) => {
      if (run.phase !== 'DETAILS' && run.phase !== 'READY_TO_REDUCE') throw wrongDetailStep()
      const catalog = CheckpointCatalogSchema.parse(run.catalog)
      // Samma valideringsordning som v1: rådetaljen före lookup/position,
      // men först efter v2:s aktuella fence och tillåtna detaljfas.
      const validated = parseVoucherDetail(key, voucher, catalog.financialYear)
      if (!validated) {
        await this.stopVoucherConflict(tx, run, DETAIL_CONFLICT)
        return { ok: false as const }
      }
      await tx.$executeRaw`SET CONSTRAINTS "fortnox_v2_detail_must_advance" DEFERRED`
      const observedAt = await this.assertContextLeaseTime(tx, run)
      const appended = await appendVoucherDetail(tx, run, validated, observedAt)
      if (appended.kind === 'CONFLICT') {
        await this.stopVoucherConflict(tx, run, DETAIL_CONFLICT)
        return { ok: false as const }
      }
      if (appended.kind === 'MISSING')
        throw new ConflictException('Verifikatet saknas i det sparade manifestet')
      if (appended.kind === 'WRONG_POSITION') throw wrongDetailStep()
      if (appended.kind === 'WRITTEN') {
        const now = await this.assertContextLeaseTime(tx, run)
        await tx.fortnoxReadRun.update({
          where: {
            id: run.id,
            organizationId: run.organizationId,
            claimVersion: run.claimVersion,
            claimToken: run.claimToken,
          },
          data: { phase: appended.nextPhase, checkpointUpdatedAt: now },
          select: { id: true },
        })
      }
      await tx.$executeRaw`SET CONSTRAINTS "fortnox_v2_detail_must_advance" IMMEDIATE`
      await this.assertContextLeaseTime(tx, run)
      return { ok: true as const, receipt: appended.receipt }
    })
    if (!result.ok) throw new ConflictException(DETAIL_CONFLICT)

    // Kvittot kommer från en ny TX och den faktiskt lagrade normalformen.
    // Nekad fence här betyder inte att den föregående committen saknas.
    return this.withLease(lease, async (tx, run) => {
      if (run.phase !== 'DETAILS' && run.phase !== 'READY_TO_REDUCE') throw invalid()
      const catalog = CheckpointCatalogSchema.parse(run.catalog)
      const observed = await readVoucherDetailReceipt(
        tx,
        run,
        catalog.financialYear,
        result.receipt.key,
        result.receipt.detailDigest,
      )
      if (
        observed.runId !== result.receipt.runId ||
        observed.checkpointId !== result.receipt.checkpointId
      )
        throw invalid()
      await this.assertContextLeaseTime(tx, run)
      return observed
    })
  }

  /** Validerad C-ordnad sida för en senare reducerare; ingen resultatpublicering. */
  async readValidatedPage(
    lease: SourceRunLease,
    options: { afterKey?: string; limit?: number } = {},
  ): Promise<ValidatedLedgerVoucher[]> {
    return this.readValidatedPageInternal(lease, options)
  }

  private async readValidatedPageInternal(
    lease: SourceRunLease,
    options: { afterKey?: string; limit?: number },
    expectedReductionBinding?: ReductionBinding,
  ): Promise<ValidatedLedgerVoucher[]> {
    const parsed = CheckpointReadPageSchema.safeParse(options)
    if (!parsed.success) throw new BadRequestException('Ogiltig detaljsida')
    const result = await this.withLease(lease, async (tx, run, _now, source) => {
      if (run.phase !== 'READY_TO_REDUCE')
        throw new ConflictException('Alla detaljer är inte sparade')
      if (expectedReductionBinding) {
        const stage = await readCompletedNormalizationStage(tx, run, source)
        await this.assertContextLeaseTime(tx, run)
        await this.assertReductionContext(
          tx,
          run,
          normalizedContextBinding(run, source, stage),
          expectedReductionBinding,
        )
      }
      const catalog = CheckpointCatalogSchema.parse(run.catalog)
      const page = await readValidatedVoucherPage(tx, run, catalog.financialYear, parsed.data)
      if (page.kind === 'INVALID') {
        await this.stopVoucherConflict(tx, run, INVALID_CONTEXT)
        return { valid: false as const }
      }
      await this.assertContextLeaseTime(tx, run)
      return { valid: true as const, items: page.items }
    })
    if (!result.valid) throw new ConflictException(INVALID_CONTEXT)
    return result.items
  }

  /** Serverägd publicering från den faktiska A–F-kedjan. Ingen caller kan
   * lämna resultat, bindning eller bevis; ingen HTTP-/köaktivering införs.
   */
  async publishReadyLedger(lease: SourceRunLease): Promise<PublicationReceipt> {
    const { held, expected, outcome } = await this.reduceReadyLedgerInternal(lease)
    // Codec/CPU-arbete ligger utanför write-TX. Efter det krävs åter aktuell
    // lease; renew får aldrig återuppliva ett utgånget anspråk.
    const encoded = encodeLedgerPublication(randomUUID(), expected.context, outcome)
    await this.renewContextLeaseIfNeeded(held)
    const committed = await this.withNormalizedContext(held.value, async (tx, run, context) => {
      await this.assertReductionContext(tx, run, context, expected)
      if (run.claimVersion !== outcome.proof.claimVersion) throw invalidReduction()
      await this.assertContextLeaseTime(tx, run)
      await tx.$executeRaw`SET CONSTRAINTS "fortnox_publication_must_finish", "fortnox_run_publication_required" DEFERRED`
      const publication = await insertLedgerPublication(tx, encoded)
      const now = await this.assertContextLeaseTime(tx, run)
      await tx.fortnoxReadRun.update({
        where: {
          id: run.id,
          organizationId: run.organizationId,
          claimVersion: held.value.claimVersion,
          claimToken: held.value.claimToken,
        },
        data: {
          status: encoded.status,
          reason: encoded.reason,
          completedAt: publication.publishedAt,
          checkpointUpdatedAt: new Date(Math.max(now.getTime(), publication.publishedAt.getTime())),
          claimToken: null,
          leaseUntil: null,
        },
        select: { id: true, status: true },
      })
      await tx.$executeRaw`SET CONSTRAINTS "fortnox_publication_must_finish", "fortnox_run_publication_required" IMMEDIATE`
      // Avsiktligt OLD-runen: token/version är fortfarande låsta och dess
      // deadline måste vara giltig även efter samtliga write-/pair-frågor.
      await this.assertContextLeaseTime(tx, run)
      return publication.id
    })
    // Ingen success baserad enbart på ett fulfilled Prisma-COMMIT. Kvitto
    // läser den verkliga kopian i en separat TX, inklusive hela resultatet.
    const receipt = await this.readPublicationReceipt(held.value.organizationId, held.value.runId)
    if (
      !receipt ||
      receipt.id !== committed ||
      receipt.id !== encoded.id ||
      receipt.publicationDigest !== encoded.publicationDigest
    )
      throw new PublicationFormatError()
    return receipt
  }

  /** Historiskt kvitto: ingen withLease/liveconnection, inga writes och ingen
   * automatisk återpublicering efter förlorat svar. Saknad rad är endast null.
   */
  async readPublicationReceipt(
    organizationId: string,
    runId: string,
  ): Promise<PublicationReceipt | null> {
    this.checkIdentity(organizationId, runId)
    const stored = await this.prisma.$transaction(
      (tx) => readStoredLedgerPublication(tx, organizationId, runId),
      {
        ...PRISMA_DEFAULT_TX_LIMITS,
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      },
    )
    // Immutable resultat och bindning kan valideras efter read-TX, utan att
    // hålla en databastransaktion öppen över full JSON-hashning.
    return stored === null ? null : checkedPublicationReceipt(stored)
  }

  /** Intern beräkning av fryst READY-underlag; skriver aldrig ekonomiskt resultat. */
  async reduceReadyLedger(lease: SourceRunLease): Promise<ReadyLedgerReduction> {
    return (await this.reduceReadyLedgerInternal(lease)).outcome
  }

  private async reduceReadyLedgerInternal(lease: SourceRunLease): Promise<{
    held: HeldContextLease
    expected: ReductionBinding
    outcome: ReadyLedgerReduction
  }> {
    const parsed = leaseSchema.safeParse(lease)
    if (!parsed.success) throw new BadRequestException('Ogiltigt läsanspråk')
    const held: HeldContextLease = { value: parsed.data }
    const expected = await this.bindReadyReduction(held)
    const maps = await this.buildFrozenReductionMaps(held, expected)
    const manifest = await this.verifyReductionManifest(held, expected)
    const first = await this.runReductionDetailPass(held, expected, manifest.keys)
    const { config, base } = buildReductionConfig(
      expected.context.input,
      expected.catalog,
      maps,
      {
        pages: manifest.pageCount,
        totalPages: expected.manifest.totalPages,
        totalResources: expected.manifest.totalResources,
        itemsSeen: manifest.itemsSeen,
      },
      manifest.duplicateWarnings,
    )
    // Alla detaljer har verifierats före den första ekonomiska summeringen.
    const accumulator = createLedgerAccumulator(config, base)
    const second = await this.runReductionDetailPass(held, expected, manifest.keys, accumulator)
    if (
      first.proof.count !== second.proof.count ||
      first.proof.digest !== second.proof.digest ||
      first.proof.firstKey !== second.proof.firstKey ||
      first.proof.lastKey !== second.proof.lastKey
    )
      throw invalidReduction()
    const result = second.overflow
      ? null
      : finishReducedLedger(accumulator.finish(), expected.catalog, maps.ownExports)
    // CPU-arbetet ovan kan överskrida lease. Sista DB-fencen ligger därför
    // efter finish och proveniens, även när det enda utfallet är overflow.
    await this.finalReductionFence(held, expected, manifest.keys.size)
    const proof: ReductionProof = {
      version: 1,
      organizationId: expected.context.organizationId,
      runId: expected.context.runId,
      sourceCaptureId: expected.context.sourceCaptureId,
      snapshotId: expected.header.id,
      snapshotDigest: expected.header.digest,
      sourceDigest: expected.header.manifest.sourceDigest,
      catalogDigest: expected.catalogDigest,
      manifestDigest: manifest.digest,
      detailDigest: second.proof.digest,
      manifestPageCount: manifest.pageCount,
      manifestItemsSeen: manifest.itemsSeen,
      voucherCount: second.proof.count,
      claimVersion: held.value.claimVersion,
    }
    const outcome: ReadyLedgerReduction =
      result === null
        ? { kind: 'FAILED', code: 'AMOUNT_OVERFLOW', proof }
        : { kind: 'REDUCED', proof, result }
    return { held, expected, outcome }
  }

  private async bindReadyReduction(held: HeldContextLease): Promise<ReductionBinding> {
    // Avvisa fel fas innan ett fullständigt kontextpass startas.
    await this.withLease(held.value, async (tx, run) => {
      if (run.phase !== 'READY_TO_REDUCE') throw invalidReduction()
      await this.assertContextLeaseTime(tx, run)
    })
    const receipt = await this.freezeNormalizedContext(held.value)
    await this.renewContextLeaseIfNeeded(held)
    return this.withNormalizedContext(held.value, async (tx, run, context) => {
      if (run.phase !== 'READY_TO_REDUCE' || receipt.runId !== run.id) throw invalidReduction()
      const header = await findNormalizedContextHeader(tx, context)
      assertNormalizedContextHeader(
        header,
        { id: receipt.snapshotId, digest: receipt.headerDigest },
        receipt.sourceDigest,
      )
      const catalog = checkedRunCatalog(run, context.input, false)
      const manifest = await this.readReductionManifest(tx, run)
      await this.assertContextLeaseTime(tx, run)
      return { context, header, catalog, catalogDigest: checkpointDigest(catalog), manifest }
    })
  }

  private async readReductionManifest(tx: Tx, run: FortnoxReadRun): Promise<ReductionManifest> {
    if (run.phase !== 'READY_TO_REDUCE' || run.nextManifestPage < 2) throw invalidReduction()
    const lastPage = run.nextManifestPage - 1
    const rows = await tx.fortnoxReadManifestPage.findMany({
      where: {
        organizationId: run.organizationId,
        runId: run.id,
        page: { in: lastPage > 1 ? [1, lastPage] : [1] },
      },
      select: reductionManifestSelect,
    })
    const first = rows.find((row) => row.page === 1)
    const last = rows.find((row) => row.page === lastPage)
    if (
      !first ||
      !last ||
      rows.length !== (lastPage > 1 ? 2 : 1) ||
      rows.some(
        (row) =>
          row.organizationId !== run.organizationId ||
          row.runId !== run.id ||
          typeof row.id !== 'string' ||
          !row.id ||
          !Number.isSafeInteger(row.page) ||
          row.page < 1 ||
          !Number.isSafeInteger(row.totalPages) ||
          row.totalPages < 0 ||
          !Number.isSafeInteger(row.totalResources) ||
          row.totalResources < 0 ||
          !Number.isSafeInteger(row.itemCount) ||
          row.itemCount < 0 ||
          row.itemCount > 100 ||
          !/^[a-f0-9]{64}$/.test(row.digest) ||
          row.totalPages !== first.totalPages ||
          row.totalResources !== first.totalResources ||
          (row.totalPages === 0
            ? !(row.page === 1 && row.totalResources === 0 && row.itemCount === 0)
            : row.page > row.totalPages),
      ) ||
      lastPage !== Math.max(1, first.totalPages)
    )
      throw invalidReduction()
    return {
      pageCount: lastPage,
      totalPages: first.totalPages,
      totalResources: first.totalResources,
      nextManifestPage: run.nextManifestPage,
      first,
      last,
    }
  }

  private async assertReductionContext(
    tx: Tx,
    run: FortnoxReadRun,
    context: NormalizedContextBinding,
    expected: ReductionBinding,
  ): Promise<ContextHeader> {
    if (run.phase !== 'READY_TO_REDUCE') throw invalidReduction()
    assertSameNormalizedContextBinding(context, expected.context)
    const header = await findNormalizedContextHeader(tx, context)
    assertNormalizedContextHeader(header, expected.header, expected.header.manifest.sourceDigest)
    const catalog = checkedRunCatalog(run, context.input, false)
    if (
      checkpointDigest(catalog) !== expected.catalogDigest ||
      checkpointDigest(await this.readReductionManifest(tx, run)) !==
        checkpointDigest(expected.manifest)
    )
      throw invalidReduction()
    return header
  }

  private async buildFrozenReductionMaps(
    held: HeldContextLease,
    expected: ReductionBinding,
  ): Promise<FrozenReductionMaps> {
    const maps = createFrozenReductionMaps()
    const stream = new CheckpointContextDigest(expected.header.manifest.input)
    const digestBinding = contextBindingDigest(expected.header)
    for (const kind of CONTEXT_KINDS) {
      const collection = expected.header.manifest.collections[kind]
      let root = contextInitialRoot(digestBinding, kind)
      let seen = 0
      for (let page = 1; page <= collection.pageCount; page++) {
        await this.renewContextLeaseIfNeeded(held)
        const checked = await this.withNormalizedContext(held.value, async (tx, run, context) => {
          const header = await this.assertReductionContext(tx, run, context, expected)
          const observed = await readNormalizedContextPage(tx, header, kind, page)
          await this.assertContextLeaseTime(tx, run)
          return observed
        })
        // Samma validerade payload bygger både konfiguration och full källdigest.
        if (kind === 'MAPPINGS') {
          const items = CheckpointContextSchema.shape.mappings.parse(checked.items)
          stream.append(kind, items)
          appendReductionMappings(maps, items)
        } else {
          const items = CheckpointContextSchema.shape.ownExports.parse(checked.items)
          stream.append(kind, items)
          appendReductionOwnExports(maps, items)
        }
        seen += checked.items.length
        root = contextExtendRoot(root, page, checked.items.length, checked.digest)
      }
      if (seen !== collection.itemCount || root !== collection.root)
        throw invalidNormalizedContext()
    }
    if (stream.digest() !== expected.header.manifest.sourceDigest) throw invalidNormalizedContext()
    await this.renewContextLeaseIfNeeded(held)
    await this.withNormalizedContext(held.value, async (tx, run, context) => {
      await this.assertReductionContext(tx, run, context, expected)
      checkedRunCatalog(run, context.input, maps.hasProjectMapping)
      for (const kind of CONTEXT_KINDS) {
        const count = await tx.fortnoxReadContextPage.count({
          where: { organizationId: context.organizationId, snapshotId: expected.header.id, kind },
        })
        if (count !== expected.header.manifest.collections[kind].pageCount)
          throw invalidNormalizedContext()
      }
      await this.assertContextLeaseTime(tx, run)
    })
    return maps
  }

  private async verifyReductionManifest(
    held: HeldContextLease,
    expected: ReductionBinding,
  ): Promise<ReturnType<ManifestReductionProof['finish']>> {
    await this.renewContextLeaseIfNeeded(held)
    // Verklig mängd före payloadloopen: förfalskat stort sidhuvud får inte
    // orsaka en obegränsad serie resultatlösa sidfrågor.
    await this.withNormalizedContext(held.value, async (tx, run, context) => {
      await this.assertReductionContext(tx, run, context, expected)
      const count = await tx.fortnoxReadManifestPage.count({
        where: { organizationId: run.organizationId, runId: run.id },
      })
      if (count !== expected.manifest.pageCount) throw invalidReduction()
      await this.assertContextLeaseTime(tx, run)
    })
    const proof = new ManifestReductionProof({
      pageCount: expected.manifest.pageCount,
      totalPages: expected.manifest.totalPages,
      totalResources: expected.manifest.totalResources,
    })
    for (let page = 1; page <= expected.manifest.pageCount; page++) {
      await this.renewContextLeaseIfNeeded(held)
      const observed = await this.withNormalizedContext(held.value, async (tx, run, context) => {
        await this.assertReductionContext(tx, run, context, expected)
        const stored = await readVoucherManifestPageForReduction(tx, run, page, expected.manifest)
        await this.assertContextLeaseTime(tx, run)
        return stored
      })
      proof.append(observed)
    }
    return proof.finish()
  }

  private async runReductionDetailPass(
    held: HeldContextLease,
    expected: ReductionBinding,
    keys: ReadonlyMap<string, string>,
    accumulator?: ReturnType<typeof createLedgerAccumulator>,
  ): Promise<{ proof: ReturnType<DetailReductionProof['finish']>; overflow: boolean }> {
    const proof = new DetailReductionProof(keys)
    let afterKey: string | undefined
    let overflow: LedgerAmountOverflow | null = null
    for (;;) {
      await this.renewContextLeaseIfNeeded(held)
      const items = await this.readValidatedPageInternal(
        held.value,
        afterKey === undefined ? { limit: 100 } : { afterKey, limit: 100 },
        expected,
      )
      if (items.length > 100) throw invalidReduction()
      proof.append(items)
      if (!items.length) break
      for (const item of items) {
        if (accumulator && overflow === null) {
          try {
            accumulator.add(item)
          } catch (error) {
            if (!(error instanceof LedgerAmountOverflow)) throw error
            overflow = error
          }
        }
      }
      afterKey = items[items.length - 1]!.key
    }
    return { proof: proof.finish(), overflow: overflow !== null }
  }

  private async finalReductionFence(
    held: HeldContextLease,
    expected: ReductionBinding,
    voucherCount: number,
  ): Promise<void> {
    await this.renewContextLeaseIfNeeded(held)
    await this.withNormalizedContext(held.value, async (tx, run, context) => {
      await this.assertReductionContext(tx, run, context, expected)
      const pages = await tx.fortnoxReadManifestPage.count({
        where: { organizationId: run.organizationId, runId: run.id },
      })
      const vouchers = await tx.fortnoxReadVoucherCheckpoint.count({
        where: { organizationId: run.organizationId, runId: run.id },
      })
      if (
        pages !== expected.manifest.pageCount ||
        vouchers !== expected.manifest.totalResources ||
        vouchers !== voucherCount
      )
        throw invalidReduction()
      await this.assertContextLeaseTime(tx, run)
    })
  }

  private async stopVoucherConflict(
    tx: Tx,
    run: FortnoxReadRun,
    reason: typeof MANIFEST_CONFLICT | typeof DETAIL_CONFLICT | typeof INVALID_CONTEXT,
  ): Promise<void> {
    const now = await this.assertContextLeaseTime(tx, run)
    await tx.fortnoxReadRun.update({
      where: {
        id: run.id,
        organizationId: run.organizationId,
        claimVersion: run.claimVersion,
        claimToken: run.claimToken,
      },
      data: {
        status: 'FAILED',
        reason,
        completedAt: now,
        checkpointUpdatedAt: now,
        claimToken: null,
        leaseUntil: null,
      },
      select: { id: true, status: true },
    })
    await this.assertContextLeaseTime(tx, run)
  }

  /** Fryst katalogbegäran eller det redan beständiga nästa steget; ingen nätläsning. */
  async getCatalogStep(lease: SourceRunLease): Promise<SourceCatalogStep> {
    // Fel steg kan avgöras under fence utan ett fullständigt kontextpass.
    await this.withLease(lease, async (tx, run) => {
      if (run.phase !== 'SOURCE_CAPTURED' && run.phase !== 'MANIFEST') throw wrongCatalogStep()
      await this.assertContextLeaseTime(tx, run)
    })
    const context = await this.readVerifiedCatalogContext(lease)
    await this.renewContextLeaseIfNeeded(context.held)
    return this.withNormalizedContext(context.held.value, async (tx, run, binding) => {
      await this.assertCatalogContext(tx, binding, context)
      if (run.phase !== 'SOURCE_CAPTURED' && run.phase !== 'MANIFEST') throw wrongCatalogStep()
      // En annan caller kan ha committat medan fullpasset pågick. Avgör
      // returgrenen från den sista låsta runen, aldrig från initial metadata.
      const step: SourceCatalogStep =
        run.phase === 'SOURCE_CAPTURED'
          ? {
              kind: 'READ_CATALOG',
              input: binding.input,
              databaseNumber: binding.connection.databaseNumber,
              readProjects: context.hasProjectMapping,
            }
          : {
              kind: 'MANIFEST',
              catalog: checkedRunCatalog(run, binding.input, context.hasProjectMapping),
              nextManifestPage: run.nextManifestPage,
            }
      await this.assertContextLeaseTime(tx, run)
      return step
    })
  }

  async commitCatalog(lease: SourceRunLease, candidate: unknown): Promise<SourceCatalogReceipt> {
    // Även en feltypad kandidat måste först passera aktuell fence och faktisk
    // kontextverifiering; en gammal caller får inte terminalisera en ny ägare.
    const context = await this.readVerifiedCatalogContext(lease)
    await this.renewContextLeaseIfNeeded(context.held)
    const result = await this.withNormalizedContext(
      context.held.value,
      async (tx, run, binding) => {
        await this.assertCatalogContext(tx, binding, context)
        const parsed = CheckpointCatalogSchema.safeParse(candidate)
        const matches =
          parsed.success &&
          checkpointCatalogMatches(
            binding.input,
            binding.connection.databaseNumber,
            context.hasProjectMapping,
            parsed.data,
          )
        const previous =
          run.phase !== 'SOURCE_CAPTURED'
            ? checkedRunCatalog(run, binding.input, context.hasProjectMapping)
            : null
        if (
          !parsed.success ||
          !matches ||
          (previous && checkpointDigest(previous) !== checkpointDigest(parsed.data))
        ) {
          const now = await this.assertContextLeaseTime(tx, run)
          await tx.fortnoxReadRun.update({
            where: {
              id: run.id,
              organizationId: run.organizationId,
              claimVersion: run.claimVersion,
              claimToken: run.claimToken,
            },
            data: {
              status: 'FAILED',
              reason: CATALOG_CONFLICT,
              completedAt: now,
              checkpointUpdatedAt: now,
              claimToken: null,
              leaseUntil: null,
            },
            select: { id: true, status: true },
          })
          // FAILED-grenen tillåter även startens generationsrotation. Den här
          // callerstyrda terminalen kräver däremot fortfarande samma giltiga
          // lease efter den verkliga skrivningen; expiry rullar tillbaka den.
          await this.assertContextLeaseTime(tx, run)
          return { ok: false as const }
        }
        const catalogDigest = checkpointDigest(parsed.data)
        if (!previous) {
          const now = await this.assertContextLeaseTime(tx, run)
          await tx.fortnoxReadRun.update({
            where: {
              id: run.id,
              organizationId: run.organizationId,
              claimVersion: run.claimVersion,
              claimToken: run.claimToken,
            },
            data: {
              phase: 'MANIFEST',
              catalog: parsed.data as Prisma.InputJsonValue,
              financialYearStart: date(parsed.data.financialYear.fromDate),
              financialYearEnd: date(parsed.data.financialYear.toDate),
              checkpointUpdatedAt: now,
            },
            select: { id: true },
          })
        }
        await this.assertContextLeaseTime(tx, run)
        return { ok: true as const, catalogDigest }
      },
    )
    if (!result.ok) throw new ConflictException(CATALOG_CONFLICT)

    // Separat beständighetskvitto efter commit, även vid identisk replay.
    // En senare expiry/fenceändring ger fel men påstår inte att commit saknas.
    await this.renewContextLeaseIfNeeded(context.held)
    return this.withNormalizedContext(context.held.value, async (tx, run, binding) => {
      await this.assertCatalogContext(tx, binding, context)
      const stored = checkedRunCatalog(run, binding.input, context.hasProjectMapping)
      if (checkpointDigest(stored) !== result.catalogDigest) throw invalid()
      await this.assertContextLeaseTime(tx, run)
      const receipt: SourceCatalogReceipt = {
        runId: run.id,
        catalogDigest: result.catalogDigest,
      }
      return receipt
    })
  }

  private async readVerifiedCatalogContext(lease: SourceRunLease): Promise<CatalogContext> {
    // Den publika bron verifierar hela den faktiska kopian och sourceDigest.
    // Bara projektpolicyn behöver därefter mapping-sidor; inga ownExports
    // samlas eller materialiseras en gång till i katalogkonsumenten.
    const receipt = await this.freezeNormalizedContext(lease)
    const parsed = leaseSchema.safeParse(lease)
    if (!parsed.success) throw new BadRequestException('Ogiltigt läsanspråk')
    const held: HeldContextLease = { value: parsed.data }
    await this.renewContextLeaseIfNeeded(held)
    const initial = await this.withNormalizedContext(held.value, async (tx, run, binding) => {
      const header = await findNormalizedContextHeader(tx, binding)
      assertNormalizedContextHeader(
        header,
        { id: receipt.snapshotId, digest: receipt.headerDigest },
        receipt.sourceDigest,
      )
      await this.assertContextLeaseTime(tx, run)
      return { binding, header }
    })
    const context: CatalogContext = { held, ...initial, hasProjectMapping: false }
    for (let page = 1; page <= initial.header.manifest.collections.MAPPINGS.pageCount; page++) {
      await this.renewContextLeaseIfNeeded(held)
      const hasProject = await this.withNormalizedContext(held.value, async (tx, run, binding) => {
        const header = await this.assertCatalogContext(tx, binding, context)
        const checked = await readNormalizedContextPage(tx, header, 'MAPPINGS', page)
        const found = checked.items.some((item) => 'type' in item && item.type === 'PROJECT')
        await this.assertContextLeaseTime(tx, run)
        return found
      })
      context.hasProjectMapping ||= hasProject
    }
    return context
  }

  private async assertCatalogContext(
    tx: Tx,
    binding: NormalizedContextBinding,
    expected: CatalogContext,
  ): Promise<ContextHeader> {
    assertSameNormalizedContextBinding(binding, expected.binding)
    const header = await findNormalizedContextHeader(tx, binding)
    assertNormalizedContextHeader(header, expected.header, expected.header.manifest.sourceDigest)
    return header
  }

  private checkIdentity(organizationId: string, runId: string): void {
    if (
      typeof organizationId !== 'string' ||
      !organizationId ||
      typeof runId !== 'string' ||
      !runId
    )
      throw new BadRequestException('Ogiltigt läsanspråk')
  }

  private checkedLeaseDuration(): number {
    const duration = this.leaseDurationMs()
    if (!Number.isInteger(duration) || duration < 1 || duration > 60_000)
      throw new Error('Ogiltigt serverintervall för läsanspråk')
    return duration
  }

  /**
   * Inert bro: två sidpass, atomisk COPY/seal, därefter full verifiering av den
   * beständiga kopian. SOURCE_CAPTURED och normaliseringsstage ändras inte.
   * Varje sidsteg äger sin korta TX; ingen caller-hash eller plan accepteras.
   */
  async freezeNormalizedContext(lease: SourceRunLease): Promise<NormalizedContextReceipt> {
    const parsed = leaseSchema.safeParse(lease)
    if (!parsed.success) throw new BadRequestException('Ogiltigt läsanspråk')
    const held: HeldContextLease = { value: parsed.data }
    await this.renewContextLeaseIfNeeded(held)
    // A: fryst metadata och eventuell första snapshot, under aktuell fence.
    const initial = await this.withNormalizedContext(held.value, async (tx, run, binding) => {
      const existing = await findNormalizedContextHeader(tx, binding)
      if (run.phase !== 'SOURCE_CAPTURED' && !existing) throw invalidNormalizedContext()
      return { binding, existing }
    })
    const binding = initial.binding
    // B: exakt full sourceDigest, högst en normaliserad sida per TX/minnessteg.
    const stream = new CheckpointContextDigest(binding.input)
    for (const kind of CONTEXT_KINDS) {
      let seen = 0
      for (let after = 0; after < binding.counts[kind]; after += CONTEXT_PAGE_SIZE) {
        const page = await this.readContextStagePage(held, binding, kind, BigInt(after))
        stream.append(kind, page.items)
        seen += page.itemCount
      }
      if (seen !== binding.counts[kind]) throw invalidNormalizedContext()
    }
    const sourceDigest = stream.digest()
    let committed: ContextHeader
    if (initial.existing) {
      assertNormalizedContextHeader(initial.existing, initial.existing, sourceDigest)
      committed = initial.existing
    } else {
      // C: andra läspasset binder nya sidhasher till hela sourceDigest. Bara
      // descriptors bevaras; buildern räknar även om hela källdigesten igen.
      const builder = new NormalizedContextPlanBuilder(binding, sourceDigest)
      for (const kind of CONTEXT_KINDS) {
        for (let after = 0; after < binding.counts[kind]; after += CONTEXT_PAGE_SIZE) {
          builder.append(await this.readContextStagePage(held, binding, kind, BigInt(after)))
        }
      }
      const plan = builder.finish()
      await this.renewContextLeaseIfNeeded(held)
      // D: runlåset serialiserar två callers. En redan committad snapshot
      // ersätts aldrig, även om det andra anropet hann göra båda hashpassen.
      committed = await this.withNormalizedContext(held.value, async (tx, run, current) => {
        assertSameNormalizedContextBinding(current, binding)
        const existing = await findNormalizedContextHeader(tx, current)
        if (existing) {
          assertNormalizedContextHeader(existing, existing, sourceDigest)
          return existing
        }
        if (run.phase !== 'SOURCE_CAPTURED') throw invalidNormalizedContext()
        await copyNormalizedContextPages(tx, current, plan)
        const now = await this.assertContextLeaseTime(tx, run)
        const sealed = await sealNormalizedContext(tx, current, plan, now)
        // Sista skyddspunkten är efter IMMEDIATE, inte ett löfte om nätets
        // svarstid eller om klockans exakta värde vid senare COMMIT.
        await this.assertContextLeaseTime(tx, run)
        return sealed
      })
    }
    // E: nya TX efter commit. Ett fulfilled Prisma-anrop är inte ensamt ett
    // kvitto; hela den faktiskt sparade kopian måste återläsas och hashas.
    return this.verifyNormalizedContext(held, binding, committed, sourceDigest)
  }

  private async renewContextLeaseIfNeeded(held: HeldContextLease): Promise<void> {
    // Lokal tid planerar bara förnyelse. renew/withLease använder DB-tid och
    // kan aldrig återuppliva en expired fence, inte heller på replayvägen.
    if (held.value.leaseUntil.getTime() - Date.now() <= 15_000) {
      held.value = await this.renew(held.value)
    }
  }

  private async readContextStagePage(
    held: HeldContextLease,
    expected: NormalizedContextBinding,
    kind: ContextKind,
    afterOrdinal: bigint,
  ): Promise<NormalizationPage> {
    await this.renewContextLeaseIfNeeded(held)
    return this.withNormalizedContext(held.value, (tx, run, binding, source) => {
      assertSameNormalizedContextBinding(binding, expected)
      return readNormalizationStagePage(tx, run, source, { kind, afterOrdinal })
    })
  }

  private async verifyNormalizedContext(
    held: HeldContextLease,
    binding: NormalizedContextBinding,
    committed: ContextHeader,
    sourceDigest: string,
  ): Promise<NormalizedContextReceipt> {
    await this.renewContextLeaseIfNeeded(held)
    const header = await this.withNormalizedContext(held.value, async (tx, _run, current) => {
      assertSameNormalizedContextBinding(current, binding)
      const observed = await findNormalizedContextHeader(tx, current)
      assertNormalizedContextHeader(observed, committed, sourceDigest)
      return observed
    })
    const stream = new CheckpointContextDigest(header.manifest.input)
    const digestBinding = contextBindingDigest(header)
    for (const kind of CONTEXT_KINDS) {
      const collection = header.manifest.collections[kind]
      let root = contextInitialRoot(digestBinding, kind)
      let seen = 0
      for (let page = 1; page <= collection.pageCount; page++) {
        await this.renewContextLeaseIfNeeded(held)
        const checked = await this.withNormalizedContext(held.value, async (tx, _run, current) => {
          assertSameNormalizedContextBinding(current, binding)
          const observed = await findNormalizedContextHeader(tx, current)
          assertNormalizedContextHeader(observed, header, sourceDigest)
          return readNormalizedContextPage(tx, observed, kind, page)
        })
        stream.append(kind, checked.items)
        seen += checked.items.length
        root = contextExtendRoot(root, page, checked.items.length, checked.digest)
      }
      if (seen !== collection.itemCount || root !== collection.root)
        throw invalidNormalizedContext()
    }
    if (stream.digest() !== sourceDigest) throw invalidNormalizedContext()
    await this.renewContextLeaseIfNeeded(held)
    return this.withNormalizedContext(held.value, async (tx, run, current) => {
      assertSameNormalizedContextBinding(current, binding)
      const observed = await findNormalizedContextHeader(tx, current)
      assertNormalizedContextHeader(observed, header, sourceDigest)
      for (const kind of CONTEXT_KINDS) {
        const stored = await tx.fortnoxReadContextPage.count({
          where: { organizationId: binding.organizationId, snapshotId: header.id, kind },
        })
        if (stored !== header.manifest.collections[kind].pageCount) throw invalidNormalizedContext()
      }
      await this.assertContextLeaseTime(tx, run)
      return normalizedContextReceipt(observed)
    })
  }

  private async withNormalizedContext<T>(
    lease: SourceRunLease,
    action: (
      tx: Tx,
      run: FortnoxReadRun,
      binding: NormalizedContextBinding,
      source: SourceHeader,
    ) => Promise<T>,
  ): Promise<T> {
    return this.withLease(lease, async (tx, run, _now, source) => {
      const stage = await readCompletedNormalizationStage(tx, run, source)
      // Väntan på stage-låset får inte använda klockan från före väntan.
      await this.assertContextLeaseTime(tx, run)
      return action(tx, run, normalizedContextBinding(run, source, stage), source)
    })
  }

  private async assertContextLeaseTime(tx: Tx, run: FortnoxReadRun): Promise<Date> {
    const now = await this.databaseNow(tx)
    if (!run.leaseUntil || run.leaseUntil <= now) throw expired()
    return now
  }

  private toLease(
    run: Pick<FortnoxReadRun, 'organizationId' | 'id'>,
    fields: Pick<FortnoxReadRun, 'claimVersion' | 'claimToken' | 'leaseUntil'>,
  ): SourceRunLease {
    const parsed = leaseSchema.safeParse({
      organizationId: run.organizationId,
      runId: run.id,
      claimVersion: fields.claimVersion,
      claimToken: fields.claimToken,
      leaseUntil: fields.leaseUntil,
    })
    if (!parsed.success) throw invalid()
    return parsed.data
  }

  private async withLease<T>(
    lease: SourceRunLease,
    action: (tx: Tx, run: FortnoxReadRun, now: Date, source: SourceHeader) => Promise<T>,
  ): Promise<T> {
    const parsed = leaseSchema.safeParse(lease)
    if (!parsed.success) throw new BadRequestException('Ogiltigt läsanspråk')
    const current = parsed.data
    const result = await this.prisma.$transaction(async (tx) => {
      const { run, connection, now } = await this.lockRun(tx, current.organizationId, current.runId)
      if (run.workVersion !== 2 || run.status !== 'RUNNING') throw expired()
      checkLeaseShape(run)
      // Callerens leaseUntil är bara planeringsinformation. DB-fence och DBtid
      // avgör, även före en anslutningsreaktion eller en identisk sidläsning.
      if (
        run.claimVersion !== current.claimVersion ||
        run.claimToken !== current.claimToken ||
        !run.leaseUntil ||
        run.leaseUntil <= now
      )
        throw expired()
      const source = await this.checkBoundRun(tx, run)
      if (!sameConnection(run, connection)) {
        await this.stopChangedConnection(tx, run, now)
        return { ok: false as const }
      }
      return { ok: true as const, value: await action(tx, run, now, source) }
    }, PRISMA_DEFAULT_TX_LIMITS)
    // Kasta efter commit: en giltig ägare stoppar varaktigt en ändrad binding.
    if (!result.ok) throw new ConflictException(CONNECTION_CHANGED)
    return result.value
  }

  private async lockRun(tx: Tx, organizationId: string, runId: string) {
    await tx.$queryRaw`SELECT "id" FROM "FortnoxConnection"
      WHERE "organizationId" = ${organizationId} FOR UPDATE`
    const connection = await tx.fortnoxConnection.findUnique({
      where: { organizationId },
      select: connectionSelect,
    })
    await tx.$queryRaw`SELECT "id" FROM "FortnoxReadRun"
      WHERE "id" = ${runId} AND "organizationId" = ${organizationId} FOR UPDATE`
    const run = await tx.fortnoxReadRun.findUnique({ where: { id: runId, organizationId } })
    if (!run) throw invalid()
    return { run, connection, now: await this.databaseNow(tx) }
  }

  private async databaseNow(tx: Tx): Promise<Date> {
    // timestamptz → Date ger en verklig instant oberoende av sessionszon.
    // Prisma skriver Date som UTC till modellens timestamp(3)-kolumner.
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`
    if (!clock || !(clock.now instanceof Date) || !Number.isFinite(clock.now.getTime()))
      throw invalid()
    return clock.now
  }

  private async stopChangedConnection(tx: Tx, run: FortnoxReadRun, now: Date): Promise<void> {
    await tx.fortnoxReadRun.update({
      where: { id: run.id, organizationId: run.organizationId },
      data: {
        status: 'FAILED',
        reason: CONNECTION_CHANGED,
        completedAt: now,
        checkpointUpdatedAt: now,
        claimToken: null,
        leaseUntil: null,
      },
      select: { id: true, status: true },
    })
  }

  private async checkBoundRun(tx: Tx, run: FortnoxReadRun): Promise<SourceHeader> {
    if (!run.sourceCaptureId || !run.requestHash) throw invalid()
    const header = await readCheckpointSourceHeader(tx, run.organizationId, run.sourceCaptureId)
    checkBinding(run, header, run.requestHash)
    if (run.phase !== 'SOURCE_CAPTURED') {
      // Slutförd stage och sealed header är immutabla. Billig återställning
      // behöver bara deras metadata; inga extra parentlås från kvittoläsaren
      // och ingen helkontextläsning vid claim/start/renew/release.
      const stage = await tx.fortnoxReadNormalizationStage.findUnique({
        where: { id: run.id, organizationId: run.organizationId },
      })
      if (
        !stage ||
        stage.formatVersion !== 1 ||
        stage.status !== 'NORMALIZED' ||
        stage.mappingsDone !== stage.mappingCount ||
        stage.exportsDone !== stage.exportCount ||
        !(stage.normalizedAt instanceof Date) ||
        !Number.isFinite(stage.normalizedAt.getTime()) ||
        !(stage.createdAt instanceof Date) ||
        !Number.isFinite(stage.createdAt.getTime())
      )
        throw invalid()
      const binding = normalizedContextBinding(run, header, {
        ...stage,
        formatVersion: 1,
        status: 'NORMALIZED',
      })
      if (!(await findNormalizedContextHeader(tx, binding))) throw invalidNormalizedContext()
      await this.checkManifestProgress(tx, run)
    }
    return header
  }

  private async checkManifestProgress(tx: Tx, run: FortnoxReadRun): Promise<void> {
    // Två skalära sidhuvuden räcker för återställning av positionen. SQL:s
    // atomiska cursorgren och immutabla barn bär hela täckningsbeviset;
    // återspelning omhashar dessutom den faktiskt efterfrågade sidan.
    const previousPage = run.nextManifestPage - 1
    const pages = await tx.fortnoxReadManifestPage.findMany({
      where: {
        organizationId: run.organizationId,
        runId: run.id,
        page: { in: previousPage > 1 ? [1, previousPage] : [1] },
      },
      select: { page: true, totalPages: true, totalResources: true, itemCount: true },
    })
    if (run.nextManifestPage === 1) {
      if (run.phase !== 'MANIFEST' || pages.length !== 0) throw invalid()
      return
    }
    const first = pages.find((page) => page.page === 1)
    const previous = pages.find((page) => page.page === previousPage)
    if (
      !first ||
      !previous ||
      pages.length !== (previousPage > 1 ? 2 : 1) ||
      pages.some(
        (page) =>
          !Number.isSafeInteger(page.page) ||
          page.page < 1 ||
          !Number.isSafeInteger(page.totalPages) ||
          page.totalPages < 0 ||
          !Number.isSafeInteger(page.totalResources) ||
          page.totalResources < 0 ||
          !Number.isSafeInteger(page.itemCount) ||
          page.itemCount < 0 ||
          page.itemCount > 100 ||
          page.totalPages !== first.totalPages ||
          page.totalResources !== first.totalResources ||
          (page.totalPages === 0
            ? !(page.page === 1 && page.totalResources === 0 && page.itemCount === 0)
            : page.page > page.totalPages),
      )
    )
      throw invalid()
    if (run.phase === 'MANIFEST') {
      if (run.nextManifestPage > first.totalPages) throw invalid()
    } else {
      if (run.nextManifestPage !== Math.max(1, first.totalPages) + 1) throw invalid()
      // SQL:s sista detaljövergång bär fulla count-beviset. Hot restore
      // behöver endast pending-indexet, aldrig COUNT över alla detaljer.
      const pending = await nextVoucherKey(tx, run)
      if (
        (run.phase === 'DETAILS' && (first.totalResources === 0 || pending === null)) ||
        (run.phase === 'READY_TO_REDUCE' && pending !== null)
      )
        throw invalid()
    }
  }

  private async readBoundRun(
    tx: Tx,
    organizationId: string,
    runId: string,
    requestHash: string,
  ): Promise<FortnoxReadRun> {
    const run = await tx.fortnoxReadRun.findUnique({ where: { id: runId, organizationId } })
    if (!run || run.requestHash !== requestHash) throw invalid()
    await this.checkBoundRun(tx, run)
    return run
  }
}
