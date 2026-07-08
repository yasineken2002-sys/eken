/**
 * #41 — deposition-livscykel: create-sida (Deposit-rad + 1510 D/2890 K) + backfill
 * + manuell betalväg (T2.2) för avi-länkade depositioner.
 *
 * Bevisar:
 *   • ensureDepositForNotice skapar Deposit{PENDING, rentNoticeId} OCH bokför
 *     1510 D/2890 K ATOMISKT; idempotent (hoppar om Deposit finns); kastar om
 *     accrual-verifikatet uteblir (Deposit skapas ALDRIG utan bokförd 1510).
 *   • markPaid BOKFÖR en avi-länkad deposition (1930 D/1510 K, manuell) + flippar
 *     avin; kastar om verifikatet uteblir (ingen PAID utan bokföring).
 *   • backfillOrphanDepositNotices sveper orphan-avier via ensureDepositForNotice.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { InternalServerErrorException } from '@nestjs/common'
import { DepositsService } from './deposits.service'

function make(opts: { existingDeposit?: unknown; accrualReturnsNull?: boolean } = {}) {
  const txDeposit = { create: jest.fn().mockResolvedValue({ id: 'dep-new' }) }
  const prisma = {
    deposit: {
      findUnique: jest.fn().mockResolvedValue(opts.existingDeposit ?? null),
      findFirst: jest.fn(),
    },
    rentNotice: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb({ deposit: txDeposit })),
  }
  const accounting = {
    createJournalEntryForDepositInvoice: jest
      .fn()
      .mockResolvedValue(opts.accrualReturnsNull ? null : { id: 'je-accrual' }),
  }
  const service = new DepositsService(prisma as never, accounting as never, {} as never)
  return { service, prisma, txDeposit, accounting }
}

const NOTICE = {
  organizationId: 'org-1',
  leaseId: 'lease-1',
  tenantId: 'ten-1',
  rentNoticeId: 'rn-dep-1',
  noticeNumber: 'AVI-2026-06-0002',
  amount: 25000,
  date: new Date('2026-06-01'),
}

describe('#41 · ensureDepositForNotice — Deposit + 1510 D/2890 K atomiskt', () => {
  it('skapar Deposit{PENDING, rentNoticeId} och bokför accrual', async () => {
    const { service, txDeposit, accounting } = make()
    const r = await service.ensureDepositForNotice(NOTICE)

    expect(r).toEqual({ created: true })
    const data = txDeposit.create.mock.calls[0]![0].data
    expect(data).toMatchObject({
      leaseId: 'lease-1',
      rentNoticeId: 'rn-dep-1',
      status: 'PENDING',
      amount: 25000,
    })
    // Accrual bokförs i SAMMA tx (7:e arg = tx vidareskickad).
    expect(accounting.createJournalEntryForDepositInvoice).toHaveBeenCalledTimes(1)
    const args = accounting.createJournalEntryForDepositInvoice.mock.calls[0]!
    expect(args[0]).toBe('dep-new') // depositId
    expect(args[2]).toBe(25000) // amount
    expect(args[6]).toBeDefined() // tx
  })

  it('idempotent: befintlig Deposit → hoppar, ingen ny rad/bokföring', async () => {
    const { service, txDeposit, accounting } = make({ existingDeposit: { id: 'dep-existing' } })
    const r = await service.ensureDepositForNotice(NOTICE)
    expect(r).toEqual({ created: false })
    expect(txDeposit.create).not.toHaveBeenCalled()
    expect(accounting.createJournalEntryForDepositInvoice).not.toHaveBeenCalled()
  })

  it('accrual-verifikat null (saknad kontoplan) → KASTAR (Deposit skapas ej)', async () => {
    const { service } = make({ accrualReturnsNull: true })
    await expect(service.ensureDepositForNotice(NOTICE)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    )
  })

  it('belopp ≤ 0 → no-op', async () => {
    const { service, txDeposit } = make()
    const r = await service.ensureDepositForNotice({ ...NOTICE, amount: 0 })
    expect(r).toEqual({ created: false })
    expect(txDeposit.create).not.toHaveBeenCalled()
  })
})

describe('#41/T2.2 · markPaid bokför avi-länkad deposition (1930 D/1510 K)', () => {
  function makeMarkPaid(opts: { manualReturnsNull?: boolean } = {}) {
    const txMock = {
      deposit: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'dep-1', status: 'PAID' }),
      },
      rentNotice: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    }
    const prisma = {
      deposit: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'dep-1',
          organizationId: 'org-1',
          status: 'PENDING',
          invoiceId: null,
          rentNoticeId: 'rn-1',
          amount: 15000,
          lease: {},
          tenant: {},
          invoice: null,
        }),
      },
      $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(txMock)),
    }
    const accounting = {
      createJournalEntryForDepositManualPayment: jest
        .fn()
        .mockResolvedValue(opts.manualReturnsNull ? null : { id: 'je-manual' }),
    }
    const service = new DepositsService(prisma as never, accounting as never, {} as never)
    return { service, txMock, accounting }
  }

  it('avi-länkad → bokför 1930 D/1510 K (manuell) + flippar länkad avi → PAID', async () => {
    const { service, txMock, accounting } = makeMarkPaid()
    await service.markPaid('dep-1', 'org-1', 'user-1')

    expect(accounting.createJournalEntryForDepositManualPayment).toHaveBeenCalledTimes(1)
    const args = accounting.createJournalEntryForDepositManualPayment.mock.calls[0]!
    expect(args[0]).toBe('dep-1') // depositId
    expect(args[2]).toBe(15000) // amount
    expect(args[6]).toBeDefined() // tx (atomiskt)
    // Deposit-status-claim (PENDING→PAID) + länkad avi → PAID.
    expect(txMock.deposit.updateMany.mock.calls[0]![0].data).toMatchObject({ status: 'PAID' })
    expect(txMock.rentNotice.updateMany.mock.calls[0]![0].data).toMatchObject({ status: 'PAID' })
  })

  it('manual-verifikat null (saknad kontoplan) → KASTAR (ingen PAID utan verifikat)', async () => {
    const { service } = makeMarkPaid({ manualReturnsNull: true })
    await expect(service.markPaid('dep-1', 'org-1', 'user-1')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    )
  })
})

describe('#41 · backfillOrphanDepositNotices', () => {
  it('sveper orphan-avier via ensureDepositForNotice', async () => {
    const { service, prisma } = make()
    prisma.rentNotice.findMany.mockResolvedValue([
      {
        id: 'rn-1',
        organizationId: 'org-1',
        leaseId: 'lease-1',
        tenantId: 'ten-1',
        noticeNumber: 'AVI-1',
        totalAmount: 12000,
        createdAt: new Date('2026-05-01'),
      },
      {
        id: 'rn-2',
        organizationId: 'org-1',
        leaseId: 'lease-2',
        tenantId: 'ten-2',
        noticeNumber: 'AVI-2',
        totalAmount: 8000,
        createdAt: new Date('2026-05-02'),
      },
    ])
    const spy = jest.spyOn(service, 'ensureDepositForNotice').mockResolvedValue({ created: true })

    const r = await service.backfillOrphanDepositNotices()
    expect(r).toEqual({ scanned: 2, created: 2 })
    expect(spy).toHaveBeenCalledTimes(2)
    // Filtrerar på DEPOSIT-avier utan länkad Deposit (fail-closed-källan).
    expect(prisma.rentNotice.findMany.mock.calls[0]![0].where).toMatchObject({
      type: 'DEPOSIT',
      deposit: { is: null },
    })
  })
})
