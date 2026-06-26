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

function makeService(opts: {
  transaction?: unknown
  reverseThrows?: boolean
  remainingAllocations?: Array<{ amount: number }>
  noticeRow?: Record<string, unknown> | null
}) {
  const tx = {
    rentNotice: {
      // PR 3b — org-scopad updateMany (defense-in-depth), inte update på enbart id.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      // PR 3b — unmatch läser avins skuldkomponenter för att avgöra reopen + paidAmount.
      findFirst: jest.fn().mockResolvedValue(
        opts.noticeRow === undefined
          ? {
              type: 'RENT',
              status: 'PAID',
              totalAmount: 7_000,
              consumptionAmount: 0,
              miscChargeAmount: 0,
              reminderFeeAmount: 0,
              interestAccruedAmount: 0,
            }
          : opts.noticeRow,
      ),
    },
    bankTransaction: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    // Bankavstämnings-härdning PR 1/3b — allokeringen städas i samma transaktion;
    // findMany läser KVARVARANDE allokeringar för paidAmount-omräkningen.
    rentNoticePayment: {
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue(opts.remainingAllocations ?? []),
    },
  }
  const prisma = {
    bankTransaction: {
      findFirst: jest.fn().mockResolvedValue(opts.transaction),
      updateMany: tx.bankTransaction.updateMany,
    },
    rentNotice: { updateMany: tx.rentNotice.updateMany },
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
    {} as never, // PaymentFreshnessService — ej använd i unmatch-vägen
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

    // avi flippad SENT + nollställd (org-scopad updateMany)
    expect(tx.rentNotice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rn-1', organizationId: 'org-1' },
        data: { status: 'SENT', paidAt: null, paidAmount: null },
      }),
    )
    // reversering anropad MED transaktionsklienten (4:e argumentet) → atomiskt
    expect(reverseJournalEntryForPayment).toHaveBeenCalledTimes(1)
    expect(reverseJournalEntryForPayment).toHaveBeenCalledWith('tx-1', 'org-1', 'user-1', tx)

    // Bankavstämnings-härdning PR 1 — allokeringen raderas i SAMMA transaktion,
    // nycklad på bank-transaktionen (0 eller 1 rad).
    expect(tx.rentNoticePayment.deleteMany).toHaveBeenCalledWith({
      where: { bankTransactionId: 'tx-1' },
    })
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

// ── Bank-härdning PR 3b — granulär unmatch av en DELbetalning ───────────────────
describe('ReconciliationService.unmatchTransaction — partiell unmatch (PR 3b)', () => {
  it('avmatchar EN delbetalning på en fortfarande obetald avi → paidAmount = Σ kvarvarande, ingen reopen', async () => {
    // Avin är SENT (delbetald), en annan delbetalning på 5 000 finns kvar efter raderingen.
    const { service, tx, reverseJournalEntryForPayment } = makeService({
      transaction: {
        id: 'tx-part-2',
        status: 'MATCHED',
        invoice: null,
        matchedRentNotice: { id: 'rn-9', status: 'SENT' },
      },
      remainingAllocations: [{ amount: 5_000 }],
      noticeRow: {
        type: 'RENT',
        status: 'SENT',
        totalAmount: 8_000,
        consumptionAmount: 0,
        miscChargeAmount: 0,
        reminderFeeAmount: 0,
        interestAccruedAmount: 0,
      },
    })

    await service.unmatchTransaction('tx-part-2', 'org-1', 'user-1')

    // Bara denna transaktions allokering raderas (granulärt).
    expect(tx.rentNoticePayment.deleteMany).toHaveBeenCalledWith({
      where: { bankTransactionId: 'tx-part-2' },
    })
    // paidAmount räknas om till Σ KVARVARANDE (5 000), status rörs INTE (ej reopen).
    const upd = tx.rentNotice.updateMany.mock.calls[0]![0]
    expect(upd.where).toEqual({ id: 'rn-9', organizationId: 'org-1' })
    expect(Number(upd.data.paidAmount)).toBe(5_000)
    expect(upd.data.status).toBeUndefined()
    expect(upd.data.paidAt).toBeUndefined()
    expect(reverseJournalEntryForPayment).toHaveBeenCalledWith('tx-part-2', 'org-1', 'user-1', tx)
  })

  it('avmatchar SLUTbetalningen (avi PAID, prior delbetalning kvar) → reopen SENT + paidAmount = Σ kvarvarande', async () => {
    const { service, tx } = makeService({
      transaction: {
        id: 'tx-final',
        status: 'MATCHED',
        invoice: null,
        matchedRentNotice: { id: 'rn-10', status: 'PAID' },
      },
      remainingAllocations: [{ amount: 3_000 }],
      noticeRow: {
        type: 'RENT',
        status: 'PAID',
        totalAmount: 8_000,
        consumptionAmount: 0,
        miscChargeAmount: 0,
        reminderFeeAmount: 0,
        interestAccruedAmount: 0,
      },
    })

    await service.unmatchTransaction('tx-final', 'org-1', 'user-1')

    const upd = tx.rentNotice.updateMany.mock.calls[0]![0]
    // ocrOutstanding = 8 000 − 3 000 = 5 000 > 0 → PAID flippas tillbaka till SENT.
    expect(upd.data).toMatchObject({ status: 'SENT', paidAt: null })
    expect(Number(upd.data.paidAmount)).toBe(3_000)
  })
})
