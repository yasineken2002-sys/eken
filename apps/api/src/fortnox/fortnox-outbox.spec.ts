/**
 * Fortnox skiva 01 — rena delar av utkorgen, utan databas.
 * Kompletterar `fortnox-outbox.db.spec.ts` (A09, A12) och modulens default.
 *
 * ── VAD PROVET MÄTER ────────────────────────────────────────────────────────
 *
 * Att TJÄNSTEN — inte adaptern — avgör om en återläst post är just den här
 * operationen, och att Stub är strukturellt inert.
 *
 * ── VAD DET INTE KAN SE ─────────────────────────────────────────────────────
 *
 * Tillståndsövergångar i databasen (claim, fencing, lease). De ägs av db-specen.
 */

import { ServiceUnavailableException } from '@nestjs/common'
import type { FortnoxOutboxEntry } from '@prisma/client'

import { classifyLookup } from './fortnox-outbox.service'
import type { FortnoxExternalCandidate, FortnoxTrustedContext } from './fortnox.types'
import { MockFortnoxWorld } from './providers/mock-fortnox.provider'
import { StubFortnoxProvider } from './providers/stub-fortnox.provider'

const CTX: FortnoxTrustedContext = {
  organizationId: 'org-a',
  connectionId: 'conn-1',
  fortnoxTenantId: 'fnx-1',
}

function rad(över: Partial<FortnoxOutboxEntry> = {}): FortnoxOutboxEntry {
  const nu = new Date('2026-10-01T00:00:00Z')
  return {
    id: 'rad-1',
    organizationId: CTX.organizationId,
    connectionId: CTX.connectionId,
    fortnoxTenantId: CTX.fortnoxTenantId,
    eventKey: 'fnx1:skapa',
    eventType: 'RENT_NOTICE',
    sourceId: 'avi-1',
    immutableVersion: 1,
    operation: 'INVOICE_CREATE',
    dependsOnEventKey: null,
    payload: { kind: 'INVOICE', totalOre: 1_000_000 },
    payloadHash: 'h-skapa',
    state: 'UNKNOWN',
    attempts: 1,
    nextAttemptAt: nu,
    attemptToken: null,
    leaseUntil: null,
    externalId: null,
    bookedConfirmed: false,
    lastErrorClass: 'UNKNOWN',
    lastErrorAt: nu,
    lastLookupAt: null,
    acknowledgedAt: null,
    createdAt: nu,
    updatedAt: nu,
    ...över,
  }
}

function kandidat(över: Partial<FortnoxExternalCandidate> = {}): FortnoxExternalCandidate {
  return {
    externalId: 'ext-1',
    fortnoxTenantId: CTX.fortnoxTenantId,
    reference: 'fnx1:skapa',
    amountOre: 1_000_000,
    currency: 'SEK',
    payloadHash: 'h-skapa',
    booked: false,
    ...över,
  }
}

describe('classifyLookup — skapande-steg', () => {
  it('exakt en fullt matchande kandidat → ACKNOWLEDGED', () => {
    expect(classifyLookup(CTX, rad(), null, { kind: 'FOUND', candidates: [kandidat()] })).toEqual({
      state: 'ACKNOWLEDGED',
      externalId: 'ext-1',
    })
  })

  it.each<[string, Partial<FortnoxExternalCandidate>]>([
    ['annat företag', { fortnoxTenantId: 'fnx-2' }],
    ['annan referens (samma belopp räcker inte)', { reference: 'fnx1:annan' }],
    ['annat belopp', { amountOre: 1_000_001 }],
    ['annan valuta', { currency: 'EUR' }],
    ['annan payloadhash', { payloadHash: 'h-annan' }],
    ['tomt externt id', { externalId: '' }],
  ])('en avvikande kandidat (%s) → MANUAL_REVIEW', (_n, över) => {
    expect(
      classifyLookup(CTX, rad(), null, { kind: 'FOUND', candidates: [kandidat(över)] }),
    ).toEqual({
      state: 'MANUAL_REVIEW',
      errorClass: 'LOOKUP_MISMATCH',
    })
  })

  it('två kandidater → MANUAL_REVIEW även om en matchar', () => {
    expect(
      classifyLookup(CTX, rad(), null, {
        kind: 'FOUND',
        candidates: [kandidat(), kandidat({ externalId: 'ext-2' })],
      }),
    ).toEqual({ state: 'MANUAL_REVIEW', errorClass: 'LOOKUP_AMBIGUOUS' })
  })

  it('noll träffar / otillgänglig → kvar i UNKNOWN; ej återläsbar → MANUAL_REVIEW', () => {
    expect(classifyLookup(CTX, rad(), null, { kind: 'FOUND', candidates: [] }).state).toBe(
      'UNKNOWN',
    )
    expect(classifyLookup(CTX, rad(), null, { kind: 'NOT_FOUND' }).state).toBe('UNKNOWN')
    expect(classifyLookup(CTX, rad(), null, { kind: 'UNAVAILABLE', reason: 'x' }).state).toBe(
      'UNKNOWN',
    )
    expect(classifyLookup(CTX, rad(), null, { kind: 'UNSUPPORTED', reason: 'x' }).state).toBe(
      'MANUAL_REVIEW',
    )
  })
})

describe('classifyLookup — bokföringssteg verifieras på skapandets objekt', () => {
  const skapad = rad({ state: 'ACKNOWLEDGED', externalId: 'ext-1' })
  const bokför = rad({
    id: 'rad-2',
    eventKey: 'fnx1:bokför',
    operation: 'INVOICE_BOOKKEEP',
    dependsOnEventKey: 'fnx1:skapa',
    payload: { kind: 'BOOKKEEP', amountOre: 1_000_000 },
    payloadHash: 'h-bokför',
  })

  it('samma objekt + bokföringsbevis → ACKNOWLEDGED', () => {
    expect(
      classifyLookup(CTX, bokför, skapad, {
        kind: 'FOUND',
        candidates: [kandidat({ booked: true })],
      }).state,
    ).toBe('ACKNOWLEDGED')
  })

  it.each<[string, Partial<FortnoxExternalCandidate>]>([
    ['inte bokförd (skapad ≠ bokförd)', { booked: false }],
    ['annat objekt', { booked: true, externalId: 'ext-9' }],
    [
      'referens till bokföringsnyckeln i stället för skapandet',
      { booked: true, reference: 'fnx1:bokför' },
    ],
  ])('%s → MANUAL_REVIEW', (_n, över) => {
    expect(
      classifyLookup(CTX, bokför, skapad, { kind: 'FOUND', candidates: [kandidat(över)] }).state,
    ).toBe('MANUAL_REVIEW')
  })

  it('utan kvitterad föregångare godtas ingenting', () => {
    expect(
      classifyLookup(CTX, bokför, null, { kind: 'FOUND', candidates: [kandidat({ booked: true })] })
        .state,
    ).toBe('MANUAL_REVIEW')
  })
})

describe('providers', () => {
  it('Stub kastar 503 på båda metoderna — modulens enda default kan inte nå någon', async () => {
    const stub = new StubFortnoxProvider()
    const cmd = {
      eventKey: 'k',
      operation: 'INVOICE_CREATE' as const,
      payload: {
        kind: 'BOOKKEEP' as const,
        of: 'INVOICE' as const,
        sourceId: 's',
        amountOre: 1,
        currency: 'SEK' as const,
      },
      payloadHash: 'h',
      predecessorExternalId: null,
    }
    await expect(stub.send(CTX, cmd)).rejects.toBeInstanceOf(ServiceUnavailableException)
    await expect(stub.lookup(CTX, cmd)).rejects.toBeInstanceOf(ServiceUnavailableException)
  })

  it('mocken är uttryckligen märkt syntetisk', () => {
    expect(new MockFortnoxWorld().synthetic).toBe(true)
  })
})
