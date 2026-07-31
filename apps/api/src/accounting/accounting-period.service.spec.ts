/**
 * T5 PR1a — bokföringsperioder: nåbar stängning, förhandskontroll, översikt.
 *
 * PREMISS som testerna vaktar: PR1a bygger INGEN andra spärr. Den som faktiskt
 * hindrar en bokföring i en stängd period är `VerifikationsnummerService.allocate`
 * och den är orörd (se allocate-testet längst ned + stockholm-period.spec).
 * Den här tjänsten gör den befintliga mekanismen NÅBAR och förhandskontrollerad.
 *
 * Kalibreringen (FAR): exakt EN kontroll blockerar — obalanserat verifikat, som är
 * en objektiv korrekthetsfråga. Allt annat är fullständighetsbedömningar som en
 * redovisningskonsult måste kunna väga in och ändå stänga.
 */

import { ConflictException, ForbiddenException, BadRequestException } from '@nestjs/common'
import { UserRole } from '@prisma/client'
import { AccountingPeriodService } from './accounting-period.service'
import { VerifikationsnummerService } from './verifikationsnummer.service'

interface RigOpts {
  closed?: Array<{ year: number; month: number; closedAt?: Date }>
  unbalancedCount?: number
  notices?: Array<{ id: string; leaseId: string }>
  bookedNoticeIds?: string[]
  invoices?: string[]
  bookedInvoiceIds?: string[]
  /** invoiceId → depositId, för fakturor som bokförts via depositionsflödet. */
  depositInvoices?: Record<string, string>
  activeLeases?: string[]
  unmatchedBankTx?: number
  verNumbers?: number[]
  vatReportingPeriod?: 'MONTHLY' | 'QUARTERLY' | 'YEARLY'
}

function makeRig(opts: RigOpts = {}) {
  const created: Array<Record<string, unknown>> = []
  const notices = opts.notices ?? []
  const bookedNotice = new Set((opts.bookedNoticeIds ?? []).map((id) => `rent-notice:${id}`))
  const bookedInvoice = new Set(opts.bookedInvoiceIds ?? [])

  const prisma = {
    closedAccountingPeriod: {
      findMany: jest.fn().mockResolvedValue(
        (opts.closed ?? []).map((c) => ({
          year: c.year,
          month: c.month,
          closedAt: c.closedAt ?? new Date('2026-04-01T10:00:00Z'),
        })),
      ),
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        created.push(args.data)
        return Promise.resolve({ id: 'cap-1', ...args.data })
      }),
    },
    organization: {
      findUnique: jest.fn().mockResolvedValue({
        vatReportingPeriod: opts.vatReportingPeriod ?? 'MONTHLY',
        fiscalYearStartMonth: 1,
      }),
    },
    rentNotice: {
      findMany: jest.fn(({ select }: { select?: Record<string, boolean> }) =>
        Promise.resolve(
          select?.leaseId
            ? notices
                .filter((n) => bookedNotice.has(`rent-notice:${n.id}`))
                .map((n) => ({ leaseId: n.leaseId }))
            : notices.map((n) => ({ id: n.id })),
        ),
      ),
    },
    invoice: { findMany: jest.fn().mockResolvedValue((opts.invoices ?? []).map((id) => ({ id }))) },
    deposit: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          Object.entries(opts.depositInvoices ?? {}).map(([invoiceId, id]) => ({ id, invoiceId })),
        ),
    },
    journalEntry: {
      findMany: jest.fn(
        ({
          where,
          select,
        }: {
          where: Record<string, unknown>
          select?: Record<string, boolean>
        }) => {
          if (select?.verNumber) {
            return Promise.resolve((opts.verNumbers ?? []).map((n) => ({ verNumber: n })))
          }
          const ids = (where.sourceId as { in?: string[] } | undefined)?.in ?? []
          return Promise.resolve(
            ids
              .filter((id) => bookedNotice.has(id) || bookedInvoice.has(id))
              .map((sourceId) => ({ sourceId })),
          )
        },
      ),
      // Luckkontrollen aggregerar i DB (min/max/count) i stället för att hämta
      // hem hela årets nummerserie.
      aggregate: jest.fn(() => {
        const nums = opts.verNumbers ?? []
        return Promise.resolve({
          _min: { verNumber: nums.length ? Math.min(...nums) : null },
          _max: { verNumber: nums.length ? Math.max(...nums) : null },
          _count: { verNumber: nums.length },
        })
      }),
    },
    lease: {
      findMany: jest.fn().mockResolvedValue((opts.activeLeases ?? []).map((id) => ({ id }))),
    },
    bankTransaction: { count: jest.fn().mockResolvedValue(opts.unmatchedBankTx ?? 0) },
    journalEntryLine: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([{ count: BigInt(opts.unbalancedCount ?? 0) }]),
  }

  const service = new AccountingPeriodService(prisma as never)
  return { service, prisma, created }
}

const ACTOR = { actorRole: UserRole.ACCOUNTANT, actorUserId: 'user-1' }

describe('T5 PR1a · AccountingPeriodService', () => {
  beforeEach(() => jest.clearAllMocks())

  describe('Förhandskontroll — exakt en hård spärr', () => {
    it('obalanserat verifikat BLOCKERAR stängningen (objektiv korrekthet)', async () => {
      const { service } = makeRig({ unbalancedCount: 2 })

      const pre = await service.precheck('org-1', 2026, 5)
      expect(pre.canClose).toBe(false)
      const blocking = pre.checks.filter((c) => c.severity === 'blocking')
      expect(blocking).toHaveLength(1)
      expect(blocking[0]!.code).toBe('unbalanced-entries')
      expect(blocking[0]!.count).toBe(2)

      await expect(service.closePeriod('org-1', 2026, 5, ACTOR)).rejects.toBeInstanceOf(
        ConflictException,
      )
    })

    it('avier utan verifikat VARNAR men hindrar inte stängning', async () => {
      const { service, created } = makeRig({
        notices: [
          { id: 'n-1', leaseId: 'l-1' },
          { id: 'n-2', leaseId: 'l-2' },
        ],
        bookedNoticeIds: ['n-1'],
      })

      const pre = await service.precheck('org-1', 2026, 5)
      const check = pre.checks.find((c) => c.code === 'notices-without-entry')!
      expect(check.severity).toBe('warning')
      expect(check.count).toBe(1)
      expect(pre.canClose).toBe(true)

      await service.closePeriod('org-1', 2026, 5, ACTOR)
      expect(created).toHaveLength(1) // varningen stoppade inte låsningen
    })

    it('oaviserade kontrakt, omatchade banktransaktioner och nummer-luckor varnar', async () => {
      const { service } = makeRig({
        activeLeases: ['l-1', 'l-2'],
        notices: [{ id: 'n-1', leaseId: 'l-1' }],
        bookedNoticeIds: ['n-1'],
        unmatchedBankTx: 3,
        verNumbers: [1, 2, 5], // två luckor
      })

      const pre = await service.precheck('org-1', 2026, 5)
      const codes = pre.checks.filter((c) => c.severity === 'warning').map((c) => c.code)
      expect(codes).toEqual(
        expect.arrayContaining([
          'unbilled-leases',
          'unmatched-bank-transactions',
          'verification-number-gaps',
        ]),
      )
      expect(pre.checks.find((c) => c.code === 'verification-number-gaps')!.count).toBe(2)
      expect(pre.canClose).toBe(true)
    })

    it('depositionsfaktura bokförd via deposit-invoice-nyckeln flaggas INTE (FAR HIGH)', async () => {
      // En DEPOSIT-faktura bokförs som skuld (1510/2890) av depositionsflödet
      // under sourceId='deposit-invoice:<depositId>' — inte under fakturans id.
      // Slås bara fakturanyckeln upp blir varje korrekt bokförd deposition ett
      // falsklarm, och sådant brus lär operatören att ignorera varningarna.
      const { service } = makeRig({
        invoices: ['inv-dep'],
        depositInvoices: { 'inv-dep': 'dep-1' },
        bookedInvoiceIds: ['deposit-invoice:dep-1'],
      })

      const pre = await service.precheck('org-1', 2026, 5)
      expect(pre.checks.find((c) => c.code === 'invoices-without-entry')).toBeUndefined()
    })

    it('faktura som verkligen saknar verifikat flaggas fortfarande', async () => {
      const { service } = makeRig({ invoices: ['inv-1'], bookedInvoiceIds: [] })

      const pre = await service.precheck('org-1', 2026, 5)
      const check = pre.checks.find((c) => c.code === 'invoices-without-entry')!
      expect(check.severity).toBe('warning')
      expect(check.count).toBe(1)
    })

    it('ren period → inga upptäckter alls', async () => {
      const { service } = makeRig()
      const pre = await service.precheck('org-1', 2026, 5)
      expect(pre.checks).toHaveLength(0)
      expect(pre.canClose).toBe(true)
    })

    it('momsvarning återanvänder #195:s etikettering och gäller bara flermånadsperiod', async () => {
      const kvartal = makeRig({ vatReportingPeriod: 'QUARTERLY' })
      const pre = await kvartal.service.precheck('org-1', 2026, 5)
      const vat = pre.checks.find((c) => c.code === 'vat-period-spans-months')
      expect(vat?.severity).toBe('warning')
      expect(pre.vatPeriods).toEqual(['Q2 2026'])

      const manad = makeRig({ vatReportingPeriod: 'MONTHLY' })
      const preM = await manad.service.precheck('org-1', 2026, 5)
      expect(preM.checks.find((c) => c.code === 'vat-period-spans-months')).toBeUndefined()
    })
  })

  describe('Stängning', () => {
    it('skriver ClosedAccountingPeriod med ögonblicksbild och stängande användare', async () => {
      const { service, created } = makeRig()
      await service.closePeriod('org-1', 2026, 5, ACTOR)

      expect(created).toHaveLength(1)
      expect(created[0]).toMatchObject({
        organizationId: 'org-1',
        year: 2026,
        month: 5,
        closedById: 'user-1',
      })
      const summary = created[0]!.summary as { generatedAt: string; month: number }
      expect(summary.month).toBe(5)
      expect(typeof summary.generatedAt).toBe('string')
    })

    it('redan stängd period avvisas', async () => {
      const { service } = makeRig({ closed: [{ year: 2026, month: 5 }] })
      const pre = await service.precheck('org-1', 2026, 5)
      expect(pre.alreadyClosed).toBe(true)
      expect(pre.canClose).toBe(false)

      await expect(service.closePeriod('org-1', 2026, 5, ACTOR)).rejects.toBeInstanceOf(
        ConflictException,
      )
    })

    it.each([UserRole.VIEWER, UserRole.MANAGER])(
      '%s nekas server-side och inget skrivs',
      async (role) => {
        const { service, created } = makeRig()
        await expect(
          service.closePeriod('org-1', 2026, 5, { actorRole: role, actorUserId: 'u' }),
        ).rejects.toBeInstanceOf(ForbiddenException)
        expect(created).toHaveLength(0)
      },
    )

    it('saknad roll nekas (fail-closed)', async () => {
      const { service } = makeRig()
      await expect(
        service.closePeriod('org-1', 2026, 5, { actorUserId: 'u' }),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })

    it('ogiltig månad avvisas', async () => {
      const { service } = makeRig()
      await expect(service.closePeriod('org-1', 2026, 13, ACTOR)).rejects.toBeInstanceOf(
        BadRequestException,
      )
    })
  })

  describe('Passiv synlighet', () => {
    it('visar senast stängda och öppna perioder (äldst först)', async () => {
      const now = new Date()
      const y = now.getUTCFullYear()
      const m = now.getUTCMonth() + 1
      const prevMonth = m === 1 ? 12 : m - 1
      const prevYear = m === 1 ? y - 1 : y

      const { service } = makeRig({ closed: [{ year: prevYear, month: prevMonth }] })
      const overview = await service.getOverview('org-1', 3)

      expect(overview.lastClosed).toEqual({ year: prevYear, month: prevMonth })
      expect(overview.items.find((i) => i.year === prevYear && i.month === prevMonth)?.closed).toBe(
        true,
      )
      expect(overview.items.find((i) => i.year === y && i.month === m)?.closed).toBe(false)
      // Öppna listas äldst först — den perioden är mest angelägen.
      const first = overview.open[0]!
      const last = overview.open[overview.open.length - 1]!
      expect(first.year * 12 + first.month).toBeLessThan(last.year * 12 + last.month)
    })

    it('ingen stängd period → lastClosed null, allt öppet', async () => {
      const { service } = makeRig()
      const overview = await service.getOverview('org-1', 4)
      expect(overview.lastClosed).toBeNull()
      expect(overview.open).toHaveLength(4)
    })
  })

  describe('Den VERKSTÄLLANDE spärren är orörd (allocate)', () => {
    it('stängd period → allocate kastar och ingen sekvens ökas', async () => {
      const upsert = jest.fn()
      const tx = {
        organization: { findUnique: jest.fn().mockResolvedValue({ fiscalYearStartMonth: 1 }) },
        closedAccountingPeriod: { findUnique: jest.fn().mockResolvedValue({ id: 'closed-1' }) },
        journalEntrySequence: { upsert },
      }
      const service = new VerifikationsnummerService({} as never)

      await expect(
        service.allocate(tx as never, 'org-1', new Date('2026-05-15T10:00:00Z')),
      ).rejects.toThrow(/2026-05.*stängd/)
      // Gap-free-garantin: numret får inte brännas när posten avvisas.
      expect(upsert).not.toHaveBeenCalled()
    })

    it('öppen period → allocate tilldelar nummer som förut', async () => {
      const tx = {
        organization: { findUnique: jest.fn().mockResolvedValue({ fiscalYearStartMonth: 1 }) },
        closedAccountingPeriod: { findUnique: jest.fn().mockResolvedValue(null) },
        journalEntrySequence: { upsert: jest.fn().mockResolvedValue({ lastNumber: 7 }) },
      }
      const service = new VerifikationsnummerService({} as never)

      const result = await service.allocate(tx as never, 'org-1', new Date('2026-05-15T10:00:00Z'))
      expect(result).toEqual({ series: 'A', verNumber: 7, fiscalYear: 2026 })
    })
  })
})
