/**
 * FIX 9 · PR 2 — Avisering bokför intäktsverifikation (LAGBROTT 2).
 *
 * Verifierar att generateMonthlyNotices anropar
 * AccountingService.createJournalEntryForRentNotice för varje skapad
 * RENT-avi — dvs. hyresfordran bokförs vid avisering, inte (som tidigare)
 * implicit och ofullständigt först vid betalning.
 */

// AviseringService importerar transitivt StorageService (→ @aws-sdk/client-s3,
// ESM som jest inte transformerar) och PdfService. Inget av detta används i
// denna test — mocka modulerna så importen inte drar in tunga beroenden.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { AviseringService } from './avisering.service'

describe('FIX 9 · PR 2 — generateMonthlyNotices bokför hyresintäkt', () => {
  function makeService(unitOverrides?: {
    type?: string
    voluntaryTaxLiability?: boolean
    monthlyRentExcludingVat?: boolean
  }) {
    const lease = {
      id: 'lease-1',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      monthlyRent: 10_000,
      monthlyRentExcludingVat: unitOverrides?.monthlyRentExcludingVat ?? false,
      startDate: new Date('2026-01-01'),
      endDate: null,
      status: 'ACTIVE',
      tenant: { id: 'tenant-1', email: 't@example.se', type: 'INDIVIDUAL' },
      unit: {
        id: 'unit-1',
        type: unitOverrides?.type ?? 'APARTMENT',
        voluntaryTaxLiability: unitOverrides?.voluntaryTaxLiability ?? false,
        name: 'Lgh 1',
        unitNumber: '1',
        property: {},
      },
    }

    const prisma = {
      lease: { findMany: jest.fn().mockResolvedValue([lease]) },
      rentNotice: {
        // Används både för "existing"-kollen och nextNoticeNumber → tom lista.
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({
            id: 'rn-1',
            ...data,
            type: 'RENT',
            lease: { unit: { type: 'APARTMENT', property: {} } },
            tenant: lease.tenant,
          }),
        ),
      },
      // T5 A1: avi + verifikat skapas i prisma.$transaction. Mocken kör callbacken
      // med hela prisma-mocken som tx → tx.rentNotice.create/findMany = samma mockar.
      $transaction: (cb: (t: unknown) => unknown) => cb(prisma),
    }

    const ocrService = { assignOcrToTenant: jest.fn().mockResolvedValue('1234567890') }
    const accounting = {
      createJournalEntryForRentNotice: jest.fn().mockResolvedValue({ id: 'je-1' }),
    }
    const consumption = {
      attachRentNoticeLineCharges: jest.fn().mockResolvedValue(0),
    }
    const noop = {}

    const service = new AviseringService(
      prisma as never,
      ocrService as never,
      noop as never, // mail
      noop as never, // pdf
      noop as never, // storage
      noop as never, // pdfQueue
      accounting as never,
      consumption as never,
      noop as never, // miscCharges
      { ensureDepositForNotice: jest.fn().mockResolvedValue({ created: false }) } as never, // deposits
      {} as never, // rentNoticeEvents
    )
    return { service, prisma, accounting }
  }

  it('skapar avi OCH bokför hyresfordran (1510 D / 39xx K) via AccountingService', async () => {
    const { service, prisma, accounting } = makeService()
    const result = await service.generateMonthlyNotices('org-1', 6, 2026)

    expect(result.created).toBe(1)
    expect(prisma.rentNotice.create).toHaveBeenCalledTimes(1)

    // Intäktsverifikationen är kärnan i LAGBROTT 2-fixen.
    expect(accounting.createJournalEntryForRentNotice).toHaveBeenCalledTimes(1)
    const [noticeArg, orgArg, createdByArg] =
      accounting.createJournalEntryForRentNotice.mock.calls[0]
    expect(noticeArg).toMatchObject({ id: 'rn-1', type: 'RENT', leaseId: 'lease-1' })
    expect(orgArg).toBe('org-1')
    expect(createdByArg).toBeNull()
  })

  it('T5 A1: bokföringsfel rullar tillbaka avin (ingen orphan) men avbryter inte körningen', async () => {
    const { service, accounting } = makeService()
    accounting.createJournalEntryForRentNotice.mockRejectedValueOnce(new Error('DB nere'))
    const result = await service.generateMonthlyNotices('org-1', 6, 2026)
    // Avi + verifikat är atomiska: bokförings-felet rullar tillbaka avin →
    // created=0, failed=1. Tidigare (best-effort) blev avin kvar utan verifikat.
    expect(result.created).toBe(0)
    expect(result.failed).toBe(1)
  })

  it('bostadsavi får INGEN moms (ML 3 kap 2 §)', async () => {
    const { service, prisma } = makeService({ type: 'APARTMENT' })
    await service.generateMonthlyNotices('org-1', 6, 2026)
    const data = prisma.rentNotice.create.mock.calls[0][0].data
    expect(data.vatAmount).toBe(0)
    expect(data.totalAmount).toBe(data.amount)
  })

  it('lokal MED frivillig skattskyldighet + hyra exkl. moms → 25% moms', async () => {
    const { service, prisma } = makeService({
      type: 'OFFICE',
      voluntaryTaxLiability: true,
      monthlyRentExcludingVat: true,
    })
    await service.generateMonthlyNotices('org-1', 6, 2026)
    const data = prisma.rentNotice.create.mock.calls[0][0].data
    // Hel månad → amount = 10000, moms 25% = 2500, total 12500
    expect(data.vatAmount).toBe(2_500)
    expect(data.totalAmount).toBe(data.amount + 2_500)
  })

  it('netto-gate: momspliktig lokal men hyra EJ markerad exkl. moms → ingen moms (JB 12 kap 19 §)', async () => {
    const { service, prisma } = makeService({
      type: 'OFFICE',
      voluntaryTaxLiability: true,
      monthlyRentExcludingVat: false,
    })
    await service.generateMonthlyNotices('org-1', 6, 2026)
    const data = prisma.rentNotice.create.mock.calls[0][0].data
    expect(data.vatAmount).toBe(0)
    expect(data.totalAmount).toBe(data.amount)
  })

  it('lokal UTAN frivillig skattskyldighet får ingen moms', async () => {
    const { service, prisma } = makeService({ type: 'OFFICE', voluntaryTaxLiability: false })
    await service.generateMonthlyNotices('org-1', 6, 2026)
    const data = prisma.rentNotice.create.mock.calls[0][0].data
    expect(data.vatAmount).toBe(0)
  })

  // ── T1.4 PR0: bookRentNoticeRevenue atomiskt läge ─────────────────────────
  describe('T1.4 PR0 · bookRentNoticeRevenue: tx trär igenom + fel-riktning', () => {
    const rentNotice = {
      id: 'rn-x',
      noticeNumber: 'AVI-2026-06-0009',
      leaseId: 'lease-1',
      type: 'RENT',
      amount: 10_000,
      vatAmount: 0,
      totalAmount: 10_000,
      year: 2026,
      month: 6,
    }
    type BookFn = (orgId: string, notice: unknown, tx?: unknown) => Promise<void>

    it('MED tx: bokföringsfel BUBBLAR UPP (fäller yttre transaktionen → ingen orphan-avi)', async () => {
      const { service, accounting } = makeService()
      accounting.createJournalEntryForRentNotice.mockRejectedValueOnce(new Error('period stängd'))
      const fakeTx = { marker: 'outer-tx' }
      await expect(
        (service as unknown as { bookRentNoticeRevenue: BookFn }).bookRentNoticeRevenue(
          'org-1',
          rentNotice,
          fakeTx,
        ),
      ).rejects.toThrow('period stängd')
      // tx trädd hela vägen ner till accounting-anropet (4:e argumentet).
      expect(accounting.createJournalEntryForRentNotice).toHaveBeenCalledWith(
        rentNotice,
        'org-1',
        null,
        fakeTx,
      )
    })

    it('UTAN tx: bokföringsfel SVÄLJS (best-effort oförändrat — avin redan committad)', async () => {
      const { service, accounting } = makeService()
      accounting.createJournalEntryForRentNotice.mockRejectedValueOnce(new Error('DB nere'))
      await expect(
        (service as unknown as { bookRentNoticeRevenue: BookFn }).bookRentNoticeRevenue(
          'org-1',
          rentNotice,
        ),
      ).resolves.toBeUndefined()
    })
  })
})
