import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { UpdateReadingReviewFollowUpSchema } from '@eken/shared'
import type { ReadingReviewFollowUpStatus, UpdateReadingReviewFollowUpInput } from '@eken/shared'
import { Button } from '@/components/ui/Button'
import { useCurrentRole } from '@/hooks/useCanWrite'
import { kontraktsfel } from '@/lib/contract-gate'
import {
  getReadingReviewFollowUp,
  updateReadingReviewFollowUp,
} from '../api/reading-review-follow-up.api'

const QUERY_KEY = ['reading-review-follow-up'] as const
const time = (value: string) =>
  new Intl.DateTimeFormat('sv-SE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Stockholm',
  }).format(new Date(value))

export function followUpState(
  status: ReadingReviewFollowUpStatus,
  now: number,
): 'off' | 'failed' | 'overdue' | 'waiting' | 'checked' {
  if (!status.enabled) return 'off'
  const checked = status.lastCheckedAt ? Date.parse(status.lastCheckedAt) : 0
  const failed = status.lastFailedAt ? Date.parse(status.lastFailedAt) : 0
  if (failed && failed >= checked) return 'failed'
  const latest = Math.max(checked, status.enabledAt ? Date.parse(status.enabledAt) : 0)
  // 26 timmar rymmer även höstens 25-timmarsdygn och mindre schemadröjsmål.
  if (!latest || now - latest > 26 * 60 * 60 * 1000) return 'overdue'
  return checked ? 'checked' : 'waiting'
}

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
  const state = status ? followUpState(status, now) : null
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
        Kontrollerar granskningskön varje dag kl. 07.15 svensk tid. Ägare, administratörer och
        förvaltare får en samlad notis i appen när varningar behöver bedömas.
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
            {state === 'off'
              ? 'Automatisk uppföljning är avstängd.'
              : state === 'waiting'
                ? 'Påslagen – väntar på första automatiska kontrollen.'
                : state === 'checked'
                  ? 'Automatisk uppföljning är påslagen.'
                  : state === 'failed'
                    ? 'Den senaste automatiska kontrollen misslyckades. Kontrollera underlaget här nedanför.'
                    : 'Den automatiska kontrollen är försenad. Senaste resultatet kan vara inaktuellt.'}
          </p>
          {status.lastCheckedAt && (
            <p className="mt-2 text-sm text-gray-600">
              Senast genomförd: {time(status.lastCheckedAt)} (svensk tid).
            </p>
          )}
          {status.lastFailedAt && (
            <p className="mt-2 text-sm text-gray-600">
              Senast misslyckad: {time(status.lastFailedAt)} (svensk tid).
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
