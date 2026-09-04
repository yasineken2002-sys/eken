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
  /** PR1c: antal återöppningar per period, för översiktens markering. */
  reopened?: Array<{ year: number; month: number; count: number }>
  /** PR1c: periodens händelsekedja, som getPeriodHistory returnerar den. */
  history?: Array<Record<string, unknown>>
  fiscalYearStartMonth?: number
  /** Aktiva mottagare av återöppnings-notisen. */
  notifyUsers?: string[]
}

function makeRig(opts: RigOpts = {}) {
  const created: Array<Record<string, unknown>> = []
  const events: Array<Record<string, unknown>> = []
  const notices = opts.notices ?? []
  const bookedNotice = new Set((opts.bookedNoticeIds ?? []).map((id) => `rent-notice:${id}`))
  const bookedInvoice = new Set(opts.bookedInvoiceIds ?? [])

  // PR1b: stängt tillstånd härleds ur senaste händelsen per period. Riggen matar
  // därför in en CLOSED-händelse per period i `opts.closed` — motsvarigheten till
  // vad DISTINCT ON hade returnerat från AccountingPeriodEvent.
  const closedEventRows = (opts.closed ?? []).map((c) => ({
    year: c.year,
    month: c.month,
    type: 'CLOSED',
    createdAt: c.closedAt ?? new Date('2026-04-01T10:00:00Z'),
  }))

  // Stängningen skriver händelse + spegling i EN transaktion. Deklareras före
  // `prisma` med explicit returtyp — annars blir objektet självrefererande för TS.
  const $transaction = jest.fn(
    (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(prisma),
  )

  const prisma = {
    // #704 PR 1: spärren frågar om räkenskapsåret först. Inget år är stängt här.
    fiscalYearClose: { findUnique: jest.fn().mockResolvedValue(null) },
    accountingPeriodEvent: {
      // Två anropare: prechecks punktuppslag ("är perioden stängd?") och
      // appendPeriodClosedEvents seq-allokering. Attrappen svarar på båda utifrån
      // periodens historik i `opts.closed`.
      findFirst: jest.fn((args: { where: { year: number; month: number } }) => {
        const hit = closedEventRows.find(
          (r) => r.year === args.where.year && r.month === args.where.month,
        )
        return Promise.resolve(hit ? { type: 'CLOSED', seq: 1 } : null)
      }),
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        events.push(args.data)
        return Promise.resolve({ id: 'ape-1', ...args.data })
      }),
      // Översikten räknar återöppningar per period (PR1c).
      groupBy: jest.fn().mockResolvedValue(
        (opts.reopened ?? []).map((r) => ({
          year: r.year,
          month: r.month,
          _count: { _all: r.count },
        })),
      ),
      findMany: jest.fn().mockResolvedValue(opts.history ?? []),
    },
    notification: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    closedAccountingPeriod: {
      // Speglingen upsertas (create-grenen är den som gäller i PR1b — perioden
      // kan inte stängas två gånger här).
      upsert: jest.fn((args: { create: Record<string, unknown> }) => {
        created.push(args.create)
        return Promise.resolve({ id: 'cap-1', ...args.create })
      }),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ firstName: 'Anna', lastName: 'Svensson' }),
      findMany: jest
        .fn()
        .mockResolvedValue((opts.notifyUsers ?? ['u-owner']).map((id) => ({ id }))),
    },
    organization: {
      findUnique: jest.fn().mockResolvedValue({
        vatReportingPeriod: opts.vatReportingPeriod ?? 'MONTHLY',
        fiscalYearStartMonth: opts.fiscalYearStartMonth ?? 1,
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
    // Två skilda råa frågor delar den här mocken: obalans-räkningen (precheck)
    // och DISTINCT ON-uppslagningen av senaste periodhändelse (closed-period.ts).
    // De skiljs på SQL-texten, inte på anropsordning.
    $queryRaw: jest.fn((strings: TemplateStringsArray) => {
      const sql = (strings.raw ?? strings).join('')
      if (sql.includes('AccountingPeriodEvent')) return Promise.resolve(closedEventRows)
      return Promise.resolve([{ count: BigInt(opts.unbalancedCount ?? 0) }])
    }),
    $transaction,
  }

  // #704 PR 2: tjänsten injicerar numera AccountingService (årsavslutsverifikatet).
  // Den här sviten rör inte årsstängningen — attrappen finns för konstruktorn.
  const service = new AccountingPeriodService(prisma as never, {} as never)
  return { service, prisma, created, events }
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
    it('skriver en CLOSED-händelse med ögonblicksbild, aktör och seq=1', async () => {
      const { service, events } = makeRig()
      await service.closePeriod('org-1', 2026, 5, ACTOR)

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        organizationId: 'org-1',
        year: 2026,
        month: 5,
        seq: 1,
        type: 'CLOSED',
        actorType: 'USER',
        actorUserId: 'user-1',
        // Denormaliserat så loggen går att läsa när User-raden är borta.
        actorLabel: 'Anna Svensson',
      })
      const summary = events[0]!.summary as { generatedAt: string; month: number }
      expect(summary.month).toBe(5)
      expect(typeof summary.generatedAt).toBe('string')
    })

    it('okänd aktör → SYSTEM, ingen påhittad användare', async () => {
      const { service, events } = makeRig()
      await service.closePeriod('org-1', 2026, 5, { actorRole: UserRole.OWNER })

      expect(events[0]).toMatchObject({ actorType: 'SYSTEM' })
      expect(events[0]).not.toHaveProperty('actorUserId')
      expect(events[0]).not.toHaveProperty('actorLabel')
    })

    it('seq fortsätter från periodens historik (N+1), inte från 1', async () => {
      // Formeln `seq = (last?.seq ?? 0) + 1` bär hela serialiseringsargumentet.
      // Tom historik täcks av testerna ovan; det här pinnar N+1-grenen i den
      // snabba sviten (den DB-backade samtidighetskörningen kompletterar, men
      // går inte i CI).
      const { service, prisma, events } = makeRig()
      prisma.accountingPeriodEvent.findFirst = jest.fn().mockResolvedValue({ seq: 3 })

      await service.closePeriod('org-1', 2026, 5, ACTOR)
      expect(events[0]).toMatchObject({ seq: 4 })
    })

    it('speglar till den gamla tabellen i SAMMA transaktion (rollback-fallskärm)', async () => {
      const { service, created, events, prisma } = makeRig()
      await service.closePeriod('org-1', 2026, 5, ACTOR)

      // Speglingen läses av ingen, men får aldrig hamna i otakt med händelsen:
      // en rollback till PR1a-kod läser den gamla tabellen.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1)
      expect(events).toHaveLength(1)
      expect(created).toHaveLength(1)
      expect(created[0]).toMatchObject({
        organizationId: 'org-1',
        year: 2026,
        month: 5,
        closedById: 'user-1',
      })
      expect(created[0]!.summary).toEqual(events[0]!.summary)
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
    /**
     * PR1b bytte VAD spärren slår upp (senaste händelsen i stället för en rad per
     * period), inte VAD den betyder. Testerna nedan matar in periodens senaste
     * händelse och kräver exakt samma utfall som mot den gamla representationen.
     */
    function allocateRig(latest: { type: string } | null) {
      const upsert = jest.fn().mockResolvedValue({ lastNumber: 7 })
      const tx = {
        organization: { findUnique: jest.fn().mockResolvedValue({ fiscalYearStartMonth: 1 }) },
        accountingPeriodEvent: { findFirst: jest.fn().mockResolvedValue(latest) },
        // #704 PR 1: årsdimensionen. Riggen prövar MÅNADSspärren — ett stängt år
        // hade fällt varje fall innan månaden ens lästes.
        fiscalYearClose: { findUnique: jest.fn().mockResolvedValue(null) },
        journalEntrySequence: { upsert },
      }
      return { tx, upsert, service: new VerifikationsnummerService({} as never) }
    }

    it('stängd period → allocate kastar och ingen sekvens ökas', async () => {
      const { tx, upsert, service } = allocateRig({ type: 'CLOSED' })

      await expect(
        service.allocate(tx as never, 'org-1', new Date('2026-05-15T10:00:00Z')),
      ).rejects.toThrow(/2026-05.*stängd/)
      // Gap-free-garantin: numret får inte brännas när posten avvisas.
      expect(upsert).not.toHaveBeenCalled()
    })

    it('period utan händelser (aldrig stängd) → allocate tilldelar nummer som förut', async () => {
      const { tx, service } = allocateRig(null)

      const result = await service.allocate(tx as never, 'org-1', new Date('2026-05-15T10:00:00Z'))
      expect(result).toEqual({ series: 'A', verNumber: 7, fiscalYear: 2026 })
    })

    it('senaste händelsen REOPENED → allocate släpper igenom (perioden ÄR öppen)', async () => {
      const { tx, service } = allocateRig({ type: 'REOPENED' })

      const result = await service.allocate(tx as never, 'org-1', new Date('2026-05-15T10:00:00Z'))
      expect(result.verNumber).toBe(7)
    })

    it('spärren frågar org-scopat, utan typfilter och på senaste seq', async () => {
      const { tx, service } = allocateRig(null)
      await service.allocate(tx as never, 'org-1', new Date('2026-05-15T10:00:00Z'))

      const args = tx.accountingPeriodEvent.findFirst.mock.calls[0]![0] as {
        where: Record<string, unknown>
        orderBy: Record<string, unknown>
      }
      expect(args.where).toEqual({ organizationId: 'org-1', year: 2026, month: 5 })
      // Ett typfilter hade gjort frågan till "har något hänt" i stället för
      // "vad hände senast" — den enda vägen till en tyst tillåtare.
      expect(args.where).not.toHaveProperty('type')
      expect(args.orderBy).toEqual({ seq: 'desc' })
    })
  })
})
