import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { extractApiError } from '@/lib/api'
import { useAuthStore } from '@/stores/auth.store'
import { getFortnoxSeriesCatalog } from '@/features/settings/api/fortnox-export.api'
import { approveActivation, fetchActivation, revokeActivation } from '../api/kundstart.api'

/**
 * KUNDSTART-001 §6: kontrollerad Fortnox-skrivning till ERT företag. Av som standard.
 * Ägaren läser konsekvenstexten och godkänner exakt den (servern binder till dess sha).
 * Varje ändring av anslutning, serie, mappning, brytdatum eller öppning upphäver beslutet.
 */
export function FortnoxCustomerActivationPanel() {
  const user = useAuthStore((s) => s.user)
  const org = useAuthStore((s) => s.organization)
  return <Scoped key={`${org?.id ?? '-'}|${user?.id ?? '-'}|${user?.role ?? '-'}`} />
}

function Scoped() {
  const role = useAuthStore((s) => s.user?.role)
  const isOwner = role === 'OWNER'
  const kanLasa = role === 'OWNER' || role === 'ADMIN' || role === 'ACCOUNTANT'
  const qc = useQueryClient()
  const [ar, setAr] = useState<number | null>(null)
  const [last, setLast] = useState(false)
  const arLista = useQuery({
    queryKey: ['kundaktivering', 'ar'],
    queryFn: () => getFortnoxSeriesCatalog(null),
    enabled: isOwner || role === 'ADMIN',
    retry: false,
  })
  const status = useQuery({
    queryKey: ['kundaktivering', ar],
    queryFn: () => fetchActivation(ar),
    enabled: kanLasa,
    retry: false,
  })
  const refresh = () =>
    qc
      .invalidateQueries({ queryKey: ['kundaktivering'] })
      .then(() => qc.invalidateQueries({ queryKey: ['fortnox'] }))
  const godkann = useMutation({
    mutationFn: () =>
      approveActivation({
        financialYearId: ar!,
        consequencesSha256: status.data!.forslag.textSha256!,
      }),
    onSuccess: async () => {
      setLast(false)
      await refresh()
    },
  })
  const aterkalla = useMutation({ mutationFn: revokeActivation, onSuccess: refresh })

  if (!kanLasa) return null
  if (status.isLoading) return <p className="text-ink-muted text-sm">Hämtar kundaktivering…</p>
  if (status.isError || !status.data)
    return (
      <p className="text-sm text-red-600">
        {extractApiError(status.error, 'Kundaktiveringen kunde inte hämtas.')}
      </p>
    )
  const s = status.data
  const fel = godkann.error ?? aterkalla.error

  return (
    <section
      aria-label="Kundaktivering av Fortnox-skrivning"
      className="border-line min-w-0 space-y-3 rounded-2xl border bg-white p-5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-ink text-[15px] font-semibold">
          Kundaktivering – skrivning till ert Fortnox
        </h3>
        {s.aktiv ? <Badge variant="success">Aktiv</Badge> : <Badge>Inte aktiv</Badge>}
      </div>
      {!s.flaggaPa && (
        <p className="text-sm text-amber-700">
          Skrivning till kundföretag är avstängd i denna miljö (driftflaggan är av). Inget kan
          skickas, oavsett beslut här.
        </p>
      )}
      {s.aktiv ? (
        <div className="space-y-2">
          <p className="text-ink text-sm">
            Eveno får skicka verifikat från brytdatum, ett i taget efter uttrycklig bekräftelse.
            Återkallelse stoppar nya sändningar och köade rader; ett verifikat som redan skrivits i
            Fortnox tas inte bort av en återkallelse.
          </p>
          {isOwner && (
            <Button
              size="sm"
              variant="secondary"
              loading={aterkalla.isPending}
              onClick={() => aterkalla.mutate()}
            >
              Återkalla
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {s.aktivHinder && s.historik.length > 0 && (
            <p className="text-ink-muted text-[12px]">
              Senaste beslutet gäller inte: {s.aktivHinder}
            </p>
          )}
          <label className="text-ink block text-sm">
            <span className="mb-1 block text-[12px] font-medium">Räkenskapsår i Fortnox</span>
            <select
              aria-label="Räkenskapsår för kundaktivering"
              value={ar ?? ''}
              onChange={(e) => {
                setAr(e.target.value ? Number(e.target.value) : null)
                setLast(false)
              }}
              className="w-full max-w-xs rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
            >
              <option value="">Välj räkenskapsår</option>
              {(arLista.data?.financialYears ?? []).map((y) => (
                <option key={y.id} value={y.id}>
                  {y.from} – {y.to}
                </option>
              ))}
            </select>
          </label>
          {s.forslag.hinder.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm text-red-700">
              {s.forslag.hinder.map((h) => (
                <li key={h} className="break-words">
                  {h}
                </li>
              ))}
            </ul>
          )}
          {s.forslag.ok && s.forslag.text && (
            <>
              <pre className="whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-3 text-[12.5px] text-gray-800">
                {s.forslag.text}
              </pre>
              {isOwner ? (
                <>
                  <label className="text-ink flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={last}
                      onChange={(e) => setLast(e.target.checked)}
                    />
                    <span>Jag har läst konsekvenserna ovan och godkänner exakt dem.</span>
                  </label>
                  <Button
                    size="sm"
                    disabled={!last || ar === null}
                    loading={godkann.isPending}
                    onClick={() => godkann.mutate()}
                  >
                    Aktivera skrivning till Fortnox
                  </Button>
                </>
              ) : (
                <p className="text-ink-muted text-[12px]">
                  Bara ägaren (OWNER) beslutar om aktivering.
                </p>
              )}
            </>
          )}
        </div>
      )}
      {fel && (
        <p role="alert" className="text-sm text-red-600">
          {extractApiError(fel, 'Åtgärden misslyckades.')}
        </p>
      )}
      {s.historik.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer">Historik ({s.historik.length})</summary>
          <ul className="mt-2 space-y-1">
            {s.historik.map((h) => (
              <li key={h.id} className="text-ink-muted break-words text-[12px]">
                {h.approvedAt.slice(0, 16).replace('T', ' ')} · {h.status} · år {h.financialYearId}{' '}
                · serie {h.voucherSeries}
                {h.invalidatedReason ? ` · ${h.invalidatedReason}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
