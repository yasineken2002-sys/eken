/**
 * Bankvägs-härdning (följd-PR till bokföringsfix #2): applyMatchToInvoice är nu
 * ATOMISK. Tidigare flippade den PAID via transitionStatus och bokförde
 * fire-and-forget (loggade bara vid fel) → en faktura kunde bli PAID utan
 * verifikat, och en samtidig manuell betalning kunde dubbelbokföras.
 *
 * Bevisar:
 *   • HAPPY PATH: status-guardad claim + bank-länk + betalningsverifikat bokas i
 *     SAMMA tx (createJournalEntryForPayment får tx-klienten), notis efter commit.
 *   • ATOMICITET: verifikatet uteblir (kontoplan saknas → null) → HELA matchningen
 *     kastar och rullas tillbaka (INTE längre fire-and-forget).
 *   • RACE/IDEMPOTENS: redan reglerad faktura (claimed=false) → ingen bokning,
 *     ingen bank-länk, transaktionen förblir omatchad.
 */

jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Decimal } from '@prisma/client/runtime/library'
import { ReconciliationService } from './reconciliation.service'

function dec(n: number | string) {
  return new Decimal(n)
}

const INVOICE = { id: 'inv-1', invoiceNumber: 'F-2026-0001', total: dec('1250') }

function makeService(
  opts: {
    claimed?: boolean
    journalReturnsNull?: boolean
    depositCount?: number
  } = {},
) {
  const txMock = {
    bankTransaction: { update: jest.fn().mockResolvedValue({}) },
    // deposit-F1: applyMatchToInvoice synkar en ev. länkad Deposit → PAID.
    deposit: { updateMany: jest.fn().mockResolvedValue({ count: opts.depositCount ?? 0 }) },
  }

  const claimPaidWithinTx = jest
    .fn()
    .mockResolvedValue({ claimed: opts.claimed ?? true, invoiceNumber: INVOICE.invoiceNumber })
  const notifyInvoicePaid = jest.fn()
  const invoices = { claimPaidWithinTx, notifyInvoicePaid }

  const createJournalEntryForPayment = jest.fn(() =>
    opts.journalReturnsNull ? Promise.resolve(null) : Promise.resolve({ id: 'je-pay-1' }),
  )
  const accounting = { createJournalEntryForPayment }
  const events = { record: jest.fn().mockResolvedValue(undefined) }

  const prisma = {
    invoice: {
      // OCR-grenen hittar fakturan; reference-grenen används ej (description tom).
      findFirst: jest.fn().mockResolvedValue(INVOICE),
      // Fuzzy-grenen (efter en claimed=false-fallthrough) hittar inga kandidater.
      findMany: jest.fn().mockResolvedValue([]),
    },
    rentNotice: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(txMock)),
  }

  const service = new ReconciliationService(
    prisma as never,
    invoices as never,
    events as never,
    accounting as never,
    {} as never,
  )
  return {
    service,
    prisma,
    txMock,
    claimPaidWithinTx,
    notifyInvoicePaid,
    createJournalEntryForPayment,
  }
}

// deposit-F1: en deposition-faktura (Deposit.invoiceId-länkad) som bankmatchas
// måste synka Deposit.status → PAID i samma tx, annars kan depositionen aldrig
// återbetalas (refund/markRefundPending kräver PAID).
describe('deposit-F1 · applyMatchToInvoice synkar länkad Deposit → PAID', () => {
  it('bankmatchad faktura → tx.deposit.updateMany({invoiceId, PENDING}) → PAID (status-guardad, atomisk)', async () => {
    const { service, txMock } = makeService({ depositCount: 1 })
    const matched = await service.matchTransaction(OCR_TX as never, 'org-1')
    expect(matched).toBe(true)
    expect(txMock.deposit.updateMany).toHaveBeenCalledTimes(1)
    const arg = txMock.deposit.updateMany.mock.calls[0]![0]
    expect(arg.where).toMatchObject({
      invoiceId: INVOICE.id,
      organizationId: 'org-1',
      status: 'PENDING',
    })
    expect(arg.data).toMatchObject({ status: 'PAID' })
    expect(arg.data.paidAt).toBeInstanceOf(Date)
  })

  it('icke-deposition-faktura → updateMany matchar 0 rader (no-op, ingen bieffekt)', async () => {
    const { service, txMock } = makeService({ depositCount: 0 })
    await service.matchTransaction(OCR_TX as never, 'org-1')
    // Anropet sker alltid men är ett DB-no-op (ingen Deposit har denna invoiceId).
    expect(txMock.deposit.updateMany).toHaveBeenCalledTimes(1)
  })

  it('claim misslyckas (redan reglerad) → ingen Deposit-synk', async () => {
    const { service, txMock } = makeService({ claimed: false })
    await service.matchTransaction(OCR_TX as never, 'org-1')
    expect(txMock.deposit.updateMany).not.toHaveBeenCalled()
  })
})

const OCR_TX = {
  id: 'tx-1',
  rawOcr: '1234567890',
  amount: dec('1250'),
  date: new Date('2026-06-15'),
  description: '',
  reference: '',
}

describe('applyMatchToInvoice — atomisk bank-matchning', () => {
  it('happy path: claim + bank-länk + verifikat i samma tx, notis efter commit', async () => {
    const { service, txMock, claimPaidWithinTx, notifyInvoicePaid, createJournalEntryForPayment } =
      makeService()

    const matched = await service.matchTransaction(OCR_TX as never, 'org-1')
    expect(matched).toBe(true)

    // Claim körs på tx-klienten med bank-payload
    expect(claimPaidWithinTx).toHaveBeenCalledTimes(1)
    const claimArgs = claimPaidWithinTx.mock.calls[0] as unknown[]
    expect(claimArgs[0]).toBe(txMock) // tx vidareskickad
    expect(claimArgs[1]).toBe('inv-1')
    expect(claimArgs[2]).toBe('org-1')

    // Bank-transaktionen länkas MATCHED till fakturan (XOR: rentNotice nollad)
    expect(txMock.bankTransaction.update).toHaveBeenCalledTimes(1)
    expect(txMock.bankTransaction.update.mock.calls[0]?.[0]).toMatchObject({
      data: { status: 'MATCHED', invoiceId: 'inv-1', matchedRentNoticeId: null },
    })

    // Verifikatet bokas ATOMISKT — tx är sista argumentet
    expect(createJournalEntryForPayment).toHaveBeenCalledTimes(1)
    expect((createJournalEntryForPayment.mock.calls[0] as unknown[])?.[4]).toBe(txMock)

    // Notis efter commit
    expect(notifyInvoicePaid).toHaveBeenCalledWith('org-1', 'inv-1', 'F-2026-0001')
  })

  it('atomicitet: verifikatet uteblir (null) → kastar, ingen fire-and-forget', async () => {
    const { service, notifyInvoicePaid } = makeService({ journalReturnsNull: true })

    await expect(service.matchTransaction(OCR_TX as never, 'org-1')).rejects.toThrow(
      /verifikat kunde inte skapas/i,
    )
    // Ingen "betald"-notis när matchningen rullades tillbaka
    expect(notifyInvoicePaid).not.toHaveBeenCalled()
  })

  it('redan reglerad faktura (claimed=false) → ingen bokning, ingen bank-länk, omatchad', async () => {
    const { service, txMock, createJournalEntryForPayment, notifyInvoicePaid } = makeService({
      claimed: false,
    })

    const matched = await service.matchTransaction(OCR_TX as never, 'org-1')
    expect(matched).toBe(false)
    expect(txMock.bankTransaction.update).not.toHaveBeenCalled()
    expect(createJournalEntryForPayment).not.toHaveBeenCalled()
    expect(notifyInvoicePaid).not.toHaveBeenCalled()
  })
})
