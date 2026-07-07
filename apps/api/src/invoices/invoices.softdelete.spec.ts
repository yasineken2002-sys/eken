/**
 * FIX 9 · PR 5 — Soft-delete av fakturor (LAGBROTT 1, BFL 1999:1078).
 *
 * Verifierar InvoicesService.remove():
 *   • Ett DRAFT-utkast MAKULERAS (status → VOID) i stället för att raderas hårt.
 *   • Varken invoice.delete() eller invoiceEvent.deleteMany() anropas —
 *     räkenskapsinformation och händelselogg bevaras.
 *   • En VOIDED-händelse loggas med aktör (BFL 5 kap 7 §).
 *   • Endast DRAFT kan tas bort; andra statusar avvisas.
 */

// InvoicesService → PdfService → StorageService drar in @aws-sdk/client-s3 (ESM
// som jest inte transformerar). Mocka modulerna så importen blir lätt.
jest.mock('./pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { BadRequestException, NotFoundException } from '@nestjs/common'
import { InvoicesService } from './invoices.service'

function makeService(invoiceStatus: string | null) {
  const found =
    invoiceStatus === null
      ? null
      : { id: 'inv-1', status: invoiceStatus, invoiceNumber: 'F-2026-0001' }

  const prisma = {
    invoice: {
      findFirst: jest.fn().mockResolvedValue(found),
      update: jest
        .fn()
        .mockImplementation((arg: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'inv-1', invoiceNumber: 'F-2026-0001', ...arg.data }),
        ),
      delete: jest.fn(),
    },
    invoiceEvent: { deleteMany: jest.fn() },
    $transaction: undefined as unknown,
  }
  ;(prisma as { $transaction: unknown }).$transaction = (cb: (tx: unknown) => unknown) => cb(prisma)

  const eventsService = { record: jest.fn().mockResolvedValue({ id: 'evt-1' }) }
  const notificationsService = { createForAllOrgUsers: jest.fn().mockResolvedValue(undefined) }
  // VOID reverserar fakturans intäktsverifikat (fix #4) — no-op-mock räcker här.
  const accountingService = {
    reverseJournalEntryForInvoice: jest.fn().mockResolvedValue(undefined),
  }

  // Övriga konstruktorberoenden används inte av remove()/transitionStatus.
  const service = new InvoicesService(
    prisma as never,
    eventsService as never,
    {} as never, // pdfService
    {} as never, // mailService
    accountingService as never,
    notificationsService as never,
    {} as never, // ocrService
    {} as never, // pdfQueue
  )
  return { service, prisma, eventsService }
}

describe('FIX 9 · PR 5 — InvoicesService.remove (soft-delete)', () => {
  it('makulerar ett DRAFT-utkast (status → VOID) utan att radera något', async () => {
    const { service, prisma, eventsService } = makeService('DRAFT')

    await service.remove('inv-1', 'org-1', 'user-1')

    // Ingen hård radering av räkenskapsinformation.
    expect(prisma.invoice.delete).not.toHaveBeenCalled()
    expect(prisma.invoiceEvent.deleteMany).not.toHaveBeenCalled()

    // Statusövergång till VOID.
    expect(prisma.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'inv-1' },
        data: expect.objectContaining({ status: 'VOID' }),
      }),
    )

    // VOIDED-händelse loggad med aktör + orsak.
    expect(eventsService.record).toHaveBeenCalledWith(
      'inv-1',
      'VOIDED',
      'USER',
      'user-1',
      expect.objectContaining({ newStatus: 'VOID', reason: 'draft_voided' }),
      expect.anything(),
    )
  })

  it.each(['SENT', 'PARTIAL', 'PAID', 'OVERDUE', 'SENT_TO_COLLECTION', 'VOID'])(
    'avvisar borttagning av icke-utkast (%s) — DRAFT-spärren är inte statusspecifik',
    async (status) => {
      const { service, prisma } = makeService(status)
      await expect(service.remove('inv-1', 'org-1', 'user-1')).rejects.toBeInstanceOf(
        BadRequestException,
      )
      expect(prisma.invoice.update).not.toHaveBeenCalled()
      expect(prisma.invoice.delete).not.toHaveBeenCalled()
    },
  )

  it('kastar NotFound när fakturan inte finns', async () => {
    const { service } = makeService(null)
    await expect(service.remove('inv-x', 'org-1', 'user-1')).rejects.toBeInstanceOf(
      NotFoundException,
    )
  })
})
