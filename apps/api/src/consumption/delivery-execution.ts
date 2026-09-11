import { createHash, randomUUID } from 'node:crypto'
import { ConflictException } from '@nestjs/common'
import { Prisma, PrismaClient } from '@prisma/client'
import type { DeliveryDispatch, DeliveryObservation } from '@prisma/client'
import { DeliveryDecisions } from './delivery-decisions'
import type { DeliveryDecisionCommand } from './delivery-decisions'

type Tx = Prisma.TransactionClient
export type DeliveryResources = Record<string, string> // Frysta base64-byte per resursnyckel.
export type DeliveryPacket = Pick<
  DeliveryDispatch,
  'attemptId' | 'team' | 'method' | 'endpoint' | 'body' | 'digest'
>
export type DeliveryReply = { status: number; id?: string; code?: string }
export interface DeliveryPorts {
  resources(): DeliveryResources
  render(snapshot: Prisma.JsonValue, resources: DeliveryResources): string
  publish(decisionId: string): Promise<void>
  send(packet: DeliveryPacket): Promise<DeliveryReply> // Idempotency-Key = attemptId; ingen intern retry.
}
export const deliveryDigest = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex')
const json = (value: unknown): Prisma.InputJsonObject => JSON.parse(JSON.stringify(value))

// Inaktiv: ingen Nest-registrering, köadapter, renderer eller nätklient importeras.
export class DeliveryExecution {
  readonly decisions: DeliveryDecisions
  constructor(
    private readonly db: PrismaClient,
    private readonly identity: { organizationId: string; principalId: string; team: string },
    private readonly ports: DeliveryPorts,
    private readonly monotonic = () => process.hrtime.bigint(),
  ) {
    this.decisions = new DeliveryDecisions(db)
  }

  private scope(d: DeliveryDispatch) {
    return {
      organizationId: d.organizationId,
      documentId: d.documentId,
      actorId: this.identity.principalId,
      authorityKind: 'SERVICE' as const,
    }
  }

  private async load(tx: Tx, decisionId: string, receipt = false) {
    await tx.$queryRaw`SELECT delivery_lock(${this.identity.organizationId})::text`
    const principal = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "DeliveryPrincipal" WHERE "id" = ${this.identity.principalId}
      AND "organizationId" = ${this.identity.organizationId} AND ("active" OR ${receipt}) FOR SHARE`
    if (!principal.length) throw new ConflictException('DELIVERY_PRINCIPAL_FORBIDDEN')
    return tx.deliveryDispatch.findFirstOrThrow({
      where: { decisionId, organizationId: this.identity.organizationId, team: this.identity.team },
      include: { decision: { include: { events: { orderBy: { revision: 'desc' }, take: 1 } } } },
    })
  }

  private observe(
    tx: Tx,
    d: DeliveryDispatch,
    kind: string,
    evidence = {},
    grantId: string | null = null,
  ) {
    return tx.deliveryObservation.create({
      data: {
        organizationId: d.organizationId,
        decisionId: d.decisionId,
        kind,
        grantId,
        evidence: json(evidence),
        principalId: this.identity.principalId,
      },
    })
  }

  async enqueue(
    command: DeliveryDecisionCommand & { resources: Prisma.InputJsonObject; team: string },
  ) {
    if (
      command.organizationId !== this.identity.organizationId ||
      command.team !== this.identity.team
    )
      throw new ConflictException('DELIVERY_SCOPE_CONFLICT')
    return this.decisions.transaction(async (tx) => {
      const result = await this.decisions.decide(command, tx)
      const existing = await tx.deliveryDispatch.findUnique({
        where: { decisionId: result.decision.id },
      })
      if (existing) return existing
      const resources = { ...this.ports.resources() }
      const digests = Object.fromEntries(
        Object.entries(resources).map(([key, bytes]) => [
          key,
          deliveryDigest(Buffer.from(bytes, 'base64')),
        ]),
      )
      // Kontrollerar verkliga resursbyte mot beslutets digester, även bakom samma nyckel.
      if (
        Object.keys(digests).length !== Object.keys(command.resources).length ||
        Object.entries(digests).some(([key, digest]) => command.resources[key] !== digest)
      )
        throw new ConflictException('DELIVERY_RESOURCE_CONFLICT')
      const body = this.ports.render(result.decision.snapshot, resources)
      return tx.deliveryDispatch.create({
        data: {
          decisionId: result.decision.id,
          organizationId: command.organizationId,
          documentId: command.documentId,
          attemptId: randomUUID(),
          team: command.team,
          method: 'POST',
          endpoint: 'https://api.resend.com/emails',
          resources: command.resources,
          body,
          digest: deliveryDigest(body),
        },
      })
    })
  }

  async publish(decisionId: string) {
    const d = await this.decisions.transaction((tx) => this.load(tx, decisionId))
    await this.ports.publish(d.decisionId)
    await this.decisions.transaction((tx) => this.observe(tx, d, 'PUBLISHED'))
  }

  private async transition(
    tx: Tx,
    d: DeliveryDispatch,
    to: 'SENDING' | 'UNKNOWN' | 'PROVIDER_ACCEPTED',
    evidence = {},
  ) {
    return this.decisions.transition(
      {
        ...this.scope(d),
        decisionId: d.decisionId,
        commandKey: randomUUID(),
        to,
        attemptId: to === 'SENDING' ? null : d.attemptId,
        evidence: json({ detail: 'Inaktiv exekveringsport', ...evidence }),
      },
      tx,
    )
  }

  private async expire(tx: Tx, d: DeliveryDispatch) {
    const started = await tx.deliveryEvent.findFirstOrThrow({
      where: { id: d.attemptId, state: 'SENDING' },
    })
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT delivery_now() AS now`
    const expired = clock!.now.getTime() >= started.createdAt.getTime() + 23 * 3600_000
    if (
      expired &&
      !(await tx.deliveryObservation.findFirst({
        where: {
          decisionId: d.decisionId,
          kind: 'CLOSED',
          evidence: { path: ['reason'], equals: 'EXPIRED' },
        },
      }))
    )
      await this.observe(tx, d, 'CLOSED', { reason: 'EXPIRED' })
    return started.createdAt.getTime() + 23 * 3600_000 - clock!.now.getTime()
  }

  private async grant(decisionId: string) {
    return this.decisions.transaction(async (tx) => {
      const d = await this.load(tx, decisionId)
      const state = d.decision.events[0]!.state
      if (!['DECIDED', 'SENDING', 'UNKNOWN'].includes(state)) return null
      if (state === 'DECIDED') {
        try {
          const fresh = await this.decisions.snapshot(tx, this.scope(d))
          if (fresh.fingerprint !== d.decision.fingerprint)
            throw new ConflictException('DELIVERY_SNAPSHOT_CONFLICT')
        } catch (error) {
          if (!(error instanceof ConflictException)) throw error
          await this.observe(tx, d, 'CONFLICT', {
            reason: error.message,
            expected: d.decision.fingerprint,
          })
          return null // Nekning committas; inget undantag rullar tillbaka spåret.
        }
        await this.transition(tx, d, 'SENDING')
      } else if (state === 'SENDING') await this.transition(tx, d, 'UNKNOWN')
      const grant = await this.observe(tx, d, state === 'DECIDED' ? 'FIRST' : 'RETRY')
      return grant.kind === 'CLOSED' ? null : { d, grant }
    }) // Först efter denna ägda commit får någon fortsätta mot nätet.
  }

  private async finalCheck(d: DeliveryDispatch) {
    return this.decisions.transaction(async (tx) => {
      const current = await this.load(tx, d.decisionId)
      const closed = await tx.deliveryObservation.findMany({
        where: { decisionId: d.decisionId, kind: 'CLOSED' },
      })
      // CALL_LIMIT stoppar nya grants; sista redan beviljade grant får fortfarande användas.
      if (
        closed.some((row) => (row.evidence as Prisma.JsonObject).reason !== 'CALL_LIMIT_OR_CLOSED')
      )
        return false
      if (!['SENDING', 'UNKNOWN'].includes(current.decision.events[0]!.state)) return false
      if (
        deliveryDigest(d.body) !== d.digest ||
        d.team !== this.identity.team ||
        d.body !== current.body ||
        d.attemptId !== current.attemptId ||
        d.method !== current.method ||
        d.endpoint !== current.endpoint
      ) {
        await this.observe(tx, current, 'CONFLICT', { reason: 'DELIVERY_ARTIFACT_CONFLICT' })
        await this.observe(tx, current, 'CLOSED', { reason: 'DELIVERY_ARTIFACT_CONFLICT' })
        if (current.decision.events[0]!.state === 'SENDING')
          await this.transition(tx, current, 'UNKNOWN')
        return false
      }
      const anchor = this.monotonic()
      const remaining = await this.expire(tx, d)
      if (remaining <= 0) {
        if (current.decision.events[0]!.state === 'SENDING') await this.transition(tx, d, 'UNKNOWN')
        return false
      }
      return anchor + BigInt(remaining) * 1_000_000n
    })
  }

  async run(decisionId: string) {
    const allowed = await this.grant(decisionId)
    if (!allowed) return { called: false }
    const boundary = await this.finalCheck(allowed.d)
    if (boundary === false) return { called: false }
    if (this.monotonic() >= boundary) {
      await this.decisions.transaction(async (tx) => {
        const current = await this.load(tx, decisionId)
        await this.observe(tx, current, 'CLOSED', { reason: 'CONSERVATIVE_DEADLINE' })
        if (current.decision.events[0]!.state === 'SENDING')
          await this.transition(tx, current, 'UNKNOWN')
      })
      return { called: false }
    }
    // Sista kontrollerbara punkt. En paus här kan INTE återkallas av DB/lease/timeout.
    const { d, grant } = allowed
    let reply: DeliveryReply
    try {
      reply = await this.ports.send({
        attemptId: d.attemptId,
        team: d.team,
        method: d.method,
        endpoint: d.endpoint,
        body: d.body,
        digest: d.digest,
      })
    } catch {
      reply = { status: 0, code: 'TRANSPORT_UNKNOWN' }
    }
    await this.record(d, grant, reply)
    return { called: true, reply }
  }

  private async record(d: DeliveryDispatch, grant: DeliveryObservation, reply: DeliveryReply) {
    await this.decisions.transaction(async (tx) => {
      const current = await this.load(tx, d.decisionId, true)
      const event = current.decision.events[0]!
      const actualGrant = await tx.deliveryObservation.findFirst({
        where: {
          id: grant.id,
          organizationId: d.organizationId,
          decisionId: d.decisionId,
          kind: { in: ['FIRST', 'RETRY'] },
        },
      })
      if (
        !actualGrant ||
        actualGrant.kind !== grant.kind ||
        d.organizationId !== current.organizationId ||
        d.documentId !== current.documentId ||
        d.team !== current.team ||
        d.method !== current.method ||
        d.endpoint !== current.endpoint ||
        d.body !== current.body ||
        d.digest !== current.digest ||
        d.attemptId !== current.attemptId
      ) {
        await this.observe(tx, current, 'CONFLICT', {
          reason: 'RECEIPT_CORRELATION',
          grantId: grant.id,
          reply,
        })
        return
      }
      const receipt = await this.observe(tx, d, 'RECEIPT', reply, actualGrant.id)
      if (
        !(
          await tx.deliveryPrincipal.findUniqueOrThrow({ where: { id: this.identity.principalId } })
        ).active
      )
        return
      await this.expire(tx, d)
      const positive =
        reply.status === 200 && typeof reply.id === 'string' && reply.id.trim().length > 0
      if (event.state === 'PROVIDER_ACCEPTED') {
        if (positive && (event.evidence as Prisma.JsonObject).reference !== reply.id)
          await this.observe(tx, d, 'CONFLICT', {
            reason: 'CONTRADICTORY_RECEIPT',
            receiptId: receipt.id,
          })
        return
      }
      if (!['SENDING', 'UNKNOWN'].includes(event.state)) return
      if (positive && (event.state === 'SENDING' || grant.kind === 'RETRY')) {
        await this.transition(tx, d, 'PROVIDER_ACCEPTED', {
          kind: 'ACCEPTANCE',
          attemptId: d.attemptId,
          provider: 'resend',
          reference: reply.id,
          receipt: { outcome: 'ACCEPTED' },
          observationId: receipt.id,
        })
      } else {
        if (reply.status === 409 && reply.code === 'invalid_idempotent_request') {
          await this.observe(tx, d, 'CONFLICT', {
            reason: 'CONTENT_CONFLICT',
            receiptId: receipt.id,
          })
          await this.observe(tx, d, 'CLOSED', { reason: 'CONTENT_CONFLICT' })
        }
        if (event.state === 'SENDING') await this.transition(tx, d, 'UNKNOWN')
      }
    })
  }
}
