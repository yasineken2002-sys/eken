/**
 * Issue #33 (BFL 5 kap 5 §/9 §) — unmatchTransaction återställer status och
 * bokför motverifikat ATOMISKT.
 *
 * Verifierar att unmatchTransaction():
 *   • vid lyckad unmatch awaitar reverseJournalEntryForPayment INNE i en
 *     transaktion (samma tx skickas in) och återställer hyresavi-status
 *   • vid misslyckad reversering PROPAGERAR felet (tx rullar tillbaka) i
 *     stället för att tyst svälja det (gammalt fire-and-forget-beteende)
 *   • avvisar avmatchning av betald faktura (kreditnota krävs) och omatchade tx
 *   • är idempotent vid retry (reverseringen är idempotent i accounting-lagret)
 */

jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { BadRequestException, ForbiddenException } from '@nestjs/common'
import { ReconciliationService } from './reconciliation.service'

function makeService(opts: { transaction?: unknown; reverseThrows?: boolean }) {
  const tx = {
    rentNotice: { update: jest.fn().mockResolvedValue({}) },
    bankTransaction: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  }
  const prisma = {
    bankTransaction: {
      findFirst: jest.fn().mockResolvedValue(opts.transaction),
      updateMany: tx.bankTransaction.updateMany,
    },
    rentNotice: { update: tx.rentNotice.update },
    // Speglar Prisma $transaction: kör callbacken; kastar callbacken
    // propagerar felet (= rollback i verklig DB).
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
  }
  const reverseJournalEntryForPayment = jest.fn(
    opts.reverseThrows
      ? () => Promise.reject(new Error('Kontoplan saknas'))
      : () => Promise.resolve(),
  )
  const accounting = { reverseJournalEntryForPayment }
  const service = new ReconciliationService(
    prisma as never,
    {} as never,
    {} as never,
    accounting as never,
  )
  return { service, prisma, tx, reverseJournalEntryForPayment }
}

const MATCHED_RENT_TX = {
  id: 'tx-1',
  status: 'MATCHED',
  invoice: null,
  matchedRentNotice: { id: 'rn-1', status: 'PAID' },
}

describe('ReconciliationService.unmatchTransaction — atomisk reversering (#33)', () => {
  it('awaitar reverseringen inne i transaktionen och återställer avi-status', async () => {
    const { service, tx, reverseJournalEntryForPayment } = makeService({
      transaction: MATCHED_RENT_TX,
    })

    await service.unmatchTransaction('tx-1', 'org-1', 'user-1')

    // avi flippad SENT + nollställd
    expect(tx.rentNotice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rn-1' },
        data: { status: 'SENT', paidAt: null, paidAmount: null },
      }),
    )
    // reversering anropad MED transaktionsklienten (4:e argumentet) → atomiskt
    expect(reverseJournalEntryForPayment).toHaveBeenCalledTimes(1)
    expect(reverseJournalEntryForPayment).toHaveBeenCalledWith('tx-1', 'org-1', 'user-1', tx)
  })

  it('propagerar felet om reverseringen fallerar (rullar tillbaka, sväljer ej)', async () => {
    const { service } = makeService({ transaction: MATCHED_RENT_TX, reverseThrows: true })
    await expect(service.unmatchTransaction('tx-1', 'org-1', 'user-1')).rejects.toThrow(
      'Kontoplan saknas',
    )
  })

  it('avvisar avmatchning av betald faktura (kreditnota krävs)', async () => {
    const { service, reverseJournalEntryForPayment } = makeService({
      transaction: {
        id: 'tx-2',
        status: 'MATCHED',
        invoice: { status: 'PAID' },
        matchedRentNotice: null,
      },
    })
    await expect(service.unmatchTransaction('tx-2', 'org-1', 'user-1')).rejects.toBeInstanceOf(
      BadRequestException,
    )
    expect(reverseJournalEntryForPayment).not.toHaveBeenCalled()
  })

  it('avvisar omatchad transaktion', async () => {
    const { service } = makeService({
      transaction: { id: 'tx-3', status: 'UNMATCHED', invoice: null, matchedRentNotice: null },
    })
    await expect(service.unmatchTransaction('tx-3', 'org-1', 'user-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it('är idempotent vid retry — reversering anropas igen (idempotent i accounting)', async () => {
    const { service, reverseJournalEntryForPayment } = makeService({ transaction: MATCHED_RENT_TX })
    await service.unmatchTransaction('tx-1', 'org-1', 'user-1')
    await service.unmatchTransaction('tx-1', 'org-1', 'user-1')
    expect(reverseJournalEntryForPayment).toHaveBeenCalledTimes(2)
  })
})
