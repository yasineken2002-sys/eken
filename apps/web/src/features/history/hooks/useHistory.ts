import { useQuery } from '@tanstack/react-query'
import { fetchGaps, fetchHistory, type HistoryDimension } from '../api/history.api'

/**
 * Disjunkta nycklar per dimension OCH per id — en invalidering av lägenhetens
 * historik får inte träffa hyresgästens.
 */
const HISTORY_KEY = (d: HistoryDimension, id: string) => ['history', 'events', d, id] as const
const GAPS_KEY = (d: HistoryDimension, id: string) => ['history', 'gaps', d, id] as const

export const historyQueryKeys = { events: HISTORY_KEY, gaps: GAPS_KEY }

/**
 * TVÅ FRÅGOR, INTE EN — och det är avsiktligt.
 *
 * Händelserna och luckorna är två endpoints i API:t. De hämtas därför var för
 * sig, och det ger gränssnittet något det annars inte kunde veta: SKILLNADEN
 * MELLAN "inga luckor" OCH "luckorna gick inte att hämta".
 *
 * Slogs de ihop till ett anrop hade ett fel i luckberäkningen antingen fällt
 * hela historiken, eller — värre — försvunnit tyst bakom en tidslinje som ser
 * komplett ut. Det andra är exakt den tystnad luckorna finns för att bryta.
 */
export function useHistoryEvents(dimension: HistoryDimension, id: string | null) {
  return useQuery({
    queryKey: id ? HISTORY_KEY(dimension, id) : ['history', 'events', dimension, '__disabled__'],
    queryFn: () => fetchHistory(dimension, id!),
    enabled: !!id,
  })
}

export function useHistoryGaps(dimension: HistoryDimension, id: string | null) {
  return useQuery({
    queryKey: id ? GAPS_KEY(dimension, id) : ['history', 'gaps', dimension, '__disabled__'],
    queryFn: () => fetchGaps(dimension, id!),
    enabled: !!id,
  })
}
