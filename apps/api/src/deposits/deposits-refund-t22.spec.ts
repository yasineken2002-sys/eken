/**
 * T2.2 — deposition-återbetalning: atomicitet (#25) + borttagen 3040→1510-fallback
 * (#56) + manuell betalnings-kontering.
 *
 * Bevisar:
 *   • createJournalEntryForDepositRefund: full återbetalning 2890 D / 1930 K
 *     (Σd=Σk); skadeavdrag → 3040 K; SAKNAT konto 3040 med avdrag → null (INGEN
 *     tyst 1510-fallback).
 *   • createJournalEntryForDepositManualPayment: 1930 D / 1510 K (Σd=Σk).
 *   • refund() är ATOMISK: null-verifikat → kastar (ingen REFUNDED utan reverserad skuld).
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { ConflictException, InternalServerErrorException } from '@nestjs/common'
import { AccountingService } from '../accounting/accounting.service'
import { DepositsService } from './deposits.service'

// ── Accounting-lagret ──────────────────────────────────────────────────────────
describe('T2.2 · createJournalEntryForDepositRefund — 2890 D / 1930 K, ingen 1510-fallback', () => {
  function makeAcc(accountNumbers: number[]) {
    const accounts = accountNumbers.map((n) => ({ id: `acc-${n}`, number: n }))
    let created: { data: { lines: { create: Array<Record<string, unknown>> } } } | null = null
    const prisma = {
      journalEntry: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation((arg: typeof created) => {
          created = arg
          return Promise.resolve({ id: 'je-1', ...arg })
        }),
      },
      account: { findMany: jest.fn().mockResolvedValue(accounts) },
    }
    ;(prisma as unknown as { $transaction: unknown }).$transaction = (
      cb: (t: unknown) => unknown,
    ) => cb(prisma)
    const ver = {
      allocate: jest.fn().mockResolvedValue({ series: 'A', verNumber: 1, fiscalYear: 2026 }),
    }
    const service = new AccountingService(prisma as never, ver as never)
    return { service, getLines: () => created?.data.lines.create ?? [] }
  }

  it('full återbetalning (inga avdrag): 2890 D 15000 / 1930 K 15000, balanserat', async () => {
    const { service, getLines } = makeAcc([2890, 1930, 3040])
    await service.createJournalEntryForDepositRefund('dep-1', 'org-1', 15000, 0, new Date(), null)
    const lines = getLines()
    const d = lines.reduce((s, l) => s + Number(l.debit ?? 0), 0)
    const k = lines.reduce((s, l) => s + Number(l.credit ?? 0), 0)
    expect(d).toBe(15000)
    expect(k).toBe(15000)
    expect(lines.find((l) => l.debit != null)?.accountId).toBe('acc-2890')
    expect(lines.find((l) => l.credit != null)?.accountId).toBe('acc-1930')
  })

  it('skadeavdrag med 3040 present: 2890 D / (1930 K + 3040 K), balanserat', async () => {
    const { service, getLines } = makeAcc([2890, 1930, 3040])
    await service.createJournalEntryForDepositRefund(
      'dep-1',
      'org-1',
      10000,
      5000,
      new Date(),
      null,
    )
    const lines = getLines()
    expect(lines.reduce((s, l) => s + Number(l.debit ?? 0), 0)).toBe(15000)
    expect(lines.reduce((s, l) => s + Number(l.credit ?? 0), 0)).toBe(15000)
    expect(lines.some((l) => l.accountId === 'acc-3040' && l.credit === 5000)).toBe(true)
    // ALDRIG 1510 (den borttagna fallbacken).
    expect(lines.some((l) => l.accountId === 'acc-1510')).toBe(false)
  })

  it('avdrag men SAKNAT konto 3040 → null (INGEN tyst 1510-fallback)', async () => {
    const { service } = makeAcc([2890, 1930, 1510]) // 3040 saknas, 1510 finns
    const res = await service.createJournalEntryForDepositRefund(
      'dep-1',
      'org-1',
      10000,
      5000,
      new Date(),
      null,
    )
    expect(res).toBeNull() // → refund() kastar
  })
})

describe('T2.2 · createJournalEntryForDepositManualPayment — 1930 D / 1510 K', () => {
  it('debiterar likvidkonto (1930) och krediterar 1510, balanserat', async () => {
    const accounts = [
      { id: 'acc-1930', number: 1930 },
      { id: 'acc-1510', number: 1510 },
    ]
    type Created = { data: { lines: { create: Array<Record<string, unknown>> } } }
    let created: Created | null = null
    const prisma = {
      journalEntry: {
        // A2b: guarden slår upp depositionens accrual (source='INVOICE',
        // 'deposit-invoice:<id>') → finns; PAYMENT-idempotens → null (skapar nytt).
        findFirst: jest
          .fn()
          .mockImplementation((args: { where?: { source?: string } }) =>
            Promise.resolve(args?.where?.source === 'INVOICE' ? { id: 'accrual' } : null),
          ),
        create: jest.fn().mockImplementation((arg: Created) => {
          created = arg
          return Promise.resolve({ id: 'je-1', ...arg })
        }),
      },
      account: { findMany: jest.fn().mockResolvedValue(accounts) },
    }
    ;(prisma as unknown as { $transaction: unknown }).$transaction = (
      cb: (t: unknown) => unknown,
    ) => cb(prisma)
    const ver = {
      allocate: jest.fn().mockResolvedValue({ series: 'A', verNumber: 1, fiscalYear: 2026 }),
    }
    const service = new AccountingService(prisma as never, ver as never)
    await service.createJournalEntryForDepositManualPayment(
      'dep-1',
      'org-1',
      15000,
      new Date(),
      'MANUAL',
      null,
    )
    const lines: Array<Record<string, unknown>> =
      (created as Created | null)?.data.lines.create ?? []
    expect(lines.find((l) => l.debit != null)?.accountId).toBe('acc-1930')
    expect(lines.find((l) => l.credit != null)?.accountId).toBe('acc-1510')
    expect(lines.reduce((s, l) => s + Number(l.debit ?? 0), 0)).toBe(15000)
    expect(lines.reduce((s, l) => s + Number(l.credit ?? 0), 0)).toBe(15000)
  })
})

// ── refund() atomicitet + status-gardad claim ──────────────────────────────────
describe('T2.2 · refund() är atomisk (#25) + race-säker claim', () => {
  function makeRefund(opts: { entryReturnsNull?: boolean; claimCount?: number }) {
    const txMock = {
      deposit: {
        updateMany: jest.fn().mockResolvedValue({ count: opts.claimCount ?? 1 }),
        findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'dep-1', status: 'REFUNDED' }),
      },
    }
    const prisma = {
      deposit: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'dep-1',
          organizationId: 'org-1',
          status: 'PAID',
          amount: 15000,
          lease: {},
          tenant: {},
          invoice: null,
        }),
      },
      $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(txMock)),
    }
    const accounting = {
      createJournalEntryForDepositRefund: jest
        .fn()
        .mockResolvedValue(opts.entryReturnsNull ? null : { id: 'je-refund' }),
    }
    const service = new DepositsService(prisma as never, accounting as never, {} as never)
    return { service, txMock, accounting }
  }

  it('null-verifikat (t.ex. saknat 3040) → KASTAR, hela återbetalningen rullas tillbaka', async () => {
    const { service } = makeRefund({ entryReturnsNull: true })
    await expect(
      service.refund(
        'dep-1',
        { refundAmount: 10000, deductions: [{ reason: 'skada', amount: 5000 }] } as never,
        'org-1',
        'user-1',
      ),
    ).rejects.toBeInstanceOf(InternalServerErrorException)
  })

  it('lyckad återbetalning: verifikatet bokas i SAMMA tx (7:e arg)', async () => {
    const { service, accounting } = makeRefund({})
    await service.refund(
      'dep-1',
      { refundAmount: 15000, deductions: [] } as never,
      'org-1',
      'user-1',
    )
    expect(accounting.createJournalEntryForDepositRefund).toHaveBeenCalledTimes(1)
    expect(accounting.createJournalEntryForDepositRefund.mock.calls[0]![6]).toBeDefined() // tx
  })

  it('status-gardad claim: samtidig andra refund (count=0) → Conflict, INGEN bokning', async () => {
    const { service, accounting } = makeRefund({ claimCount: 0 })
    await expect(
      service.refund('dep-1', { refundAmount: 15000, deductions: [] } as never, 'org-1', 'user-1'),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(accounting.createJournalEntryForDepositRefund).not.toHaveBeenCalled()
  })
})

// ── #73 catch-up sweep ─────────────────────────────────────────────────────────
describe('#73 · sweepTerminatedLeasesForRefundPending (självläkning)', () => {
  it('flaggar PAID-depositioner på TERMINATED-kontrakt → REFUND_PENDING (idempotent)', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 3 })
    const prisma = { deposit: { updateMany } }
    const service = new DepositsService(prisma as never, {} as never, {} as never)
    const n = await service.sweepTerminatedLeasesForRefundPending()
    expect(n).toBe(3)
    expect(updateMany.mock.calls[0]![0]).toMatchObject({
      where: { status: 'PAID', lease: { status: 'TERMINATED' } },
      data: { status: 'REFUND_PENDING' },
    })
  })
})
