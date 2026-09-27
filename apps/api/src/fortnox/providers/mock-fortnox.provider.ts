import { amountOreOf } from '../fortnox-mapping'
import {
  isBookkeepOperation,
  type FortnoxCommand,
  type FortnoxExternalCandidate,
  type FortnoxLedgerPort,
  type FortnoxLookupResult,
  type FortnoxSendResult,
  type FortnoxTrustedContext,
} from '../fortnox.types'

/**
 * SYNTETISK Fortnox-attrapp för skiva 01. INTE ett sandboxbevis.
 *
 * ── VAD DEN ÄR STARKARE ÄN VERKLIGHETEN I ───────────────────────────────────
 *
 * Referensuppslaget är exakt och omedelbart. Kontraktet (KONTRAKT.md v1) säger
 * att varken unikhet för fakturareferens eller read-after-write är styrkt för
 * Fortnox API. Ett grönt prov mot den här klassen bevisar därför utkorgens
 * lokala beteende — aldrig att Fortnox beter sig likadant.
 *
 * Betalningsuppslag svarar UNSUPPORTED, i linje med kontraktets fynd att
 * betalningens fakturareferens inte identifierar en enskild delbetalning.
 *
 * ── TILLSTÅND UTANFÖR INSTANSEN ─────────────────────────────────────────────
 *
 * Den "externa" sidan bor i `MockFortnoxWorld`, inte i providern. Ett prov kan
 * alltså skapa en NY provider och en NY utkorgstjänst mot samma värld och samma
 * DB — det är så en processomstart efterliknas (A08/A10) utan att något
 * minnesobjekt i utkorgen bär bevisningen.
 */

export type MockSendScenario =
  /** Effekt + svar. Bokföringssteg svarar booked=true. */
  | 'ACK'
  /** Bokföringssteg: svarar ACK men utan bokföringsbevis. */
  | 'ACK_UNBOOKED'
  /** Bokföringssteg: svarar ACK med ett ANNAT externt id. */
  | 'ACK_WRONG_OBJECT'
  /** Effekten sker, svaret tappas (timeout efter extern effekt). */
  | 'EFFECT_THEN_UNKNOWN'
  /** Effekten sker, sedan kastar anropet (t.ex. nätfel mitt i svaret). */
  | 'EFFECT_THEN_THROW'
  /** Ingen effekt, oklart svar (oklar 5xx). */
  | 'UNKNOWN_NO_EFFECT'
  | 'SAFE_TO_RETRY'
  | 'AUTH'
  | 'REJECTED'

export type MockLookupMode =
  | 'REAL'
  | 'NOT_FOUND'
  | 'AMBIGUOUS'
  | 'MISMATCH_AMOUNT'
  | 'MISMATCH_REFERENCE'
  | 'UNAVAILABLE'
  | 'UNSUPPORTED'

interface MockObject extends FortnoxExternalCandidate {
  operation: FortnoxCommand['operation']
}

export class MockFortnoxWorld {
  readonly synthetic = true as const
  /** Externa objekt, nyckel = externalId. */
  readonly objects = new Map<string, MockObject>()
  /** Varje anrop till `send`, i ordning — oavsett utfall. */
  readonly sends: { eventKey: string; operation: string }[] = []
  /** Anrop som faktiskt gav extern effekt. */
  readonly effects: { eventKey: string; operation: string; externalId: string }[] = []
  readonly lookups: { eventKey: string }[] = []
  /** Konsumeras ett per `send`; tom kö ⇒ 'ACK'. */
  readonly sendScript: MockSendScenario[] = []
  lookupMode: MockLookupMode = 'REAL'
  /**
   * Anropas INNAN anropet räknas som skickat — ett prov kan hålla kvar ett
   * försök som "dog före nätverket" (A10a) eller låta två försök mötas (A07).
   */
  beforeSend: ((cmd: FortnoxCommand) => Promise<void>) | null = null
  /**
   * Anropas EFTER den externa effekten men innan svaret lämnas — ett prov kan
   * efterlikna en process som dör mellan extern framgång och lokal kvittens (A10b).
   */
  beforeReturn: ((cmd: FortnoxCommand) => Promise<void>) | null = null
  private seq = 0

  nextExternalId(): string {
    this.seq += 1
    return `mock-${this.seq}`
  }

  sendCount(eventKey?: string): number {
    return eventKey ? this.sends.filter((s) => s.eventKey === eventKey).length : this.sends.length
  }

  effectCount(eventKey?: string): number {
    return eventKey ? this.effects.filter((s) => s.eventKey === eventKey).length : this.effects.length
  }
}

export class MockFortnoxProvider implements FortnoxLedgerPort {
  readonly name = 'MOCK'

  constructor(readonly world: MockFortnoxWorld) {}

  /** Utför den externa effekten och returnerar objektets id. */
  private effect(ctx: FortnoxTrustedContext, cmd: FortnoxCommand, booked: boolean): string {
    if (isBookkeepOperation(cmd.operation)) {
      const id = cmd.predecessorExternalId
      const obj = id ? this.world.objects.get(id) : undefined
      if (!obj) throw new Error('mock: bokföringssteg utan känt objekt')
      if (booked) obj.booked = true
      this.world.effects.push({ eventKey: cmd.eventKey, operation: cmd.operation, externalId: obj.externalId })
      return obj.externalId
    }
    const externalId = this.world.nextExternalId()
    this.world.objects.set(externalId, {
      externalId,
      fortnoxTenantId: ctx.fortnoxTenantId,
      reference: cmd.eventKey,
      amountOre: amountOreOf(cmd.payload),
      currency: 'SEK',
      payloadHash: cmd.payloadHash,
      booked: false,
      operation: cmd.operation,
    })
    this.world.effects.push({ eventKey: cmd.eventKey, operation: cmd.operation, externalId })
    return externalId
  }

  async send(ctx: FortnoxTrustedContext, cmd: FortnoxCommand): Promise<FortnoxSendResult> {
    if (this.world.beforeSend) await this.world.beforeSend(cmd)
    this.world.sends.push({ eventKey: cmd.eventKey, operation: cmd.operation })
    const scenario = this.world.sendScript.shift() ?? 'ACK'
    const svar = this.utför(ctx, cmd, scenario)
    if (this.world.beforeReturn) await this.world.beforeReturn(cmd)
    if (svar === 'THROW') throw new Error('syntetiskt nätfel efter extern effekt')
    return svar
  }

  private utför(ctx: FortnoxTrustedContext, cmd: FortnoxCommand, scenario: MockSendScenario): FortnoxSendResult | 'THROW' {
    switch (scenario) {
      case 'ACK': {
        const booked = isBookkeepOperation(cmd.operation)
        const externalId = this.effect(ctx, cmd, booked)
        return booked ? { kind: 'ACK', externalId, booked: true } : { kind: 'ACK', externalId }
      }
      case 'ACK_UNBOOKED':
        return { kind: 'ACK', externalId: this.effect(ctx, cmd, false), booked: false }
      case 'ACK_WRONG_OBJECT':
        this.effect(ctx, cmd, true)
        return { kind: 'ACK', externalId: 'mock-annat-objekt', booked: true }
      case 'EFFECT_THEN_UNKNOWN':
        this.effect(ctx, cmd, isBookkeepOperation(cmd.operation))
        return { kind: 'UNKNOWN', reason: 'syntetisk timeout efter extern effekt' }
      case 'EFFECT_THEN_THROW':
        this.effect(ctx, cmd, isBookkeepOperation(cmd.operation))
        return 'THROW'
      case 'UNKNOWN_NO_EFFECT':
        return { kind: 'UNKNOWN', reason: 'syntetisk oklar 5xx' }
      case 'SAFE_TO_RETRY':
        return { kind: 'SAFE_TO_RETRY', reason: 'syntetisk 429 före mottagning' }
      case 'AUTH':
        return { kind: 'AUTH', reason: 'syntetisk 401' }
      case 'REJECTED':
        return { kind: 'REJECTED', reason: 'syntetiskt valideringsfel' }
    }
  }

  async lookup(ctx: FortnoxTrustedContext, cmd: FortnoxCommand): Promise<FortnoxLookupResult> {
    this.world.lookups.push({ eventKey: cmd.eventKey })
    const mode = this.world.lookupMode
    if (mode === 'UNAVAILABLE') return { kind: 'UNAVAILABLE', reason: 'syntetiskt otillgänglig' }
    if (mode === 'UNSUPPORTED' || cmd.operation === 'PAYMENT_CREATE' || cmd.operation === 'PAYMENT_BOOKKEEP') {
      return { kind: 'UNSUPPORTED', reason: 'betalning kan inte återläsas säkert per allokering' }
    }
    if (mode === 'NOT_FOUND') return { kind: 'NOT_FOUND' }

    // Bokföringssteget letar på skapandets objekt; skapandet på sin egen referens.
    const träffar = isBookkeepOperation(cmd.operation)
      ? [...this.world.objects.values()].filter((o) => o.externalId === cmd.predecessorExternalId)
      : [...this.world.objects.values()].filter(
          (o) => o.reference === cmd.eventKey && o.fortnoxTenantId === ctx.fortnoxTenantId,
        )
    const kandidater: FortnoxExternalCandidate[] = träffar.map((o) => ({
      externalId: o.externalId,
      fortnoxTenantId: o.fortnoxTenantId,
      reference: o.reference,
      amountOre: o.amountOre,
      currency: o.currency,
      payloadHash: o.payloadHash,
      booked: o.booked,
    }))

    if (mode === 'AMBIGUOUS') {
      const bas = kandidater[0] ?? {
        externalId: 'mock-x',
        fortnoxTenantId: ctx.fortnoxTenantId,
        reference: cmd.eventKey,
        amountOre: amountOreOf(cmd.payload),
        currency: 'SEK',
        payloadHash: cmd.payloadHash,
        booked: false,
      }
      return { kind: 'FOUND', candidates: [bas, { ...bas, externalId: `${bas.externalId}-dubblett` }] }
    }
    if (mode === 'MISMATCH_AMOUNT' || mode === 'MISMATCH_REFERENCE') {
      // Samma belopp och datum är aldrig identitet: en post med rätt belopp men
      // fel referens ska inte godtas, och inte heller rätt referens med fel belopp.
      const c: FortnoxExternalCandidate = {
        externalId: 'mock-avvikande',
        fortnoxTenantId: ctx.fortnoxTenantId,
        reference: mode === 'MISMATCH_REFERENCE' ? 'någon-annans-referens' : cmd.eventKey,
        amountOre: mode === 'MISMATCH_AMOUNT' ? amountOreOf(cmd.payload) + 1 : amountOreOf(cmd.payload),
        currency: 'SEK',
        payloadHash: cmd.payloadHash,
        booked: false,
      }
      return { kind: 'FOUND', candidates: [c] }
    }
    return kandidater.length === 0 ? { kind: 'NOT_FOUND' } : { kind: 'FOUND', candidates: kandidater }
  }
}
