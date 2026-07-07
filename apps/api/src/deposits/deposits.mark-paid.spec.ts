/**
 * Bokföringsfix #3 — deposition markPaid bokför inbetalningen.
 *
 * Tidigare satte markPaid bara Deposit.status + Invoice.status = PAID och skrev
 * ett event — inbetalningen bokfördes ALDRIG. Depositionens kundfordran (1510,
 * bokförd 1510 D / 2890 K vid create) stod kvar öppen trots betald deposition
 * (BFL 5 kap 6 §). markPaid ska nu boka likvidkonto D / 1510 K i samma tx, och
 * rulla tillbaka om verifikatet uteblir.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { DepositsService } from './deposits.service'

function makeService(opts: { invoiceStatus?: string; journalReturnsNull?: boolean } = {}) {
  const deposit = {
    id: 'dep-1',
    status: 'PENDING',
    amount: 20_000,
    invoiceId: 'inv-1',
    invoice: { id: 'inv-1', invoiceNumber: 'F-2026-0001', status: opts.invoiceStatus ?? 'DRAFT' },
  }

  const txMock = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    deposit: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirstOrThrow: jest.fn().mockResolvedValue({ ...deposit, status: 'PAID' }),
    },
    invoice: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'inv-1',
        status: opts.invoiceStatus ?? 'DRAFT',
        invoiceNumber: 'F-2026-0001',
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    invoiceEvent: { create: jest.fn().mockResolvedValue({}) },
  }

  const prisma = {
    deposit: { findFirst: jest.fn().mockResolvedValue(deposit) },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(txMock)),
  }

  const createJournalEntryForInvoiceManualPayment = jest.fn(() =>
    opts.journalReturnsNull ? Promise.resolve(null) : Promise.resolve({ id: 'je-pay-1' }),
  )
  const accounting = { createJournalEntryForInvoiceManualPayment }
  const notifications = { createForAllOrgUsers: jest.fn() }

  const service = new DepositsService(prisma as never, accounting as never, notifications as never)
  return { service, txMock, createJournalEntryForInvoiceManualPayment }
}

describe('DepositsService.markPaid — bokför inbetalningen', () => {
  it('bokför likvidkonto D / 1510 K i samma tx och sätter deposition + faktura PAID', async () => {
    const { service, txMock, createJournalEntryForInvoiceManualPayment } = makeService()

    await service.markPaid('dep-1', 'org-1', 'user-1')

    // Status-guardad deposition-claim
    expect(txMock.deposit.updateMany).toHaveBeenCalledTimes(1)
    expect(txMock.deposit.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'dep-1', status: 'PENDING' },
      data: { status: 'PAID' },
    })
    // Rad-lås på fakturan (serialiserar mot bankmatch)
    expect(txMock.$queryRaw).toHaveBeenCalledTimes(1)
    // Betalningsverifikat bokat ATOMISKT — tx sista argumentet, belopp = deposit.amount
    expect(createJournalEntryForInvoiceManualPayment).toHaveBeenCalledTimes(1)
    const args = createJournalEntryForInvoiceManualPayment.mock.calls[0] as unknown[]
    expect(args[1]).toBe(20_000)
    expect(args[3]).toBe('MANUAL')
    expect(args[6]).toBe(txMock)
  })

  it('rullar tillbaka (kastar) om verifikatet uteblir — ingen PAID utan verifikat', async () => {
    const { service } = makeService({ journalReturnsNull: true })
    await expect(service.markPaid('dep-1', 'org-1', 'user-1')).rejects.toThrow(
      /verifikat kunde inte skapas/i,
    )
  })

  it('dubbelbokför inte om fakturan redan reglerats av en bankmatch (status PAID)', async () => {
    const { service, txMock, createJournalEntryForInvoiceManualPayment } = makeService({
      invoiceStatus: 'PAID',
    })

    await service.markPaid('dep-1', 'org-1', 'user-1')

    // Depositionen markeras betald, men ingen ny bokning/statusskrivning på fakturan
    expect(txMock.deposit.updateMany).toHaveBeenCalledTimes(1)
    expect(createJournalEntryForInvoiceManualPayment).not.toHaveBeenCalled()
    expect(txMock.invoice.update).not.toHaveBeenCalled()
  })
})
