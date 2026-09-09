import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  UpdateReadingReviewFollowUpSchema,
  readingReviewFollowUpState,
  readingReviewFollowUpTime,
  READING_REVIEW_FOLLOW_UP_SCHEDULE,
  READING_REVIEW_FOLLOW_UP_STATE_LABELS,
} from '@eken/shared'
import type { UpdateReadingReviewFollowUpInput } from '@eken/shared'
import { Button } from '@/components/ui/Button'
import { useCurrentRole } from '@/hooks/useCanWrite'
import { kontraktsfel } from '@/lib/contract-gate'
import {
  getReadingReviewFollowUp,
  updateReadingReviewFollowUp,
} from '../api/reading-review-follow-up.api'

const QUERY_KEY = ['reading-review-follow-up'] as const
export function ReadingReviewFollowUp() {
  const owner = useCurrentRole() === 'OWNER'
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    // Oförändrade API-svar delar samma query-data och behöver inte rendera om.
    // Klockan måste ändå kunna växla till försenat på en redan öppen sida.
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const qc = useQueryClient()
  const [contractError, setContractError] = useState<string | null>(null)
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: getReadingReviewFollowUp,
    refetchInterval: 60_000,
  })
  const save = useMutation({
    mutationFn: updateReadingReviewFollowUp,
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: QUERY_KEY })
    },
    onSuccess: (status) => qc.setQueryData(QUERY_KEY, status),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY })
    },
  })
  const status = query.data
  const state = status ? readingReviewFollowUpState(status, now) : null
  function toggle() {
    if (!status || save.isPending) return
    const dto: UpdateReadingReviewFollowUpInput = { enabled: !status.enabled }
    const error = kontraktsfel(UpdateReadingReviewFollowUpSchema, dto)
    setContractError(error)
    if (!error) save.mutate(dto)
  }
  return (
    <section
      aria-label="Automatisk uppföljning"
      className="mt-6 rounded-2xl border border-gray-200 bg-white p-5"
    >
      <h2 className="text-lg font-semibold text-gray-900">Automatisk uppföljning</h2>
      <p className="mt-2 text-sm text-gray-600">
        Kontrollerar granskningskön varje dag kl.{' '}
        {String(READING_REVIEW_FOLLOW_UP_SCHEDULE.hour).padStart(2, '0')}.
        {String(READING_REVIEW_FOLLOW_UP_SCHEDULE.minute).padStart(2, '0')} svensk tid. Ägare,
        administratörer och förvaltare får en samlad notis i appen när varningar behöver bedömas.
      </p>
      {query.isError ? (
        <div role="alert" className="mt-3 text-sm text-red-700">
          Inställningen och senaste kontrollen kunde inte hämtas.
          <Button onClick={() => void query.refetch()} className="mt-2">
            Försök igen
          </Button>
        </div>
      ) : !status ? (
        <p className="mt-3 text-sm text-gray-600" role="status">
          Hämtar uppföljning…
        </p>
      ) : (
        <>
          <p className="mt-3 text-sm font-medium text-gray-900" role="status">
            {state && READING_REVIEW_FOLLOW_UP_STATE_LABELS[state]}
          </p>
          {status.lastCheckedAt && (
            <p className="mt-2 text-sm text-gray-600">
              Senast genomförd: {readingReviewFollowUpTime(status.lastCheckedAt)}.
            </p>
          )}
          {status.lastFailedAt && (
            <p className="mt-2 text-sm text-gray-600">
              Senast misslyckad: {readingReviewFollowUpTime(status.lastFailedAt)}.
            </p>
          )}
          {owner ? (
            <Button className="mt-4" onClick={toggle} disabled={save.isPending}>
              {save.isPending
                ? 'Sparar…'
                : status.enabled
                  ? 'Stäng av automatisk uppföljning'
                  : 'Slå på automatisk uppföljning'}
            </Button>
          ) : (
            <p className="mt-3 text-xs text-gray-600">
              Organisationens ägare kan slå på eller stänga av uppföljningen.
            </p>
          )}
        </>
      )}
      {(save.isError || contractError) && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {contractError ?? 'Ändringen kunde inte bekräftas. Läs om inställningen och försök igen.'}
        </p>
      )}
      <p className="mt-3 text-xs text-gray-600">
        Kontrollen ändrar inga avläsningar, bedömningar eller fakturor. En genomförd kontroll är
        inget godkännande av mätvärden eller debitering. Bedömda avvikelser finns kvar i
        granskningskön.
      </p>
    </section>
  )
}
