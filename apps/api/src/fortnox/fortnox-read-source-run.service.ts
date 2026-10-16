import { BadRequestException, ConflictException, Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { Prisma, type FortnoxReadRun } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import {
  canonicalCheckpointInput,
  checkpointDigest,
  type StartCheckpointInput,
} from './fortnox-read-checkpoint-context'
import { captureCheckpointSource, readCheckpointSourceHeader } from './fortnox-read-source-capture'

type Tx = Prisma.TransactionClient
type SourceHeader = Awaited<ReturnType<typeof readCheckpointSourceHeader>>
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

function sameConnection(run: FortnoxReadRun, connection: Connection): boolean {
  return (
    connection.status === 'ACTIVE' &&
    run.organizationId === connection.organizationId &&
    run.connectionId === connection.id &&
    run.connectionGeneration === connection.generation &&
    run.fortnoxDatabaseNumber === connection.fortnoxDatabaseNumber &&
    run.fortnoxOrgNumber === connection.fortnoxOrgNumber
  )
}

function checkBinding(run: FortnoxReadRun, header: SourceHeader, requestHash: string): void {
  const input = header.input
  if (
    run.workVersion !== 2 ||
    run.status !== 'RUNNING' ||
    run.phase !== 'SOURCE_CAPTURED' ||
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
    run.claimVersion !== 0 ||
    run.claimToken !== null ||
    run.leaseUntil !== null ||
    run.nextAttemptAt !== null ||
    run.nextManifestPage !== 1
  )
    throw invalid()
}

/**
 * Inert start för v2: en liten körning binds atomiskt till komplett råkälla.
 * SOURCE_CAPTURED innebär ännu ingen validerad kontext, lease eller ekonomiskt
 * resultat. Ingen HTTP-, kö-, normaliserings- eller providerkoppling finns här.
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
              const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
              SELECT clock_timestamp() AS "now"`
              if (!clock) throw invalid()
              await tx.fortnoxReadRun.update({
                where: { id: existing.id, organizationId },
                data: {
                  status: 'FAILED',
                  reason: 'Fortnox-anslutningen har ändrats; starta en ny läsning.',
                  completedAt: clock.now,
                  checkpointUpdatedAt: clock.now,
                },
              })
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

  private async readBoundRun(
    tx: Tx,
    organizationId: string,
    runId: string,
    requestHash: string,
  ): Promise<FortnoxReadRun> {
    const run = await tx.fortnoxReadRun.findUnique({ where: { id: runId, organizationId } })
    if (!run?.sourceCaptureId) throw invalid()
    const header = await readCheckpointSourceHeader(tx, organizationId, run.sourceCaptureId)
    checkBinding(run, header, requestHash)
    return run
  }
}
