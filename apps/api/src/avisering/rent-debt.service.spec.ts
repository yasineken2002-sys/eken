/**
 * Bankavstämnings-härdning PR 1 — KATEGORI A: outstanding-enhetstester.
 *
 * Verifierar den rena skuldberäkningen (computeRentDebt) och den scopade
 * outstanding()-läsaren:
 *   • Strukturerad retur med alla komponenter (kapital/förbrukning/avgift/ränta).
 *   • claim = Σ(komponenter) − Σ allokeringar, SIGNERAT (negativ vid överbetalning).
 *   • outstanding = max(0, claim) (klampad, aldrig negativ).
 *   • EN round2 — öresavrundning kompounderar inte.
 *   • DEPOSIT → nollor (ej kravavi).
 *   • outstanding() är org-scopad och summerar de granulära allokeringarna.
 */

import { NotFoundException } from '@nestjs/common'
import { Decimal } from '@prisma/client/runtime/library'
import { computeRentDebt, RentDebtService } from './rent-debt.service'

const RENT = 'RENT' as never
const DEPOSIT = 'DEPOSIT' as never

describe('PR1 · A — computeRentDebt (ren beräkning)', () => {
  it('obetald avi: claim = kapital, outstanding = kapital, paid = 0', () => {
    const d = computeRentDebt({
      type: RENT,
      totalAmount: 10_000,
      consumptionAmount: 0,
      reminderFeeAmount: 0,
      interestAccruedAmount: 0,
      allocations: [],
    })
    expect(d).toEqual({
      capital: 10_000,
      consumption: 0,
      reminderFee: 0,
      interest: 0,
      claim: 10_000,
      paid: 0,
      outstanding: 10_000,
    })
  })

  it('full uppdelning: alla fyra komponenter exponeras och summeras i claim', () => {
    const d = computeRentDebt({
      type: RENT,
      totalAmount: 7_000,
      consumptionAmount: 240,
      reminderFeeAmount: 60,
      interestAccruedAmount: 32.5,
      allocations: [],
    })
    expect(d.capital).toBe(7_000)
    expect(d.consumption).toBe(240)
    expect(d.reminderFee).toBe(60)
    expect(d.interest).toBe(32.5)
    // 7000 + 240 + 60 + 32,5 = 7332,5
    expect(d.claim).toBe(7_332.5)
    expect(d.outstanding).toBe(7_332.5)
    expect(d.paid).toBe(0)
  })

  it('delbetalning: outstanding minskar, paid = Σ allokeringar', () => {
    const d = computeRentDebt({
      type: RENT,
      totalAmount: 10_000,
      consumptionAmount: 0,
      reminderFeeAmount: 0,
      interestAccruedAmount: 0,
      allocations: [4_000, 1_500],
    })
    expect(d.paid).toBe(5_500)
    expect(d.claim).toBe(4_500)
    expect(d.outstanding).toBe(4_500)
  })

  it('full betalning: claim och outstanding = 0', () => {
    const d = computeRentDebt({
      type: RENT,
      totalAmount: 7_300,
      consumptionAmount: 0,
      reminderFeeAmount: 0,
      interestAccruedAmount: 0,
      allocations: [7_300],
    })
    expect(d.claim).toBe(0)
    expect(d.outstanding).toBe(0)
  })

  it('ÖVERBETALNING: claim signerat negativt (råvärde), outstanding klampat till 0', () => {
    const d = computeRentDebt({
      type: RENT,
      totalAmount: 5_000,
      consumptionAmount: 0,
      reminderFeeAmount: 0,
      interestAccruedAmount: 0,
      allocations: [5_500],
    })
    expect(d.paid).toBe(5_500)
    expect(d.claim).toBe(-500) // råvärdet exponeras
    expect(d.outstanding).toBe(0) // klampad
  })

  it('öresavrundning: EN round2 på nettot, inget kompounderande dropp', () => {
    // Decimal(10,2)-fält kan inte bära mer än två decimaler i DB, men beräkningen
    // ska ändå vara robust mot rå Decimal-input. 0,1 + 0,2 = 0,3 (ej 0,30000004).
    const d = computeRentDebt({
      type: RENT,
      totalAmount: new Decimal('0.10'),
      consumptionAmount: new Decimal('0.20'),
      reminderFeeAmount: 0,
      interestAccruedAmount: 0,
      allocations: [new Decimal('0.01')],
    })
    expect(d.claim).toBe(0.29)
    expect(d.outstanding).toBe(0.29)
  })

  it('DEPOSIT är ingen kravavi → nollor även med belopp satta', () => {
    const d = computeRentDebt({
      type: DEPOSIT,
      totalAmount: 12_000,
      consumptionAmount: 0,
      reminderFeeAmount: 0,
      interestAccruedAmount: 0,
      allocations: [],
    })
    expect(d).toEqual({
      capital: 0,
      consumption: 0,
      reminderFee: 0,
      interest: 0,
      claim: 0,
      paid: 0,
      outstanding: 0,
    })
  })

  it('hanterar Decimal-, number- och string-input likvärdigt', () => {
    const d = computeRentDebt({
      type: RENT,
      totalAmount: new Decimal('1000.00'),
      consumptionAmount: '250.50',
      reminderFeeAmount: 60,
      interestAccruedAmount: '0',
      allocations: [new Decimal('310.50'), '0', 1_001],
    })
    // gross = 1000 + 250,50 + 60 = 1310,50 ; paid = 310,50 + 0 + 1001 = 1311,50
    expect(d.paid).toBe(1_311.5)
    expect(d.claim).toBe(-1) // 1310,50 − 1311,50
    expect(d.outstanding).toBe(0)
  })
})

describe('PR1 · A — RentDebtService.outstanding (scopad läsare)', () => {
  function makeService(notice: Record<string, unknown> | null) {
    const findFirst = jest.fn().mockResolvedValue(notice)
    const prisma = { rentNotice: { findFirst } }
    const service = new RentDebtService(prisma as never)
    return { service, findFirst }
  }

  it('är org-scopad och summerar de granulära allokeringarna', async () => {
    const { service, findFirst } = makeService({
      type: 'RENT',
      totalAmount: new Decimal('8000'),
      consumptionAmount: new Decimal('0'),
      reminderFeeAmount: new Decimal('0'),
      interestAccruedAmount: new Decimal('0'),
      payments: [{ amount: new Decimal('3000') }, { amount: new Decimal('2000') }],
    })

    const d = await service.outstanding('rn-1', 'org-1')

    // tenant-scoping: findFirst MÅSTE filtrera på organizationId.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'rn-1', organizationId: 'org-1' } }),
    )
    expect(d.paid).toBe(5_000)
    expect(d.outstanding).toBe(3_000)
  })

  it('saknad avi → NotFoundException', async () => {
    const { service } = makeService(null)
    await expect(service.outstanding('saknas', 'org-1')).rejects.toBeInstanceOf(NotFoundException)
  })
})
