import { z } from 'zod'
import {
  ReadingReviewFollowUpStatusSchema,
  readingReviewFollowUpState,
  readingReviewFollowUpTime,
  nextReadingReviewFollowUp,
  READING_REVIEW_FOLLOW_UP_STATE_LABELS,
} from '@eken/shared'

const ReadResultSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: ReadingReviewFollowUpStatusSchema,
    observedAt: z.string().datetime(),
  }),
})

const LIMITS =
  'En utebliven notis bevisar inte att det saknas varningar. Statusen visar inte om en notis har levererats eller hur många varningar en tidigare kontroll hittade. Avläsningar eller debitering godkänns inte av denna status.'

/** Endast resultat från det faktiskt körda läsverktyget; aldrig modellens text. */
export function consumptionFollowUpFacts(result: unknown): string {
  const parsed = ReadResultSchema.safeParse(result)
  const heading = '\n\n────\nUppföljningsstatus från systemet\n'
  if (!parsed.success)
    return (
      heading +
      'Statusen kunde inte läsas. Den här läsningen ger inget besked om av/på eller kontrolltider. Öppna Förbrukning → Granskning för ett nytt försök.\n' +
      LIMITS
    )

  // Beräkna från de ursprungliga fyra kolumnerna och läsögonblicket. Kopiera
  // aldrig message, display, state, nästa tid eller fri text ur verktygssvaret.
  const { status, observedAt } = parsed.data.data
  const now = new Date(observedAt)
  const state = readingReviewFollowUpState(status, now.getTime())
  const time = (value: string | null) =>
    value ? readingReviewFollowUpTime(value) : 'Ingen tid registrerad'
  return (
    heading +
    [
      `Läst: ${time(observedAt)}. Uppgifterna gäller detta läsögonblick.`,
      READING_REVIEW_FOLLOW_UP_STATE_LABELS[state],
      `Senaste påslag: ${time(status.enabledAt)}.`,
      `Senaste lyckade kontroll: ${time(status.lastCheckedAt)}.`,
      `Senaste registrerade fel: ${time(status.lastFailedAt)}. Orsaken framgår inte av statusen.`,
      status.enabled
        ? `Nästa planerade schematid: ${time(nextReadingReviewFollowUp(now).toISOString())}. Det är ingen garanti om att jobbet körs eller lyckas.`
        : 'Ingen nästa schematid medan uppföljningen är avstängd. Avstängningstid finns inte i underlaget.',
      LIMITS,
      'Aktuella varningar finns i Förbrukning → Granskning. Statusläsningen ändrar inget och startar ingen kontroll.',
    ].join('\n')
  )
}

/**
 * Båda chattvägarna använder samma urval EFTER en färdig läsomgång.
 * Resultaten behåller anropsordningen även om de avslutas i annan ordning.
 * Ett senare fel ersätter en tidigare lyckad status; föregående tur återanvänds aldrig.
 */
export function followUpFactsFromRound(
  calls: readonly { id: string; name: string }[],
  results: readonly { tool_use_id: string; content?: unknown }[],
): string | undefined {
  const callsForStatus = calls.filter((call) => call.name === 'get_consumption_follow_up')
  if (!callsForStatus.length) return undefined
  const reads = callsForStatus.map((call) => {
    const content = results.find((result) => result.tool_use_id === call.id)?.content
    try {
      return typeof content === 'string' ? (JSON.parse(content) as unknown) : undefined
    } catch {
      return undefined
    }
  })
  // Samtidiga läsningar är inte en gemensam DB-snapshot. Vid olika underlag
  // väljer vi inte en godtycklig vinnare och presenterar den som aktuell.
  const valid = reads.map((read) => ReadResultSchema.safeParse(read))
  if (valid.some((read) => !read.success)) return consumptionFollowUpFacts(undefined)
  const states = valid.map((read) => (read.success ? JSON.stringify(read.data.data.status) : ''))
  if (new Set(states).size !== 1)
    return (
      '\n\n────\nUppföljningsstatus från systemet\nLäsningarna gav olika status. Öppna Förbrukning → Granskning för ett aktuellt besked.\n' +
      LIMITS
    )
  // Identiska kolumner: den senast observerade läsningen avgör färskheten.
  const newest = valid.reduce((a, b) =>
    a.success &&
    b.success &&
    Date.parse(b.data.data.observedAt) > Date.parse(a.data.data.observedAt)
      ? b
      : a,
  )
  return consumptionFollowUpFacts(newest.success ? newest.data : undefined)
}
