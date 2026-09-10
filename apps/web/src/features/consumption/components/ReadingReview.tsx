import { useId, useState } from 'react'
import {
  readingReviewQueue,
  ReadingReviewFilterSchema,
  READING_REVIEW_FILTER_LABELS,
} from '@eken/shared'
import type { ReadingReviewFilter, ReadingReviewSnapshot } from '@eken/shared'
import { useCanWrite } from '@/hooks/useCanWrite'
import { ReadingReviewAssessment, ReadingReviewHistory } from './ReadingReviewAssessment'
import { ReadingReviewEvidence } from './ReadingReviewEvidence'
import { useReadingReview } from '../hooks/useReadingReview'
import { LoadErrorState } from '@/components/ui/LoadErrorState'
import { PermissionDeniedState } from '@/components/ui/PermissionDeniedState'
import { isForbidden } from '@/lib/api'

export function ReadingReviewContent({
  report,
  meterLabel,
  canAssess = false,
  unavailable = false,
}: {
  canAssess?: boolean
  unavailable?: boolean
  report: ReadingReviewSnapshot
  meterLabel: (id: string) => string
}) {
  const filterId = useId()
  const [filter, setFilter] = useState<ReadingReviewFilter>('ALL')
  const [editing, setEditing] = useState<Record<string, ReadingReviewSnapshot['findings'][number]>>(
    {},
  )
  const queue = readingReviewQueue(report.findings, filter)
  const key = (f: ReadingReviewSnapshot['findings'][number]) => `${f.readingId}-${f.code}`
  const selected = new Set(queue.findings.map(key))
  // En bakgrundsuppdatering får inte kasta bort en påbörjad motivering när
  // någon annans bedömning flyttar raden ut ur det valda urvalet.
  const outside = report.findings.filter((f) => key(f) in editing && !selected.has(key(f)))
  const missing = Object.values(editing).filter(
    (f) => !report.findings.some((current) => key(current) === key(f)),
  )
  const visible = [...queue.findings, ...outside, ...missing]
  return (
    <section className="mt-6 space-y-4" aria-label="Granskning av avläsningar">
      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-gray-900">Avläsningar att kontrollera</h2>
        <p className="mt-2 text-sm text-gray-600">
          Granskningen visar möjliga avvikelser i alla hämtade avläsningar. Den ändrar inga värden,
          förbrukningsposter eller fakturor.
        </p>
        <p className="mt-2 text-sm text-gray-600">
          En ökning markeras från tre gånger medianen för tre tidigare jämförbara perioder, räknat
          per dag. Säsong och ändrad användning kan förklara en ökning.
        </p>
        <dl className="mt-5 grid gap-4 sm:grid-cols-3">
          {[
            ['Avläsningar', report.total],
            ['Trendbedömda', report.trendAssessed],
            ['Utan tillräcklig trendjämförelse', report.notTrendAssessed],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-gray-500">{label}</dt>
              <dd className="mt-1 text-2xl font-semibold text-gray-900">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-5 border-t border-gray-200 pt-4">
          <label htmlFor={filterId} className="block text-sm font-medium text-gray-900">
            Visa varningar
          </label>
          <select
            id={filterId}
            value={filter}
            className="mt-2 w-full rounded-lg border border-gray-300 bg-white p-2 text-sm sm:max-w-sm"
            onChange={(event) => {
              const parsed = ReadingReviewFilterSchema.safeParse(event.target.value)
              if (parsed.success) setFilter(parsed.data)
            }}
          >
            {ReadingReviewFilterSchema.options.map((value) => (
              <option key={value} value={value}>
                {READING_REVIEW_FILTER_LABELS[value]} ({queue.counts[value]})
              </option>
            ))}
          </select>
          <p className="mt-2 text-sm text-gray-600" role="status">
            Visar {queue.findings.length} av {queue.counts.ALL} varningar. {queue.counts.TO_ASSESS}{' '}
            behöver bedömas.
            {outside.length > 0 &&
              ` Dessutom visas ${outside.length} öppet formulär utanför urvalet.`}
          </p>
          <p className="mt-2 text-xs text-gray-600">
            Ändrat underlag visas först. Behöver bedömas omfattar även varningar som behöver
            utredas. En bedömd avvikelse är inte automatiskt åtgärdad eller godkänd för debitering.
          </p>
        </div>
      </div>
      {report.total === 0 && visible.length === 0 ? (
        <p className="rounded-xl bg-white p-5 text-sm text-gray-600">
          Inga avläsningar att granska ännu.
        </p>
      ) : report.findings.length === 0 && visible.length === 0 ? (
        <p className="rounded-xl bg-white p-5 text-sm text-gray-600">
          Inga avvikelser hittades av dessa kontroller. Avläsningar utan tillräcklig historik har
          inte trendbedömts.
        </p>
      ) : visible.length === 0 ? (
        <p className="rounded-xl bg-white p-5 text-sm text-gray-600">
          Inga varningar i detta urval. Övriga varningar finns under Alla varningar.
        </p>
      ) : (
        <ul className="space-y-3">
          {visible.map((f) => (
            <li
              key={`${f.readingId}-${f.code}`}
              className="rounded-xl border border-amber-200 bg-amber-50 p-5"
            >
              <h3 className="font-medium text-gray-900">{meterLabel(f.meterId)}</h3>
              {!selected.has(key(f)) && (
                <p className="mt-2 text-sm font-medium text-amber-900">
                  Utanför urvalet – formuläret är kvar så att din motivering inte försvinner.
                </p>
              )}
              <p className="mt-1 text-sm text-gray-700">{f.explanation}</p>
              <p className="mt-2 text-xs text-gray-600">
                Period:{' '}
                {f.sourceReadings.find((r) => r.id === f.readingId)?.periodStart.slice(0, 10)} –{' '}
                {f.sourceReadings.find((r) => r.id === f.readingId)?.periodEnd.slice(0, 10)}
              </p>
              <ReadingReviewEvidence finding={f} />
              <ReadingReviewAssessment
                finding={f}
                canAssess={canAssess}
                unavailable={unavailable || missing.some((old) => key(old) === key(f))}
                onEditingChange={(open) =>
                  setEditing((current) => {
                    const next = { ...current }
                    if (open) next[key(f)] = f
                    else delete next[key(f)]
                    return next
                  })
                }
              />
            </li>
          ))}
        </ul>
      )}
      <ReadingReviewHistory history={report.history} meterLabel={meterLabel} />
    </section>
  )
}

export function ReadingReview({ meterLabel }: { meterLabel: (id: string) => string }) {
  // API:t äger underlaget. Listflikens datumfilter får inte klippa trendhistoriken.
  const query = useReadingReview()
  const canAssess = useCanWrite()
  if (query.isError && !query.data)
    return isForbidden(query.error) ? (
      <PermissionDeniedState vad="avläsningarna" />
    ) : (
      <LoadErrorState vad="avläsningarna" onRetry={() => void query.refetch()} />
    )
  if (query.isLoading || !query.data)
    return (
      <p className="py-10 text-sm text-gray-500" role="status">
        Hämtar avläsningar för granskning…
      </p>
    )
  return (
    <>
      {query.isError && (
        <LoadErrorState
          vad="aktuella avläsningarna; ditt utkast finns kvar"
          onRetry={() => void query.refetch()}
        />
      )}
      <ReadingReviewContent
        report={query.data}
        meterLabel={meterLabel}
        canAssess={canAssess}
        unavailable={query.isError}
      />
    </>
  )
}
