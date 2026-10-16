import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { FortnoxAccountRole, FortnoxVatTreatment } from '@eken/shared'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Input'
import { extractApiError } from '@/lib/api'
import { useAuthStore } from '@/stores/auth.store'
import { getFortnoxCatalog } from '../api/fortnox.api'
import {
  approveFortnoxAccountMapping,
  createFortnoxAccountMappingDraft,
  getFortnoxAccountMapping,
  type FortnoxAccountMappingRevision,
} from '../api/fortnox-account-mapping.api'

export const ROLL_TEXT: Record<FortnoxAccountRole, string> = {
  KUNDFORDRAN: 'Kundfordran',
  HYRESINTAKT: 'Hyresintäkt',
  LIKVID: 'Bank',
  DEPOSITIONSSKULD: 'Depositionsskuld',
  KUNDTILLGODOSKULD: 'Kundtillgodoskuld',
  KOSTNAD: 'Kostnad',
  INGAENDE_MOMS: 'Ingående moms',
  LEVERANTORSSKULD: 'Leverantörsskuld',
}
export const BEHANDLING_TEXT: Record<FortnoxVatTreatment, string> = {
  EJ_TILLAMPLIG: 'ingen moms på raden',
  MOMSFRI: 'momsfri bostadshyra',
  AVDRAGSGILL: 'avdragsgill ingående moms',
}
const TEKNIK_TEXT = {
  FORENLIG: 'Tekniskt förenlig',
  KONFLIKT: 'Motsägelse – kan inte godkännas',
  EJ_BELAGD: 'Ej belagd – kan inte godkännas',
} as const
const STATUS_TEXT = { DRAFT: 'Utkast', APPROVED: 'Godkänd', SUPERSEDED: 'Ersatt' } as const

const nyckel = (r: { role: string; sourceAccountNumber: number; vatTreatment: string }) =>
  `${r.role}|${r.sourceAccountNumber}|${r.vatTreatment}`

/**
 * TESTKUND-008: kontomappning för Fortnox-export. Kunden väljer målkonto per (roll, Eveno-konto,
 * momsbehandling) — inget förval, inte heller samma nummer. Servern läser Fortnox, bedömer
 * tekniken och binder revisionen till anslutning och räkenskapsår. Godkännandet avser kontots
 * innebörd; Eveno rekommenderar inget konto, ingen momskod och ingen sats.
 */
export function FortnoxAccountMapping() {
  const user = useAuthStore((s) => s.user)
  const org = useAuthStore((s) => s.organization)
  return <Scoped key={`${org?.id ?? '-'}|${user?.id ?? '-'}|${user?.role ?? '-'}`} />
}

function Scoped() {
  const user = useAuthStore((s) => s.user)
  const org = useAuthStore((s) => s.organization)
  const kanSe = ['OWNER', 'ADMIN', 'ACCOUNTANT'].includes(user?.role ?? '')
  const kanAndra = user?.role === 'OWNER' || user?.role === 'ADMIN'
  const scope = [org?.id, user?.id, user?.role] as const
  const client = useQueryClient()
  const [ar, setAr] = useState<number | null>(null)
  const [val, setVal] = useState<Record<string, string>>({})
  const [fel, setFel] = useState<string | null>(null)

  const oversikt = useQuery({
    queryKey: ['fortnox', 'account-mapping', ...scope],
    queryFn: getFortnoxAccountMapping,
    enabled: kanSe,
    retry: false,
  })
  const ar0 = useQuery({
    queryKey: ['fortnox', 'account-mapping-years', ...scope],
    queryFn: () => getFortnoxCatalog(null),
    enabled: kanAndra,
    retry: false,
  })
  const katalog = useQuery({
    queryKey: ['fortnox', 'account-mapping-accounts', ...scope, ar],
    queryFn: () => getFortnoxCatalog(ar),
    enabled: kanAndra && ar !== null,
    retry: false,
  })
  const uppdatera = () => client.invalidateQueries({ queryKey: ['fortnox'] })
  const spara = useMutation({
    mutationFn: () =>
      createFortnoxAccountMappingDraft({
        financialYearId: ar!,
        rows: (oversikt.data?.behov ?? []).map((b) => ({
          role: b.role,
          vatTreatment: b.vatTreatment,
          sourceAccountNumber: b.sourceAccountNumber,
          targetAccountNumber: Number(val[nyckel(b)]),
        })),
      }),
    retry: false,
    onMutate: () => setFel(null),
    onError: (e) => setFel(extractApiError(e)),
    onSuccess: uppdatera,
  })
  const godkann = useMutation({
    mutationFn: (r: FortnoxAccountMappingRevision) =>
      approveFortnoxAccountMapping(r.id, { contentSha256: r.contentSha256 }),
    retry: false,
    onMutate: () => setFel(null),
    onError: (e) => setFel(extractApiError(e)),
    onSuccess: uppdatera,
  })

  if (!kanSe) return null
  if (oversikt.isLoading) return <p className="text-ink-muted text-sm">Hämtar kontomappningen…</p>
  if (oversikt.isError || !oversikt.data)
    return <p className="text-sm text-red-600">Kontomappningen kunde inte hämtas.</p>
  const { behov, ejStodda, revisioner } = oversikt.data
  const senaste = revisioner[0] ?? null
  const godkand = revisioner.find((r) => r.status === 'APPROVED') ?? null
  const konton = (katalog.data?.costAccounts ?? []).filter((k) => k.selectable)
  const allaValda = behov.length > 0 && behov.every((b) => /^\d{4}$/.test(val[nyckel(b)] ?? ''))

  return (
    <section
      aria-label="Kontomappning för export till Fortnox"
      className="border-line min-w-0 space-y-4 rounded-2xl border bg-white p-5"
    >
      <div className="space-y-1">
        <h3 className="text-ink text-[15px] font-semibold">
          Kontomappning för export till Fortnox
        </h3>
        <p className="text-ink-muted text-sm">
          Varje rad som exporteras måste ha ett uttryckligt godkänt Fortnox-konto för sin roll och
          momsbehandling. Ett lika kontonummer eller ett liknande namn är inget bevis på samma
          innebörd. Eveno ändrar aldrig dina Fortnox-konton.
        </p>
        {godkand ? (
          <p className="text-sm text-emerald-700" data-testid="km-godkand">
            Godkänd revision {godkand.revision} (räkenskapsår {godkand.financialYearFrom}–
            {godkand.financialYearTo}), godkänd av {godkand.approvedByRole}.
          </p>
        ) : (
          <p className="text-sm text-amber-700" data-testid="km-ingen">
            Ingen godkänd kontomappning – ingenting exporteras till Fortnox förrän en revision är
            godkänd.
          </p>
        )}
      </div>

      {ejStodda.length > 0 && (
        <div
          className="rounded-xl border border-amber-200 bg-amber-50 p-3"
          data-testid="km-ej-stodda"
        >
          <p className="text-sm font-medium text-amber-900">Stöds inte i denna version</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-amber-900">
            {ejStodda.map((e) => (
              <li key={e} className="break-words">
                {e}
              </li>
            ))}
          </ul>
        </div>
      )}

      {kanAndra && (
        <div className="space-y-3" data-testid="km-val">
          <Select
            label="Räkenskapsår i Fortnox"
            value={ar === null ? '' : String(ar)}
            onChange={(e) => {
              setAr(e.target.value ? Number(e.target.value) : null)
              setVal({})
            }}
            options={[
              { value: '', label: '— välj år —' },
              ...(ar0.data?.financialYears ?? []).map((y) => ({
                value: String(y.id),
                label: `${y.from}–${y.to}`,
              })),
            ]}
          />
          {ar !== null && (
            <ul className="space-y-2">
              {behov.map((b) => (
                <li
                  key={nyckel(b)}
                  className="border-line grid min-w-0 gap-2 rounded-xl border p-3 sm:grid-cols-2"
                >
                  <div className="min-w-0 text-sm">
                    <p className="text-ink break-words font-medium">
                      Eveno {b.sourceAccountNumber} «{b.sourceAccountName}»
                    </p>
                    <p className="text-ink-muted break-words">
                      {ROLL_TEXT[b.role]}, {BEHANDLING_TEXT[b.vatTreatment]} – {b.varfor}
                    </p>
                  </div>
                  <Select
                    aria-label={`Fortnox-konto för Eveno ${b.sourceAccountNumber} (${ROLL_TEXT[b.role]})`}
                    value={val[nyckel(b)] ?? ''}
                    onChange={(e) => setVal({ ...val, [nyckel(b)]: e.target.value })}
                    options={[
                      { value: '', label: '— välj Fortnox-konto —' },
                      ...konton.map((k) => ({
                        value: String(k.number),
                        label: `${k.number} ${k.name}`,
                      })),
                    ]}
                  />
                </li>
              ))}
            </ul>
          )}
          {ar !== null && (
            <Button
              onClick={() => spara.mutate()}
              disabled={!allaValda || spara.isPending}
              data-testid="km-spara"
            >
              {spara.isPending ? 'Läser Fortnox…' : 'Spara som nytt utkast (läser Fortnox)'}
            </Button>
          )}
        </div>
      )}

      {fel && (
        <p className="break-words text-sm text-red-600" role="alert" data-testid="km-fel">
          {fel}
        </p>
      )}

      {senaste && (
        <RevisionVy
          r={senaste}
          kanGodkanna={kanAndra && senaste.status === 'DRAFT'}
          busy={godkann.isPending}
          onGodkann={() => godkann.mutate(senaste)}
        />
      )}
    </section>
  )
}

function RevisionVy(props: {
  r: FortnoxAccountMappingRevision
  kanGodkanna: boolean
  busy: boolean
  onGodkann: () => void
}) {
  const { r } = props
  const blockerad = r.rows.some((x) => !x.approvable)
  return (
    <div className="space-y-2" data-testid="km-revision">
      <p className="text-ink text-sm font-medium">
        Revision {r.revision} – {STATUS_TEXT[r.status]} (Fortnox-databas {r.fortnoxDatabaseNumber},
        år {r.financialYearFrom}–{r.financialYearTo})
      </p>
      <ul className="space-y-2">
        {r.rows.map((x) => (
          <li
            key={x.id}
            className={`grid min-w-0 gap-1 rounded-xl border p-3 text-sm sm:grid-cols-2 ${
              x.approvable ? 'border-line' : 'border-red-200 bg-red-50'
            }`}
            data-testid="km-rad"
          >
            <div className="min-w-0">
              <p className="text-ink break-words">
                Eveno {x.sourceAccountNumber} «{x.sourceAccountName}»
              </p>
              <p className="text-ink-muted break-words">
                {ROLL_TEXT[x.role]}, {BEHANDLING_TEXT[x.vatTreatment]}
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-ink break-words">
                Fortnox {x.targetAccountNumber}{' '}
                {x.targetExists ? `«${x.targetName ?? '?'}»` : '– finns inte för året'}
              </p>
              <p className="text-ink-muted break-words">
                {x.targetActive === true ? 'aktivt' : x.targetExists ? 'inaktivt' : '–'},{' '}
                {!x.targetVatCodePresent
                  ? 'momskod saknas i svaret'
                  : x.targetVatCode
                    ? `momskod ${x.targetVatCode}`
                    : 'ingen momskod'}
              </p>
              <p className={x.approvable ? 'text-emerald-700' : 'text-red-700'}>
                {TEKNIK_TEXT[x.technical]}: {x.hinder ?? x.technicalReason}
              </p>
            </div>
          </li>
        ))}
      </ul>
      {props.kanGodkanna && (
        <div className="space-y-2 rounded-xl border border-blue-200 bg-blue-50 p-3">
          <p className="text-sm text-blue-900">
            Godkännandet avser kontonas innebörd: att varje Fortnox-konto ovan betyder samma sak som
            Evenos konto i den angivna rollen. Eveno rekommenderar inget konto, ingen momskod och
            ingen sats. Ett godkännande upphäver en befintlig kundaktivering, och en ändring i
            Fortnox efteråt stoppar exporten tills en ny revision godkänts.
          </p>
          {blockerad ? (
            <p className="text-sm font-medium text-red-700" data-testid="km-kan-inte-godkannas">
              Revisionen kan inte godkännas: minst en rad har en motsägelse eller är inte belagd.
              Välj ett annat konto eller stäm av kontoplanen med redovisningsansvarig.
            </p>
          ) : (
            <Button onClick={props.onGodkann} disabled={props.busy} data-testid="km-godkann">
              {props.busy ? 'Godkänner…' : `Godkänn revision ${r.revision}`}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
