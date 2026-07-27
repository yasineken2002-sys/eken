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
