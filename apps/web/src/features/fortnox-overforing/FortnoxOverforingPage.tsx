import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { PageHeader } from '@/components/ui/PageHeader'
import { useAuthStore } from '@/stores/auth.store'
import { getFortnoxExportState } from '@/features/settings/api/fortnox-export.api'
import { FortnoxExportList } from '@/features/settings/components/FortnoxExportList'
import { FortnoxPanel } from '@/features/settings/components/FortnoxPanel'
import { useHuvudbokslage } from './huvudbokslage'

/**
 * MENY-ETAPP 4 (201): Fortnox › Överföring och avstämning.
 *
 * En samlad vy av BEFINTLIGA delar — exportrader, anslutning och återläsning.
 * Ingen ny export- eller sändlogik: raderna är samma komponent som i
 * Inställningar › Fortnox, och inget skickas eller skickas om av att sidan visas.
 * Innehållet visas bara när organisationen VERIFIERAT har Fortnox som huvudbok.
 */
export function FortnoxOverforingPage() {
  const lage = useHuvudbokslage()
  const user = useAuthStore((s) => s.user)
  const org = useAuthStore((s) => s.organization)
  const exportRoll = user?.role === 'OWNER' || user?.role === 'ADMIN'

  return (
    <div className="space-y-5">
      <PageHeader
        title="Överföring och avstämning"
        description="Vad som har skickats till Fortnox, vad som behöver stämmas av och anslutningens läge"
      />

      {lage === 'OKAND' && (
        <p
          data-testid="huvudbok-okand"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          Huvudboksvalet kunde inte läsas. Inga Fortnox-uppgifter visas som verifierade här.
          Bokföringen och rapporterna går fortfarande att öppna.
        </p>
      )}

      {lage === 'EVENO' && (
        <p data-testid="huvudbok-eveno" className="text-ink-muted text-sm">
          Sidan gäller organisationer som har Fortnox som huvudbok. Den här organisationen bokför i
          Eveno.
        </p>
      )}

      {lage === 'FORTNOX' &&
        (exportRoll ? (
          // Byte av organisation/användare/roll monterar om vyn (samma princip som
          // FortnoxExportSetup U01): inga rader från föregående scope kan visas.
          <Overforingar key={`${org?.id ?? '-'}|${user?.id ?? '-'}|${user?.role ?? '-'}`} />
        ) : (
          <p data-testid="overforing-roll" className="text-ink-muted text-sm">
            Överföringar och avstämning visas för ägare och administratörer.
          </p>
        ))}

      <section aria-label="Arkiv" className="text-sm">
        <h2 className="text-ink text-sm font-semibold">Arkiv</h2>
        <ul className="mt-1 space-y-1">
          <li>
            <Link to="/accounting" className="text-brand-600 hover:underline">
              Bokföringsarkiv
            </Link>
          </li>
          <li>
            <Link to="/reports" className="text-brand-600 hover:underline">
              Rapporter
            </Link>
          </li>
          {lage === 'FORTNOX' && exportRoll && (
            <li>
              <Link to="/settings/fortnox" className="text-brand-600 hover:underline">
                Inställningar › Fortnox (koppling, kontomappning och export)
              </Link>
            </li>
          )}
        </ul>
      </section>

      {lage === 'FORTNOX' && exportRoll && <FortnoxPanel />}
    </div>
  )
}

function Overforingar() {
  const client = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const org = useAuthStore((s) => s.organization)
  const scope = [org?.id, user?.id, user?.role] as const
  const state = useQuery({
    queryKey: ['fortnox', 'export-state', ...scope],
    queryFn: getFortnoxExportState,
    retry: false,
  })
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ['fortnox'] })
  }

  const anslutning = state.data?.connection?.status ?? null
  const sendingEnabled = state.data?.exports.sendingEnabled === true

  return (
    <div className="space-y-4">
      {state.isSuccess && anslutning !== 'ACTIVE' && (
        <p
          data-testid="anslutning-bruten"
          role="status"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          {anslutning === null
            ? 'Ingen anslutning till Fortnox.'
            : anslutning === 'AUTH_LOST'
              ? 'Åtkomsten till Fortnox har gått förlorad.'
              : 'Anslutningen till Fortnox är frånkopplad.'}{' '}
          Huvudboksvalet gäller fortfarande: fria verifikat görs i Fortnox, inte i Eveno. Inget
          skickas eller skickas om automatiskt.
        </p>
      )}

      {state.isError && (
        <p data-testid="overforing-fel" className="text-sm text-red-700">
          Överföringarna kunde inte läsas.
        </p>
      )}

      <FortnoxExportList
        group="NEEDS_REVIEW"
        title="Att stämma av"
        testId="att-stamma-av"
        sendingEnabled={sendingEnabled}
        onChanged={refresh}
      />
      <FortnoxExportList
        group="OTHER"
        title="Övriga överföringar"
        testId="ovriga-overforingar"
        sendingEnabled={sendingEnabled}
        onChanged={refresh}
      />
    </div>
  )
}
