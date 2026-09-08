import { ReadingReviewEvidence } from './ReadingReviewEvidence'
import { useReadingReview } from '../hooks/useReadingReview'
import type { ReadingReviewReport } from '@eken/shared'
import { LoadErrorState } from '@/components/ui/LoadErrorState'
import { PermissionDeniedState } from '@/components/ui/PermissionDeniedState'
import { isForbidden } from '@/lib/api'

export function ReadingReviewContent({
  report,
  meterLabel,
}: {
  report: ReadingReviewReport
  meterLabel: (id: string) => string
}) {
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
      </div>
      {report.total === 0 ? (
        <p className="rounded-xl bg-white p-5 text-sm text-gray-600">
          Inga avläsningar att granska ännu.
        </p>
      ) : report.findings.length === 0 ? (
        <p className="rounded-xl bg-white p-5 text-sm text-gray-600">
          Inga avvikelser hittades av dessa kontroller. Avläsningar utan tillräcklig historik har
          inte trendbedömts.
        </p>
      ) : (
        <ul className="space-y-3">
          {report.findings.map((f) => (
            <li
              key={`${f.readingId}-${f.code}`}
              className="rounded-xl border border-amber-200 bg-amber-50 p-5"
            >
              <h3 className="font-medium text-gray-900">{meterLabel(f.meterId)}</h3>
              <p className="mt-1 text-sm text-gray-700">{f.explanation}</p>
              <p className="mt-2 text-xs text-gray-600">
                Period:{' '}
                {f.sourceReadings.find((r) => r.id === f.readingId)?.periodStart.slice(0, 10)} –{' '}
                {f.sourceReadings.find((r) => r.id === f.readingId)?.periodEnd.slice(0, 10)}
              </p>
              <ReadingReviewEvidence finding={f} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function ReadingReview({ meterLabel }: { meterLabel: (id: string) => string }) {
  // API:t äger underlaget. Listflikens datumfilter får inte klippa trendhistoriken.
  const query = useReadingReview()
  if (query.isError)
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
  return <ReadingReviewContent report={query.data} meterLabel={meterLabel} />
}
