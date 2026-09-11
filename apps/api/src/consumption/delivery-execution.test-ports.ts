import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import type { DeliveryPacket, DeliveryReply, DeliveryResources } from './delivery-execution'

// Uttryckligen syntetisk provider. Ingen nätklient eller verkliga hemligheter.
export class SimulatedDeliveryProvider {
  now = Date.UTC(2026, 8, 11)
  readonly calls: DeliveryPacket[] = []
  readonly accepted: Array<{ key: string; id: string; body: string }> = []
  readonly modes: Array<'drop-before' | 'drop-after' | 'pending' | DeliveryReply> = []
  private pendingBarrier: {
    entered: ReturnType<typeof latch>
    release: ReturnType<typeof latch>
  } | null = null
  private readonly waiting = new Set<string>()
  get pendingRequests() {
    return this.waiting.size
  }

  holdNextRequest() {
    if (this.pendingBarrier || this.waiting.size)
      throw new Error('SIMULATED: pending-barriär redan reserverad')
    const entered = latch(),
      release = latch()
    this.pendingBarrier = { entered, release }
    this.modes.push('pending')
    return { entered: entered.promise, release: release.release }
  }

  private readonly cache = new Map<string, { body: string; expires: number; id: string | null }>()

  private key(packet: DeliveryPacket) {
    return [packet.team, packet.method, packet.endpoint, packet.attemptId].join('|')
  }

  async send(packet: DeliveryPacket): Promise<DeliveryReply> {
    this.calls.push({ ...packet })
    const mode = this.modes.shift()
    if (mode === 'drop-before') throw new Error('SIMULATED: aldrig framme hos provider')
    if (mode && typeof mode === 'object') return mode
    const key = this.key(packet)
    let stored = this.cache.get(key)
    if (stored && stored.expires <= this.now) {
      this.cache.delete(key)
      stored = undefined
    }
    if (stored) {
      if (stored.body !== packet.body) return { status: 409, code: 'invalid_idempotent_request' }
      if (!stored.id) return { status: 409, code: 'concurrent_idempotent_requests' }
      return { status: 200, id: stored.id }
    }
    if (mode === 'pending') {
      const barrier = this.pendingBarrier
      if (!barrier) throw new Error('SIMULATED: pending kräver uttrycklig entered/release-barriär')
      this.pendingBarrier = null
      this.cache.set(key, { body: packet.body, expires: this.now + 24 * 3600_000, id: null })
      this.waiting.add(key)
      barrier.entered.release()
      try {
        await barrier.release.promise
        return { status: 200, id: this.accept(packet) }
      } finally {
        this.waiting.delete(key)
      }
    }
    const id = this.accept(packet)
    if (mode === 'drop-after') throw new Error('SIMULATED: accepterat, svar tappat')
    return { status: 200, id }
  }

  private accept(packet: DeliveryPacket) {
    const key = this.key(packet)
    const id = 'simulated-email-' + (this.accepted.length + 1)
    this.accepted.push({ key, id, body: packet.body })
    this.cache.set(key, { body: packet.body, expires: this.now + 24 * 3600_000, id })
    return id
  }
}

export const fixtureResources: DeliveryResources = {
  'synthetic/template': Buffer.from('Fryst syntetisk mall v1').toString('base64'),
  'synthetic/pdf': Buffer.from('%PDF-1.4\nSyntetiska frysta bilagebyte\n%%EOF').toString('base64'),
}
export const fixtureResourceDigests = (resources = fixtureResources) =>
  Object.fromEntries(
    Object.entries(resources).map(([key, bytes]) => [
      key,
      createHash('sha256').update(Buffer.from(bytes, 'base64')).digest('hex'),
    ]),
  )
export function syntheticRenderer(snapshot: Prisma.JsonValue, resources: DeliveryResources) {
  const data = snapshot as { recipient: { email: string }; document: { id: string } }
  return JSON.stringify({
    from: 'Syntetisk avsändare <fixture@example.test>',
    to: [data.recipient.email],
    subject: 'Syntetiskt fryst dokument ' + data.document.id,
    text: 'Fryst syntetisk text',
    html: '<p>Fryst syntetisk text</p>',
    attachments: [
      {
        content: resources['synthetic/pdf'],
        filename: 'fryst-dokument.pdf',
        content_type: 'application/pdf',
      },
    ],
    headers: { 'X-Synthetic-Resource': fixtureResourceDigests(resources)['synthetic/template'] },
    tags: [{ name: 'environment', value: 'synthetic-contract-only' }],
  })
}

export type RendererAdapter = {
  render(snapshot: Prisma.JsonValue, resources: DeliveryResources): string | Promise<string>
}

// Steg 2 kan importera exakt detta kontrakt och lämna sin riktiga adapterfactory.
// Att den syntetiska adaptern klarar det säger ingenting om verklig rendering.
export async function assertRendererContract(
  factory: () => RendererAdapter,
  snapshot: Prisma.JsonValue,
  resources: DeliveryResources,
) {
  const frozen = JSON.stringify({ snapshot, resources })
  const expectedInputs = () =>
    JSON.parse(frozen) as {
      snapshot: Prisma.JsonValue
      resources: DeliveryResources
    }
  let expected: string | undefined
  for (let instance = 0; instance < 2; instance++) {
    const adapter = factory()
    for (let repetition = 0; repetition < 2; repetition++) {
      const input = expectedInputs()
      const result = await adapter.render(input.snapshot, input.resources)
      if (JSON.stringify(input) !== frozen) throw new Error('RENDERER_MUTATED_INPUT')
      if (expected === undefined) expected = result
      if (result !== expected) throw new Error('RENDERER_NONDETERMINISTIC_BYTES')
    }
  }
  return expected!
}

export function latch() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
