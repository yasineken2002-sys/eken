import { BadRequestException, ConflictException, Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { Prisma, type FortnoxReadRun } from '@prisma/client'
import { z } from 'zod'
import { PrismaService } from '../common/prisma/prisma.service'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import {
  canonicalCheckpointInput,
  checkpointDigest,
  type StartCheckpointInput,
} from './fortnox-read-checkpoint-context'
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
  type NormalizationPage,
  type NormalizationPageReceipt,
  type NormalizationPosition,
  type NormalizationProgress,
  type NormalizedPagePosition,
} from './fortnox-read-normalization-stage'

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
    run.phase !== 'SOURCE_CAPTURED' ||
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
    run.catalog !== null ||
    run.summary !== null ||
    run.rows !== null ||
    run.financialYearStart !== null ||
    run.financialYearEnd !== null ||
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
    run.nextManifestPage !== 1
  )
    throw invalid()
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
    return this.withLease(lease, (tx, run, now, source) =>
      prepareNormalizationStage(tx, run, source, now),
    )
  }

  async normalizePage(
    lease: SourceRunLease,
    input: NormalizationPosition,
  ): Promise<NormalizationPageReceipt> {
    const expected = parseNormalizationPosition(input)
    const result = await this.withLease(lease, async (tx, run, _now, source) => {
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
    return header
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
