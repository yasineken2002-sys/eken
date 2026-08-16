jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
/**
 * M2 PR 1 — avi-grenen skriver en MOTTAGNINGSHÄNDELSE, och märker fuzzy.
 *
 * #326 speglade REVERSERINGEN till båda sidorna (B faktura, C avi). MOTTAGANDET
 * speglades aldrig: fakturagrenen skriver PAYMENT_RECEIVED/PAYMENT_PARTIAL för
 * varje betalning, avi-grenen skrev ingenting. Avins historik kunde visa att en
 * betalning återtogs utan att någonsin ha visat att den togs emot.
 *
 * Följden för M2: en fuzzy-GISSNING var oskiljbar från en deterministisk
 * OCR-träff i avins historik, alltså omätbar.
 *
 * ADDITIV, inte inert: nya händelserader tillkommer. Inget befintligt utfall
 * ändras — det är det andra talet i PR-texten.
 */

import { Decimal } from '@prisma/client/runtime/library'
import { ReconciliationService } from './reconciliation.service'

const dec = (v: string | number) => new Decimal(v)

function makeService(opts: { payable?: number; prior?: number[] } = {}) {
  const notice = {
    id: 'rn-1',
    noticeNumber: 'AVI-2026-06-0001',
    status: 'SENT',
    collectionStage: 'NONE',
    type: 'RENT',
    totalAmount: dec(opts.payable ?? 10_000),
    consumptionAmount: dec(0),
    miscChargeAmount: dec(0),
    reminderFeeAmount: dec(0),
    interestAccruedAmount: dec(0),
  }
  const txMock = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    rentNotice: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(notice),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    rentNoticePayment: {
      findMany: jest.fn().mockResolvedValue((opts.prior ?? []).map((n) => ({ amount: dec(n) }))),
      create: jest.fn().mockResolvedValue({ id: 'rnp-42' }),
    },
    bankTransaction: { update: jest.fn().mockResolvedValue({}) },
  }
  const rentNoticeEvents = { record: jest.fn().mockResolvedValue({}) }
  const prisma = { $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(txMock)) }
  const service = new ReconciliationService(
    prisma as never,
    {} as never,
    { record: jest.fn() } as never,
    {
      createJournalEntryForRentNoticePayment: jest.fn().mockResolvedValue({ id: 'je-1' }),
    } as never,
    {} as never,
    rentNoticeEvents as never,
  )
  const kör = (belopp: number, matchType?: 'fuzzy') =>
    (
      service as unknown as {
        applyMatchToRentNotice: (
          t: string,
          n: string,
          o: string,
          a: Decimal,
          d: Date,
          u: string | null,
          allowPartial: boolean,
          mt?: 'fuzzy',
        ) => Promise<boolean>
      }
    ).applyMatchToRentNotice(
      'tx-1',
      'rn-1',
      'org-1',
      dec(belopp),
      new Date('2026-06-20'),
      null,
      true,
      matchType,
    )

  const mottagande = () =>
    rentNoticeEvents.record.mock.calls.filter((c) => c[1] === 'PAYMENT_RECEIVED')
  return { kör, rentNoticeEvents, mottagande }
}

describe('avi-grenen skriver PAYMENT_RECEIVED', () => {
  it('KÄRNAN: en full betalning ger en mottagningshändelse — tidigare skrevs ingen alls', async () => {
    const { kör, mottagande } = makeService()
    await expect(kör(10_000)).resolves.toBe(true)
    expect(mottagande()).toHaveLength(1)
  })

  it('fälten speglar #326 C:s reversering, så posterna går att para ihop', async () => {
    const { kör, mottagande } = makeService()
    await kör(10_000)

    const payload = mottagande()[0]![4] as Record<string, unknown>
    // Samma nycklar som PAYMENT_REVERSED bär — plus allocationId på BÅDA.
    expect(payload).toMatchObject({
      transactionId: 'tx-1',
      allocationId: 'rnp-42',
      amount: 10_000,
      allocationSource: 'BANK_RECONCILIATION',
      source: 'bank_reconciliation',
    })
    expect(payload.paidAt).toBe(new Date('2026-06-20').toISOString())
  })

  it('DELBETALNING uttrycks med outstandingAfter, INTE med ett nytt enum-värde', async () => {
    // RentNoticeEventType saknar PAYMENT_PARTIAL (fakturans enum har det). Att
    // införa det vore en migration; outstandingAfter är härledbart och räcker.
    const { kör, mottagande } = makeService()
    await expect(kör(4_000)).resolves.toBe(true)

    const p = mottagande()[0]![4] as Record<string, unknown>
    expect(mottagande()[0]![1]).toBe('PAYMENT_RECEIVED')
    expect(p.amount).toBe(4_000)
    expect(p.outstandingAfter).toBe(6_000)
  })

  it('full reglering ger outstandingAfter = 0', async () => {
    const { kör, mottagande } = makeService()
    await kör(10_000)
    expect((mottagande()[0]![4] as Record<string, unknown>).outstandingAfter).toBe(0)
  })

  it('KANARIEFÅGEL: en fuzzy-träff MÄRKS — annars är gissningen omätbar', async () => {
    // Hela skälet till PR 1. Utan märkningen ser en beloppsgissning likadan ut
    // som en deterministisk OCR-träff i avins historik.
    const { kör, mottagande } = makeService()
    await kör(10_000, 'fuzzy')
    expect((mottagande()[0]![4] as Record<string, unknown>).matchType).toBe('fuzzy')
  })

  it('en DETERMINISTISK träff märks INTE — fältet finns bara när det betyder något', async () => {
    const { kör, mottagande } = makeService()
    await kör(10_000)
    expect(mottagande()[0]![4]).not.toHaveProperty('matchType')
  })

  it('ingen match → ingen mottagningshändelse', async () => {
    // Överbetalning mot en enda avi: ingen allokering, alltså inget mottagande.
    const { kör, mottagande } = makeService()
    await expect(kör(20_000)).resolves.toBe(false)
    expect(mottagande()).toHaveLength(0)
  })
})
