/**
 * T4/#47 — getRevenueYearToDate: DELAD "bokförd intäkt räkenskapsår-till-idag"
 * (Σ 3xxx accrual) som AI-lagret och dashboarden ska rapportera identiskt.
 * Bevisar att räkenskapsår-till-idag-perioden beräknas med SAMMA formel som
 * DashboardService.fiscalYearToDate (default 1, UTC) och att summan = Σ 3xxx
 * credit−debit för den perioden.
 */

import { AccountingService } from './accounting.service'

function makeService(opts: {
  fiscalYearStartMonth?: number | null
  credit?: number
  debit?: number
}) {
  const aggregate = jest.fn().mockResolvedValue({
    _sum: { credit: opts.credit ?? 0, debit: opts.debit ?? 0 },
  })
  const organizationFindUnique = jest
    .fn()
    .mockResolvedValue(
      opts.fiscalYearStartMonth === null
        ? null
        : { fiscalYearStartMonth: opts.fiscalYearStartMonth ?? 1 },
    )
  const prisma = {
    organization: { findUnique: organizationFindUnique },
    journalEntryLine: { aggregate },
  }
  const service = new AccountingService(prisma as never, {} as never)
  return { service, aggregate }
}

describe('AccountingService.getRevenueYearToDate', () => {
  it('kalenderår (fiscalStart=1): från = 1 jan samma år, total = credit−debit', async () => {
    const { service, aggregate } = makeService({
      fiscalYearStartMonth: 1,
      credit: 250000,
      debit: 10000,
    })
    const now = new Date('2026-07-15T12:00:00Z')
    const res = await service.getRevenueYearToDate('org-1', now)

    expect(res.total).toBe(240000)
    expect(res.from.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(res.to).toBe(now)
    // Aggregatet grindar på [från, now] och kontospann 3xxx, dubbelt org-scopat.
    const where = aggregate.mock.calls[0][0].where
    expect(where.account).toMatchObject({
      organizationId: 'org-1',
      number: { gte: 3000, lt: 4000 },
    })
    expect(where.journalEntry.organizationId).toBe('org-1')
    expect(where.journalEntry.date.gte.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    // ÖVRE GRÄNSEN ÄR EN DAG, INTE ÖGONBLICKET (#730).
    //
    // Provet krävde tidigare `date.lte === now`, alltså exakt det inskickade
    // ögonblicket. Den assertionen fastnaglade en defekt: `JournalEntry.date` är
    // `@db.Date`, så Prisma trunkerar gränsen till dess UTC-datum — inte till
    // dagens datum i Sverige. Mätt mot riktig Postgres föll en rad daterad
    // 2027-01-01 bort när `now` var 2026-12-31T23:30Z, som ÄR 1 januari 00:30
    // svensk tid. "Årets intäkter hittills" tappade alltså den innevarande dagen
    // under de sista en till två timmarna av varje UTC-dygn.
    //
    // `res.to` bär fortfarande ögonblicket — det är svarets tidsstämpel, och den
    // ska inte trubbas av. Det är BARA databasgränsen som normaliseras.
    expect(where.journalEntry.date.lte.toISOString()).toBe('2026-07-15T00:00:00.000Z')
  })

  it('#730: gränsen följer den SVENSKA dagen, inte UTC-dygnet', async () => {
    // 23:30 UTC den 31 december är 00:30 svensk tid den 1 januari. Gränsen ska
    // därför bli 2027-01-01, inte 2026-12-31.
    const { service, aggregate } = makeService({ fiscalYearStartMonth: 1, credit: 1 })
    const now = new Date('2026-12-31T23:30:00Z')
    const res = await service.getRevenueYearToDate('org-1', now)

    const where = aggregate.mock.calls[0][0].where
    expect(where.journalEntry.date.lte.toISOString()).toBe('2027-01-01T00:00:00.000Z')
    // Räkenskapsåret är redan 2027 i svensk tid — samma härledning, samma svar.
    expect(res.from.toISOString()).toBe('2027-01-01T00:00:00.000Z')
    // Svarets `to` är oförändrat ögonblicket.
    expect(res.to).toBe(now)
  })

  it('brutet räkenskapsår (fiscalStart=7), now i juli → från = 1 juli samma år', async () => {
    const { service } = makeService({ fiscalYearStartMonth: 7, credit: 100000 })
    const res = await service.getRevenueYearToDate('org-1', new Date('2026-07-15T00:00:00Z'))
    expect(res.from.toISOString()).toBe('2026-07-01T00:00:00.000Z')
    expect(res.total).toBe(100000)
  })

  it('brutet räkenskapsår (fiscalStart=7), now i mars → från = 1 juli FÖREGÅENDE år', async () => {
    const { service } = makeService({ fiscalYearStartMonth: 7 })
    const res = await service.getRevenueYearToDate('org-1', new Date('2026-03-15T00:00:00Z'))
    expect(res.from.toISOString()).toBe('2025-07-01T00:00:00.000Z')
  })

  it('org saknar fiscalYearStartMonth → default 1 (kalenderår)', async () => {
    const { service } = makeService({ fiscalYearStartMonth: null })
    const res = await service.getRevenueYearToDate('org-1', new Date('2026-05-10T00:00:00Z'))
    expect(res.from.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })
})
