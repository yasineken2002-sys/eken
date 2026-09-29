import { randomUUID } from 'crypto'
import { Inject, Injectable, Optional } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { FortnoxOutboxEntry, FortnoxOutboxState } from '@prisma/client'

import { PrismaService } from '../common/prisma/prisma.service'
import { isP2002From } from '../common/prisma/p2002-constraint'
import {
  EVENT_TYPE_OF,
  INTENT_KIND_OF,
  amountOreOf,
  fortnoxEventKey,
  fortnoxPayloadHash,
  sourceIdOf,
} from './fortnox-mapping'
import {
  BOOKKEEP_OF,
  FORTNOX_PROVIDER,
  FORTNOX_SUPPORTED_VERSION,
  isBookkeepOperation,
  type FortnoxCommand,
  type FortnoxExternalCandidate,
  type FortnoxIntent,
  type FortnoxLedgerPort,
  type FortnoxLookupResult,
  type FortnoxOperation,
  type FortnoxSendResult,
  type FortnoxTrustedContext,
} from './fortnox.types'

/**
 * Fortnox skiva 01 — beständig utkorg. OANSLUTEN: ingen affärstjänst, hook, kö,
 * cron eller endpoint anropar den. I 01 matas den bara av prov.
 *
 * ── DEN BÄRANDE REGELN ──────────────────────────────────────────────────────
 *
 * En databastransaktion kan inte rulla tillbaka Fortnox. Därför:
 *
 *   1. claim (READY/RETRY_WAIT → SENDING, unikt attemptToken, lease) COMMITTAS
 *      innan nätverket rörs. Ingen transaktion hålls över `send`.
 *   2. Avslutet kräver samma attemptToken och samma org/anslutning/företag
 *      (fencing). Ett sent svar efter att leasen gått ut skriver ingenting.
 *   3. Allt som KAN ha haft extern effekt — timeout, förlorat svar, oklar 5xx,
 *      kast från adaptern, lease som löpt ut — blir UNKNOWN. UNKNOWN går ALDRIG
 *      tillbaka till READY. Enda vägen ut är en återläsning som tjänsten själv
 *      verifierar (→ ACKNOWLEDGED), annars MANUAL_REVIEW eller kvar i UNKNOWN.
 *   4. Det finns inget "försök ändå"-API.
 *
 * ── VAD DEN INTE KAN SE ─────────────────────────────────────────────────────
 *
 * Utkorgen är idempotent per händelsenyckel. Den är INTE en spärr mot två
 * OLIKA källhändelser för samma fordran — det kräver ett ägarregister per
 * fordran (NASTA-BYGGE steg 4). Och den kan inte göra Fortnox idempotent: med
 * en verklig adapter är återläsningen högst så säker som Fortnox referenssökning.
 */

export interface FortnoxOutboxOptions {
  now?: () => Date
  /** [0, 1) — jitter. Injiceras så att prov blir deterministiska. */
  random?: () => number
  maxAttempts?: number
  leaseMs?: number
  backoffBaseMs?: number
}

export const FORTNOX_OUTBOX_OPTIONS = Symbol('FORTNOX_OUTBOX_OPTIONS')

export class FortnoxPayloadConflictError extends Error {
  constructor(readonly eventKey: string) {
    super('Fortnox-utkorg: samma händelsenyckel med annan payload — nekas, ingen uppdatering')
  }
}

export class FortnoxEnqueueError extends Error {}

/** Redigerad felklass. Aldrig adapterns fritext — den kan bära persondata. */
export type FortnoxErrorClass =
  | 'SAFE_TO_RETRY'
  | 'RETRY_EXHAUSTED'
  | 'AUTH'
  | 'REJECTED'
  | 'UNKNOWN'
  | 'PROVIDER_THREW'
  | 'BOOKKEEP_UNVERIFIED'
  | 'ACK_WITHOUT_ID'
  | 'LEASE_EXPIRED'
  | 'LOOKUP_NOT_FOUND'
  | 'LOOKUP_UNAVAILABLE'
  | 'LOOKUP_UNSUPPORTED'
  | 'LOOKUP_AMBIGUOUS'
  | 'LOOKUP_MISMATCH'

export type EnqueueResult = { status: 'CREATED' | 'EXISTING'; entry: FortnoxOutboxEntry }

export type ProcessResult =
  | { status: 'NOT_FOUND' }
  | { status: 'BLOCKED'; reason: 'PREDECESSOR_NOT_ACKNOWLEDGED' | 'PREDECESSOR_NOT_BOOKED' }
  | { status: 'NOT_CLAIMABLE' }
  /** Fencing slog till: ett nyare läge fanns redan, ingenting skrevs. */
  | { status: 'STALE' }
  | { status: 'DONE'; state: FortnoxOutboxState }

export type ReconcileResult =
  | { status: 'NOT_FOUND' }
  | { status: 'NOT_UNKNOWN'; state: FortnoxOutboxState }
  | { status: 'STALE' }
  | { status: 'DONE'; state: FortnoxOutboxState; errorClass: FortnoxErrorClass | null }

const CLAIMABLE: FortnoxOutboxState[] = ['READY', 'RETRY_WAIT']

@Injectable()
export class FortnoxOutboxService {
  private readonly now: () => Date
  private readonly random: () => number
  private readonly maxAttempts: number
  private readonly leaseMs: number
  private readonly backoffBaseMs: number

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FORTNOX_PROVIDER) private readonly provider: FortnoxLedgerPort,
    @Optional() @Inject(FORTNOX_OUTBOX_OPTIONS) options?: FortnoxOutboxOptions,
  ) {
    this.now = options?.now ?? (() => new Date())
    this.random = options?.random ?? Math.random
    this.maxAttempts = options?.maxAttempts ?? 5
    // Större än den föreslagna adaptertimeouten (15 s) med marginal.
    this.leaseMs = options?.leaseMs ?? 60_000
    this.backoffBaseMs = options?.backoffBaseMs ?? 30_000
  }

  // ── Köning ─────────────────────────────────────────────────────────────────

  /** Föregångarens nyckel härleds server-side — anroparen kan inte välja den. */
  predecessorKey(
    ctx: FortnoxTrustedContext,
    operation: FortnoxOperation,
    payload: FortnoxIntent,
  ): string | null {
    const skapande = BOOKKEEP_OF[operation]
    if (skapande) {
      return fortnoxEventKey(
        ctx,
        EVENT_TYPE_OF[skapande],
        sourceIdOf(payload),
        FORTNOX_SUPPORTED_VERSION,
        skapande,
      )
    }
    if (payload.kind === 'PAYMENT') {
      return fortnoxEventKey(
        ctx,
        'RENT_NOTICE',
        payload.noticeId,
        FORTNOX_SUPPORTED_VERSION,
        'INVOICE_BOOKKEEP',
      )
    }
    if (payload.kind === 'CREDIT') {
      return fortnoxEventKey(
        ctx,
        'RENT_NOTICE',
        payload.originalNoticeId,
        FORTNOX_SUPPORTED_VERSION,
        'INVOICE_BOOKKEEP',
      )
    }
    return null
  }

  async enqueue(
    ctx: FortnoxTrustedContext,
    input: { operation: FortnoxOperation; immutableVersion: number; payload: FortnoxIntent },
  ): Promise<EnqueueResult> {
    assertContext(ctx)
    const { operation, immutableVersion, payload } = input
    // Försvar på djupet: mappingen nekar redan version ≠ 1 (A15). Utan den här
    // raden hade en version 2 fått en NY nyckel och därmed en andra extern effekt.
    if (immutableVersion !== FORTNOX_SUPPORTED_VERSION) {
      throw new FortnoxEnqueueError(`version ${immutableVersion} stöds inte i skiva 01`)
    }
    if (payload.kind !== INTENT_KIND_OF[operation]) {
      throw new FortnoxEnqueueError(
        `operation ${operation} kräver avsikt ${INTENT_KIND_OF[operation]}`,
      )
    }

    const sourceId = sourceIdOf(payload)
    const eventType = EVENT_TYPE_OF[operation]
    const eventKey = fortnoxEventKey(ctx, eventType, sourceId, immutableVersion, operation)
    const payloadHash = fortnoxPayloadHash(payload)
    const dependsOnEventKey = this.predecessorKey(ctx, operation, payload)

    if (dependsOnEventKey) {
      const pred = await this.findScoped(ctx, dependsOnEventKey)
      if (!pred)
        throw new FortnoxEnqueueError('föregångaren saknas i samma organisation/anslutning/företag')
      if (
        isBookkeepOperation(operation) &&
        amountOreOf(pred.payload as unknown as FortnoxIntent) !== amountOreOf(payload)
      ) {
        throw new FortnoxEnqueueError('bokföringssteget avviker i belopp från sitt skapande-steg')
      }
    }

    try {
      const entry = await this.prisma.fortnoxOutboxEntry.create({
        data: {
          organizationId: ctx.organizationId,
          connectionId: ctx.connectionId,
          fortnoxTenantId: ctx.fortnoxTenantId,
          eventKey,
          eventType,
          sourceId,
          immutableVersion,
          operation,
          dependsOnEventKey,
          payload: payload as unknown as Prisma.InputJsonValue,
          payloadHash,
          nextAttemptAt: this.now(),
        },
      })
      return { status: 'CREATED', entry }
    } catch (err) {
      if (
        !isP2002From(err, {
          column: 'eventKey',
          indexName: 'FortnoxOutboxEntry_organizationId_eventKey_key',
        })
      ) {
        throw err
      }
      const befintlig = await this.findScoped(ctx, eventKey)
      // Nyckeln bär org/anslutning/företag, så en träff i org men inte i
      // anslutningen är omöjlig så länge nyckeln är oförändrad — men den avgörs
      // här i stället för att antas.
      if (!befintlig) throw err
      if (befintlig.payloadHash !== payloadHash) throw new FortnoxPayloadConflictError(eventKey)
      return { status: 'EXISTING', entry: befintlig }
    }
  }

  // ── Sändning ───────────────────────────────────────────────────────────────

  async processOne(ctx: FortnoxTrustedContext, eventKey: string): Promise<ProcessResult> {
    assertContext(ctx)
    const rad = await this.findScoped(ctx, eventKey)
    if (!rad) return { status: 'NOT_FOUND' }

    const pred = rad.dependsOnEventKey ? await this.findScoped(ctx, rad.dependsOnEventKey) : null
    if (rad.dependsOnEventKey) {
      if (!pred || pred.state !== 'ACKNOWLEDGED' || !pred.externalId) {
        return { status: 'BLOCKED', reason: 'PREDECESSOR_NOT_ACKNOWLEDGED' }
      }
      // Betalning/kredit kräver originalets BOKFÖRINGSkvittens, inte bara att det skapats.
      if (!pred.bookedConfirmed && pred.operation === 'INVOICE_BOOKKEEP') {
        return { status: 'BLOCKED', reason: 'PREDECESSOR_NOT_BOOKED' }
      }
    }

    const token = randomUUID()
    const nu = this.now()
    const claim = await this.prisma.fortnoxOutboxEntry.updateMany({
      where: {
        id: rad.id,
        organizationId: ctx.organizationId,
        connectionId: ctx.connectionId,
        fortnoxTenantId: ctx.fortnoxTenantId,
        state: { in: CLAIMABLE },
        nextAttemptAt: { lte: nu },
        // F02: CAS på räknaren som LÄSTES, och taket i samma villkor. Utan
        // `equals` kunde en arbetare med gammal läsning vinna en senare claim
        // och räkna fel försöksnummer (3+1 när databasen skrev 5) — och därmed
        // släppa ett sjätte försök. Med den är `rad.attempts + 1` nedan per
        // konstruktion exakt det värde den vinnande claimen skrev.
        attempts: { equals: rad.attempts, lt: this.maxAttempts },
      },
      data: {
        state: 'SENDING',
        attemptToken: token,
        leaseUntil: new Date(nu.getTime() + this.leaseMs),
        attempts: { increment: 1 },
      },
    })
    if (claim.count !== 1) return { status: 'NOT_CLAIMABLE' }
    // Claimen är committad här. Nätverket rörs först nu.
    const attempts = rad.attempts + 1

    let utfall: FortnoxSendResult | { kind: 'THREW' }
    try {
      utfall = await this.provider.send(ctx, commandOf(rad, pred))
    } catch {
      utfall = { kind: 'THREW' }
    }

    const beslut = this.decideAfterSend(rad, pred, utfall, attempts)
    const avslut = await this.prisma.fortnoxOutboxEntry.updateMany({
      where: {
        id: rad.id,
        organizationId: ctx.organizationId,
        connectionId: ctx.connectionId,
        fortnoxTenantId: ctx.fortnoxTenantId,
        state: 'SENDING',
        attemptToken: token,
      },
      data: {
        ...beslut,
        attemptToken: null,
        leaseUntil: null,
      },
    })
    if (avslut.count !== 1) return { status: 'STALE' }
    return { status: 'DONE', state: beslut.state }
  }

  private decideAfterSend(
    rad: FortnoxOutboxEntry,
    pred: FortnoxOutboxEntry | null,
    utfall: FortnoxSendResult | { kind: 'THREW' },
    attempts: number,
  ): Prisma.FortnoxOutboxEntryUpdateManyMutationInput & { state: FortnoxOutboxState } {
    const nu = this.now()
    const fel = (state: FortnoxOutboxState, klass: FortnoxErrorClass) => ({
      state,
      lastErrorClass: klass,
      lastErrorAt: nu,
    })

    switch (utfall.kind) {
      case 'ACK': {
        if (typeof utfall.externalId !== 'string' || utfall.externalId.length === 0) {
          return fel('MANUAL_REVIEW', 'ACK_WITHOUT_ID')
        }
        if (isBookkeepOperation(rad.operation)) {
          // En skapad faktura är inte en bokförd faktura. Bokföringen räknas
          // bara med uttryckligt bevis, och på SAMMA objekt som skapandet.
          if (utfall.booked !== true || utfall.externalId !== pred?.externalId) {
            return fel('MANUAL_REVIEW', 'BOOKKEEP_UNVERIFIED')
          }
          return {
            state: 'ACKNOWLEDGED',
            externalId: utfall.externalId,
            bookedConfirmed: true,
            acknowledgedAt: nu,
          }
        }
        return {
          state: 'ACKNOWLEDGED',
          externalId: utfall.externalId,
          bookedConfirmed: false,
          acknowledgedAt: nu,
        }
      }
      case 'SAFE_TO_RETRY': {
        if (attempts >= this.maxAttempts) return fel('MANUAL_REVIEW', 'RETRY_EXHAUSTED')
        const väntan = this.backoffBaseMs * 2 ** (attempts - 1)
        const jitter = Math.floor(väntan * 0.2 * this.random())
        return {
          ...fel('RETRY_WAIT', 'SAFE_TO_RETRY'),
          nextAttemptAt: new Date(nu.getTime() + väntan + jitter),
        }
      }
      case 'AUTH':
        return fel('AUTH_REQUIRED', 'AUTH')
      case 'REJECTED':
        return fel('REJECTED', 'REJECTED')
      case 'UNKNOWN':
        return fel('UNKNOWN', 'UNKNOWN')
      case 'THREW':
        // Kastet kan ha kommit EFTER att motparten tog emot anropet.
        return fel('UNKNOWN', 'PROVIDER_THREW')
    }
  }

  // ── Återhämtning ───────────────────────────────────────────────────────────

  /**
   * SENDING med utgången lease → UNKNOWN. Processen kan ha dött före ELLER efter
   * att anropet nådde motparten; det går inte att skilja, så ingen av dem får
   * sändas om blint. Token nollställs så att ett sent svar faller på fencingen.
   */
  async recoverExpiredLeases(ctx: FortnoxTrustedContext): Promise<number> {
    assertContext(ctx)
    const nu = this.now()
    const r = await this.prisma.fortnoxOutboxEntry.updateMany({
      where: {
        organizationId: ctx.organizationId,
        connectionId: ctx.connectionId,
        fortnoxTenantId: ctx.fortnoxTenantId,
        state: 'SENDING',
        leaseUntil: { lt: nu },
      },
      data: {
        state: 'UNKNOWN',
        attemptToken: null,
        leaseUntil: null,
        lastErrorClass: 'LEASE_EXPIRED' satisfies FortnoxErrorClass,
        lastErrorAt: nu,
      },
    })
    return r.count
  }

  /** Återläsning av ett okänt utfall. Skickar aldrig. */
  async reconcileUnknown(ctx: FortnoxTrustedContext, eventKey: string): Promise<ReconcileResult> {
    assertContext(ctx)
    const rad = await this.findScoped(ctx, eventKey)
    if (!rad) return { status: 'NOT_FOUND' }
    if (rad.state !== 'UNKNOWN') return { status: 'NOT_UNKNOWN', state: rad.state }
    const pred = rad.dependsOnEventKey ? await this.findScoped(ctx, rad.dependsOnEventKey) : null

    let svar: FortnoxLookupResult
    try {
      svar = await this.provider.lookup(ctx, commandOf(rad, pred))
    } catch {
      svar = { kind: 'UNAVAILABLE', reason: 'kast' }
    }

    const nu = this.now()
    const beslut = classifyLookup(ctx, rad, pred, svar)
    const data: Prisma.FortnoxOutboxEntryUpdateManyMutationInput =
      beslut.state === 'ACKNOWLEDGED'
        ? {
            state: 'ACKNOWLEDGED',
            externalId: beslut.externalId,
            bookedConfirmed: isBookkeepOperation(rad.operation),
            acknowledgedAt: nu,
            lastLookupAt: nu,
          }
        : {
            state: beslut.state,
            lastErrorClass: beslut.errorClass,
            lastErrorAt: nu,
            lastLookupAt: nu,
          }

    const r = await this.prisma.fortnoxOutboxEntry.updateMany({
      where: {
        id: rad.id,
        organizationId: ctx.organizationId,
        connectionId: ctx.connectionId,
        fortnoxTenantId: ctx.fortnoxTenantId,
        state: 'UNKNOWN',
      },
      data,
    })
    if (r.count !== 1) return { status: 'STALE' }
    return {
      status: 'DONE',
      state: beslut.state,
      errorClass: beslut.state === 'ACKNOWLEDGED' ? null : beslut.errorClass,
    }
  }

  // ── Läsning ────────────────────────────────────────────────────────────────

  /** Varje uppslag är avgränsat till org + anslutning + företag. */
  findScoped(ctx: FortnoxTrustedContext, eventKey: string): Promise<FortnoxOutboxEntry | null> {
    assertContext(ctx)
    return this.prisma.fortnoxOutboxEntry.findFirst({
      where: {
        organizationId: ctx.organizationId,
        connectionId: ctx.connectionId,
        fortnoxTenantId: ctx.fortnoxTenantId,
        eventKey,
      },
    })
  }
}

// ── Rena hjälpare ────────────────────────────────────────────────────────────

function assertContext(ctx: FortnoxTrustedContext): void {
  for (const v of [ctx?.organizationId, ctx?.connectionId, ctx?.fortnoxTenantId]) {
    if (typeof v !== 'string' || v.length === 0) {
      throw new FortnoxEnqueueError('Fortnox-kontext saknar organisation/anslutning/företag')
    }
  }
}

function commandOf(rad: FortnoxOutboxEntry, pred: FortnoxOutboxEntry | null): FortnoxCommand {
  return {
    eventKey: rad.eventKey,
    operation: rad.operation,
    payload: rad.payload as unknown as FortnoxIntent,
    payloadHash: rad.payloadHash,
    predecessorExternalId: pred?.externalId ?? null,
  }
}

type LookupDecision =
  | { state: 'ACKNOWLEDGED'; externalId: string }
  | { state: 'UNKNOWN' | 'MANUAL_REVIEW'; errorClass: FortnoxErrorClass }

/**
 * Tjänsten — inte adaptern — avgör om en extern post är JUST den här
 * operationen. Belopp + datum är aldrig identitet; referens, företag, valuta,
 * payloadhash och (för bokföringssteg) objekt + bokföringsbevis måste stämma.
 */
export function classifyLookup(
  ctx: FortnoxTrustedContext,
  rad: FortnoxOutboxEntry,
  pred: FortnoxOutboxEntry | null,
  svar: FortnoxLookupResult,
): LookupDecision {
  switch (svar.kind) {
    case 'NOT_FOUND':
      // En tom lista bevisar inte att effekten uteblev (ingen read-after-write-
      // garanti). Raden stannar i UNKNOWN för senare läsning — ingen omsändning.
      return { state: 'UNKNOWN', errorClass: 'LOOKUP_NOT_FOUND' }
    case 'UNAVAILABLE':
      return { state: 'UNKNOWN', errorClass: 'LOOKUP_UNAVAILABLE' }
    case 'UNSUPPORTED':
      return { state: 'MANUAL_REVIEW', errorClass: 'LOOKUP_UNSUPPORTED' }
    case 'FOUND': {
      if (svar.candidates.length === 0) return { state: 'UNKNOWN', errorClass: 'LOOKUP_NOT_FOUND' }
      if (svar.candidates.length > 1)
        return { state: 'MANUAL_REVIEW', errorClass: 'LOOKUP_AMBIGUOUS' }
      const c = svar.candidates[0]!
      return matches(ctx, rad, pred, c)
        ? { state: 'ACKNOWLEDGED', externalId: c.externalId }
        : { state: 'MANUAL_REVIEW', errorClass: 'LOOKUP_MISMATCH' }
    }
  }
}

function matches(
  ctx: FortnoxTrustedContext,
  rad: FortnoxOutboxEntry,
  pred: FortnoxOutboxEntry | null,
  c: FortnoxExternalCandidate,
): boolean {
  const belopp = amountOreOf(rad.payload as unknown as FortnoxIntent)
  const gemensamt =
    c.fortnoxTenantId === ctx.fortnoxTenantId &&
    c.fortnoxTenantId === rad.fortnoxTenantId &&
    c.amountOre === belopp &&
    c.currency === 'SEK' &&
    typeof c.externalId === 'string' &&
    c.externalId.length > 0
  if (!gemensamt) return false
  if (isBookkeepOperation(rad.operation)) {
    // Bokföringssteget verifieras på skapandets objekt.
    return (
      pred !== null &&
      pred.state === 'ACKNOWLEDGED' &&
      c.externalId === pred.externalId &&
      c.reference === pred.eventKey &&
      c.payloadHash === pred.payloadHash &&
      c.booked === true
    )
  }
  return c.reference === rad.eventKey && c.payloadHash === rad.payloadHash
}
