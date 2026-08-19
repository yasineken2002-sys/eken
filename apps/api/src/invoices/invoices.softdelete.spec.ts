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

function makeService(invoiceStatus: string | null, allocations: Array<{ id: string }> = []) {
  const found =
    invoiceStatus === null
      ? null
      : { id: 'inv-1', status: invoiceStatus, invoiceNumber: 'F-2026-0001' }

  const prisma = {
    invoice: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(found),
      update: jest
        .fn()
        .mockImplementation((arg: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'inv-1', invoiceNumber: 'F-2026-0001', ...arg.data }),
        ),
      delete: jest.fn(),
    },
    invoiceEvent: { deleteMany: jest.fn() },
    // C4/C5: VOID-guarden läser faktiska betalningsallokeringar (inte status).
    invoicePayment: { findMany: jest.fn().mockResolvedValue(allocations) },
    // A: VOID plockar bort avgiftsraden och drar av den från totalen.
    invoiceLine: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    // E: förbrukningsdebiteringar lossas vid VOID. Ingen charge här.
    consumptionCharge: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    // #301: radlåset på fakturan (låsordning Invoice → Deposit) + uppslaget som
    // hittar depositionens accrual i sin egen namnrymd. Utan deposition → no-op.
    $queryRaw: jest.fn().mockResolvedValue([]),
    deposit: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: undefined as unknown,
  }
  ;(prisma as { $transaction: unknown }).$transaction = (cb: (tx: unknown) => unknown) => cb(prisma)

  const eventsService = { record: jest.fn().mockResolvedValue({ id: 'evt-1' }) }
  const notificationsService = { createForAllOrgUsers: jest.fn().mockResolvedValue(undefined) }
  // VOID reverserar fakturans intäktsverifikat (fix #4) — no-op-mock räcker här.
  const accountingService = {
    reverseJournalEntryForInvoice: jest.fn().mockResolvedValue(undefined),
    reverseJournalEntryForReminderFee: jest.fn().mockResolvedValue(undefined),
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

describe('transitionStatus → VOID: blockera makulering av delvis betald faktura', () => {
  // BETEENDEÄNDRING (C4/C5): guarden nyckar på FAKTISKA allokeringar, inte på
  // status === 'PARTIAL'. Statusvarianten (PR #166) räckte så länge PARTIAL var
  // onåbart; med delbetalningsmodellen tillåter INVOICE_TRANSITIONS
  // PARTIAL → OVERDUE → VOID, och PATCH /status blockerar bara PAID — så en
  // delbetald faktura kunde makuleras i två steg förbi den gamla spärren.
  it('PARTIAL MED registrerad betalning → VOID avvisas', async () => {
    const { service, prisma } = makeService('PARTIAL', [{ id: 'pay-1' }])
    await expect(
      service.transitionStatus('inv-1', 'org-1', 'VOID', 'user-1', 'USER'),
    ).rejects.toThrow(/registrerad betalning/i)
    expect(prisma.invoice.update).not.toHaveBeenCalled()
  })

  it('OVERDUE MED registrerad betalning → VOID avvisas (hålet statusvarianten missade)', async () => {
    const { service, prisma } = makeService('OVERDUE', [{ id: 'pay-1' }])
    await expect(
      service.transitionStatus('inv-1', 'org-1', 'VOID', 'user-1', 'USER'),
    ).rejects.toThrow(/registrerad betalning/i)
    expect(prisma.invoice.update).not.toHaveBeenCalled()
  })

  it('PARTIAL UTAN registrerad betalning → VOID tillåts (inga pengar att strandsätta)', async () => {
    const { service, prisma } = makeService('PARTIAL', [])
    await service.transitionStatus('inv-1', 'org-1', 'VOID', 'user-1', 'USER')
    expect(prisma.invoice.update).toHaveBeenCalled()
  })

  it('SENT → VOID tillåts (ingen delbetalning att strandsätta)', async () => {
    const { service, prisma } = makeService('SENT')
    await service.transitionStatus('inv-1', 'org-1', 'VOID', 'user-1', 'USER')
    expect(prisma.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'VOID' }) }),
    )
  })
})
