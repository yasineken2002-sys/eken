/**
 * T5 A1 (BFL 5:6) — createDepositInvoice (manuella deposit-vägen) skapar
 * Invoice + Deposit + verifikat ATOMISKT. Bevisar:
 *   • lyckad väg: accrual bokförs i SAMMA tx (7:e arg = tx),
 *   • bokförings-fel (kast) → HELA depositionen rullas tillbaka (create kastar),
 *   • accrual null (kontoplan saknar 1510/2890) → rollback (F1-fälle-skydd).
 */

jest.mock('../invoices/invoice-number', () => ({
  allocateInvoiceNumber: jest.fn().mockResolvedValue({ invoiceNumber: 'F-2026-0001', sequence: 1 }),
}))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { DepositsService } from './deposits.service'

function make(opts: { accrual?: 'ok' | 'null' | 'throw' } = {}) {
  const tx = {
    invoice: {
      create: jest.fn().mockResolvedValue({
        id: 'inv-1',
        invoiceNumber: 'F-2026-0001',
        total: 25000,
        issueDate: new Date('2026-06-01'),
      }),
    },
    deposit: { create: jest.fn().mockResolvedValue({ id: 'dep-1' }) },
    invoiceEvent: { create: jest.fn().mockResolvedValue({}) },
  }
  const prisma = {
    lease: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'lease-1',
        tenantId: 'ten-1',
        depositAmount: 25000,
        monthlyRent: 10000,
        unit: { type: 'APARTMENT' },
      }),
    },
    deposit: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: (cb: (t: unknown) => unknown) => cb(tx),
  }
  const createJournalEntryForDepositInvoice = jest.fn().mockImplementation(() => {
    if (opts.accrual === 'throw') return Promise.reject(new Error('stängd period'))
    if (opts.accrual === 'null') return Promise.resolve(null)
    return Promise.resolve({ id: 'je-accrual' })
  })
  const accounting = { createJournalEntryForDepositInvoice }
  const service = new DepositsService(prisma as never, accounting as never, {} as never)
  return { service, tx, accounting }
}

const DTO = { leaseId: 'lease-1', amount: 25000 } as never

describe('T5 A1 · createDepositInvoice — atomisk deposition + verifikat', () => {
  it('lyckad väg: accrual bokförs i SAMMA tx som Invoice+Deposit', async () => {
    const { service, tx, accounting } = make({ accrual: 'ok' })
    const dep = await service.create(DTO, 'org-1', 'user-1')

    expect(dep).toMatchObject({ id: 'dep-1' })
    expect(tx.invoice.create).toHaveBeenCalledTimes(1)
    expect(tx.deposit.create).toHaveBeenCalledTimes(1)
    // 7:e argumentet är tx → verifikatet skapas i samma transaktion.
    const args = accounting.createJournalEntryForDepositInvoice.mock.calls[0]!
    expect(args[0]).toBe('dep-1') // depositId
    expect(args[6]).toBe(tx) // tx vidareskickad
  })

  it('bokförings-fel (kast) rullar tillbaka hela depositionen', async () => {
    const { service } = make({ accrual: 'throw' })
    await expect(service.create(DTO, 'org-1', 'user-1')).rejects.toThrow('stängd period')
  })

  it('accrual null (saknad kontoplan) → rollback (F1-fälle-skydd, ingen obokförd deposition)', async () => {
    const { service } = make({ accrual: 'null' })
    await expect(service.create(DTO, 'org-1', 'user-1')).rejects.toThrow(/1510 eller 2890/)
  })
})
