/** Kalendern för hyresaviers förfallodag, oberoende av serverns/klientens TZ. */
export const SWEDISH_TIME_ZONE = 'Europe/Stockholm'

const calendar = new Intl.DateTimeFormat('en-GB', {
  timeZone: SWEDISH_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

function parts(date: Date) {
  const values = Object.fromEntries(calendar.formatToParts(date).map((p) => [p.type, p.value]))
  return values as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', string>
}

/** Även äldre UTC-midnatt och svensk lokal midnatt läses som samma svenska dag. */
export function swedishDateKey(date: Date): string {
  const p = parts(date)
  return `${p.year}-${p.month}-${p.day}`
}

/** Läsbart svenskt kalenderdatum, även när läsaren befinner sig i en annan zon. */
export function formatSwedishDate(date: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: SWEDISH_TIME_ZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

/** Kalenderdatum kodat som UTC-midnatt för dagaritmetik, INTE en lokal tidpunkt. */
export function swedishCalendarDate(date: Date): Date {
  const p = parts(date)
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day))
}

/** Kalenderdagar, inte golv(24-timmarsperioder): DST-dygn kan ha 23 eller 25 timmar. */
export function swedishDaysBetween(from: Date, to: Date): number {
  return (swedishCalendarDate(to).getTime() - swedishCalendarDate(from).getTime()) / 86_400_000
}

/** Verklig tidpunkt för dagens svenska midnatt, för DateTime-filter i DB. */
export function startOfSwedishDay(now: Date): Date {
  const target = swedishCalendarDate(now).getTime()
  let instant = target
  // Lös lokal midnatt med zonens offset vid tidpunkten. Om offseten ändras
  // mellan första uppskattningen och midnatt korrigerar nästa varv den.
  for (let i = 0; i < 2; i++) {
    const p = parts(new Date(instant))
    const civil = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
    instant += target - civil
  }
  return new Date(instant)
}
