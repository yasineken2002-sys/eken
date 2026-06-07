/**
 * Bankavstämnings-härdning PR 1 — KATEGORI C: dual-write i reconciliation.
 *
 * Verifierar att en RentNoticePayment-allokering skrivs ADDITIVT bredvid varje
 * befintlig betalning, i SAMMA transaktion, UTAN att röra matchningslogik eller
 * bokföring:
 *   • applyMatchToRentNotice (via manualMatch) → BANK_RECONCILIATION-allokering.
 *   • fuzzy-match (via matchTransaction) → BANK_RECONCILIATION-allokering.
 *   • verifikatet (createJournalEntryForRentNoticePayment) anropas FORTFARANDE
 *     exakt en gång — allokeringen lägger INTE till någon huvudbokspost.
 */

jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Decimal } from '@prisma/client/runtime/library'
import { ReconciliationService } from './reconciliation.service'

function makeService(opts: {
  transaction: Record<string, unknown>
  notice?: Record<string, unknown> | null
  fuzzyNotices?: Array<Record<string, unknown>>
}) {
  const rentNoticePaymentCreate = jest.fn().mockResolvedValue({ id: 'rnp-1' })
  const createJournalEntryForRentNoticePayment = jest.fn().mockResolvedValue({ id: 'je-1' })

  const prisma = {
    bankTransaction: {
      findFirst: jest.fn().mockResolvedValue(opts.transaction),
      update: jest.fn().mockResolvedValue({}),
    },
    rentNotice: {
      findFirst: jest.fn().mockResolvedValue(opts.notice ?? null),
      findUnique: jest.fn().mockResolvedValue(
        opts.notice
          ? {
              id: opts.notice.id,
              noticeNumber: opts.notice.noticeNumber,
              organizationId: 'org-1',
              status: opts.notice.status,
            }
          : null,
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue(opts.fuzzyNotices ?? []),
    },
    invoice: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    rentNoticePayment: { create: rentNoticePaymentCreate },
  }

  const accounting = { createJournalEntryForRentNoticePayment }
  const events = { record: jest.fn().mockResolvedValue(undefined) }

  const service = new ReconciliationService(
    prisma as never,
    {} as never, // invoices
    events as never,
    accounting as never,
  )
  return { service, prisma, rentNoticePaymentCreate, createJournalEntryForRentNoticePayment }
}

describe('PR1 · C — dual-write: applyMatchToRentNotice (manualMatch)', () => {
  it('skriver en BANK_RECONCILIATION-allokering bredvid betalningen', async () => {
    const { service, rentNoticePaymentCreate, createJournalEntryForRentNoticePayment } =
      makeService({
        transaction: { id: 'tx-1', date: new Date('2026-06-15'), organizationId: 'org-1' },
        notice: {
          id: 'rn-1',
          noticeNumber: 'AVI-2026-06-0001',
          status: 'SENT',
          totalAmount: new Decimal('7000'),
          consumptionAmount: new Decimal('240'),
          reminderFeeAmount: new Decimal('60'),
        },
      })

    await service.manualMatch('tx-1', { rentNoticeId: 'rn-1' }, 'org-1', 'user-1')

    expect(rentNoticePaymentCreate).toHaveBeenCalledTimes(1)
    const data = rentNoticePaymentCreate.mock.calls[0][0].data
    expect(data).toMatchObject({
      rentNoticeId: 'rn-1',
      bankTransactionId: 'tx-1',
      source: 'BANK_RECONCILIATION',
    })
    // betalbar total = 7000 + 240 + 60 = 7300
    expect(new Decimal(data.amount).toNumber()).toBe(7_300)
    expect((data.paidAt as Date).toISOString().slice(0, 10)).toBe('2026-06-15')

    // PENGANEUTRAL: verifikatet skapas FORTFARANDE exakt en gång (ingen extra post).
    expect(createJournalEntryForRentNoticePayment).toHaveBeenCalledTimes(1)
  })
})

describe('PR1 · C — dual-write: fuzzy-match (matchTransaction)', () => {
  it('skriver en BANK_RECONCILIATION-allokering för fuzzy-träffen', async () => {
    const { service, rentNoticePaymentCreate, createJournalEntryForRentNoticePayment } =
      makeService({
        transaction: {
          id: 'tx-2',
          date: new Date('2026-06-20'),
          amount: new Decimal('7300'),
          rawOcr: null,
          description: '',
          reference: '',
        },
        fuzzyNotices: [
          {
            id: 'rn-2',
            noticeNumber: 'AVI-2026-06-0002',
            status: 'SENT',
            totalAmount: new Decimal('7000'),
            consumptionAmount: new Decimal('240'),
            reminderFeeAmount: new Decimal('60'),
          },
        ],
      })

    const matched = await service.matchTransaction(
      {
        id: 'tx-2',
        date: new Date('2026-06-20'),
        amount: new Decimal('7300'),
        rawOcr: null,
        description: '',
        reference: '',
      } as never,
      'org-1',
    )

    expect(matched).toBe(true)
    expect(rentNoticePaymentCreate).toHaveBeenCalledTimes(1)
    const data = rentNoticePaymentCreate.mock.calls[0][0].data
    expect(data).toMatchObject({
      rentNoticeId: 'rn-2',
      bankTransactionId: 'tx-2',
      source: 'BANK_RECONCILIATION',
    })
    expect(new Decimal(data.amount).toNumber()).toBe(7_300)
    expect(createJournalEntryForRentNoticePayment).toHaveBeenCalledTimes(1)
  })
})
