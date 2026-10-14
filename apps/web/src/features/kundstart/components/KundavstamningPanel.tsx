import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import type {
  OpeningEvidenceDifference,
  OpeningEvidenceListView,
  OpeningEvidenceView,
} from '@eken/shared'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { extractApiError } from '@/lib/api'
import { useAuthStore } from '@/stores/auth.store'
import { createEvidence, fetchEvidence, kr, reviewEvidence } from '../api/kundstart.api'
import type { PackageStatus } from '../api/kundstart.api'

/**
 * KUNDSTART-205 (R165-3): kundavstämning mot det tidigare systemets reskontra.
 *
 * Servern jämför importen dokument för dokument och kund för kund mot en SEPARAT export,
 * lagrar underlaget oföränderligt och binder granskning och godkännande till exakt den
 * versionen. Den här vyn visar bara serverns resultat — den kan aldrig själv göra ett
 * underlag "granskat" eller "godkänt", och en lika totalsumma ersätter aldrig
 * dokumentjämförelsen.
 */

export const evidensNyckel = (packageId: string) => ['kundstart', 'evidens', packageId] as const

export function useKundavstamning(packageId: string) {
  return useQuery({
    queryKey: evidensNyckel(packageId),
    queryFn: () => fetchEvidence(packageId),
    retry: false,
  })
}

/**
 * Varför ägaren inte kan godkänna ännu. Tom lista = inget hinder SOM VYN SER; servern
 * prövar allt igen under lås och kan fortfarande neka.
 */
export function godkannandeHinder(
  list: OpeningEvidenceListView | undefined,
  userId: string | undefined,
): string[] {
  const a = list?.aktuell
  if (!a)
    return [
      'Ingen kundavstämning finns. Ägaren eller en administratör laddar upp det tidigare systemets reskontra och mappningen.',
    ]
  const skal: string[] = []
  if (a.comparisonStatus === 'STOPP')
    skal.push('Kundavstämningen är stoppad. Rätta underlaget och jämför igen.')
  if (a.comparisonStatus === 'AVVIKELSE')
    skal.push('Kundavstämningen visar avvikelser per dokument eller kund.')
  if (!a.artefaktKontroll.kallaOk || !a.artefaktKontroll.mappningOk)
    skal.push('De lagrade underlagen stämmer inte med sina kontrollsummor.')
  if (!a.granskning) skal.push('Väntar på ekonomigranskarens granskning.')
  else if (userId && a.granskning.reviewerUserId === userId)
    skal.push('Du har själv granskat underlaget. En annan användare måste godkänna.')
  for (const s of a.giltighet.skal) if (!skal.includes(s)) skal.push(s)
  if (!a.giltighet.forGodkannande && skal.length === 0)
    skal.push('Underlaget gäller inte längre det aktuella paketet. Jämför igen.')
  return skal
}

const STATUS_TEXT: Record<OpeningEvidenceView['comparisonStatus'], string> = {
  OK: 'Stämmer per dokument och kund',
  AVVIKELSE: 'Avvikelser',
  STOPP: 'Stoppad',
}

function varde(d: OpeningEvidenceDifference, v: string | number | null): string {
  if (v === null) return 'saknas'
  if (typeof v === 'number' && /ore|belopp|summa/i.test(d.falt)) return kr(v)
  return String(v)
}

function datum(iso: string) {
  return iso.slice(0, 10)
}

export function KundavstamningPanel({
  packageId,
  packageStatus,
}: {
  packageId: string
  packageStatus: PackageStatus
}) {
  const user = useAuthStore((s) => s.user)
  const role = user?.role
  const kanLadda = (role === 'OWNER' || role === 'ADMIN') && packageStatus === 'VALIDATED'
  const arGranskare = role === 'ACCOUNTANT'
  const qc = useQueryClient()
  const q = useKundavstamning(packageId)
  const refresh = () => qc.invalidateQueries({ queryKey: ['kundstart'] })

  const [produkt, setProdukt] = useState('')
  const [foretag, setForetag] = useState('')
  const [omfattning, setOmfattning] = useState('')
  const [kallOrgnr, setKallOrgnr] = useState('')
  const [avstamningsdag, setAvstamningsdag] = useState('')
  const [exporttid, setExporttid] = useState('')
  const [ansvarig, setAnsvarig] = useState('')
  const [kalla, setKalla] = useState<{ namn: string; text: string } | null>(null)
  const [mappning, setMappning] = useState<{ namn: string; text: string } | null>(null)

  const ladda = useMutation({
    mutationFn: () =>
      createEvidence(packageId, {
        sourceSystemProduct: produkt,
        sourceCompanyKey: foretag,
        scopeDeclaration: omfattning,
        sourceOrgNumber: kallOrgnr,
        sourceAsOfDate: avstamningsdag,
        // datetime-local saknar tidszon; skicka som UTC-tid.
        sourceExportedAt: new Date(exporttid).toISOString(),
        scopeResponsible: ansvarig,
        sourceName: kalla!.namn,
        sourceContent: kalla!.text,
        mappingName: mappning!.namn,
        mappingContent: mappning!.text,
      }),
    onSuccess: refresh,
  })
  const granska = useMutation({
    mutationFn: (a: OpeningEvidenceView) =>
      reviewEvidence(packageId, a.id, { evidenceSha256: a.evidenceSha256 }),
    onSuccess: refresh,
  })

  const lasFil =
    (sattare: (v: { namn: string; text: string }) => void) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0]
      if (f) void f.text().then((text) => sattare({ namn: f.name, text }))
      e.target.value = ''
    }

  const a = q.data?.aktuell ?? null

  return (
    <section
      data-testid="kundavstamning"
      className="space-y-3 rounded-xl border border-gray-100 p-3"
      aria-label="Kundavstämning"
    >
      <div>
        <h4 className="text-ink text-sm font-semibold">Kundavstämning mot tidigare reskontra</h4>
        <p className="text-ink-muted text-[12px]">
          Importen jämförs dokument för dokument och kund för kund med en separat export ur det
          tidigare systemet. En ekonomigranskare granskar resultatet, och därefter godkänner ägaren.
          Ett lika totalbelopp räcker inte.
        </p>
      </div>

      {q.isLoading && <p className="text-ink-muted text-sm">Läser kundavstämningen…</p>}
      {q.isError && (
        <p role="alert" className="text-sm text-red-600">
          {extractApiError(q.error, 'Kundavstämningen kunde inte läsas.')}
        </p>
      )}

      {q.isSuccess && !a && (
        <p className="text-ink-muted text-sm" data-testid="evidens-saknas">
          Ingen kundavstämning ännu.
        </p>
      )}

      {a && (
        <div className="space-y-2" data-testid="evidens-aktuell">
          <div className="flex flex-wrap items-center gap-2">
            <span data-testid="evidens-status" data-status={a.comparisonStatus}>
              <Badge variant={a.comparisonStatus === 'OK' ? 'success' : 'danger'}>
                {STATUS_TEXT[a.comparisonStatus]}
              </Badge>
            </span>
            <span className="text-ink-muted text-[12px]">
              Version {a.evidenceVersion} av underlaget, för paketversion {a.packageVersion}
            </span>
          </div>

          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-[13px] sm:grid-cols-2">
            <div>
              <dt className="text-ink-muted inline">Källa: </dt>
              <dd className="inline">
                {a.sourceSystemProduct}, företag {a.sourceCompanyKey}, per {a.sourceAsOfDate} (
                {a.sourceName})
              </dd>
            </div>
            <div>
              <dt className="text-ink-muted inline">Mappning: </dt>
              <dd className="inline">{a.mappingName}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-ink-muted inline">Uppgiven omfattning: </dt>
              <dd className="inline">
                {a.scopeDeclaration} (ansvarig: {a.scopeResponsible}; export{' '}
                {a.sourceExportedAt.slice(0, 16).replace('T', ' ')}, orgnr{' '}
                {a.declaredSourceOrgNumber})
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-ink-muted inline">Jämfört: </dt>
              <dd className="inline">
                {a.counts.dokumentKalla} dokument i källan, {a.counts.dokumentImport} i importen,{' '}
                {a.counts.matchade} stämmer, {a.counts.avvikelser} avvikelser, {a.counts.stopp}{' '}
                stopp
              </dd>
            </div>
          </dl>

          {(!a.artefaktKontroll.kallaOk || !a.artefaktKontroll.mappningOk) && (
            <p role="alert" className="text-sm text-red-600">
              De lagrade underlagen stämmer inte med sina kontrollsummor.
            </p>
          )}

          {a.stopp.length > 0 && (
            <div>
              <h5 className="text-ink text-[13px] font-semibold">Stopp</h5>
              <ul data-testid="evidens-stopp" className="list-disc pl-5 text-[13px]">
                {a.stopp.map((s, i) => (
                  <li key={i}>
                    {s.skal}
                    {s.fil && s.rad !== null && (
                      <span className="text-ink-muted">
                        {' '}
                        (
                        {s.fil === 'KALLA'
                          ? 'källan'
                          : s.fil === 'MAPPNING'
                            ? 'mappningen'
                            : 'importen'}{' '}
                        rad {s.rad})
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {a.avvikelser.length > 0 && (
            <div className="max-w-full overflow-x-auto">
              <table data-testid="evidens-avvikelser" className="w-full text-left text-[12px]">
                <thead>
                  <tr className="text-ink-muted">
                    <th className="pr-2">Gäller</th>
                    <th className="pr-2">Uppgift</th>
                    <th className="pr-2">Tidigare system</th>
                    <th className="pr-2">Importen</th>
                    <th>Vad som är fel</th>
                  </tr>
                </thead>
                <tbody>
                  {a.avvikelser.map((d, i) => (
                    <tr key={i} className="border-t border-gray-100 align-top">
                      <td className="pr-2">
                        {d.niva === 'DOKUMENT' ? `Dokument ${d.nyckel}` : `Kund ${d.kund ?? '–'}`}
                        {d.avtal ? `, avtal ${d.avtal}` : ''}
                        {d.typ === 'DEPOSIT' ? ' (deposition)' : ''}
                      </td>
                      <td className="pr-2">{d.falt}</td>
                      <td className="pr-2">{varde(d, d.kalla)}</td>
                      <td className="pr-2">{varde(d, d.import)}</td>
                      <td>{d.skal}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {a.comparisonStatus !== 'OK' && (
            <p className="text-[13px]" data-testid="evidens-atgard">
              {a.comparisonStatus === 'STOPP'
                ? 'Rätta källfilen eller mappningen enligt stoppen ovan och ladda upp underlaget igen.'
                : 'Rätta importen (en ny version av paketet) eller underlaget så att varje dokument och varje kund stämmer, och jämför igen.'}
            </p>
          )}

          <p className="text-[13px]" data-testid="evidens-granskning">
            {a.granskning ? (
              <span className="inline-flex items-center gap-1 text-emerald-700">
                <CheckCircle2 size={14} /> Granskad av{' '}
                {a.granskning.reviewerUserId === user?.id ? 'dig' : 'ekonomigranskaren'} den{' '}
                {datum(a.granskning.reviewedAt)}.
              </span>
            ) : (
              <span className="text-ink-muted">Inte granskad av ekonomigranskaren.</span>
            )}
          </p>

          {a.giltighet.skal.length > 0 && (
            <ul className="list-disc pl-5 text-[12px] text-amber-800">
              {a.giltighet.skal.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          )}

          {arGranskare && !a.granskning && (
            <div className="space-y-1">
              <p className="text-ink-muted text-[12px]">
                Din granskning gäller exakt den här versionen av underlaget och jämförelsen. Du kan
                inte godkänna eller verkställa paketet.
              </p>
              <Button
                size="sm"
                data-testid="evidens-granska"
                disabled={!a.giltighet.forGranskning}
                loading={granska.isPending}
                onClick={() => granska.mutate(a)}
              >
                Granska jämförelsen
              </Button>
              {granska.isError && (
                <p role="alert" className="text-sm text-red-600">
                  {extractApiError(granska.error, 'Granskningen nekades.')}
                </p>
              )}
            </div>
          )}

          <details className="text-[12px]">
            <summary className="text-ink-muted cursor-pointer">Teknisk identitet</summary>
            <p className="break-all">Underlagets kontrollsumma: {a.evidenceSha256}</p>
          </details>
        </div>
      )}

      {kanLadda && (
        <div className="space-y-2 border-t border-gray-100 pt-3" data-testid="evidens-ladda">
          <h5 className="text-ink text-[13px] font-semibold">Ladda upp underlag</h5>
          <p className="text-ink-muted text-[12px]">
            Format: EVENO-RESKONTRA-1 och EVENO-MAPPNING-1. Underlaget ska komma ur det tidigare
            systemet, inte ur Evenos import. En ny uppladdning ger en ny version som måste granskas
            på nytt.
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="text-[13px]">
              Tidigare system
              <input
                className="mt-0.5 w-full rounded-lg border border-gray-200 px-2 py-1"
                value={produkt}
                onChange={(e) => setProdukt(e.target.value)}
              />
            </label>
            <label className="text-[13px]">
              Företag i tidigare system
              <input
                className="mt-0.5 w-full rounded-lg border border-gray-200 px-2 py-1"
                value={foretag}
                onChange={(e) => setForetag(e.target.value)}
              />
            </label>
            <label className="text-[13px]">
              Källföretagets organisationsnummer
              <input
                className="mt-0.5 w-full rounded-lg border border-gray-200 px-2 py-1"
                placeholder="NNNNNN-NNNN"
                value={kallOrgnr}
                onChange={(e) => setKallOrgnr(e.target.value)}
              />
            </label>
            <label className="text-[13px]">
              Avstämningsdag (dagen före brytdatum)
              <input
                type="date"
                className="mt-0.5 w-full rounded-lg border border-gray-200 px-2 py-1"
                value={avstamningsdag}
                onChange={(e) => setAvstamningsdag(e.target.value)}
              />
            </label>
            <label className="text-[13px]">
              När exporten togs ut
              <input
                type="datetime-local"
                className="mt-0.5 w-full rounded-lg border border-gray-200 px-2 py-1"
                value={exporttid}
                onChange={(e) => setExporttid(e.target.value)}
              />
            </label>
            <label className="text-[13px]">
              Ansvarig för att exporten är fullständig
              <input
                className="mt-0.5 w-full rounded-lg border border-gray-200 px-2 py-1"
                value={ansvarig}
                onChange={(e) => setAnsvarig(e.target.value)}
              />
            </label>
            <label className="text-[13px] sm:col-span-2">
              Omfattning (vad exporten omfattar)
              <textarea
                className="mt-0.5 w-full rounded-lg border border-gray-200 px-2 py-1"
                rows={2}
                value={omfattning}
                onChange={(e) => setOmfattning(e.target.value)}
              />
            </label>
            <label className="text-[13px]">
              Reskontra (CSV) {kalla && <span className="text-ink-muted">– {kalla.namn}</span>}
              <input
                type="file"
                accept=".csv,text/csv,text/plain"
                aria-label="Reskontra ur tidigare system"
                className="mt-0.5 block w-full text-[12px]"
                onChange={lasFil(setKalla)}
              />
            </label>
            <label className="text-[13px]">
              Mappning (CSV) {mappning && <span className="text-ink-muted">– {mappning.namn}</span>}
              <input
                type="file"
                accept=".csv,text/csv,text/plain"
                aria-label="Mappning gammal kund och avtal till ny"
                className="mt-0.5 block w-full text-[12px]"
                onChange={lasFil(setMappning)}
              />
            </label>
          </div>
          <Button
            size="sm"
            disabled={
              !produkt ||
              !foretag ||
              !omfattning ||
              !kallOrgnr ||
              !avstamningsdag ||
              !exporttid ||
              !ansvarig ||
              !kalla ||
              !mappning
            }
            loading={ladda.isPending}
            onClick={() => ladda.mutate()}
          >
            Jämför och spara underlaget
          </Button>
          {ladda.isError && (
            <p role="alert" className="flex items-center gap-1 text-sm text-red-600">
              <AlertTriangle size={14} /> {extractApiError(ladda.error, 'Underlaget nekades.')}
            </p>
          )}
        </div>
      )}

      {q.data && q.data.tidigare.length > 0 && (
        <details className="text-[12px]" data-testid="evidens-historik">
          <summary className="text-ink-muted cursor-pointer">
            Tidigare versioner ({q.data.tidigare.length})
          </summary>
          <ul className="mt-1 space-y-0.5">
            {q.data.tidigare.map((t) => (
              <li key={t.id}>
                Version {t.evidenceVersion} ({datum(t.createdAt)}):{' '}
                {STATUS_TEXT[t.comparisonStatus]}
                {t.granskning ? `, granskad ${datum(t.granskning.reviewedAt)}` : ', inte granskad'}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
