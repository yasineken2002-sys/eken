/**
 * Bokföringsperiod i svensk civil tid (Europe/Stockholm).
 *
 * PROBLEMET: periodhärledningen kördes i UTC (`getUTCFullYear`/`getUTCMonth`).
 * En verifikation daterad 1 januari 00:30 svensk tid är 31 december 23:30 UTC —
 * så kontrollen mot stängd period tittade på FEL månad, och räkenskapsåret
 * kunde tilldelas fel. En post kunde skrivas in i en redan stängd period vid
 * års- och månadsskiften.
 *
 * VARFÖR SVENSK TID ÄR RÄTT SVAR: en bokföringsperiod är ett svenskt
 * civilkalender-begrepp. Vilken månad en affärshändelse tillhör avgörs av
 * datumet i Sverige, inte av UTC-datumet. Räkenskapsåret likaså.
 *
 * VARFÖR INTE FAST OFFSET: Sverige växlar mellan CET (UTC+1) och CEST (UTC+2).
 * Ett hårdkodat +1 är fel halva året — en post 31 oktober 23:30 svensk tid
 * (sommartid, UTC+2) är 21:30 UTC samma dag, men 1 juli 00:30 svensk tid är
 * 22:30 föregående dag i UTC. Bara en riktig tidszonskonvertering klarar båda.
 * `Intl.DateTimeFormat` bär IANA:s tidszonsdata och hanterar DST korrekt.
 */

const STOCKHOLM = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export interface CivilDate {
  /** Kalenderår i svensk tid. */
  year: number
  /** Kalendermånad 1–12 i svensk tid. */
  month: number
  /** Dag i månaden i svensk tid. */
  day: number
}

/**
 * Civilt datum i Sverige för ett givet ögonblick.
 *
 * `formatToParts` används i stället för `toLocaleDateString` för att slippa
 * bero på hur en locale råkar formatera — delarna hämtas vid namn.
 */
export function stockholmCivilDate(instant: Date): CivilDate {
  const parts = STOCKHOLM.formatToParts(instant)
  const get = (type: 'year' | 'month' | 'day'): number =>
    Number(parts.find((p) => p.type === type)!.value)
  return { year: get('year'), month: get('month'), day: get('day') }
}

/**
 * Räkenskapsår för ett ögonblick, givet organisationens startmånad (1–12).
 *
 * Med startmånad 1 sammanfaller räkenskapsåret med kalenderåret. Med t.ex. 5
 * löper det maj–april, och en händelse i mars tillhör året som började i maj
 * föregående kalenderår.
 */
export function stockholmFiscalYear(instant: Date, fiscalYearStartMonth: number): number {
  const { year, month } = stockholmCivilDate(instant)
  return month < fiscalYearStartMonth ? year - 1 : year
}

/**
 * UTC-ögonblicken som avgränsar en svensk kalendermånad: `[from, to)`.
 *
 * MOTSVARIGHETEN till stockholmCivilDate åt andra hållet. Den funktionen svarar
 * "vilken period tillhör den här posten?" — den här svarar "vilka poster tillhör
 * den här perioden?". Båda MÅSTE ge samma svar, annars kan en rapport eller
 * kontroll räkna en post till en annan månad än den spärren placerade den i.
 *
 * Naiva `Date.UTC(year, month - 1, 1)` duger inte: en post skapad 22:30 UTC den
 * 31 mars är 00:30 svensk tid den 1 april (sommartid) — den tillhör april enligt
 * spärren, men ett UTC-fönster hade räknat den till mars.
 *
 * Offseten hämtas från IANA-data via `Intl` (samma skäl som ovan: Sverige växlar
 * CET/CEST). Vi tar UTC-midnatt för dagen, läser den faktiska offseten just då
 * och drar av den — månadsgränser ligger aldrig nära DST-omställningen (sista
 * söndagen i mars/oktober), så den enkla formen räcker och är entydig.
 */
export function stockholmMonthBounds(year: number, month: number): { from: Date; to: Date } {
  const boundary = (y: number, m: number): Date => {
    const utcMidnight = Date.UTC(y, m - 1, 1)
    return new Date(utcMidnight - stockholmOffsetMs(new Date(utcMidnight)))
  }
  const nextYear = month === 12 ? year + 1 : year
  const nextMonth = month === 12 ? 1 : month + 1
  return { from: boundary(year, month), to: boundary(nextYear, nextMonth) }
}

/** Sveriges UTC-offset (ms) vid ett givet ögonblick — +1h (CET) eller +2h (CEST). */
function stockholmOffsetMs(instant: Date): number {
  const { year, month, day } = stockholmCivilDate(instant)
  const parts = STOCKHOLM_TIME.formatToParts(instant)
  const get = (type: 'hour' | 'minute'): number => Number(parts.find((p) => p.type === type)!.value)
  // Vad klockan är i Sverige, uttryckt som om det vore UTC, minus det faktiska
  // UTC-ögonblicket = offseten.
  const asUtc = Date.UTC(year, month - 1, day, get('hour'), get('minute'))
  return asUtc - instant.getTime()
}

const STOCKHOLM_TIME = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Stockholm',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

// ─── DATUMKOLUMNER (@db.Date) — EN ANNAN SORTS GRÄNS (#730) ──────────────────

/**
 * `[from, to)` som DAGAR för en svensk kalendermånad — för `@db.Date`-kolumner.
 *
 * ── VARFÖR stockholmMonthBounds INTE DUGER MOT EN DATUMKOLUMN ──────────────
 *
 * `stockholmMonthBounds` ger ÖGONBLICK (22:00/23:00 UTC). Det är rätt mot en
 * tidsstämpelkolumn och fel mot en `@db.Date`-kolumn, för Prisma TRUNKERAR då
 * jämförelseparametern till ett datum. Mätt mot riktig Postgres, fyra verifikat
 * i december 2026 och `stockholmMonthBounds(2026, 12)`:
 *
 *   A) Prisma ORM  gte/lt  →  2026-11-30 · 2026-12-01     ← FEL i båda ändarna
 *   B) rå SQL      >=/<    →  2026-12-01 · 2026-12-31     ← rätt
 *   C) Prisma      DAGAR   →  2026-12-01 · 2026-12-31     ← rätt
 *
 * Fönstret tar alltså med FÖREGÅENDE månads sista dag och tappar sin egen.
 *
 * B och C skiljer sig därför att rå SQL skickar en riktig `timestamptz` som
 * Postgres jämför genom att promota datumet till midnatt; Prismas ORM-lager
 * skickar i stället en DATE. En kontroll som går via `$queryRaw` är alltså
 * korrekt med samma gränser som fäller ORM-vägen — det är inte en inkonsekvens
 * att laga, det är två olika frågor till databasen.
 *
 * ── VARFÖR DET INTE FINNS NÅGON TIDSZONSSUBTILITET HÄR ────────────────────
 *
 * En `@db.Date`-kolumn bär ingen tid. Det lagrade värdet ÄR det civila datumet,
 * satt av den som skrev raden. Det finns därför ingenting att konvertera:
 * gränserna är dagarna själva, uttryckta som UTC-midnatt (Prismas form för en
 * DATE).
 */
export function stockholmMonthDayBounds(year: number, month: number): { from: Date; to: Date } {
  const nextYear = month === 12 ? year + 1 : year
  const nextMonth = month === 12 ? 1 : month + 1
  return {
    from: new Date(Date.UTC(year, month - 1, 1)),
    to: new Date(Date.UTC(nextYear, nextMonth - 1, 1)),
  }
}

/**
 * Övre gräns INKLUSIVE ("t.o.m. i dag") mot en `@db.Date`-kolumn, för ett
 * ögonblick.
 *
 * Ett rått `lte: now` trunkeras till `now`s UTC-DATUM, inte till dagens datum i
 * Sverige. Mätt: med `now = 2026-12-31T23:30Z` — som är 1 januari 00:30 svensk
 * tid — returnerade `lte: now` bara raden daterad 2026-12-31, medan raden
 * daterad 2027-01-01 föll bort. "Årets intäkter hittills" tappade alltså den
 * innevarande dagen under de sista en till två timmarna av varje UTC-dygn.
 *
 * Funktionen svarar med den SVENSKA civila dagen som UTC-midnatt, så gränsen
 * betyder samma sak dygnet runt.
 */
export function throughStockholmDay(instant: Date): Date {
  const { year, month, day } = stockholmCivilDate(instant)
  return new Date(Date.UTC(year, month - 1, day))
}
