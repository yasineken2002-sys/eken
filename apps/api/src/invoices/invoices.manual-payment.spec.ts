/**
 * Bokföringsfix #2 — manuell betalningsregistrering bokför inbetalningen.
 *
 * Tidigare satte PATCH /invoices/:id/status → PAID bara status, aldrig ett
 * verifikat: 1510 (Kundfordringar) stod kvar öppen (BFL 5 kap 6 §-brott).
 * markAsPaidManually ska istället:
 *   • atomiskt claima fakturan (SENT/PARTIAL/OVERDUE/SENT_TO_COLLECTION → PAID)
 *   • boka betalningen (likvidkonto D / 1510 K) med fakturans totalbelopp
 *   • ÅNGRA statusen om verifikatet uteblir (kontoplan saknas)
 *   • vägra dubbelbetalning och ogiltiga övergångar
 */

jest.mock('./pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { InvoicesService, toPaymentMethod } from './invoices.service'

function makeService(
  opts: { status?: string; journalReturnsNull?: boolean; claimCount?: number } = {},
) {
  const status = opts.status ?? 'SENT'
  const invoiceRow = {
    id: 'inv-1',
    status,
    invoiceNumber: 'F-2026-0001',
    total: 1250,
  }

  const updateMany = jest.fn().mockResolvedValue({ count: opts.claimCount ?? 1 })
  const findFirst = jest.fn().mockResolvedValue(invoiceRow)
  const findFirstOrThrow = jest.fn().mockResolvedValue({ ...invoiceRow, status: 'PAID' })
  const prisma = {
    invoice: { findFirst, findFirstOrThrow, updateMany },
  }

  const createJournalEntryForInvoiceManualPayment = jest.fn(() =>
    opts.journalReturnsNull ? Promise.resolve(null) : Promise.resolve({ id: 'je-pay-1' }),
  )
  const accountingService = { createJournalEntryForInvoiceManualPayment }
  const eventsService = { record: jest.fn().mockResolvedValue(undefined) }
  const notificationsService = { createForAllOrgUsers: jest.fn().mockResolvedValue(undefined) }

  const service = new InvoicesService(
    prisma as never,
    eventsService as never,
    {} as never,
    {} as never,
    accountingService as never,
    notificationsService as never,
    {} as never,
    {} as never,
  )

  return {
    service,
    updateMany,
    createJournalEntryForInvoiceManualPayment,
    eventsService,
    notificationsService,
  }
}

describe('InvoicesService.markAsPaidManually — bokför inbetalningen', () => {
  it('bokför likvidkonto D / 1510 K med fakturans totalbelopp och sätter PAID', async () => {
    const { service, updateMany, createJournalEntryForInvoiceManualPayment, eventsService } =
      makeService()

    await service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {
      enteredAmount: 1250,
      reference: 'OCR123',
    })

    // atomisk claim till PAID
    expect(updateMany).toHaveBeenCalledTimes(1)
    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({ data: { status: 'PAID' } })
    // bokför med totalbeloppet (settlement), inte det inmatade beloppet
    expect(createJournalEntryForInvoiceManualPayment).toHaveBeenCalledTimes(1)
    const args = createJournalEntryForInvoiceManualPayment.mock.calls[0] as unknown[]
    expect(args[1]).toBe(1250)
    expect(args[3]).toBe('BANK')
    // append-only PAYMENT_RECEIVED-händelse
    expect(eventsService.record).toHaveBeenCalledWith(
      'inv-1',
      'PAYMENT_RECEIVED',
      'USER',
      'user-1',
      expect.objectContaining({ newStatus: 'PAID', settlementAmount: 1250, reference: 'OCR123' }),
    )
  })

  it('ångrar statusövergången om verifikatet uteblir (kontoplan saknas)', async () => {
    const { service, updateMany, eventsService } = makeService({ journalReturnsNull: true })

    await expect(
      service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {}),
    ).rejects.toThrow(/verifikat kunde inte skapas/i)

    // två updateMany: 1) claim PAID, 2) revert till SENT
    expect(updateMany).toHaveBeenCalledTimes(2)
    expect(updateMany.mock.calls[1]?.[0]).toMatchObject({
      data: { status: 'SENT', paidAt: null },
    })
    // ingen betald-händelse skrevs för en revertad betalning
    expect(eventsService.record).not.toHaveBeenCalled()
  })

  it('vägrar dubbelbetalning (redan PAID)', async () => {
    const { service, updateMany } = makeService({ status: 'PAID' })

    await expect(
      service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {}),
    ).rejects.toThrow(/redan betald/i)
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('vägrar betalning på ett utkast (DRAFT → PAID är ogiltig)', async () => {
    const { service, updateMany } = makeService({ status: 'DRAFT' })

    await expect(
      service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {}),
    ).rejects.toThrow(/inte tillåten/i)
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('kastar konflikt om en parallell process hann reglera fakturan (claim count 0)', async () => {
    const { service, createJournalEntryForInvoiceManualPayment } = makeService({ claimCount: 0 })

    await expect(
      service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {}),
    ).rejects.toThrow(/redan reglerad eller makulerad/i)
    expect(createJournalEntryForInvoiceManualPayment).not.toHaveBeenCalled()
  })
})

describe('toPaymentMethod — UI-sträng → PaymentMethod-enum', () => {
  it('mappar visningssträngarna till rätt enum', () => {
    expect(toPaymentMethod('Bankgiro')).toBe('BANK')
    expect(toPaymentMethod('Plusgiro')).toBe('BANK')
    expect(toPaymentMethod('Autogiro')).toBe('BANK')
    expect(toPaymentMethod('Swish')).toBe('SWISH')
    expect(toPaymentMethod('Kontant')).toBe('CASH')
  })

  it('faller tillbaka till MANUAL för okänt/utelämnat betalsätt', () => {
    expect(toPaymentMethod(undefined)).toBe('MANUAL')
    expect(toPaymentMethod('')).toBe('MANUAL')
    expect(toPaymentMethod('Bitcoin')).toBe('MANUAL')
  })
})
