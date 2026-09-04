/**
 * H5 — PERIODHÄRLEDNING I SVENSK CIVIL TID.
 *
 * Buggen: perioden och räkenskapsåret härleddes med getUTCFullYear/getUTCMonth.
 * En verifikation daterad 1 januari 00:30 svensk tid är 31 december 23:30 UTC —
 * så kontrollen mot stängd period tittade på december, och räkenskapsåret kunde
 * tilldelas fel. En post kunde skrivas in i en redan STÄNGD period.
 *
 * En bokföringsperiod är ett svenskt civilkalender-begrepp: vilken månad en
 * affärshändelse tillhör avgörs av datumet i Sverige, inte i UTC.
 *
 * Testet konstruerar tidsstämplarna som de VERKLIGA UTC-ögonblick som motsvarar
 * en given svensk lokaltid — det är hela poängen. Ett test som skickar in
 * "2026-01-01T00:30:00Z" prövar ingenting, eftersom UTC och svensk tid då råkar
 * ge samma datum.
 */

import { stockholmCivilDate, stockholmFiscalYear } from './stockholm-period'

/** Ögonblicket i UTC som motsvarar en viss svensk lokaltid. */
const atStockholm = (utcIso: string): Date => new Date(utcIso)

describe('H5 — årsskiftet', () => {
  it('1 jan 00:30 svensk tid → januari 2026 (UTC säger 31 dec 2025)', () => {
    // Vintertid, CET = UTC+1 → 2025-12-31T23:30Z är 2026-01-01 00:30 i Sverige.
    const instant = atStockholm('2025-12-31T23:30:00Z')
    expect(instant.getUTCFullYear()).toBe(2025) // det gamla, felaktiga svaret
    expect(instant.getUTCMonth() + 1).toBe(12)

    expect(stockholmCivilDate(instant)).toEqual({ year: 2026, month: 1, day: 1 })
  })

  it('31 dec 23:30 svensk tid → december 2025, inte januari', () => {
    const instant = atStockholm('2025-12-31T22:30:00Z')
    expect(stockholmCivilDate(instant)).toEqual({ year: 2025, month: 12, day: 31 })
  })

  it('räkenskapsår (kalenderår): 1 jan 00:30 svensk tid tillhör 2026', () => {
    expect(stockholmFiscalYear(atStockholm('2025-12-31T23:30:00Z'), 1)).toBe(2026)
  })

  it('brutet räkenskapsår (maj–april): 1 jan svensk tid tillhör året som började maj 2025', () => {
    expect(stockholmFiscalYear(atStockholm('2025-12-31T23:30:00Z'), 5)).toBe(2025)
  })

  it('brutet räkenskapsår: 1 maj 00:30 svensk tid startar nytt räkenskapsår', () => {
    // 2026-04-30T22:00Z = 2026-05-01 00:00 svensk tid (CEST, UTC+2).
    expect(stockholmFiscalYear(atStockholm('2026-04-30T22:00:00Z'), 5)).toBe(2026)
  })
})

describe('H5 — sommartid (DST), där ett fast +1 hade varit fel', () => {
  it('sommartid CEST (UTC+2): 1 juli 00:30 svensk tid → 1 juli, inte 30 juni', () => {
    // Med fast +1 hade 2026-06-30T22:30Z blivit 23:30 den 30 juni — fel dag.
    expect(stockholmCivilDate(atStockholm('2026-06-30T22:30:00Z'))).toEqual({
      year: 2026,
      month: 7,
      day: 1,
    })
  })

  it('vintertid CET (UTC+1): 1 juli-motsvarigheten i januari kräver 23:30, inte 22:30', () => {
    // Samma UTC-tid (22:30) ger i vintertid FÖREGÅENDE dag — beviset för att
    // en fast offset inte kan vara rätt året runt.
    expect(stockholmCivilDate(atStockholm('2026-01-31T22:30:00Z'))).toEqual({
      year: 2026,
      month: 1,
      day: 31,
    })
  })

  it('natten till sommartidsskiftet (sista söndagen i mars)', () => {
    // 2026-03-29 02:00 CET → 03:00 CEST. Strax före skiftet gäller UTC+1.
    expect(stockholmCivilDate(atStockholm('2026-03-28T23:30:00Z'))).toEqual({
      year: 2026,
      month: 3,
      day: 29,
    })
    // Efter skiftet gäller UTC+2.
    expect(stockholmCivilDate(atStockholm('2026-03-29T22:30:00Z'))).toEqual({
      year: 2026,
      month: 3,
      day: 30,
    })
  })

  it('natten till vintertidsskiftet (sista söndagen i oktober)', () => {
    // Före skiftet: UTC+2.
    expect(stockholmCivilDate(atStockholm('2026-10-24T22:30:00Z'))).toEqual({
      year: 2026,
      month: 10,
      day: 25,
    })
    // Efter skiftet: UTC+1 — samma klockslag i UTC ger nu samma dag.
    expect(stockholmCivilDate(atStockholm('2026-10-25T22:30:00Z'))).toEqual({
      year: 2026,
      month: 10,
      day: 25,
    })
  })

  it('månadsskifte i sommartid: 31 okt 23:30 svensk tid är fortfarande oktober', () => {
    expect(stockholmCivilDate(atStockholm('2026-10-31T22:30:00Z'))).toEqual({
      year: 2026,
      month: 10,
      day: 31,
    })
  })
})

describe('H5 — rena datum (@db.Date) påverkas inte', () => {
  it('UTC-midnatt från en Date-kolumn ger samma datum i svensk tid', () => {
    // Prisma returnerar @db.Date som UTC-midnatt. Sverige ligger 1–2 timmar
    // före UTC, så midnatt UTC är samma dygn i Sverige — konverteringen är
    // säker även för de kolumnerna.
    expect(stockholmCivilDate(new Date('2026-06-15T00:00:00Z'))).toEqual({
      year: 2026,
      month: 6,
      day: 15,
    })
    expect(stockholmCivilDate(new Date('2026-01-01T00:00:00Z'))).toEqual({
      year: 2026,
      month: 1,
      day: 1,
    })
  })
})

/**
 * Grinden i praktiken: VerifikationsnummerService.allocate() vägrar tilldela
 * nummer i en STÄNGD period. Med UTC-härledning kunde en post daterad
 * 1 januari svensk tid kontrolleras mot december — och därmed skrivas in i ett
 * stängt räkenskapsår.
 */
describe('H5 — stängd-period-grinden använder svensk civil tid', () => {
  const { VerifikationsnummerService } = jest.requireActual<
    typeof import('../../accounting/verifikationsnummer.service')
  >('../../accounting/verifikationsnummer.service')

  // PR1b: spärren slår upp periodens SENASTE händelse i stället för en rad per
  // period. Perioden ett datum tillhör härleds fortfarande i svensk civil tid —
  // det är precis det den här sviten vaktar, och det är oförändrat.
  function makeTx(closedPeriods: Array<{ year: number; month: number }>) {
    const findFirst = jest.fn((args: { where: { year: number; month: number } }) => {
      const { year, month } = args.where
      const hit = closedPeriods.some((p) => p.year === year && p.month === month)
      return Promise.resolve(hit ? { type: 'CLOSED' } : null)
    })
    return {
      organization: { findUnique: jest.fn().mockResolvedValue({ fiscalYearStartMonth: 1 }) },
      accountingPeriodEvent: { findFirst },
      // #704 PR 1: spärren frågar om räkenskapsåret först. Inget år är stängt i
      // den här sviten — den vaktar MÅNADSHÄRLEDNINGEN i svensk civil tid, och
      // ett stängt år hade fällt varje prov innan månaden ens lästes.
      fiscalYearClose: { findUnique: jest.fn().mockResolvedValue(null) },
      journalEntrySequence: { upsert: jest.fn().mockResolvedValue({ lastNumber: 1 }) },
      _findFirst: findFirst,
    }
  }

  it('post 1 jan 00:30 svensk tid kontrolleras mot JANUARI, inte december', async () => {
    const service = new VerifikationsnummerService({} as never)
    // December 2025 är stängd; januari 2026 är öppen.
    const tx = makeTx([{ year: 2025, month: 12 }])

    const result = await service.allocate(
      tx as never,
      'org-1',
      new Date('2025-12-31T23:30:00Z'), // = 2026-01-01 00:30 svensk tid
    )

    // Med UTC hade den träffat den stängda december-perioden och kastat.
    expect(result.fiscalYear).toBe(2026)
    expect(tx._findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-1', year: 2026, month: 1 },
      }),
    )
  })

  it('post 1 jan svensk tid AVVISAS när januari är stängd', async () => {
    const service = new VerifikationsnummerService({} as never)
    const tx = makeTx([{ year: 2026, month: 1 }])

    await expect(
      service.allocate(tx as never, 'org-1', new Date('2025-12-31T23:30:00Z')),
    ).rejects.toThrow(/2026-01.*stängd/)
  })

  it('post 31 dec 23:30 svensk tid AVVISAS när december är stängd', async () => {
    const service = new VerifikationsnummerService({} as never)
    const tx = makeTx([{ year: 2025, month: 12 }])

    await expect(
      service.allocate(tx as never, 'org-1', new Date('2025-12-31T22:30:00Z')),
    ).rejects.toThrow(/2025-12.*stängd/)
  })
})
