/**
 * Finansiella rapporter — getVatReport / getProfitLossReport / getBalanceSheet.
 *
 * Dessa beräkningar exponeras både som REST-endpoints (AccountingController)
 * och via AI-verktygen (tool-executor) — EN sanningskälla. Testerna låser
 * teckenkonventionerna (debet/kredit per kontoklass) så de inte glider.
 */

import { BadRequestException } from '@nestjs/common'
import { AccountingController } from './accounting.controller'
import { AccountingService } from './accounting.service'

type Line = {
  debit: number | null
  credit: number | null
  account: { number: number; name: string }
}

function makeService(opts?: {
  lines?: Line[]
  vatAccounts?: Array<{ id: string; number: number }>
  vatSums?: Record<number, { debit: number; credit: number }>
}) {
  const vatAccounts = opts?.vatAccounts ?? [
    { id: 'a-2611', number: 2611 },
    { id: 'a-2621', number: 2621 },
    { id: 'a-2631', number: 2631 },
    { id: 'a-2641', number: 2641 },
  ]
  const idByNumber = new Map(vatAccounts.map((a) => [a.id, a.number]))
  const prisma = {
    account: { findMany: jest.fn().mockResolvedValue(vatAccounts) },
    journalEntryLine: {
      findMany: jest.fn().mockResolvedValue(opts?.lines ?? []),
      aggregate: jest.fn().mockImplementation((arg: { where: { accountId: string } }) => {
        const num = idByNumber.get(arg.where.accountId)
        const sums = (num != null && opts?.vatSums?.[num]) || { debit: 0, credit: 0 }
        return Promise.resolve({ _sum: { debit: sums.debit, credit: sums.credit } })
      }),
    },
  }
  const verifikationsnummer = { allocate: jest.fn() }
  const service = new AccountingService(prisma as never, verifikationsnummer as never)
  return { service }
}

describe('AccountingService — momsrapport', () => {
  it('utgående = kredit−debet på 2611/2621/2631, ingående = debet−kredit på 2641', async () => {
    const { service } = makeService({
      vatSums: {
        2611: { debit: 0, credit: 25000 }, // utgående 25 %
        2621: { debit: 0, credit: 6000 }, // utgående 12 %
        2631: { debit: 0, credit: 1200 }, // utgående 6 %
        2641: { debit: 10000, credit: 0 }, // ingående
      },
    })
    const r = await service.getVatReport('org-1', '2026-01-01', '2026-03-31')
    expect(r.outgoing.vat25).toBe(25000)
    expect(r.outgoing.vat12).toBe(6000)
    expect(r.outgoing.vat6).toBe(1200)
    expect(r.outgoing.total).toBe(32200)
    expect(r.incoming.total).toBe(10000)
    expect(r.netToPay).toBe(22200)
    expect(r.direction).toBe('BETALA')
  })

  it('mer ingående än utgående → ÅTERBÄRING (negativt netToPay)', async () => {
    const { service } = makeService({
      vatSums: {
        2611: { debit: 0, credit: 5000 },
        2641: { debit: 8000, credit: 0 },
      },
    })
    const r = await service.getVatReport('org-1', '2026-01-01', '2026-03-31')
    expect(r.netToPay).toBe(-3000)
    expect(r.direction).toBe('ÅTERBÄRING')
  })
})

describe('AccountingService — resultaträkning', () => {
  it('intäkter (3xxx kredit) minus kostnader (5–8xxx debet), grupperat per klass', async () => {
    const { service } = makeService({
      lines: [
        { debit: null, credit: 100000, account: { number: 3911, name: 'Hyresintäkt bostad' } },
        { debit: 20000, credit: null, account: { number: 5010, name: 'Drift' } },
        { debit: 5000, credit: null, account: { number: 6110, name: 'Admin' } },
        { debit: 30000, credit: null, account: { number: 7010, name: 'Personal' } },
        { debit: 8000, credit: null, account: { number: 8010, name: 'Avskrivning' } },
        { debit: 2000, credit: null, account: { number: 8410, name: 'Räntekostnad' } },
      ],
    })
    const r = await service.getProfitLossReport('org-1', '2026-01-01', '2026-12-31')
    expect(r.revenue.total).toBe(100000)
    expect(r.costs.operating.total).toBe(20000)
    expect(r.costs.admin.total).toBe(5000)
    expect(r.costs.personnel.total).toBe(30000)
    expect(r.costs.depreciation.total).toBe(8000)
    expect(r.costs.financial.total).toBe(2000)
    expect(r.costs.total).toBe(65000)
    expect(r.result).toBe(35000)
  })

  it('propertyId sätter propertyFilter + note (kostnader ej taggade per fastighet)', async () => {
    const { service } = makeService({ lines: [] })
    const r = await service.getProfitLossReport('org-1', '2026-01-01', '2026-12-31', 'prop-9')
    expect(r.propertyFilter).toBe('prop-9')
    expect(r.note).toContain('taggade per fastighet')
  })
})

describe('AccountingController — query-validering', () => {
  function makeController() {
    const service = {
      getProfitLossReport: jest.fn().mockResolvedValue({ ok: true }),
      getBalanceSheet: jest.fn().mockResolvedValue({ ok: true }),
      getVatReport: jest.fn().mockResolvedValue({ ok: true }),
    }
    const controller = new AccountingController(service as never)
    return { controller, service }
  }

  it('giltig period passerar och anropar servicen', async () => {
    const { controller, service } = makeController()
    await controller.getProfitLoss('org-1', '2026-01-01', '2026-12-31')
    expect(service.getProfitLossReport).toHaveBeenCalledWith(
      'org-1',
      '2026-01-01',
      '2026-12-31',
      undefined,
    )
  })

  it('saknat datum → 400', async () => {
    const { controller } = makeController()
    await expect(controller.getVatReport('org-1', undefined, '2026-12-31')).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })

  it('kalenderorimligt datum (2026-02-30) → 400, inte tyst koercering', async () => {
    const { controller, service } = makeController()
    await expect(controller.getBalanceSheet('org-1', '2026-02-30')).rejects.toBeInstanceOf(
      BadRequestException,
    )
    expect(service.getBalanceSheet).not.toHaveBeenCalled()
  })

  it('icke-UUID propertyId → 400', async () => {
    const { controller } = makeController()
    await expect(
      controller.getProfitLoss('org-1', '2026-01-01', '2026-12-31', 'not-a-uuid'),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it('giltigt UUID propertyId vidarebefordras', async () => {
    const { controller, service } = makeController()
    const uuid = '11111111-2222-3333-4444-555555555555'
    await controller.getProfitLoss('org-1', '2026-01-01', '2026-12-31', uuid)
    expect(service.getProfitLossReport).toHaveBeenCalledWith(
      'org-1',
      '2026-01-01',
      '2026-12-31',
      uuid,
    )
  })
})

describe('AccountingService — balansräkning', () => {
  it('tillgångar (1xxx debet−kredit) mot skulder/EK (2xxx kredit−debet); balanserad → difference 0', async () => {
    const { service } = makeService({
      lines: [
        { debit: 50000, credit: null, account: { number: 1930, name: 'Bank' } },
        { debit: null, credit: 50000, account: { number: 2010, name: 'Eget kapital' } },
      ],
    })
    const r = await service.getBalanceSheet('org-1', '2026-12-31')
    expect(r.assets.total).toBe(50000)
    expect(r.liabilitiesAndEquity.total).toBe(50000)
    expect(r.difference).toBe(0)
  })

  it('konton sorteras stigande och aggregeras per kontonummer', async () => {
    const { service } = makeService({
      lines: [
        { debit: 1000, credit: null, account: { number: 1930, name: 'Bank' } },
        { debit: 500, credit: null, account: { number: 1930, name: 'Bank' } },
        { debit: 200, credit: null, account: { number: 1510, name: 'Kundfordran' } },
      ],
    })
    const r = await service.getBalanceSheet('org-1', '2026-12-31')
    expect(r.assets.accounts.map((a) => a.number)).toEqual([1510, 1930])
    expect(r.assets.accounts.find((a) => a.number === 1930)?.balance).toBe(1500)
  })
})
