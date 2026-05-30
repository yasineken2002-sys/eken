/**
 * FIX 9 · PR 1 — BAS-kontoplan för fastighet (LAGBROTT 3 + 4).
 *
 * Verifierar att:
 *   • basChartFor seedar korrekta BAS 2024-konton (3911-3920) och INTE de
 *     gamla felaktiga (3001/3010/3011/3012/3013/3030).
 *   • revenueAccountForUnitType mappar upplåtelsetyp → rätt 39xx-konto.
 *   • createJournalEntryForInvoice krediterar rätt intäktskonto utifrån
 *     lägenhetens/lokalens typ (bostad → 3911, lokal → 3913, p-plats → 3912).
 *   • Depositioner bokförs mot 2890 (Mottagna depositioner), inte 2490/2820.
 */

import type { UnitType } from '@prisma/client'
import { AccountingService, revenueAccountForUnitType } from './accounting.service'
import { basChartFor } from './bas-chart'

describe('FIX 9 · PR 1 — BAS-kontoplan fastighet', () => {
  describe('basChartFor (AB)', () => {
    const numbers = basChartFor('AB').map((a) => a.number)

    it('innehåller korrekta BAS 2024 hyresintäktskonton (3900-serien)', () => {
      expect(numbers).toEqual(expect.arrayContaining([3911, 3912, 3913, 3914, 3920]))
    })

    it('innehåller 2890 Mottagna depositioner (inte felaktigt 2820)', () => {
      const acc = basChartFor('AB').find((a) => a.number === 2890)
      expect(acc).toMatchObject({ number: 2890, type: 'LIABILITY' })
      expect(numbers).not.toContain(2820)
    })

    it('seedar inte längre de gamla felaktiga intäktskontona', () => {
      for (const old of [3001, 3010, 3011, 3012, 3013, 3030]) {
        expect(numbers).not.toContain(old)
      }
    })

    it('3911 är märkt som intäkt (REVENUE)', () => {
      const acc = basChartFor('AB').find((a) => a.number === 3911)
      expect(acc?.type).toBe('REVENUE')
    })
  })

  describe('revenueAccountForUnitType', () => {
    const cases: Array<[UnitType, number]> = [
      ['APARTMENT', 3911],
      ['PARKING', 3912],
      ['OFFICE', 3913],
      ['RETAIL', 3913],
      ['STORAGE', 3914],
      ['OTHER', 3914],
    ]
    it.each(cases)('%s → %i', (type, expected) => {
      expect(revenueAccountForUnitType(type)).toBe(expected)
    })

    it('saknad typ (null) → 3914 fallback', () => {
      expect(revenueAccountForUnitType(null)).toBe(3914)
      expect(revenueAccountForUnitType(undefined)).toBe(3914)
    })
  })

  describe('createJournalEntryForInvoice — kontoval per upplåtelsetyp', () => {
    // Bygger en prisma-mock vars account.findMany returnerar samtliga
    // 39xx-konton, och vars lease.findUnique returnerar given unit-typ.
    function makeService(unitType: UnitType | null) {
      const accounts = [
        { id: 'acc-1510', number: 1510 },
        { id: 'acc-3911', number: 3911 },
        { id: 'acc-3912', number: 3912 },
        { id: 'acc-3913', number: 3913 },
        { id: 'acc-3914', number: 3914 },
        { id: 'acc-2611', number: 2611 },
      ]
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
        lease: {
          findUnique: jest
            .fn()
            .mockResolvedValue(unitType ? { unit: { type: unitType } } : { unit: null }),
        },
      }
      ;(prisma as unknown as { $transaction: unknown }).$transaction = (
        cb: (tx: unknown) => unknown,
      ) => cb(prisma)
      const verifikationsnummer = {
        allocate: jest.fn().mockResolvedValue({ series: 'A', verNumber: 1, fiscalYear: 2026 }),
      }
      const service = new AccountingService(prisma as never, verifikationsnummer as never)
      return { service, prisma, getCreated: () => created }
    }

    const invoice = {
      id: 'inv-1',
      invoiceNumber: 'F-2026-0001',
      leaseId: 'lease-1',
      issueDate: new Date('2026-05-29'),
      subtotal: 10_000,
      vatTotal: 0,
      total: 10_000,
      lines: [],
    } as never

    async function revenueAccountIdUsedFor(unitType: UnitType | null) {
      const { service, getCreated } = makeService(unitType)
      await service.createJournalEntryForInvoice(invoice, 'org-1', 'user-1')
      const lines = getCreated()?.data.lines.create ?? []
      // Intäktsraden är den som krediteras (debiteringen är kundfordran 1510).
      return lines.find((l) => l.credit != null)?.accountId
    }

    it('bostad (APARTMENT) krediterar 3911', async () => {
      expect(await revenueAccountIdUsedFor('APARTMENT')).toBe('acc-3911')
    })

    it('lokal (OFFICE) krediterar 3913', async () => {
      expect(await revenueAccountIdUsedFor('OFFICE')).toBe('acc-3913')
    })

    it('p-plats (PARKING) krediterar 3912', async () => {
      expect(await revenueAccountIdUsedFor('PARKING')).toBe('acc-3912')
    })

    it('saknad lease/unit krediterar 3914 (fallback)', async () => {
      expect(await revenueAccountIdUsedFor(null)).toBe('acc-3914')
    })
  })

  describe('depositioner bokförs mot 2890 (inte 2490/2820)', () => {
    function makeService() {
      const accounts = [
        { id: 'acc-1510', number: 1510 },
        { id: 'acc-1930', number: 1930 },
        { id: 'acc-2890', number: 2890 },
        { id: 'acc-2820', number: 2820 },
        { id: 'acc-2490', number: 2490 },
        { id: 'acc-3040', number: 3040 },
      ]
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
        cb: (tx: unknown) => unknown,
      ) => cb(prisma)
      const verifikationsnummer = {
        allocate: jest.fn().mockResolvedValue({ series: 'A', verNumber: 1, fiscalYear: 2026 }),
      }
      const service = new AccountingService(prisma as never, verifikationsnummer as never)
      return { service, getCreated: () => created }
    }

    it('createJournalEntryForDepositInvoice krediterar 2890', async () => {
      const { service, getCreated } = makeService()
      await service.createJournalEntryForDepositInvoice(
        'dep-1',
        'org-1',
        25_000,
        'F-2026-0002',
        new Date('2026-05-29'),
        'user-1',
      )
      const lines = getCreated()?.data.lines.create ?? []
      const credit = lines.find((l) => l.credit != null)
      expect(credit?.accountId).toBe('acc-2890')
    })

    it('createJournalEntryForDepositRefund debiterar 2890', async () => {
      const { service, getCreated } = makeService()
      await service.createJournalEntryForDepositRefund(
        'dep-1',
        'org-1',
        20_000,
        0,
        new Date('2026-05-29'),
        'user-1',
      )
      const lines = getCreated()?.data.lines.create ?? []
      const debit = lines.find((l) => l.debit != null)
      expect(debit?.accountId).toBe('acc-2890')
    })
  })
})
