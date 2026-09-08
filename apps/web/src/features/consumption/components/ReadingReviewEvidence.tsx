import { formatDate } from '@eken/shared'
import type { ReadingFinding, ReadingRate } from '../lib/reading-review'

const number = (value: number) => value.toLocaleString('sv-SE', { maximumFractionDigits: 6 })
// Felaktiga datum hör till det underlag användaren ska kunna granska.
const date = (value: string) =>
  Number.isFinite(Date.parse(value)) ? formatDate(value) : `Ogiltigt datum: ${value || '(tomt)'}`
const raw = (value: string | number) => String(value).trim() || '(tomt värde)'
const checks: Record<ReadingFinding['code'], string> = {
  DATA: 'Jämför värdet och periodens datum med originalunderlaget.',
  OVERLAP:
    'Kontrollera om samma period har registrerats flera gånger eller om periodgränserna blivit fel.',
  DECREASE:
    'Jämför med originalavläsningarna och kontrollera om ett dokumenterat mätarbyte förklarar minskningen.',
  HIGH_RATE:
    'Jämför med originalavläsningen. Kontrollera om säsong eller ändrad användning förklarar ökningen innan du bedömer den som ett fel.',
}

function RateEvidence({ entry, label }: { entry: ReadingRate; label: string }) {
  return (
    <li className="rounded-xl border border-gray-200 bg-white p-4">
      <p className="text-sm font-medium text-gray-900">{label}</p>
      <p className="mt-1 text-xs text-gray-600">
        {entry.previousReading ? 'Mellan periodsluten' : 'Period'}:{' '}
        {date(entry.previousReading?.periodEnd ?? entry.reading.periodStart)} –{' '}
        {date(entry.reading.periodEnd)}
      </p>
      <p className="mt-2 text-sm text-gray-700">
        {entry.previousReading ? (
          <>
            {raw(entry.reading.value)} − {raw(entry.previousReading.value)} ={' '}
            {number(entry.quantity)} mätenheter
          </>
        ) : (
          <>{number(entry.quantity)} mätenheter under perioden</>
        )}
      </p>
      <p className="mt-1 text-sm text-gray-700">
        {number(entry.quantity)} / {number(entry.days)} {entry.days === 1 ? 'dag' : 'dagar'} ={' '}
        {number(entry.perDay)} mätenheter/dag
      </p>
    </li>
  )
}

interface ReadingReviewEvidenceProps {
  finding: ReadingFinding
}

/** Underlaget kommer från samma beräkning som varningen; inga nya läsningar eller skrivningar. */
export function ReadingReviewEvidence({ finding }: ReadingReviewEvidenceProps) {
  return (
    <details className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
      <summary className="cursor-pointer text-sm font-medium text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4">
        Visa underlag och kontrollsteg
      </summary>
      <div className="mt-4 space-y-5">
        {finding.trend && (
          <section aria-label="Beräkning för varningen">
            <h4 className="text-sm font-semibold text-gray-900">Så räknades jämförelsen</h4>
            <p className="mt-2 text-sm text-gray-600">
              Medianen är {number(finding.trend.median)} mätenheter/dag. Varningsgränsen är{' '}
              {number(finding.trend.threshold)} mätenheter/dag (3 × medianen).
            </p>
            <p className="mt-2 text-xs text-gray-600">
              Periodvolym räknar inklusive start- och slutdag. Mätarställningar jämförs som
              differens mellan periodsluten. Visade beräkningar är avrundade till högst sex
              decimaler.
            </p>
            <ol className="mt-3 grid gap-3 sm:grid-cols-2">
              {finding.trend.comparison.map((entry, i) => (
                <RateEvidence
                  key={entry.reading.id}
                  entry={entry}
                  label={`Jämförelseperiod ${i + 1}`}
                />
              ))}
              <RateEvidence entry={finding.trend.current} label="Avläsningen med varning" />
            </ol>
          </section>
        )}
        <section aria-label="Avläsningar i underlaget">
          <h4 className="text-sm font-semibold text-gray-900">Registrerade avläsningar</h4>
          <ul className="mt-3 space-y-2">
            {finding.sourceReadings.map((r) => (
              <li key={r.id} className="rounded-lg bg-gray-50 p-3 text-sm text-gray-700">
                <p className="font-medium">
                  {r.readingType === 'CUMULATIVE' ? 'Mätarställning' : 'Periodvolym'}:{' '}
                  {raw(r.value)} mätenheter
                </p>
                <p className="mt-1 text-xs">
                  {date(r.periodStart)} – {date(r.periodEnd)}
                </p>
              </li>
            ))}
          </ul>
        </section>
        <section aria-label="Kontrollsteg">
          <h4 className="text-sm font-semibold text-gray-900">Kontrollera detta</h4>
          <p className="mt-2 text-sm text-gray-700">{checks[finding.code]}</p>
          <p className="mt-2 text-xs text-gray-600">
            Det här är underlag för din bedömning. Att öppna vyn godkänner eller ändrar ingenting.
          </p>
        </section>
      </div>
    </details>
  )
}
