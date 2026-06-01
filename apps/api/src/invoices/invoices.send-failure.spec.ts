/**
 * Synlig felhantering vid misslyckat faktura-utskick.
 *
 * Verifierar InvoicesService.processInvoiceSendJob() — samma mönster som
 * AviseringService redan använder (sendError + synligt fel) men för fakturor:
 *
 *   • Transient fel (PDF/mejl kastar) → Invoice.sendError sätts, ett immutabelt
 *     SEND_FAILED-event loggas, och felet kastas vidare så Bull kan retrya.
 *   • Saknad mottagar-e-post → markeras som fel UTAN att kasta (permanent —
 *     inga meningslösa retries), exakt som avisering.
 *   • Lyckat utskick efter ett tidigare fel → sendError nollställs så att
 *     UI-varningen försvinner.
 *
 * Statusen förblir DRAFT i felfallen (utskicket skedde aldrig) — InvoiceStatus
 * är en finansiell statusmaskin utan FAILED; fältet bär felet.
 */

// InvoicesService → PdfService → StorageService drar in @aws-sdk/client-s3 (ESM
// som jest inte transformerar). Mocka modulerna så importen blir lätt.
jest.mock('./pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { InvoicesService } from './invoices.service'

interface MockInvoice {
  id: string
  status: string
  invoiceNumber: string
  total: number
  dueDate: Date
  sendError: string | null
  tenant: { type: string; firstName: string; lastName: string; email: string | null } | null
  customer: null
  organization: { name: string; invoiceColor: string | null }
  lines: unknown[]
}

function makeService(overrides: Partial<MockInvoice> = {}) {
  const invoice: MockInvoice = {
    id: 'inv-1',
    status: 'DRAFT',
    invoiceNumber: 'F-2026-0001',
    total: 10000,
    dueDate: new Date('2026-06-30'),
    sendError: null,
    tenant: { type: 'INDIVIDUAL', firstName: 'Test', lastName: 'Hyresgäst', email: 'h@test.se' },
    customer: null,
    organization: { name: 'Org AB', invoiceColor: null },
    lines: [],
    ...overrides,
  }

  const prisma = {
    invoice: {
      findFirst: jest.fn().mockResolvedValue(invoice),
      update: jest.fn().mockResolvedValue(invoice),
    },
  }
  const eventsService = { record: jest.fn().mockResolvedValue({ id: 'evt-1' }) }
  const pdfService = { generateInvoicePdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')) }
  const mailService = { sendInvoice: jest.fn().mockResolvedValue('mail-1') }

  const service = new InvoicesService(
    prisma as never,
    eventsService as never,
    pdfService as never,
    mailService as never,
    {} as never, // accountingService
    {} as never, // notificationsService
    {} as never, // ocrService
    {} as never, // pdfQueue
  )
  return { service, prisma, eventsService, pdfService, mailService }
}

describe('InvoicesService.processInvoiceSendJob — synlig felhantering', () => {
  it('transient fel: sätter sendError, loggar SEND_FAILED och kastar vidare (Bull retry)', async () => {
    const { service, prisma, eventsService, pdfService } = makeService()
    pdfService.generateInvoicePdf.mockRejectedValueOnce(new Error('Chromium kraschade'))

    await expect(service.processInvoiceSendJob('inv-1', 'org-1', 'user-1')).rejects.toThrow(
      'Chromium kraschade',
    )

    // Synligt fel sparat på fakturan.
    expect(prisma.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'inv-1' },
        data: { sendError: 'Chromium kraschade' },
      }),
    )
    // Immutabelt SEND_FAILED-event i historiken.
    expect(eventsService.record).toHaveBeenCalledWith(
      'inv-1',
      'SEND_FAILED',
      'SYSTEM',
      null,
      expect.objectContaining({ error: 'Chromium kraschade' }),
    )
  })

  it('saknad mottagar-e-post: markeras som fel UTAN att kasta (permanent, ingen retry)', async () => {
    const { service, prisma, eventsService, pdfService } = makeService({
      tenant: { type: 'INDIVIDUAL', firstName: 'Test', lastName: 'X', email: null },
    })

    await expect(service.processInvoiceSendJob('inv-1', 'org-1', 'user-1')).resolves.toBeUndefined()

    expect(pdfService.generateInvoicePdf).not.toHaveBeenCalled()
    expect(prisma.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { sendError: 'Fakturan saknar mottagare med e-postadress' },
      }),
    )
    expect(eventsService.record).toHaveBeenCalledWith(
      'inv-1',
      'SEND_FAILED',
      'SYSTEM',
      null,
      expect.any(Object),
    )
  })

  it('lyckat utskick efter tidigare fel: nollställer sendError', async () => {
    const { service, prisma, eventsService } = makeService({ sendError: 'Tidigare fel' })
    // Undvik den riktiga state machine-transaktionen i transitionStatus.
    jest
      .spyOn(service, 'transitionStatus')
      .mockResolvedValue({ id: 'inv-1', status: 'SENT' } as never)

    await service.processInvoiceSendJob('inv-1', 'org-1', 'user-1')

    expect(service.transitionStatus).toHaveBeenCalledWith(
      'inv-1',
      'org-1',
      'SENT',
      'user-1',
      'USER',
    )
    // sendError nollställs.
    expect(prisma.invoice.update).toHaveBeenCalledWith({
      where: { id: 'inv-1' },
      data: { sendError: null },
    })
    // Inget SEND_FAILED loggas vid lyckat utskick.
    expect(eventsService.record).not.toHaveBeenCalledWith(
      'inv-1',
      'SEND_FAILED',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    )
  })

  it('hoppar tyst över redan PAID faktura (ingen felmarkering)', async () => {
    const { service, prisma, eventsService } = makeService({ status: 'PAID' })

    await expect(service.processInvoiceSendJob('inv-1', 'org-1', 'user-1')).resolves.toBeUndefined()

    expect(prisma.invoice.update).not.toHaveBeenCalled()
    expect(eventsService.record).not.toHaveBeenCalled()
  })
})
