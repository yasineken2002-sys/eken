/**
 * C4 — PARTIELL BANKMATCHNING MOT FAKTURA.
 *
 * `applyMatchToInvoice` skickade tidigare `invoice.total` som transaktions-
 * belopp till bokföringen, oavsett vad som faktiskt kommit in på kontot. En
 * manuell matchning av en inbetalning på 3 000 kr mot en faktura på 10 000 kr
 * debiterade 1930 med 10 000 kr — bankkontot i huvudboken divergerade från
 * kontoutdraget, och fakturan flippades till PAID med 7 000 kr obetalt.
 *
 * Den befintliga sviten (reconciliation-invoice-match.spec.ts) kunde aldrig
 * fånga det: den använder OCR_TX.amount = INVOICE.total = 1250, så beloppen
 * sammanfaller. Här skiljer de sig.
 */

jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Decimal } from '@prisma/client/runtime/library'
import { ReconciliationService } from './reconciliation.service'

const dec = (n: number | string) => new Decimal(n)
const INVOICE = { id: 'inv-1', invoiceNumber: 'F-2026-0001', total: dec('10000') }

function makeService(opts: { priorAllocations?: number[] } = {}) {
  const priors = opts.priorAllocations ?? []
  const txMock = {
    bankTransaction: { update: jest.fn().mockResolvedValue({}) },
    deposit: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    invoicePayment: {
      findMany: jest.fn().mockResolvedValue(priors.map((a) => ({ amount: dec(a) }))),
      create: jest.fn().mockResolvedValue({}),
    },
    invoice: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirstOrThrow: jest.fn().mockResolvedValue({ invoiceNumber: INVOICE.invoiceNumber }),
    },
  }

  const claimPaidWithinTx = jest
    .fn()
    .mockResolvedValue({ claimed: true, invoiceNumber: INVOICE.invoiceNumber })
  const notifyInvoicePaid = jest.fn()
  const createJournalEntryForPayment = jest.fn().mockResolvedValue({ id: 'je-1' })

  const prisma = {
    bankTransaction: { findFirst: jest.fn().mockResolvedValue(null) },
    invoice: { findFirst: jest.fn().mockResolvedValue(INVOICE) },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(txMock)),
  }

  const service = new ReconciliationService(
    prisma as never,
    { claimPaidWithinTx, notifyInvoicePaid } as never,
    { record: jest.fn().mockResolvedValue(undefined) } as never,
    { createJournalEntryForPayment } as never,
    {} as never,
  )
  return { service, txMock, claimPaidWithinTx, notifyInvoicePaid, createJournalEntryForPayment }
}

/** Anropar den privata matchningen direkt med ett valfritt transaktionsbelopp. */
const applyMatch = (
  service: ReconciliationService,
  amount: Decimal,
  allowPartial = true,
): Promise<boolean> =>
  (
    service as unknown as {
      applyMatchToInvoice: (...a: unknown[]) => Promise<boolean>
    }
  ).applyMatchToInvoice(
    'tx-1',
    INVOICE.id,
    'org-1',
    INVOICE.total,
    amount,
    new Date('2026-06-15'),
    'user-1',
    null,
    allowPartial,
  )

/** Beloppet som gick till bokföringen (arg 1 = transaktionsobjektet). */
const bookedAmount = (fn: jest.Mock): number =>
  Number((fn.mock.calls[0] as Array<{ amount: Decimal }>)[1]!.amount)

describe('C4 — bankmatchning bokför transaktionsbeloppet, inte fakturans total', () => {
  it('delbetalning 3 000 mot 10 000 → bokför 3 000, status PARTIAL', async () => {
    const { service, txMock, createJournalEntryForPayment, claimPaidWithinTx, notifyInvoicePaid } =
      makeService()

    const matched = await applyMatch(service, dec('3000'))
    expect(matched).toBe(true)

    // DET HÄR fäller den gamla koden: 3 000, inte 10 000.
    expect(bookedAmount(createJournalEntryForPayment)).toBe(3_000)

    // Delbetalning går INTE via PAID-claimen.
    expect(claimPaidWithinTx).not.toHaveBeenCalled()
    expect(txMock.invoice.updateMany.mock.calls[0]?.[0]).toMatchObject({
      data: { status: 'PARTIAL' },
    })

    // Allokeringen bär det faktiska beloppet och banktransaktionen.
    const alloc = txMock.invoicePayment.create.mock.calls[0]?.[0]?.data
    expect(Number(alloc.amount)).toBe(3_000)
    expect(alloc.bankTransactionId).toBe('tx-1')
    expect(alloc.source).toBe('BANK_RECONCILIATION')

    // Ingen "betald"-notis för en delbetalning.
    expect(notifyInvoicePaid).not.toHaveBeenCalled()
    // Depositionssynk sker bara vid full reglering.
    expect(txMock.deposit.updateMany).not.toHaveBeenCalled()
  })

  it('andra inbetalningen slutför → PAID via claimPaidWithinTx, notis skickas', async () => {
    const { service, claimPaidWithinTx, createJournalEntryForPayment, notifyInvoicePaid } =
      makeService({ priorAllocations: [3_000] })

    await applyMatch(service, dec('7000'))

    expect(bookedAmount(createJournalEntryForPayment)).toBe(7_000)
    expect(claimPaidWithinTx).toHaveBeenCalledTimes(1)
    expect(notifyInvoicePaid).toHaveBeenCalledWith('org-1', 'inv-1', 'F-2026-0001')
  })

  it('full reglering i ett svep bokför hela beloppet', async () => {
    const { service, createJournalEntryForPayment, claimPaidWithinTx } = makeService()
    await applyMatch(service, dec('10000'))
    expect(bookedAmount(createJournalEntryForPayment)).toBe(10_000)
    expect(claimPaidWithinTx).toHaveBeenCalledTimes(1)
  })
})

describe('C4 — gränsfall', () => {
  it('inom 1 kr-toleransen räknas som FULL reglering (allokerar restskulden)', async () => {
    const { service, createJournalEntryForPayment, claimPaidWithinTx } = makeService()
    await applyMatch(service, dec('9999.50'))
    // Hela restskulden allokeras, inte det inbetalda beloppet — annars hade
    // 50 öre blivit en skuld som aldrig regleras.
    expect(bookedAmount(createJournalEntryForPayment)).toBe(10_000)
    expect(claimPaidWithinTx).toHaveBeenCalledTimes(1)
  })

  it('allowPartial=false (automatmatchning) avvisar ett delbelopp', async () => {
    const { service, createJournalEntryForPayment, txMock } = makeService()
    const matched = await applyMatch(service, dec('3000'), false)
    expect(matched).toBe(false)
    expect(createJournalEntryForPayment).not.toHaveBeenCalled()
    expect(txMock.invoicePayment.create).not.toHaveBeenCalled()
  })

  it('ÖVERBETALNING avvisas — ingen bokning, ingen allokering', async () => {
    const { service, createJournalEntryForPayment, txMock } = makeService()
    const matched = await applyMatch(service, dec('12000'))
    expect(matched).toBe(false)
    expect(createJournalEntryForPayment).not.toHaveBeenCalled()
    expect(txMock.invoicePayment.create).not.toHaveBeenCalled()
  })

  it('redan fullt reglerad faktura → ingen ny bokning', async () => {
    const { service, createJournalEntryForPayment } = makeService({ priorAllocations: [10_000] })
    const matched = await applyMatch(service, dec('500'))
    expect(matched).toBe(false)
    expect(createJournalEntryForPayment).not.toHaveBeenCalled()
  })
})
