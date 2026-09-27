/**
 * Fortnox skiva 01 — ren mapping. PROVPLAN A02, A03, A04 (nyckeldelen), A05, A15.
 *
 * ── VAD PROVET MÄTER ────────────────────────────────────────────────────────
 *
 * Att Eveno-underlaget blir rätt NEUTRAL avsikt, och att allt utanför skivan
 * nekas HELT med skäl i stället för att filtreras.
 *
 * ── VAD DET INTE KAN SE ─────────────────────────────────────────────────────
 *
 * Fortnox fältserialisering, kontering, moms och avrundning. Avsikten är
 * neutral; en skarp adapter och ett sandboxprov äger den frågan.
 */

import {
  fortnoxEventKey,
  fortnoxPayloadHash,
  mapBookkeep,
  mapFullCredit,
  mapPaymentAllocation,
  mapRentNoticeToInvoice,
  ärKalenderdatum,
  type FullCreditSnapshot,
  type NoticeComponent,
  type PaymentAllocationSnapshot,
  type RentNoticeSnapshot,
} from './fortnox-mapping'
import { FORTNOX_OPERATIONS, type FortnoxTrustedContext } from './fortnox.types'

const CTX: FortnoxTrustedContext = {
  organizationId: 'org-syntetisk-a',
  connectionId: 'conn-syntetisk-1',
  fortnoxTenantId: 'fnx-foretag-1',
}

function avi(över: Partial<RentNoticeSnapshot> = {}): RentNoticeSnapshot {
  return {
    organizationId: CTX.organizationId,
    noticeId: 'avi-1',
    immutableVersion: 1,
    noticeNumber: 'A-2026-0001',
    customerRef: 'K-100',
    currency: 'SEK',
    totalOre: 1_000_000,
    invoiceDate: '2026-10-01',
    dueDate: '2026-10-31',
    bookkeepingDate: '2026-10-01',
    propertyUse: 'RESIDENTIAL',
    lines: [
      { component: 'RENT', description: 'Hyra oktober', vatRatePercent: 0, amountOre: 1_000_000 },
    ],
    accountMapping: { receivableAccount: 1510, revenueAccount: 3911 },
    ...över,
  }
}

function betalning(över: Partial<PaymentAllocationSnapshot> = {}): PaymentAllocationSnapshot {
  return {
    organizationId: CTX.organizationId,
    fortnoxTenantId: CTX.fortnoxTenantId,
    paymentAllocationId: 'alloc-1',
    noticeId: 'avi-1',
    immutableVersion: 1,
    currency: 'SEK',
    originalAmountOre: 1_000_000,
    confirmedPaidOre: 0,
    confirmedCreditedOre: 0,
    amountOre: 400_000,
    paidAt: '2026-10-05',
    bookkeepingDate: '2026-10-05',
    ...över,
  }
}

function kredit(över: Partial<FullCreditSnapshot> = {}): FullCreditSnapshot {
  return {
    organizationId: CTX.organizationId,
    fortnoxTenantId: CTX.fortnoxTenantId,
    creditId: 'kredit-1',
    originalNoticeId: 'avi-1',
    immutableVersion: 1,
    originalReference: 'A-2026-0001',
    currency: 'SEK',
    originalAmountOre: 1_000_000,
    creditAmountOre: 1_000_000,
    paidOre: 0,
    previousCreditsOre: 0,
    collectionHandover: false,
    badDebt: false,
    propertyUse: 'RESIDENTIAL',
    originalLines: [
      { component: 'RENT', description: 'Hyra oktober', vatRatePercent: 0, amountOre: 1_000_000 },
    ],
    bookkeepingDate: '2026-10-10',
    ...över,
  }
}

describe('A02 · ren momsfri bostadsavi → en fakturaavsikt, bokföring separat', () => {
  it('1 000 000 öre ger EN rad, net = gross, moms 0, konto 1510/3911', () => {
    const r = mapRentNoticeToInvoice(CTX, avi())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.intent.kind).toBe('INVOICE')
    expect(r.intent.totalOre).toBe(1_000_000)
    expect(r.intent.receivableAccount).toBe(1510)
    expect(r.intent.rows).toEqual([
      {
        description: 'Hyra oktober',
        accountNumber: 3911,
        netOre: 1_000_000,
        vatOre: 0,
        grossOre: 1_000_000,
      },
    ])
  })

  it('bokföringen är en EGEN avsikt med egen nyckel på samma källa', () => {
    const r = mapRentNoticeToInvoice(CTX, avi())
    if (!r.ok) throw new Error(r.reason)
    const bok = mapBookkeep(r.intent)
    expect(bok).toEqual({
      kind: 'BOOKKEEP',
      of: 'INVOICE',
      sourceId: 'avi-1',
      amountOre: 1_000_000,
      currency: 'SEK',
    })
    const skapa = fortnoxEventKey(CTX, 'RENT_NOTICE', 'avi-1', 1, 'INVOICE_CREATE')
    const bokf = fortnoxEventKey(CTX, 'RENT_NOTICE', 'avi-1', 1, 'INVOICE_BOOKKEEP')
    expect(skapa).not.toBe(bokf)
  })

  it('det finns ingen verifikats-/voucheroperation i skivan', () => {
    expect(FORTNOX_OPERATIONS.filter((o) => /VOUCHER/i.test(o))).toEqual([])
  })

  it('kontona tas ur mappningen, aldrig ur fri text', () => {
    const r = mapRentNoticeToInvoice(
      CTX,
      avi({
        lines: [
          { component: 'RENT', description: 'konto 3011', vatRatePercent: 0, amountOre: 1_000_000 },
        ],
      }),
    )
    if (!r.ok) throw new Error(r.reason)
    expect(r.intent.rows[0]!.accountNumber).toBe(3911)
    expect(
      mapRentNoticeToInvoice(
        CTX,
        avi({ accountMapping: { receivableAccount: 1510, revenueAccount: 39110 } }),
      ).ok,
    ).toBe(false)
  })

  it.each<[string, Partial<RentNoticeSnapshot>]>([
    ['lokal', { propertyUse: 'COMMERCIAL' }],
    [
      'moms',
      {
        lines: [
          { component: 'RENT', description: 'Hyra', vatRatePercent: 25, amountOre: 1_000_000 },
        ],
      },
    ],
    ['annan valuta', { currency: 'EUR' }],
    [
      'noll',
      {
        totalOre: 0,
        lines: [{ component: 'RENT', description: 'Hyra', vatRatePercent: 0, amountOre: 0 }],
      },
    ],
    [
      'flyttal',
      {
        totalOre: 1000.5,
        lines: [{ component: 'RENT', description: 'Hyra', vatRatePercent: 0, amountOre: 1000.5 }],
      },
    ],
    ['radsumma ≠ total', { totalOre: 999_999 }],
    ['ogiltigt datum', { dueDate: '2026-02-30' }],
    ['annan organisation', { organizationId: 'org-syntetisk-b' }],
    ['saknat kundnummer', { customerRef: ' ' }],
  ])('nekas: %s', (_namn, över) => {
    expect(mapRentNoticeToInvoice(CTX, avi(över)).ok).toBe(false)
  })

  it('kalenderdatum kontrolleras på riktigt', () => {
    expect(ärKalenderdatum('2028-02-29')).toBe(true)
    expect(ärKalenderdatum('2026-02-29')).toBe(false)
    expect(ärKalenderdatum('2026-1-01')).toBe(false)
  })
})

describe('A03 · delbetalning och slutbetalning per allokering', () => {
  it('400 000 + 600 000 ger två avsikter med olika nycklar; slutbetalningen är 600 000', () => {
    const första = mapPaymentAllocation(CTX, betalning())
    const andra = mapPaymentAllocation(
      CTX,
      betalning({ paymentAllocationId: 'alloc-2', amountOre: 600_000, confirmedPaidOre: 400_000 }),
    )
    if (!första.ok || !andra.ok) throw new Error('förväntade två godkända')
    expect(första.intent.amountOre).toBe(400_000)
    expect(andra.intent.amountOre).toBe(600_000)
    const k1 = fortnoxEventKey(
      CTX,
      'RENT_PAYMENT',
      första.intent.paymentAllocationId,
      1,
      'PAYMENT_CREATE',
    )
    const k2 = fortnoxEventKey(
      CTX,
      'RENT_PAYMENT',
      andra.intent.paymentAllocationId,
      1,
      'PAYMENT_CREATE',
    )
    expect(k1).not.toBe(k2)
  })

  it('en öre över kvarvarande fordran nekas', () => {
    const r = mapPaymentAllocation(
      CTX,
      betalning({ paymentAllocationId: 'alloc-2', amountOre: 600_001, confirmedPaidOre: 400_000 }),
    )
    expect(r).toMatchObject({ ok: false, code: 'INVALID' })
  })

  it('kredit räknas av från kvarvarande', () => {
    expect(
      mapPaymentAllocation(CTX, betalning({ amountOre: 600_001, confirmedCreditedOre: 400_000 }))
        .ok,
    ).toBe(false)
  })

  it.each<[string, Partial<PaymentAllocationSnapshot>]>([
    ['annan valuta', { currency: 'USD' }],
    ['annan organisation', { organizationId: 'org-syntetisk-b' }],
    ['annat Fortnox-företag', { fortnoxTenantId: 'fnx-foretag-2' }],
    ['noll', { amountOre: 0 }],
    ['negativ', { amountOre: -1 }],
    ['saknat allokerings-id', { paymentAllocationId: '' }],
  ])('nekas: %s', (_namn, över) => {
    expect(mapPaymentAllocation(CTX, betalning(över)).ok).toBe(false)
  })
})

describe('A04 · nyckeln är allokeringen, inte belopp + datum', () => {
  it('två legitima 400 000 samma dag med olika allokerings-id får olika nycklar och samma hash-form', () => {
    const a = mapPaymentAllocation(CTX, betalning({ paymentAllocationId: 'alloc-a' }))
    const b = mapPaymentAllocation(CTX, betalning({ paymentAllocationId: 'alloc-b' }))
    if (!a.ok || !b.ok) throw new Error('förväntade två godkända')
    expect(fortnoxEventKey(CTX, 'RENT_PAYMENT', 'alloc-a', 1, 'PAYMENT_CREATE')).not.toBe(
      fortnoxEventKey(CTX, 'RENT_PAYMENT', 'alloc-b', 1, 'PAYMENT_CREATE'),
    )
    expect(fortnoxPayloadHash(a.intent)).not.toBe(fortnoxPayloadHash(b.intent))
  })

  it('hashen är oberoende av nyckelordning men känslig för värden', () => {
    const r = mapPaymentAllocation(CTX, betalning())
    if (!r.ok) throw new Error(r.reason)
    const omkastad = Object.fromEntries(Object.entries(r.intent).reverse()) as typeof r.intent
    expect(fortnoxPayloadHash(omkastad)).toBe(fortnoxPayloadHash(r.intent))
    expect(fortnoxPayloadHash({ ...r.intent, amountOre: 400_001 })).not.toBe(
      fortnoxPayloadHash(r.intent),
    )
  })

  it('nyckeln bär anslutning och företag', () => {
    const bas = fortnoxEventKey(CTX, 'RENT_PAYMENT', 'alloc-a', 1, 'PAYMENT_CREATE')
    expect(
      fortnoxEventKey(
        { ...CTX, connectionId: 'conn-2' },
        'RENT_PAYMENT',
        'alloc-a',
        1,
        'PAYMENT_CREATE',
      ),
    ).not.toBe(bas)
    expect(
      fortnoxEventKey(
        { ...CTX, fortnoxTenantId: 'fnx-2' },
        'RENT_PAYMENT',
        'alloc-a',
        1,
        'PAYMENT_CREATE',
      ),
    ).not.toBe(bas)
    expect(
      fortnoxEventKey(
        { ...CTX, organizationId: 'org-2' },
        'RENT_PAYMENT',
        'alloc-a',
        1,
        'PAYMENT_CREATE',
      ),
    ).not.toBe(bas)
  })
})

describe('A05 · hel kredit av obetald bostadsavi; allt annat nekas helt', () => {
  it('speglar originalreferens och belopp', () => {
    const r = mapFullCredit(CTX, kredit())
    expect(r).toEqual({
      ok: true,
      intent: {
        kind: 'CREDIT',
        creditId: 'kredit-1',
        originalNoticeId: 'avi-1',
        originalReference: 'A-2026-0001',
        currency: 'SEK',
        amountOre: 1_000_000,
        bookkeepingDate: '2026-10-10',
      },
    })
  })

  it('originalunderlaget muteras inte', () => {
    const u = kredit()
    const före = JSON.stringify(u)
    mapFullCredit(CTX, u)
    expect(JSON.stringify(u)).toBe(före)
  })

  it.each<[string, Partial<FullCreditSnapshot>]>([
    ['delkredit', { creditAmountOre: 400_000 }],
    ['redan krediterad', { previousCreditsOre: 1 }],
    ['betald', { paidOre: 1_000_000 }],
    ['delbetald', { paidOre: 1 }],
    ['kravöverlämnad', { collectionHandover: true }],
    ['kundförlust', { badDebt: true }],
    ['lokal', { propertyUse: 'COMMERCIAL' }],
    [
      'moms',
      {
        originalLines: [
          { component: 'RENT', description: 'Hyra', vatRatePercent: 25, amountOre: 1_000_000 },
        ],
      },
    ],
    ['annat Fortnox-företag', { fortnoxTenantId: 'fnx-foretag-2' }],
  ])('UNSUPPORTED/INVALID: %s', (_namn, över) => {
    const r = mapFullCredit(CTX, kredit(över))
    expect(r.ok).toBe(false)
  })

  it('delkredit skalas aldrig upp — skälet säger det', () => {
    const r = mapFullCredit(CTX, kredit({ creditAmountOre: 400_000 }))
    expect(r).toMatchObject({ ok: false, code: 'UNSUPPORTED' })
    if (!r.ok) expect(r.reason).toMatch(/delkredit/)
  })

  // Blandade avier: HELA avin nekas — både för faktura och kredit. Varje
  // komponent prövas för sig, så att en som glömts i listan syns.
  const FRÄMMANDE: NoticeComponent[] = [
    'CONSUMPTION',
    'MISC',
    'REMINDER_FEE',
    'INTEREST',
    'DEPOSIT',
    'OTHER',
  ]
  it.each(FRÄMMANDE)('avi med %s-rad nekas helt, inga rader tappas', (komponent) => {
    const rader = [
      { component: 'RENT' as const, description: 'Hyra', vatRatePercent: 0, amountOre: 900_000 },
      { component: komponent, description: 'Tillägg', vatRatePercent: 0, amountOre: 100_000 },
    ]
    const f = mapRentNoticeToInvoice(CTX, avi({ lines: rader }))
    const k = mapFullCredit(CTX, kredit({ originalLines: rader }))
    expect(f).toMatchObject({ ok: false, code: 'UNSUPPORTED' })
    expect(k).toMatchObject({ ok: false, code: 'UNSUPPORTED' })
    if (!f.ok) expect(f.reason).toContain(komponent)
  })
})

describe('A15 · version 2 avvisas av mappingen', () => {
  it('faktura, betalning och kredit med version 2 → UNSUPPORTED', () => {
    expect(mapRentNoticeToInvoice(CTX, avi({ immutableVersion: 2 }))).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED',
    })
    expect(mapPaymentAllocation(CTX, betalning({ immutableVersion: 2 }))).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED',
    })
    expect(mapFullCredit(CTX, kredit({ immutableVersion: 2 }))).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED',
    })
  })

  it('version 0 och icke-heltal avvisas också', () => {
    expect(mapRentNoticeToInvoice(CTX, avi({ immutableVersion: 0 })).ok).toBe(false)
    expect(mapRentNoticeToInvoice(CTX, avi({ immutableVersion: 1.5 })).ok).toBe(false)
  })
})
