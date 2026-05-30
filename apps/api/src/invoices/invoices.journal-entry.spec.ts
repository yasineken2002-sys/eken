/**
 * H3 — faktura-bokföringen är synkron (awaited), inte fire-and-forget.
 *
 * Verifierar att InvoicesService.create():
 *   • hämtar fakturan MED rader i transaktionen (include: { lines: true })
 *   • awaitar createJournalEntryForInvoice med just det objektet (rader med)
 *   • inte kraschar om bokföringen fallerar (loggar, fakturan är redan skapad)
 */

jest.mock('./pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { InvoicesService } from './invoices.service'

interface NumberGenAccess {
  generateInvoiceNumber: (
    orgId: string,
    tx: unknown,
  ) => Promise<{ invoiceNumber: string; sequence: number }>
}

const DTO = {
  type: 'RENT' as const,
  leaseId: 'lease-1',
  issueDate: '2026-06-01',
  dueDate: '2026-06-30',
  lines: [{ description: 'Hyra', quantity: 1, unitPrice: 1000, vatRate: 0 }],
}

function makeService(opts: { journalThrows?: boolean } = {}) {
  const createdInvoice = {
    id: 'inv-1',
    invoiceNumber: 'F-2026-0001',
    lines: [{ id: 'l1', description: 'Hyra' }],
  }
  const txCreate = jest.fn().mockResolvedValue(createdInvoice)
  const tx = { invoice: { create: txCreate } }
  const prisma = {
    lease: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'lease-1',
        status: 'ACTIVE',
        tenantId: 'tenant-1',
        unit: { type: 'APARTMENT', voluntaryTaxLiability: false },
      }),
    },
    $transaction: (cb: (t: unknown) => unknown) => cb(tx),
  }
  const captured: { invoice?: { lines?: unknown } } = {}
  const createJournalEntryForInvoice = jest.fn((invoice: { lines?: unknown }) => {
    captured.invoice = invoice
    return opts.journalThrows
      ? Promise.reject(new Error('Kontoplan saknas'))
      : Promise.resolve({ id: 'je-1' })
  })
  const eventsService = { record: jest.fn().mockResolvedValue(undefined) }
  const accountingService = { createJournalEntryForInvoice }
  const ocrService = { generateForInvoiceSequence: jest.fn().mockReturnValue('1234567890') }

  const service = new InvoicesService(
    prisma as never,
    eventsService as never,
    {} as never, // pdfService
    {} as never, // mailService
    accountingService as never,
    {} as never, // notificationsService
    ocrService as never,
    {} as never, // pdfQueue
  )
  // Hoppa över sekvens-/sekvenstabell-internals — inte under test här.
  ;(service as unknown as NumberGenAccess).generateInvoiceNumber = () =>
    Promise.resolve({ invoiceNumber: 'F-2026-0001', sequence: 1 })

  return { service, txCreate, createJournalEntryForInvoice, captured }
}

describe('InvoicesService.create — atomisk bokföring (H3)', () => {
  it('hämtar fakturan med rader i transaktionen och awaitar bokföringen med dem', async () => {
    const { service, txCreate, createJournalEntryForInvoice, captured } = makeService()

    await service.create('org-1', 'user-1', DTO as never)

    // include: { lines: true } i tx-create
    expect(txCreate.mock.calls[0]?.[0]).toMatchObject({ include: { lines: true } })
    // bokföringen anropad med objektet som bär rader
    expect(createJournalEntryForInvoice).toHaveBeenCalledTimes(1)
    expect(Array.isArray(captured.invoice?.lines)).toBe(true)
  })

  it('returnerar fakturan även om bokföringen fallerar (inget kast)', async () => {
    const { service, createJournalEntryForInvoice } = makeService({ journalThrows: true })

    const result = await service.create('org-1', 'user-1', DTO as never)

    expect(createJournalEntryForInvoice).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ id: 'inv-1' })
  })
})
