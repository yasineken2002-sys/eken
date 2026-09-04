import { useState } from 'react'
import { CalendarCheck, CircleAlert, Lock } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { useAuthStore } from '@/stores/auth.store'
import { formatDate } from '@eken/shared'
import { CloseFiscalYearModal } from './CloseFiscalYearModal'
import { årsKortStatus } from './fiscal-year-status'
import { useFiscalYears } from '../hooks/useAccounting'
import type { FiscalYearOverviewItem } from '../api/accounting.api'

/**
 * RÄKENSKAPSÅREN — ett kort per år (#704 PR 3).
 *
 * Periodöversikten under den här panelen visar MÅNADER och vet inget om år. Utan
 * korten syns det inte att ett räkenskapsår är låst: månad tolv ser ut som en
 * vanlig stängd månad, medan årsspärren i själva verket avvisar varje verifikat
 * i hela året.
 *
 * ROLLGRINDEN ÄR SPEGLAD, INTE UPPFUNNEN: knappen visas för OWNER och ADMIN,
 * samma mängd som `@Roles('ADMIN', 'OWNER')` på endpointen och `CLOSE_YEAR_ROLES`
 * i tjänsten. ACCOUNTANT får stänga en MÅNAD men inte ett ÅR — en månad kan
 * öppnas igen, ett år kan inte. Läsningen är oförändrad: korten och deras status
 * syns för alla som når bokföringssidan, så den som inte får stänga ändå förstår
 * varför en period inte går att öppna.
 */
export function FiscalYearsPanel() {
  const years = useFiscalYears()
  const [pending, setPending] = useState<{ fiscalYear: number; label: string } | null>(null)

  const role = useAuthStore((s) => s.user?.role)
  const mayCloseYear = role === 'ADMIN' || role === 'OWNER'

  if (years.isLoading) {
    return (
      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-32 animate-pulse rounded-2xl bg-gray-100" />
        ))}
      </div>
    )
  }

  const data = years.data
  if (!data || data.length === 0) {
    return (
      <div className="border-line mt-5 flex gap-2 rounded-2xl border bg-white p-4">
        <CircleAlert size={15} strokeWidth={1.8} className="mt-0.5 shrink-0 text-gray-400" />
        <p className="text-[13px] text-gray-600">Kunde inte ladda räkenskapsåren.</p>
      </div>
    )
  }

  return (
    <div className="mt-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data.map((item: FiscalYearOverviewItem) => {
          const status = årsKortStatus(item)
          return (
            <div
              key={item.fiscalYear}
              data-testid={`fiscal-year-card-${item.fiscalYear}`}
              className="border-line rounded-2xl border bg-white p-5 transition-shadow hover:shadow-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[13.5px] font-medium text-gray-900">
                    Räkenskapsåret {item.label}
                  </p>
                  <p className="text-[12px] text-gray-500">
                    {formatDate(item.fiscalStart)} – {formatDate(item.yearEndDate)}
                  </p>
                </div>
                {/* Neutral info-nivå: "stängt" är ett tillstånd, inte ett utfall.
                    Signalfärgerna är reserverade för faktiska signaler. */}
                {/* Testid ligger på omslaget: <Badge> vidarebefordrar bara
                    children/variant/dot/className, inte godtyckliga attribut. */}
                <span data-testid={`fiscal-year-badge-${item.fiscalYear}`}>
                  <Badge variant={status.ton === 'ready' ? 'success' : 'info'}>
                    {status.badge}
                  </Badge>
                </span>
              </div>

              <p className="mt-3 text-[13px] text-gray-600">{status.beskrivning}</p>

              {item.status === 'CLOSED' && (
                <div className="mt-3 flex items-start gap-2 text-[12px] text-gray-500">
                  <Lock size={13} strokeWidth={1.8} className="mt-0.5 shrink-0 text-gray-400" />
                  <span>
                    {item.closedAt && <>Stängt {formatDate(item.closedAt)}. </>}
                    {item.entry ? (
                      <>
                        Verifikat{' '}
                        <span
                          data-testid={`fiscal-year-entry-${item.fiscalYear}`}
                          className="font-medium text-gray-700"
                        >
                          {item.entry.series}
                          {item.entry.verNumber}
                        </span>
                        .
                      </>
                    ) : (
                      <>Inget verifikat behövdes — inget resultatkonto hade saldo.</>
                    )}
                  </span>
                </div>
              )}

              {mayCloseYear && status.kanStänga && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-4"
                  data-testid={`fiscal-year-close-${item.fiscalYear}`}
                  onClick={() => setPending({ fiscalYear: item.fiscalYear, label: item.label })}
                >
                  <CalendarCheck size={14} strokeWidth={1.8} />
                  Stäng räkenskapsår
                </Button>
              )}
            </div>
          )
        })}
      </div>

      {pending && (
        <CloseFiscalYearModal
          fiscalYear={pending.fiscalYear}
          label={pending.label}
          onClose={() => setPending(null)}
        />
      )}
    </div>
  )
}
