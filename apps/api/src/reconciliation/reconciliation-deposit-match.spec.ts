/**
 * #41 — bankmatchning av en DEPOSITIONS-avi.
 *
 * Bevisar:
 *   • FAIL-CLOSED: en DEPOSIT-avi UTAN länkad Deposit (orphan) matchas ALDRIG →
 *     ingen bokning (skydd mot 1930 D/1510 K på obokförd 1510 = F1-fällan).
 *   • MATCHAD: en DEPOSIT-avi MED länkad PENDING Deposit → 1930 D/1510 K bokförs,
 *     avin → PAID, Deposit → PAID (sanningskällan för återbetalning).
 *   • Delbelopp ≠ helt belopp → ingen match (deposition betalas i sin helhet).
 *   • computeRentDebt/kravtrappan rörs ALDRIG (DEPOSIT-grenen är fristående).
 */

jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Decimal } from '@prisma/client/runtime/library'
import { ReconciliationService } from './reconciliation.service'

function dec(n: number | string) {
  return new Decimal(n)
}

function makeService(opts: { linkedDeposit?: Record<string, unknown> | null }) {
  const txNotice = {
    id: 'rn-1',
    noticeNumber: 'AVI-2026-06-0002',
    status: 'SENT',
    collectionStage: 'NONE',
    type: 'DEPOSIT',
    totalAmount: dec('25000'),
    consumptionAmount: dec('0'),
    miscChargeAmount: dec('0'),
    reminderFeeAmount: dec('0'),
    interestAccruedAmount: dec('0'),
  }

  const txMock = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    rentNotice: {
      findFirst: jest.fn().mockResolvedValue(txNotice),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    rentNoticePayment: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'rnp-x' }),
    },
    deposit: {
      findFirst: jest.fn().mockResolvedValue(opts.linkedDeposit ?? null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    bankTransaction: { update: jest.fn().mockResolvedValue({}) },
  }

  const createJournalEntryForRentNoticePayment = jest.fn().mockResolvedValue({ id: 'je-dep' })

  const prisma = {
    bankTransaction: {
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
    rentNotice: {
      findFirst: jest.fn().mockResolvedValue({ id: 'rn-1' }), // OCR-kandidat
      findMany: jest.fn().mockResolvedValue([]),
    },
    invoice: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(txMock)),
  }
  const accounting = { createJournalEntryForRentNoticePayment }
  const events = { record: jest.fn().mockResolvedValue(undefined) }
  const service = new ReconciliationService(
    prisma as never,
    {} as never,
    events as never,
    accounting as never,
    {} as never,
  )
  return { service, txMock, createJournalEntryForRentNoticePayment }
}

const OCR_TX = (amount: number) => ({
  id: 'tx-1',
  rawOcr: '1234567890',
  amount: dec(amount),
  date: new Date('2026-06-15'),
  description: '',
  reference: '',
})

describe('#41 · DEPOSIT-avi utan länkad Deposit → FAIL-CLOSED (omatchbar)', () => {
  it('orphan-avi matchas inte, ingen bokning, ingen status-flip', async () => {
    const { service, txMock, createJournalEntryForRentNoticePayment } = makeService({
      linkedDeposit: null,
    })
    const matched = await service.matchTransaction(OCR_TX(25000) as never, 'org-1')
    expect(matched).toBe(false)
    expect(createJournalEntryForRentNoticePayment).not.toHaveBeenCalled()
    expect(txMock.rentNotice.updateMany).not.toHaveBeenCalled()
    expect(txMock.deposit.updateMany).not.toHaveBeenCalled()
  })
})

describe('#41 · DEPOSIT-avi med länkad PENDING Deposit → matchad + bokförd', () => {
  it('bokar 1930 D/1510 K, flippar avi→PAID och Deposit→PAID', async () => {
    const { service, txMock, createJournalEntryForRentNoticePayment } = makeService({
      linkedDeposit: { id: 'dep-1', status: 'PENDING' },
    })
    const matched = await service.matchTransaction(OCR_TX(25000) as never, 'org-1')
    expect(matched).toBe(true)

    // 1930 D/1510 K på hela beloppet, atomiskt (tx som 5:e arg).
    expect(createJournalEntryForRentNoticePayment).toHaveBeenCalledTimes(1)
    const jArgs = createJournalEntryForRentNoticePayment.mock.calls[0]!
    expect(new Decimal(jArgs[1].amount).toNumber()).toBe(25000)
    expect(jArgs[4]).toBe(txMock)

    // Avi → PAID.
    expect(txMock.rentNotice.updateMany.mock.calls[0]![0].data).toMatchObject({ status: 'PAID' })
    // Deposit → PAID (status-guardad).
    expect(txMock.deposit.updateMany).toHaveBeenCalledTimes(1)
    const depUpd = txMock.deposit.updateMany.mock.calls[0]![0]
    expect(depUpd.where).toMatchObject({ id: 'dep-1', status: 'PENDING' })
    expect(depUpd.data).toMatchObject({ status: 'PAID' })
  })

  it('redan PAID Deposit → omatchbar (idempotent)', async () => {
    const { service, createJournalEntryForRentNoticePayment } = makeService({
      linkedDeposit: { id: 'dep-1', status: 'PAID' },
    })
    const matched = await service.matchTransaction(OCR_TX(25000) as never, 'org-1')
    expect(matched).toBe(false)
    expect(createJournalEntryForRentNoticePayment).not.toHaveBeenCalled()
  })

  it('fel belopp (delbetalning) → ingen match (allt-eller-inget)', async () => {
    const { service, createJournalEntryForRentNoticePayment } = makeService({
      linkedDeposit: { id: 'dep-1', status: 'PENDING' },
    })
    const matched = await service.matchTransaction(OCR_TX(10000) as never, 'org-1')
    expect(matched).toBe(false)
    expect(createJournalEntryForRentNoticePayment).not.toHaveBeenCalled()
  })
})
