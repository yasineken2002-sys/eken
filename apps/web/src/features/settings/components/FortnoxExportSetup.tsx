import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Input'
import { extractApiError } from '@/lib/api'
import { useAuthStore } from '@/stores/auth.store'
import { FortnoxExportList } from './FortnoxExportList'
import { FortnoxJournalPicker } from './FortnoxJournalPicker'
import {
  getFortnoxExportState,
  getFortnoxSeriesCatalog,
  saveFortnoxExportSettings,
} from '../api/fortnox-export.api'

export { EXPORT_NEXT_STEP, EXPORT_STATE_TEXT } from './fortnox-export-text'

/**
 * Export mot Fortnox huvudbok — kundval och lokal förhandskontroll. Sändning finns
 * inte i denna version. Visas endast för OWNER/ADMIN; servern kontrollerar igen.
 */
export function FortnoxExportSetup() {
  const user = useAuthStore((s) => s.user)
  const org = useAuthStore((s) => s.organization)
  // U01: en verklig gräns per organisation/användare/roll. Byte av scope monterar om
  // komponenten, så val, beslut och resultat från föregående scope kan aldrig visas
  // eller skickas, och sena svar från gammal scope landar i en avmonterad instans.
  return (
    <FortnoxExportSetupScoped key={`${org?.id ?? '-'}|${user?.id ?? '-'}|${user?.role ?? '-'}`} />
  )
}

function FortnoxExportSetupScoped() {
  const user = useAuthStore((s) => s.user)
  const org = useAuthStore((s) => s.organization)
  const allowed = user?.role === 'OWNER' || user?.role === 'ADMIN'
  const scope = [org?.id, user?.id, user?.role] as const
  const client = useQueryClient()
  const [yearId, setYearId] = useState<number | null>(null)
  const [series, setSeries] = useState('')
  const [omitConfirmed, setOmitConfirmed] = useState(false)

  const state = useQuery({
    queryKey: ['fortnox', 'export-state', ...scope],
    queryFn: getFortnoxExportState,
    enabled: allowed,
    retry: false,
  })
  // U04: verifierat aktiverad modul + aktiv anslutning + behörig scope styr allt.
  const active =
    allowed && state.data?.enabled === true && state.data?.connection?.status === 'ACTIVE'
  // Två frågor: årslistan står kvar medan serierna för valt år hämtas.
  const years = useQuery({
    queryKey: ['fortnox', 'export-years', ...scope],
    queryFn: () => getFortnoxSeriesCatalog(null),
    enabled: active,
    retry: false,
  })
  const catalog = useQuery({
    queryKey: ['fortnox', 'export-series', ...scope, yearId],
    queryFn: () => getFortnoxSeriesCatalog(yearId),
    enabled: active && yearId !== null,
    retry: false,
  })
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ['fortnox'] })
  }
  const saveSeries = useMutation({
    mutationFn: () => saveFortnoxExportSettings({ voucherSeries: series }),
    retry: false,
    onSuccess: refresh,
  })
  const saveOmit = useMutation({
    mutationFn: () => saveFortnoxExportSettings({ omitDimensions: true }),
    retry: false,
    onSuccess: refresh,
  })
  if (!allowed) return null
  if (state.isLoading) return <p className="text-ink-muted text-sm">Hämtar exportinställningar…</p>
  if (state.isError || !state.data)
    return <p className="text-sm text-red-600">Exportinställningarna kunde inte hämtas.</p>
  const conn = state.data.connection
  if (!active || !conn) return null
  const catalogProblem = years.isError || catalog.isError
  const catalogUsable =
    Boolean(years.data?.ready) && (yearId === null || Boolean(catalog.data?.ready))

  return (
    <section
      aria-label="Förhandskontroll av export till Fortnox"
      className="border-line min-w-0 space-y-4 rounded-2xl border bg-white p-5"
    >
      <div>
        <h3 className="text-ink text-[15px] font-semibold">
          Export till Fortnox – förhandskontroll
        </h3>
        {state.data.exports.sendingEnabled ? (
          <p className="text-ink-muted text-sm">
            Sändning är aktiverad för det anslutna företaget: testföretaget, eller ett kundföretag
            med ett giltigt ägarbeslut (se Kundaktivering ovan). Inget skickas förrän du
            uttryckligen bekräftar ett enskilt verifikat; förhandskontrollen visar först vad som
            skulle skickas.
          </p>
        ) : (
          <p className="text-ink-muted text-sm">
            Inget skickas till Fortnox. Förhandskontrollen visar om ett verifikat skulle kunna
            exporteras med dina val. Sändning är inte aktiverad.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <h4 className="text-ink text-sm font-semibold">1. Verifikatserie</h4>
        <p className="text-ink text-sm">
          Vald serie: {conn.exportVoucherSeries ?? 'ingen – välj nedan'}
        </p>
        {years.data?.ready && years.data.financialYears.length === 0 && (
          <p className="text-sm text-amber-600">
            Fortnox-företaget har inga räkenskapsår ännu. Lägg upp räkenskapsåret i Fortnox och
            hämta sedan om valen – serie kan inte väljas förrän ett år finns.
          </p>
        )}
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <Select
            label="Räkenskapsår i Fortnox"
            value={yearId === null ? '' : String(yearId)}
            options={[
              { value: '', label: 'Välj räkenskapsår' },
              ...(years.data?.financialYears ?? []).map((y) => ({
                value: String(y.id),
                label: `${y.from} – ${y.to}`,
              })),
            ]}
            onChange={(e) => {
              setYearId(e.target.value ? Number(e.target.value) : null)
              setSeries('')
            }}
          />
          <Select
            label="Serie i Fortnox"
            value={series}
            disabled={yearId === null || !catalog.data?.ready}
            options={[
              { value: '', label: 'Välj serie' },
              ...(yearId === null ? [] : (catalog.data?.voucherSeries ?? [])).map((s) => ({
                value: s.code,
                label: s.description ? `${s.code} – ${s.description}` : s.code,
              })),
            ]}
            onChange={(e) => setSeries(e.target.value)}
          />
        </div>
        {(years.isLoading || catalog.isFetching) && (
          <p className="text-ink-muted text-sm">Hämtar val från Fortnox…</p>
        )}
        {catalogProblem && (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-red-600">Fortnox-valen kunde inte hämtas.</p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void years.refetch().then(() => catalog.refetch())}
            >
              Försök igen
            </Button>
          </div>
        )}
        {!catalogProblem &&
        ((years.data && !years.data.ready) || (catalog.data && !catalog.data.ready)) ? (
          <p className="text-sm text-amber-600">
            {catalog.data?.reason ?? years.data?.reason ?? 'Fortnox-valen kunde inte verifieras.'}
          </p>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          disabled={
            !series ||
            saveSeries.isPending ||
            !catalogUsable ||
            catalogProblem ||
            catalog.isFetching
          }
          onClick={() => saveSeries.mutate()}
        >
          Spara serie
        </Button>
        {saveSeries.isError && (
          <p className="text-sm text-red-600">{extractApiError(saveSeries.error)}</p>
        )}
      </div>

      <div className="space-y-2">
        <h4 className="text-ink text-sm font-semibold">2. Kostnadsställe och projekt</h4>
        <p className="text-ink-muted text-sm">
          Evenos verifikat saknar kostnadsställe och projekt. Exporterade verifikat skulle därför
          sakna dimension i Fortnox och inte fördelas per fastighet där. Inget väljs åt dig.
        </p>
        <p className="text-ink text-sm">
          Beslut:{' '}
          {conn.exportOmitDimensions
            ? 'exportera utan kostnadsställe och projekt'
            : 'inget beslut – förhandskontrollen spärras'}
        </p>
        {!conn.exportOmitDimensions && (
          <>
            <label className="text-ink flex min-w-0 items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1 shrink-0"
                checked={omitConfirmed}
                onChange={(e) => setOmitConfirmed(e.target.checked)}
              />
              <span className="min-w-0 break-words">
                Jag väljer att exportera utan kostnadsställe och projekt.
              </span>
            </label>
            <Button
              size="sm"
              variant="secondary"
              disabled={!omitConfirmed || saveOmit.isPending}
              onClick={() => saveOmit.mutate()}
            >
              Spara beslut
            </Button>
          </>
        )}
        {saveOmit.isError && (
          <p className="text-sm text-red-600">{extractApiError(saveOmit.error)}</p>
        )}
      </div>

      <FortnoxJournalPicker onChanged={refresh} />

      <FortnoxExportList
        group="ALL"
        title="Förhandskontroller och sändningar"
        sendingEnabled={state.data.exports.sendingEnabled}
        onChanged={refresh}
      />
    </section>
  )
}
