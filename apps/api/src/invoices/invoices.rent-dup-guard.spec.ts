/**
 * Fix #1 (dubbelfaktureringsskydd) — restposten efter borttagningen av createBulk.
 *
 * Avisering (RentNotice) är den kanoniska hyresmotorn. En manuell RENT-faktura via
 * POST /invoices för ett avtal+period som redan aviserats skulle intäktsbokföra
 * samma hyra en andra gång (1510 D / 39xx K två gånger, BFL 4 kap 2 §). create()
 * ska nu blockera med ConflictException om en icke-annullerad RentNotice finns för
 * samma leaseId + månad/år.
 */

jest.mock('./pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { ConflictException } from '@nestjs/common'
import { InvoicesService } from './invoices.service'

const DTO = {
  type: 'RENT' as const,
  leaseId: 'lease-1',
  issueDate: '2026-06-01',
  dueDate: '2026-06-30',
  lines: [{ description: 'Hyra', quantity: 1, unitPrice: 10000, vatRate: 0 }],
}

function makeService(opts: { existingNotice?: boolean } = {}) {
  const rentNoticeFindFirst = jest
    .fn()
    .mockResolvedValue(opts.existingNotice ? { id: 'rn-1' } : null)

  const tx = {
    invoice: {
      create: jest.fn().mockResolvedValue({
        id: 'inv-1',
        invoiceNumber: 'F-2026-0001',
        lines: [{ id: 'l1' }],
      }),
    },
  }
  const prisma = {
    lease: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'lease-1',
        status: 'ACTIVE',
        tenantId: 'tenant-1',
        unit: { type: 'APARTMENT', voluntaryTaxLiability: false },
      }),
    },
    rentNotice: { findFirst: rentNoticeFindFirst },
    $transaction: (cb: (t: unknown) => unknown) => cb(tx),
  }
  const eventsService = { record: jest.fn().mockResolvedValue(undefined) }
  const accountingService = {
    createJournalEntryForInvoice: jest.fn().mockResolvedValue({ id: 'je-1' }),
  }
  const ocrService = { generateForInvoiceSequence: jest.fn().mockReturnValue('1234567890') }

  const service = new InvoicesService(
    prisma as never,
    eventsService as never,
    {} as never,
    {} as never,
    accountingService as never,
    {} as never,
    ocrService as never,
    {} as never,
  )
  ;(
    service as unknown as {
      generateInvoiceNumber: () => Promise<{ invoiceNumber: string; sequence: number }>
    }
  ).generateInvoiceNumber = () => Promise.resolve({ invoiceNumber: 'F-2026-0001', sequence: 1 })

  return { service, rentNoticeFindFirst, txCreate: tx.invoice.create }
}

describe('InvoicesService.create — dubbelfaktureringsspärr mot RentNotice', () => {
  it('blockerar en RENT-faktura när en icke-annullerad hyresavi finns för perioden', async () => {
    const { service, rentNoticeFindFirst, txCreate } = makeService({ existingNotice: true })

    await expect(service.create('org-1', 'user-1', DTO as never)).rejects.toBeInstanceOf(
      ConflictException,
    )
    // Slår upp rätt avtal + period, exkluderar annullerade avier
    expect(rentNoticeFindFirst.mock.calls[0]?.[0]).toMatchObject({
      where: {
        leaseId: 'lease-1',
        type: 'RENT',
        month: 6,
        year: 2026,
        status: { not: 'CANCELLED' },
      },
    })
    // Ingen faktura skapades
    expect(txCreate).not.toHaveBeenCalled()
  })

  it('tillåter en RENT-faktura när ingen hyresavi finns för perioden', async () => {
    const { service, txCreate } = makeService({ existingNotice: false })

    const result = await service.create('org-1', 'user-1', DTO as never)
    expect(result).toMatchObject({ id: 'inv-1' })
    expect(txCreate).toHaveBeenCalledTimes(1)
  })
})
