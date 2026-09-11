import { randomUUID } from 'node:crypto'
import { ConflictException } from '@nestjs/common'
import { Prisma, PrismaClient } from '@prisma/client'
import { consumptionConflict, requireChargeActor, requireChargeCheck } from './charge-gate'

type Tx = Prisma.TransactionClient
type Scope = { organizationId: string; documentId: string; actorId: string }
type Creation =
  | {
      kind: 'INVOICE'
      data: Omit<Prisma.InvoiceUncheckedCreateInput, 'id' | 'organizationId' | 'deliveryDocuments'>
    }
  | {
      kind: 'NOTICE'
      data: Omit<
        Prisma.RentNoticeUncheckedCreateInput,
        'id' | 'organizationId' | 'deliveryDocuments'
      >
    }
export type DeliveryDecisionCommand = Scope & {
  commandKey: string
  operation: 'ORIGINAL' | 'INVOICE_RESEND'
  expectedFingerprint: string
  reason: string
}
export type DeliveryTransitionCommand = Scope & {
  commandKey: string
  decisionId: string
  to: 'REVOKED' | 'SENDING' | 'UNKNOWN' | 'PROVIDER_ACCEPTED' | 'FAILED_NO_ACCEPTANCE'
  attemptId: string | null
  evidence: Prisma.InputJsonObject
}
type Command = DeliveryDecisionCommand | DeliveryTransitionCommand
type Snapshot = Prisma.JsonObject & {
  document: Prisma.JsonObject
  recipient: Prisma.JsonObject | null
  checks: Array<Prisma.JsonObject & { id: string; chargeId: string }>
}
const conflict = (code: string): never => {
  throw new ConflictException(code)
}
const json = (value: unknown): Prisma.InputJsonObject => JSON.parse(JSON.stringify(value))
const eventFields = (command: Command) => ({
  organizationId: command.organizationId,
  documentId: command.documentId,
  commandKey: command.commandKey,
  request: json(command),
  actorId: command.actorId,
  actorName: '',
})

// Ingen Nest-modul registrerar denna klass. Inga kö-/leverantörsadaptrar importeras.
export class DeliveryDecisions {
  constructor(private readonly db: PrismaClient) {}

  private transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db
      .$transaction(
        async (tx) => {
          const result = await work(tx)
          await this.checkConstraints(tx)
          return result
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 },
      )
      .catch(consumptionConflict)
  }

  // Måste vara sista steget även hos tx-ägaren i 2b: Prisma 5 kan dölja COMMIT-fel.
  async checkConstraints(tx: Tx) {
    await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`
  }

  async register(organizationId: string, actorId: string, input: Creation) {
    return this.transaction(async (tx) => {
      const id = randomUUID()
      await requireChargeActor(tx, organizationId, actorId)
      // Roten måste komma först. Uppskjutna FK kräver den faktiska insättningen.
      const root = await tx.deliveryDocument.create({
        data: {
          id,
          organizationId,
          createdById: actorId,
          invoiceId: input.kind === 'INVOICE' ? id : null,
          noticeId: input.kind === 'NOTICE' ? id : null,
        },
      })
      if (input.kind === 'INVOICE') {
        await tx.invoice.create({ data: { ...input.data, id, organizationId, status: 'DRAFT' } })
      } else {
        await tx.rentNotice.create({
          data: {
            ...input.data,
            id,
            organizationId,
            status: 'PENDING',
            sentAt: null,
          },
        })
      }
      return root
    })
  }

  private async authorize(tx: Tx, scope: Scope) {
    await tx.$queryRaw`SELECT delivery_lock(${scope.organizationId})::text`
    await requireChargeActor(tx, scope.organizationId, scope.actorId)
  }

  private async snapshot(tx: Tx, scope: Scope) {
    const root = await tx.deliveryDocument.findFirst({
      where: {
        id: scope.documentId,
        organizationId: scope.organizationId,
      },
    })
    if (!root) conflict('HISTORY_UNVERIFIED')
    const charges = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT delivery_charge_ids(${scope.documentId}) AS id`
    for (const charge of charges) await requireChargeCheck(tx, scope.organizationId, charge.id)
    const [result] = await tx.$queryRaw<Array<{ snapshot: Snapshot; fingerprint: string }>>`
      SELECT s AS snapshot, delivery_fingerprint(s) AS fingerprint
      FROM (SELECT delivery_snapshot(${scope.organizationId}, ${scope.documentId}) AS s) content`
    if (!result?.snapshot?.recipient?.email) return conflict('DELIVERY_RECIPIENT_INVALID')
    if (['VOID', 'PAID', 'CANCELLED'].includes(String(result.snapshot.document.status))) {
      conflict('DELIVERY_DOCUMENT_STATUS_FORBIDDEN')
    }
    return result
  }

  // Förhandsläsning av domänunderlag; varken beslut eller byteattest.
  async prepare(scope: Scope) {
    return this.transaction(async (tx) => {
      await this.authorize(tx, scope)
      return this.snapshot(tx, scope)
    })
  }

  private async result(tx: Tx, scope: Scope, decisionId: string, outcome: string) {
    const decision = await tx.deliveryDecision.findFirstOrThrow({
      where: {
        id: decisionId,
        documentId: scope.documentId,
        organizationId: scope.organizationId,
      },
      include: { members: true, events: { orderBy: { revision: 'desc' }, take: 1 } },
    })
    const event = decision.events[0]!
    return {
      decision,
      event,
      outcome,
      startGranted: false,
      blockingReason: event.state === 'UNKNOWN' ? 'OUTCOME_UNKNOWN_REQUIRES_HUMAN' : null,
    }
  }

  private async replay(tx: Tx, command: Command) {
    const event = await tx.deliveryEvent.findUnique({
      where: {
        organizationId_commandKey: {
          organizationId: command.organizationId,
          commandKey: command.commandKey,
        },
      },
    })
    if (!event) return null
    // JSONB-jämförelse: objektens nyckelordning saknar betydelse, innehållet gör det inte.
    if (
      !(await tx.deliveryEvent.findFirst({
        where: { id: event.id, request: { equals: json(command) } },
      }))
    ) {
      conflict('KEY_CONFLICT')
    }
    return this.result(
      tx,
      command,
      event.decisionId,
      'to' in command && command.to === 'SENDING' ? 'ALREADY_STARTED' : 'REPLAYED',
    )
  }

  // tx gör en framtida outboxavsikt möjlig i SAMMA commit. Ingen outbox finns i 2a.
  async decide(
    command: DeliveryDecisionCommand,
    tx?: Tx,
  ): Promise<Awaited<ReturnType<DeliveryDecisions['result']>>> {
    if (!tx) return this.transaction((client) => this.decide(command, client))
    await this.authorize(tx, command)
    const replay = await this.replay(tx, command)
    if (replay) return replay
    const [position] = await tx.$queryRaw<
      Array<{ original: string | null; previous: string | null; sequence: number }>
    >`
      SELECT * FROM delivery_ready(${command.organizationId}, ${command.documentId}, ${command.operation})`
    const current = await this.snapshot(tx, command)
    if (current.fingerprint !== command.expectedFingerprint) conflict('DELIVERY_SNAPSHOT_CONFLICT')
    const decision = await tx.deliveryDecision.create({
      data: {
        organizationId: command.organizationId,
        documentId: command.documentId,
        sequence: position!.sequence,
        originalId: position!.original,
        previousId: position!.previous,
        operation: command.operation,
        snapshot: current.snapshot,
        fingerprint: current.fingerprint,
      },
    })
    await tx.deliveryMember.createMany({
      data: current.snapshot.checks.map((check) => ({
        organizationId: command.organizationId,
        documentId: command.documentId,
        decisionId: decision.id,
        chargeId: check.chargeId,
        checkId: check.id,
      })),
    })
    await tx.deliveryEvent.create({
      data: {
        ...eventFields(command),
        decisionId: decision.id,
        revision: 1,
        state: 'DECIDED',
        evidence: {},
      },
    })
    return this.result(tx, command, decision.id, 'CREATED')
  }

  async transition(
    command: DeliveryTransitionCommand,
    tx?: Tx,
  ): Promise<Awaited<ReturnType<DeliveryDecisions['result']>>> {
    if (!tx) {
      const result = await this.transaction((client) => this.transition(command, client))
      // Först efter ägd commit. En övertagen transaktion får aldrig starttillstånd.
      return {
        ...result,
        startGranted: result.outcome === 'RECORDED' && result.event.state === 'SENDING',
      }
    }
    await this.authorize(tx, command)
    const replay = await this.replay(tx, command)
    if (replay) return replay
    const current = await this.result(tx, command, command.decisionId, 'READ')
    if (command.to === 'SENDING') {
      if (command.attemptId !== null) conflict('DELIVERY_TRANSITION_FORBIDDEN')
      const fresh = await this.snapshot(tx, command)
      if (fresh.fingerprint !== current.decision.fingerprint) conflict('DELIVERY_SNAPSHOT_CONFLICT')
    }
    const id = randomUUID()
    await tx.deliveryEvent.create({
      data: {
        ...eventFields(command),
        id,
        decisionId: command.decisionId,
        revision: current.event.revision + 1,
        state: command.to,
        attemptId: command.to === 'SENDING' ? id : command.attemptId,
        evidence: command.evidence,
      },
    })
    return this.result(tx, command, command.decisionId, 'RECORDED')
  }
}
