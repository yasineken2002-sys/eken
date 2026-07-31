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
