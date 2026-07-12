/**
 * T5 A1 (bokförings-expert HIGH) — createJournalEntryForInvoice ska INTE tyst
 * returnera null vid saknad kontoplan: den loggar alltid, och i ATOMISKT läge
 * (tx angiven) KASTAR den så fakturans transaktion rullas tillbaka (ingen
 * orphan-faktura). Symmetriskt med createJournalEntryForRentNotice.
 */

import { UnprocessableEntityException } from '@nestjs/common'
import { AccountingService } from './accounting.service'

const INVOICE = {
  id: 'inv-1',
  invoiceNumber: 'F-2026-0001',
  leaseId: null,
  subtotal: 1000,
  vatTotal: 0,
  total: 1000,
  issueDate: new Date('2026-06-01'),
  lines: [],
} as never

function makeService() {
  // Kontoplan SAKNAS helt → receivable/revenue-uppslag ger undefined.
  const prisma = { account: { findMany: jest.fn().mockResolvedValue([]) } }
  const service = new AccountingService(prisma as never, {} as never)
  return service
}

describe('AccountingService.createJournalEntryForInvoice — saknad kontoplan', () => {
  it('ATOMISKT läge (tx angiven) → KASTAR (rullar tillbaka fakturan)', async () => {
    const service = makeService()
    // tx läses via `db = tx ?? this.prisma` → måste ha account.findMany (tom → saknad kontoplan).
    const tx = { account: { findMany: jest.fn().mockResolvedValue([]) } } as never
    await expect(
      service.createJournalEntryForInvoice(INVOICE, 'org-1', 'user-1', tx),
    ).rejects.toBeInstanceOf(UnprocessableEntityException)
  })

  it('best-effort-läge (ingen tx) → returnerar null (oförändrat, men loggas)', async () => {
    const service = makeService()
    const result = await service.createJournalEntryForInvoice(INVOICE, 'org-1', 'user-1')
    expect(result).toBeNull()
  })
})
