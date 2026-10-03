import { useState } from 'react'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { formatCurrency, formatDate } from '@eken/shared'
import { extractApiError } from '@/lib/api'
import { useCanWrite } from '@/hooks/useCanWrite'
import { useImportStops, useResolveImportStop } from '../hooks/useReconciliation'
import type { Importstopp } from '../api/reconciliation.api'

// IMPORTSTOPP-009 (FORTNOX-100): kända, olösta importstopp — pengar som en bankimport inte
// tog in. Så länge något stopp är olöst är automatiska krav (påminnelse, avgift, ränta,
// kundförlust) pausade för hela organisationen. Kortet visar det filen faktiskt sa; ett
// fält filen inte anger visas som okänt. Upplösning kräver en motivering och sparas som
// historik (vem, när, varför) — inget försvinner.

const OMFATTNING: Record<Importstopp['scope'], string> = {
  FIL: 'Hela filen',
  AVSNITT: 'Ett avsnitt',
  BETALARE: 'En betalare',
}

const okänt = <span className="text-gray-400">okänt</span>

function Fält({ etikett, children }: { etikett: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{etikett}</p>
      <p className="mt-0.5 break-words text-[13px] text-gray-800">{children}</p>
    </div>
  )
}

function StoppRad({ stopp, kanLösa }: { stopp: Importstopp; kanLösa: boolean }) {
  const [öppen, setÖppen] = useState(false)
  const [motivering, setMotivering] = useState('')
  const lös = useResolveImportStop()
  const fel = lös.error ? extractApiError(lös.error, 'Stoppet kunde inte markeras.') : null
  const löst = stopp.resolvedAt !== null

  return (
    <li className="border-b border-gray-100 px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-[13px] font-semibold text-gray-800">
          {OMFATTNING[stopp.scope]} importerades inte
        </p>
        {löst ? (
          <span className="inline-flex items-center gap-1 text-[12px] text-emerald-700">
            <CheckCircle2 size={13} /> Hanterat {formatDate(stopp.resolvedAt!)}
          </span>
        ) : null}
      </div>
      <p className="mt-1 break-words text-[12.5px] text-gray-600">{stopp.message}</p>
      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Fält etikett="Konto">{stopp.bankAccount?.name ?? okänt}</Fält>
        <Fält etikett="Fil">{stopp.fileName}</Fält>
        <Fält etikett="Betalningsdag">
          {stopp.paymentDate ? formatDate(stopp.paymentDate) : okänt}
        </Fält>
        <Fält etikett="Belopp">{stopp.amount !== null ? formatCurrency(stopp.amount) : okänt}</Fält>
        {stopp.reference || stopp.payerBankgiro ? (
          <>
            <Fält etikett="Referens">{stopp.reference ?? okänt}</Fält>
            <Fält etikett="Betalarens bankgiro">{stopp.payerBankgiro ?? okänt}</Fält>
          </>
        ) : null}
      </div>
      {löst ? (
        <p className="mt-2 text-[12px] text-gray-500">Motivering: {stopp.resolutionNote}</p>
      ) : kanLösa ? (
        öppen ? (
          <div className="mt-3">
            <label className="text-[12px] font-medium text-gray-700" htmlFor={`motiv-${stopp.id}`}>
              Hur har stoppet hanterats?
            </label>
            <textarea
              id={`motiv-${stopp.id}`}
              value={motivering}
              onChange={(e) => setMotivering(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-[13px] focus:border-[#218F52] focus:outline-none focus:ring-2 focus:ring-[#218F52]/20"
              placeholder="T.ex. betalningen registrerad manuellt mot kreditfakturan"
            />
            {fel ? (
              <p role="alert" className="mt-1 text-[12px] text-red-600">
                {fel}
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="primary"
                disabled={motivering.trim().length < 10}
                loading={lös.isPending}
                onClick={() => lös.mutate({ id: stopp.id, note: motivering })}
              >
                Markera hanterat
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setÖppen(false)}>
                Avbryt
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-2">
            <Button size="xs" variant="outline" onClick={() => setÖppen(true)}>
              Markera hanterat…
            </Button>
          </div>
        )
      ) : null}
    </li>
  )
}

export function ImportStopsCard() {
  const [visaHistorik, setVisaHistorik] = useState(false)
  const kanLösa = useCanWrite()
  const öppna = useImportStops('open')
  const alla = useImportStops('all')
  const olösta = öppna.data ?? []
  const lösta = (alla.data ?? []).filter((s) => s.resolvedAt !== null)

  if (olösta.length === 0 && lösta.length === 0) return null

  return (
    <section
      aria-label="Importstopp"
      className="mb-5 overflow-hidden rounded-2xl border border-amber-200 bg-white"
    >
      <header className="flex flex-wrap items-start gap-3 bg-amber-50 px-4 py-3">
        <AlertTriangle size={18} className="mt-0.5 flex-shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold text-gray-900">Importstopp</h2>
          <p className="text-[12.5px] text-gray-700">
            {olösta.length > 0
              ? `${olösta.length} olöst(a) importstopp. Pengar som en bankimport inte tog in. ` +
                'Påminnelser, avgifter, ränta och kravsteg är pausade för hela organisationen ' +
                'tills stoppen markerats hanterade.'
              : 'Inga olösta importstopp. Hanterade stopp finns i historiken.'}
          </p>
        </div>
        {lösta.length > 0 ? (
          <Button size="xs" variant="ghost" onClick={() => setVisaHistorik((v) => !v)}>
            {visaHistorik ? 'Dölj historik' : `Historik (${lösta.length})`}
          </Button>
        ) : null}
      </header>
      {olösta.length > 0 ? (
        <ul>
          {olösta.map((s) => (
            <StoppRad key={s.id} stopp={s} kanLösa={kanLösa} />
          ))}
        </ul>
      ) : null}
      {visaHistorik ? (
        <ul className="border-t border-gray-100 bg-gray-50/50">
          {lösta.map((s) => (
            <StoppRad key={s.id} stopp={s} kanLösa={false} />
          ))}
        </ul>
      ) : null}
    </section>
  )
}
