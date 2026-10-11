import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { PermissionDeniedState } from '@/components/ui/PermissionDeniedState'
import { LoadErrorState } from '@/components/ui/LoadErrorState'
import { isForbidden, isUnavailable } from '@/lib/api'
import { useAuthStore } from '@/stores/auth.store'
import { useFortnox } from '../hooks/useFortnox'
import { FortnoxReadSetup } from './FortnoxReadSetup'
import type { FortnoxReadView, FortnoxStatusResponse } from '../api/fortnox.api'

const READ_LABELS: Record<FortnoxReadView['status'], string> = {
  RUNNING: 'Läsning pågår',
  COMPLETE: 'Läsning slutförd',
  COMPLETE_WITH_UNCERTAINTY: 'Slutförd med osäkerhet',
  PARTIAL: 'Delvis läst',
  FAILED: 'Läsningen misslyckades',
  AUTH_LOST: 'Åtkomst till Fortnox saknas',
  WRONG_COMPANY: 'Företaget stämmer inte',
}
const resourceNames: Record<string, string> = {
  vouchers: 'Verifikationer',
  supplierinvoices: 'Leverantörsfakturor',
  accounts: 'Konton',
  financialyears: 'Räkenskapsår',
  costcenters: 'Kostnadsställen',
  projects: 'Projekt',
}
const money = (value: number) =>
  new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'SEK',
    minimumFractionDigits: 2,
  }).format(value / 100)
const completed = (read: FortnoxReadView | null) =>
  read?.status === 'COMPLETE' || read?.status === 'COMPLETE_WITH_UNCERTAINTY'
function time(value: string | null) {
  if (!value || Number.isNaN(Date.parse(value))) return 'Tid saknas'
  return new Intl.DateTimeFormat('sv-SE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Stockholm',
  }).format(new Date(value))
}
function day(value: string) {
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : 'Datum saknas'
}

/** Server enforces OWNER/ADMIN as well; this is only the presentation boundary. */
export function FortnoxPanel() {
  const user = useAuthStore((state) => state.user)
  const organization = useAuthStore((state) => state.organization)
  if (!organization || (user?.role !== 'OWNER' && user?.role !== 'ADMIN'))
    return <PermissionDeniedState vad="Fortnox-inställningarna" />
  return <AuthorizedFortnoxPanel key={`${organization.id}:${user.id}:${user.role}`} />
}

function AuthorizedFortnoxPanel() {
  const { status, connect, disconnect } = useFortnox()
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [catalogDenied, setCatalogDenied] = useState(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const denied =
    catalogDenied ||
    isForbidden(status.error) ||
    isForbidden(connect.error) ||
    isForbidden(disconnect.error)
  const busy = connect.isPending || disconnect.isPending

  if (denied) return <PermissionDeniedState vad="Fortnox-inställningarna" />
  if (status.isLoading)
    return (
      <section
        aria-label="Fortnox"
        aria-busy="true"
        className="border-line bg-surface rounded-2xl border p-5"
      >
        <h2 className="text-ink font-semibold">Fortnox</h2>
        <p role="status" className="text-ink-muted mt-3 text-sm">
          Hämtar Fortnox-status…
        </p>
      </section>
    )
  if (status.isError)
    return <LoadErrorState vad="Fortnox-statusen" onRetry={() => void status.refetch()} />
  if (!status.data)
    return <LoadErrorState vad="Fortnox-underlaget" onRetry={() => void status.refetch()} />
  const data = status.data
  const connection = data.connection
  const canConnect = data.enabled && connection?.status !== 'ACTIVE'
  const beginConnect = async () => {
    if (!canConnect || busy) return
    setActionError(null)
    try {
      const authUrl = await connect.mutateAsync()
      if (active.current) window.location.assign(authUrl)
    } catch (error) {
      setActionError(
        isUnavailable(error)
          ? 'Fortnox-anslutning är inte aktiverad just nu. Uppdatera statusen.'
          : 'Anslutningen kunde inte startas. Försök igen.',
      )
    }
  }
  const endConnection = async () => {
    if (!data.enabled || busy) return
    setActionError(null)
    try {
      await disconnect.mutateAsync()
      setConfirmDisconnect(false)
    } catch {
      setActionError(
        'Det gick inte att bekräfta frånkopplingen. Uppdatera statusen innan du försöker igen.',
      )
    }
  }

  return (
    <section
      aria-labelledby="fortnox-title"
      className="border-line bg-surface min-w-0 space-y-5 rounded-2xl border p-4 sm:p-6"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="fortnox-title" className="text-ink text-lg font-semibold">
            Fortnox
          </h2>
          <p className="text-ink-muted mt-1 text-sm">Bokföringsunderlag och anslutning</p>
        </div>
        <Button
          size="sm"
          onClick={() => void status.refetch()}
          disabled={status.isFetching || busy}
        >
          {status.isFetching ? 'Hämtar status…' : 'Uppdatera status'}
        </Button>
      </header>
      <p className="text-ink-muted rounded-xl bg-gray-50 p-3 text-sm leading-relaxed">
        Eveno hanterar avier och betalningar. Fortnox-underlaget visas separat. Anslutningen byter
        inte källa för dina befintliga ekonomirapporter.
      </p>
      {!data.enabled ? (
        <div role="status" className="border-line rounded-xl border p-4">
          <h3 className="text-ink font-semibold">Inte aktiverat</h3>
          <p className="text-ink-muted mt-1 text-sm">
            Fortnox-kopplingen är inte tillgänglig ännu.
          </p>
        </div>
      ) : (
        <div className="border-line space-y-3 rounded-xl border p-4">
          <h3 className="text-ink font-semibold">
            {connection?.status === 'ACTIVE'
              ? 'Ansluten'
              : connection?.status === 'AUTH_LOST'
                ? 'Anslutningen behöver förnyas'
                : 'Inte ansluten'}
          </h3>
          {connection && (
            <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
              <Detail label="Företag" value={connection.company.name ?? 'Företagsnamn saknas'} />
              <Detail
                label="Organisationsnummer"
                value={connection.company.orgNumber ?? 'Saknas'}
              />
              <Detail
                label="Företagsidentitet i Fortnox"
                value={String(connection.company.databaseNumber)}
              />
              <Detail label="Ansluten sedan" value={time(connection.connectedAt)} />
              {connection.disconnectedAt && (
                <Detail label="Frånkopplad" value={time(connection.disconnectedAt)} />
              )}
              {connection.lastErrorAt && (
                <Detail label="Senaste anslutningsfel" value={time(connection.lastErrorAt)} />
              )}
            </dl>
          )}
          {connection?.lastErrorClass && (
            <p className="text-sm text-amber-600">
              {connection.lastErrorClass === 'COMPANY_MISMATCH'
                ? 'Företaget i anslutningen kunde inte verifieras.'
                : connection.lastErrorClass === 'AUTH_REJECTED'
                  ? 'Fortnox nekade åtkomst. Anslutningen kan behöva förnyas.'
                  : 'Ett anslutningsfel har registrerats. Uppdatera statusen innan du fortsätter.'}
            </p>
          )}
          {canConnect && (
            <Button
              variant="primary"
              disabled={busy || status.isFetching}
              onClick={() => void beginConnect()}
            >
              {connect.isPending
                ? 'Startar anslutning…'
                : connection?.status === 'AUTH_LOST'
                  ? 'Förnya anslutning'
                  : 'Anslut Fortnox'}
            </Button>
          )}
          {connection && connection.status !== 'DISCONNECTED' && !confirmDisconnect && (
            <Button
              size="sm"
              disabled={busy || status.isFetching}
              onClick={() => setConfirmDisconnect(true)}
            >
              Koppla från
            </Button>
          )}
          {confirmDisconnect && (
            <div
              className="rounded-xl bg-amber-50 p-3"
              role="group"
              aria-label="Bekräfta frånkoppling"
            >
              <p className="text-ink text-sm">
                Koppla från Fortnox? Nya läsningar stoppas. Tidigare underlag finns kvar som
                historik.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="danger" disabled={busy} onClick={() => void endConnection()}>
                  {disconnect.isPending ? 'Kopplar från…' : 'Bekräfta frånkoppling'}
                </Button>
                <Button disabled={busy} onClick={() => setConfirmDisconnect(false)}>
                  Avbryt
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      {actionError && (
        <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-600">
          {actionError}
        </p>
      )}
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <ReadAttempt read={data.latestRead} />
        <ReadSummary data={data} />
      </div>
      {data.enabled && connection?.status === 'ACTIVE' && (
        <FortnoxReadSetup
          key={`${connection.company.databaseNumber}:${connection.connectedAt}`}
          companyNumber={connection.company.databaseNumber}
          blocked={busy || status.isFetching || data.latestRead?.status === 'RUNNING'}
          onAccessDenied={() => setCatalogDenied(true)}
        />
      )}
      <section aria-labelledby="fortnox-mappings" className="border-line rounded-xl border p-4">
        <h3 id="fortnox-mappings" className="text-ink font-semibold">
          Fastighetsfördelning
        </h3>
        {data.mappings.length === 0 ? (
          <p className="text-ink-muted mt-2 text-sm">Inga fastighetskopplingar registrerade.</p>
        ) : (
          <ul className="mt-2 divide-y divide-gray-100 text-sm">
            {data.mappings.map((mapping) => (
              <li key={mapping.id} className="break-words py-2">
                {mapping.dimensionType === 'PROJECT' ? 'Projekt' : 'Kostnadsställe'} {mapping.code}{' '}
                → {mapping.propertyName}
              </li>
            ))}
          </ul>
        )}
        <p className="text-ink-muted mt-3 text-sm">
          Fördelningen behöver stämma med företagets dimensioner och fastigheter innan underlaget
          kan beskriva ett enskilt hus.
        </p>
      </section>
      <section
        aria-labelledby="fortnox-exports"
        className="border-line space-y-3 rounded-xl border p-4"
      >
        <h3 id="fortnox-exports" className="text-ink font-semibold">
          Export till Fortnox
        </h3>
        {data.exports.sendingEnabled ? (
          <>
            <p className="text-sm font-medium text-amber-600">
              Sändning är aktiverad endast för testföretaget
            </p>
            <p className="text-ink-muted text-sm">
              Varje verifikat skickas först efter uttrycklig bekräftelse. Ett oklart sändningsutfall
              låses och kräver avstämning mot Fortnox; inget skickas om automatiskt.
            </p>
          </>
        ) : (
          <>
            <p className="text-sm font-medium text-amber-600">Sändning är inte aktiverad</p>
            <p className="text-ink-muted text-sm">
              Provexport kontrollerar underlaget utan att skicka bokföring. Säker återhämtning efter
              ett oklart sändningsutfall behöver vara verifierad innan sändning öppnas.
            </p>
          </>
        )}
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Detail label="Klara provexporter" value={String(data.exports.counts.DRY_RUN_READY)} />
          <Detail label="Blockerade" value={String(data.exports.counts.BLOCKED)} />
          <Detail label="Okänt utfall" value={String(data.exports.counts.UNKNOWN)} />
          <Detail label="Bekräftade" value={String(data.exports.counts.CONFIRMED)} />
        </dl>
        {data.exports.needsReconciliation > 0 && (
          <p role="alert" className="text-ink rounded-lg bg-amber-50 p-3 text-sm">
            {data.exports.needsReconciliation} exportförsök har okänt utfall och kräver avstämning i
            Fortnox före en ny sändning.
          </p>
        )}
      </section>
    </section>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-ink mt-1 break-words font-medium">{value}</dd>
    </div>
  )
}

function ReadAttempt({ read }: { read: FortnoxReadView | null }) {
  return (
    <section
      aria-labelledby="fortnox-attempt"
      className="border-line min-w-0 space-y-3 rounded-xl border p-4"
    >
      <h3 id="fortnox-attempt" className="text-ink font-semibold">
        Senaste läsförsök
      </h3>
      {!read ? (
        <p className="text-ink-muted text-sm">Ingen läsning har gjorts.</p>
      ) : (
        <>
          <p className="text-ink text-sm font-medium" role="status">
            {READ_LABELS[read.status]}
          </p>
          <dl className="space-y-2 text-sm">
            <Detail label="Period" value={`${day(read.periodFrom)} – ${day(read.periodTo)}`} />
            <Detail
              label="Sparat kontourval"
              value={read.selectedAccounts.length ? read.selectedAccounts.join(', ') : 'Saknas'}
            />
            <Detail label="Startat" value={time(read.startedAt)} />
            <Detail
              label="Avslutat"
              value={read.completedAt ? time(read.completedAt) : 'Inte avslutat'}
            />
          </dl>
          {read.reason && <p className="break-words text-sm text-amber-600">{read.reason}</p>}
          {!completed(read) && <p className="text-ink text-sm font-medium">Ingen aktuell summa</p>}
          <Coverage read={read} />
          {read.uncertainties.length > 0 && (
            <ul
              aria-label="Osäkerheter i senaste försöket"
              className="text-ink-muted list-disc space-y-1 pl-5 text-sm"
            >
              {read.uncertainties.map((text, index) => (
                <li className="break-words" key={index}>
                  {text}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}

function Coverage({ read }: { read: FortnoxReadView }) {
  const entries = Object.entries(read.coverage)
  return (
    <div className="space-y-2">
      <h4 className="text-ink text-sm font-medium">Lästäckning</h4>
      {entries.length === 0 ? (
        <p className="text-ink-muted text-sm">Täckning saknas.</p>
      ) : (
        <ul className="text-ink-muted space-y-2 text-xs">
          {entries.map(([name, value]) => (
            <li className="break-words" key={name}>
              {resourceNames[name] ?? name}: {value.pages} av {value.totalPages} sidor ·{' '}
              {value.itemsSeen} av {value.totalResources} poster
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ReadSummary({ data }: { data: FortnoxStatusResponse }) {
  const read = data.latestCompleteRead
  const summary = read && completed(read) && read.selectedAccounts.length > 0 ? read.summary : null
  const earlier =
    !data.enabled ||
    data.connection?.status !== 'ACTIVE' ||
    !completed(data.latestRead) ||
    data.latestRead?.id !== read?.id
  return (
    <section
      aria-labelledby="fortnox-complete"
      className="border-line min-w-0 space-y-3 rounded-xl border p-4"
    >
      <h3 id="fortnox-complete" className="text-ink font-semibold">
        Senaste kompletta underlag
      </h3>
      {!read || !summary ? (
        <p className="text-ink-muted text-sm">
          {read && read.selectedAccounts.length === 0
            ? 'Sparat kontourval saknas. Ingen verifierbar summa visas.'
            : 'Ingen komplett läsning med summa finns.'}
        </p>
      ) : (
        <>
          {earlier && (
            <p className="text-ink rounded-lg bg-amber-50 p-2 text-sm">
              Tidigare underlag – beskriver inte ett nytt eller pågående läsförsök.
            </p>
          )}
          <p className="text-ink-muted text-sm">
            {day(read.periodFrom)} – {day(read.periodTo)} · Lästillfälle {time(read.completedAt)}
          </p>
          {read.status === 'COMPLETE_WITH_UNCERTAINTY' && (
            <p className="text-sm font-medium text-amber-600">Underlaget innehåller osäkerheter</p>
          )}
          <dl>
            <Detail label="Nettobelopp för valda konton" value={money(summary.totalOre)} />
            <Detail label="Sparat kontourval" value={read.selectedAccounts.join(', ')} />
          </dl>
          <p className="text-ink-muted text-xs">
            Avser det sparade kontourvalet vid lästillfället. Detta är inte en fullständig
            resultaträkning.
          </p>
          <dl className="space-y-3 text-sm">
            <Detail label="Utan dimension" value={money(summary.unallocatedOre)} />
            <Detail label="Uteslutna osäkra rader" value={money(summary.uncertainRemovedOre)} />
            <Detail
              label="Varav Eveno-exporter, redan inräknade"
              value={money(summary.evenoExportOre)}
            />
          </dl>
          {summary.byProperty.length > 0 && (
            <div>
              <h4 className="text-ink text-sm font-medium">Fördelat per fastighet</h4>
              <ul className="mt-2 space-y-2 text-sm">
                {summary.byProperty.map((item) => (
                  <li
                    key={item.propertyId}
                    className="flex min-w-0 flex-wrap justify-between gap-2"
                  >
                    <span className="break-words">{item.propertyName}</span>
                    <span>{money(item.amountOre)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {summary.unmappedDimensions.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-amber-600">Saknar fastighetskoppling</h4>
              <ul className="mt-2 space-y-2 text-sm">
                {summary.unmappedDimensions.map((item, index) => (
                  <li key={index} className="break-words">
                    {item.dimensionType === 'PROJECT' ? 'Projekt' : 'Kostnadsställe'} {item.code}:{' '}
                    {money(item.amountOre)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {read.uncertainties.length > 0 && (
            <ul
              aria-label="Osäkerheter i underlaget"
              className="text-ink-muted list-disc space-y-1 pl-5 text-sm"
            >
              {read.uncertainties.map((text, index) => (
                <li className="break-words" key={index}>
                  {text}
                </li>
              ))}
            </ul>
          )}
          <Coverage read={read} />
        </>
      )}
    </section>
  )
}
