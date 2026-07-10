/**
 * T1.4 / #44 — bevis att en efterdebiterad (backfill) avi bokförs korrekt:
 * REAL AviseringService.createBackfillRentNoticeInTx + REAL AccountingService.
 * Verifierar faktiska verifikatrader (Σd = Σk), isBackfill-markören och den
 * framåtklampade förfallodagen. Mockar bara DB-ytan (tx) + verifikationsnummer.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { UnprocessableEntityException } from '@nestjs/common'
import { AviseringService } from './avisering.service'
import { AccountingService } from '../accounting/accounting.service'
import { backfillRentDueDate, BACKFILL_MIN_DAYS_UNTIL_DUE } from '@eken/shared'

type Line = { accountId: string; debit?: number; credit?: number; description: string }

function makeRig(opts: {
  unitType: 'APARTMENT' | 'OFFICE'
  voluntaryTaxLiability?: boolean
  monthlyRentExcludingVat?: boolean
  accounts: Array<{ id: string; number: number }>
}) {
  const journalCreates: Array<{ data: { date: Date; lines: { create: Line[] } } }> = []
  let noticeData: Record<string, unknown> | null = null

  const tx = {
    rentNotice: {
      findMany: jest.fn().mockResolvedValue([]), // nextNoticeNumber → serie 0001
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        noticeData = data
        return Promise.resolve({ id: 'rn-1', ...data })
      }),
    },
    account: { findMany: jest.fn().mockResolvedValue(opts.accounts) },
    lease: { findFirst: jest.fn().mockResolvedValue({ unit: { type: opts.unitType } }) },
    journalEntry: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((arg: { data: { date: Date; lines: { create: Line[] } } }) => {
          journalCreates.push(arg)
          return Promise.resolve({ id: 'je-1', ...arg })
        }),
    },
  }

  const verifikationsnummer = {
    allocate: jest.fn().mockResolvedValue({ series: 'A', verNumber: 1, fiscalYear: 2026 }),
  }
  const accounting = new AccountingService(tx as never, verifikationsnummer as never)
  const noop = {} as never
  const avisering = new AviseringService(
    tx as never, // prisma (createBackfillRentNoticeInTx tar tx explicit; prisma-ytan orörd)
    noop, // ocr
    noop, // mail
    noop, // pdf
    noop, // storage
    noop, // pdfQueue
    accounting as never,
    noop, // consumption
    noop, // miscCharges
    noop, // deposits
  )

  const lease = {
    id: 'lease-1',
    organizationId: 'org-1',
    tenantId: 'tenant-1',
    monthlyRent: 10_000,
    monthlyRentExcludingVat: opts.monthlyRentExcludingVat ?? false,
    startDate: new Date('2026-02-01'),
    endDate: null,
    unit: {
      type: opts.unitType,
      voluntaryTaxLiability: opts.voluntaryTaxLiability ?? false,
    },
  }

  return { avisering, tx, journalCreates, getNotice: () => noticeData, lease }
}

const sumD = (lines: Line[]) => lines.reduce((s, l) => s + (Number(l.debit) || 0), 0)
const sumK = (lines: Line[]) => lines.reduce((s, l) => s + (Number(l.credit) || 0), 0)

describe('T1.4 · backfill-avi bokförs balanserat (Σd = Σk)', () => {
  it('bostad (ingen moms): 1510 D 10000 / 3911 K 10000, isBackfill=true, framåt-förfallodag', async () => {
    const { avisering, tx, journalCreates, getNotice, lease } = makeRig({
      unitType: 'APARTMENT',
      accounts: [
        { id: 'acc-1510', number: 1510 },
        { id: 'acc-3911', number: 3911 },
      ],
    })
    const dueDate = backfillRentDueDate(new Date())
    const notice = await avisering.createBackfillRentNoticeInTx(tx as never, lease as never, {
      year: 2026,
      month: 2,
      ocrNumber: '1234567890',
      dueDate,
    })

    // Avin
    const nd = getNotice()!
    expect(nd.isBackfill).toBe(true)
    expect(nd.type).toBe('RENT')
    expect(nd.amount).toBe(10_000)
    expect(nd.dueDate).toBe(dueDate)
    // Framåtklampad: minst 30 dagar från idag (aldrig historiskt)
    const minDue = Date.now() + (BACKFILL_MIN_DAYS_UNTIL_DUE - 1) * 86_400_000
    expect((notice!.dueDate as Date).getTime()).toBeGreaterThanOrEqual(minDue)

    // Verifikatet
    const lines = journalCreates[0]!.data.lines.create
    const debit = lines.find((l) => l.debit != null)
    const credit = lines.find((l) => l.credit != null)
    expect(debit).toMatchObject({ accountId: 'acc-1510', debit: 10_000 })
    expect(credit).toMatchObject({ accountId: 'acc-3911', credit: 10_000 })
    expect(sumD(lines)).toBe(10_000)
    expect(sumD(lines)).toBe(sumK(lines))
    // Periodiserat till februari (period-månaden), inte skapandedatum
    expect(journalCreates[0]!.data.date.toISOString().slice(0, 7)).toBe('2026-02')
  })

  it('momspliktig lokal (exkl. moms): 1510 D 12500 / 3913 K 10000 / 2611 K 2500, balanserad', async () => {
    const { avisering, tx, journalCreates, getNotice, lease } = makeRig({
      unitType: 'OFFICE',
      voluntaryTaxLiability: true,
      monthlyRentExcludingVat: true,
      accounts: [
        { id: 'acc-1510', number: 1510 },
        { id: 'acc-3913', number: 3913 },
        { id: 'acc-2611', number: 2611 },
      ],
    })
    await avisering.createBackfillRentNoticeInTx(tx as never, lease as never, {
      year: 2026,
      month: 2,
      ocrNumber: '1234567890',
      dueDate: backfillRentDueDate(new Date()),
    })

    const nd = getNotice()!
    expect(nd.vatAmount).toBe(2_500)
    expect(nd.totalAmount).toBe(12_500)
    expect(nd.isBackfill).toBe(true)

    const lines = journalCreates[0]!.data.lines.create
    expect(lines.find((l) => l.accountId === 'acc-1510')).toMatchObject({ debit: 12_500 })
    expect(lines.find((l) => l.accountId === 'acc-3913')).toMatchObject({ credit: 10_000 })
    expect(lines.find((l) => l.accountId === 'acc-2611')).toMatchObject({ credit: 2_500 })
    expect(sumD(lines)).toBe(12_500)
    expect(sumD(lines)).toBe(sumK(lines))
  })

  // Bokförings-expert CRITICAL: i atomiskt läge (tx) MÅSTE saknat konto KASTA —
  // annars committar den yttre transaktionen avin utan verifikat (orphan-avi).
  it('saknat 1510/intäktskonto under tx → createBackfillRentNoticeInTx KASTAR (ingen orphan-avi)', async () => {
    const { avisering, tx, journalCreates, lease } = makeRig({
      unitType: 'APARTMENT',
      // 1510 saknas → verifikatet kan inte skapas.
      accounts: [{ id: 'acc-3911', number: 3911 }],
    })
    await expect(
      avisering.createBackfillRentNoticeInTx(tx as never, lease as never, {
        year: 2026,
        month: 2,
        ocrNumber: '1234567890',
        dueDate: backfillRentDueDate(new Date()),
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException)
    // Inget verifikat skapades → i en RIKTIG $transaction rullas även avin
    // tillbaka (mock:en saknar rollback, men kastet är beviset).
    expect(journalCreates).toHaveLength(0)
  })

  it('saknat momskonto (2611) under tx för momspliktig lokal → KASTAR', async () => {
    const { avisering, tx, lease } = makeRig({
      unitType: 'OFFICE',
      voluntaryTaxLiability: true,
      monthlyRentExcludingVat: true,
      accounts: [
        { id: 'acc-1510', number: 1510 },
        { id: 'acc-3913', number: 3913 },
        // 2611 saknas avsiktligt
      ],
    })
    await expect(
      avisering.createBackfillRentNoticeInTx(tx as never, lease as never, {
        year: 2026,
        month: 2,
        ocrNumber: '1234567890',
        dueDate: backfillRentDueDate(new Date()),
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException)
  })
})
