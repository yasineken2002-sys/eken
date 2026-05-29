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
  function makeService() {
    const lease = {
      id: 'lease-1',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      monthlyRent: 10_000,
      startDate: new Date('2026-01-01'),
      endDate: null,
      status: 'ACTIVE',
      tenant: { id: 'tenant-1', email: 't@example.se', type: 'INDIVIDUAL' },
      unit: { id: 'unit-1', type: 'APARTMENT', name: 'Lgh 1', unitNumber: '1', property: {} },
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
    }

    const ocrService = { assignOcrToTenant: jest.fn().mockResolvedValue('1234567890') }
    const accounting = {
      createJournalEntryForRentNotice: jest.fn().mockResolvedValue({ id: 'je-1' }),
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

  it('bokföringsfel fäller inte avi-genereringen (avin är redan skapad)', async () => {
    const { service, accounting } = makeService()
    accounting.createJournalEntryForRentNotice.mockRejectedValueOnce(new Error('DB nere'))
    const result = await service.generateMonthlyNotices('org-1', 6, 2026)
    expect(result.created).toBe(1)
  })
})
