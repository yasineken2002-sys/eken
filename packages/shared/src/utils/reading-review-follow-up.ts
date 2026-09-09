import type { ReadingReviewFollowUpStatus } from '../schemas'

export const READING_REVIEW_FOLLOW_UP_SCHEDULE = {
  hour: 7,
  minute: 15,
  timeZone: 'Europe/Stockholm',
} as const

export function readingReviewFollowUpTime(value: string): string {
  return (
    new Intl.DateTimeFormat('sv-SE', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: READING_REVIEW_FOLLOW_UP_SCHEDULE.timeZone,
    }).format(new Date(value)) + ' (svensk tid)'
  )
}

/** Nästa SCHEMATID, inte ett löfte om att jobbet körs eller lyckas. */
export function nextReadingReviewFollowUp(now: Date): Date {
  const { hour, minute, timeZone } = READING_REVIEW_FOLLOW_UP_SCHEDULE
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const parts = (date: Date) => {
    const p = Object.fromEntries(
      formatter.formatToParts(date).map((part) => [part.type, part.value]),
    )
    return {
      year: Number(p.year),
      month: Number(p.month),
      day: Number(p.day),
      hour: Number(p.hour),
      minute: Number(p.minute),
    }
  }
  const today = parts(now)
  const atDay = (dayOffset: number) => {
    const utc = Date.UTC(today.year, today.month - 1, today.day + dayOffset, hour, minute)
    // 07.15 ligger efter Stockholms sommartidsbyte och finns exakt en gång
    // varje dag. Läs dagens verkliga UTC-offset; addera aldrig 24 timmar.
    const local = parts(new Date(utc))
    const offset = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - utc
    return new Date(utc - offset)
  }
  const candidate = atDay(0)
  return candidate.getTime() > now.getTime() ? candidate : atDay(1)
}

export const READING_REVIEW_FOLLOW_UP_MAX_AGE_HOURS = 26

/** Samma tillstånd i granskningsvyn och assistentens läsning. */
export function readingReviewFollowUpState(
  status: ReadingReviewFollowUpStatus,
  now: number,
): 'off' | 'failed' | 'overdue' | 'waiting' | 'checked' {
  if (!status.enabled) return 'off'
  const checked = status.lastCheckedAt ? Date.parse(status.lastCheckedAt) : 0
  const failed = status.lastFailedAt ? Date.parse(status.lastFailedAt) : 0
  if (failed && failed >= checked) return 'failed'
  const latest = Math.max(checked, status.enabledAt ? Date.parse(status.enabledAt) : 0)
  // 26 timmar rymmer även höstens 25-timmarsdygn och mindre schemadröjsmål.
  if (!latest || now - latest > READING_REVIEW_FOLLOW_UP_MAX_AGE_HOURS * 60 * 60 * 1000)
    return 'overdue'
  return checked ? 'checked' : 'waiting'
}

export const READING_REVIEW_FOLLOW_UP_STATE_LABELS = {
  off: 'Automatisk uppföljning är avstängd.',
  waiting: 'Påslagen – väntar på första automatiska kontrollen.',
  checked: 'Automatisk uppföljning är påslagen.',
  failed: 'Den senaste automatiska kontrollen misslyckades. Kontrollera underlaget i Granskning.',
  overdue: 'Den automatiska kontrollen är försenad. Senaste resultatet kan vara inaktuellt.',
} as const
