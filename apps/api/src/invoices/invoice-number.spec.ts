/**
 * Delad fakturanummer-allokering — enda källan för både InvoicesService och
 * DepositsService (tidigare divergerade deposits med count()+1 → kollision).
 */

import { allocateInvoiceNumber } from './invoice-number'

function txWith(lastNumber: number) {
  return {
    invoiceNumberSequence: {
      upsert: jest.fn().mockResolvedValue({ lastNumber }),
    },
  }
}

describe('allocateInvoiceNumber', () => {
  it('formaterar F-<år>-<nr> (4 siffror) och returnerar sekvensen', async () => {
    const out = await allocateInvoiceNumber(txWith(7) as never, 'org-1', 2026)
    expect(out).toEqual({ invoiceNumber: 'F-2026-0007', sequence: 7 })
  })

  it('använder atomisk upsert med increment (race-säker, gap-fri)', async () => {
    const tx = txWith(1)
    await allocateInvoiceNumber(tx as never, 'org-1', 2026)
    expect(tx.invoiceNumberSequence.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-1' },
        update: { lastNumber: { increment: 1 } },
      }),
    )
  })
})
