import { useState } from 'react'
import { toast } from 'sonner'
import { Lock, LockOpen, AlertTriangle, CircleAlert } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/EmptyState'
import { extractApiError } from '@/lib/api'
import { useAuthStore } from '@/stores/auth.store'
import { ReopenPeriodModal } from './ReopenPeriodModal'
import { periodLabel } from './period-label'
import { periodInLockedFiscalYear } from './fiscal-year-status'
import {
  usePeriods,
  usePeriodPrecheck,
  useClosePeriod,
  useFiscalYears,
} from '../hooks/useAccounting'
import type { PeriodOverviewItem } from '../api/accounting.api'

/**
 * Bokföringsperioder — stänger och visar. Stängningen gick tidigare bara att nå
 * via AI-assistenten; spärren mot att bokföra i en stängd period är oförändrad
 * och ligger i backend.
 *
 * PR1c: en stängning går att ångra — men bara av kontoägaren, bara när en post
 * SAKNAS, och alltid med ett skäl som sparas i periodens historik. Är en bokförd
 * post felaktig är återöppning fel verktyg; den dialogen förklarar varför i
 * stället för att bara neka. Se ReopenPeriodModal.
 */
export function PeriodsPanel() {
  const periods = usePeriods()
  // Månaderna vet inget om år. Utan den här frågan syns det inte att en stängd
  // månad ligger i ett LÅST räkenskapsår — och skillnaden är att den ena går att
  // öppna igen medan den andra inte gör det (#704 PR 3).
  const fiscalYears = useFiscalYears()
  const [pending, setPending] = useState<{ year: number; month: number } | null>(null)
  const [detail, setDetail] = useState<{ year: number; month: number } | null>(null)
  const precheck = usePeriodPrecheck(pending)
  const close = useClosePeriod()

  // Att stänga en period är en redovisningshandling — MANAGER utesluts, precis
  // som server-side (R2 steg 3). Speglat här så knappen inte visas för den som
  // ändå nekas; grinden svarar "Otillräckliga rättigheter", vilket inte
  // förklarar något för en förvaltare som undrar varför det inte går.
  // Samma mönster som mayReverse i AccountingPage och isOwner i
  // ReopenPeriodModal. Läsning är oförändrad: listan och historiken syns.
  const role = useAuthStore((s) => s.user?.role)
  const mayClose = role === 'ACCOUNTANT' || role === 'ADMIN' || role === 'OWNER'

  function handleClose() {
    if (!pending) return
    close.mutate(pending, {
      onSuccess: () => {
        toast.success(`Perioden ${periodLabel(pending)} är stängd.`)
        setPending(null)
      },
      onError: (err: unknown) => toast.error(extractApiError(err, 'Perioden kunde inte stängas.')),
    })
  }

  if (periods.isLoading) {
    return (
      <div className="mt-5 space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-14 animate-pulse rounded-2xl bg-gray-100" />
        ))}
      </div>
    )
  }

  const data = periods.data
  if (!data) {
    return (
      <div className="mt-5">
        <EmptyState
          icon={CircleAlert}
          title="Kunde inte ladda perioder"
          description="Försök igen om en stund."
        />
      </div>
    )
  }

  const blocking = (precheck.data?.checks ?? []).filter((c) => c.severity === 'blocking')
  const warnings = (precheck.data?.checks ?? []).filter((c) => c.severity === 'warning')

  return (
    <div className="mt-5">
      {/* Passiv synlighet — ingen påminnelse, ingen badge, bara läget. */}
      <div className="border-line mb-4 rounded-2xl border bg-white p-4 text-[13px] text-gray-600">
        <span className="font-medium text-gray-900">
          {data.lastClosed
            ? `Senast stängd period: ${periodLabel(data.lastClosed)}`
            : 'Ingen period är stängd ännu'}
        </span>
        {data.open.length > 0 && (
          <span className="text-gray-500">
            {' · '}Öppna: {data.open.map(periodLabel).join(', ')}
          </span>
        )}
      </div>

      <div className="border-line overflow-hidden rounded-2xl border bg-white">
        {data.items.map((item: PeriodOverviewItem) => (
          <div
            key={`${item.year}-${item.month}`}
            className="flex items-center justify-between border-b border-gray-100 px-4 py-3 last:border-0"
          >
            <div className="flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-50 text-gray-400">
                {item.closed ? (
                  <Lock size={14} strokeWidth={1.8} />
                ) : (
                  <LockOpen size={14} strokeWidth={1.8} />
                )}
              </span>
              <div>
                <p className="text-[13.5px] font-medium text-gray-900">
                  {periodLabel({ year: item.year, month: item.month })}
                </p>
                {item.closed && item.closedAt && (
                  <p className="text-[11.5px] text-gray-500">
                    Stängd {new Date(item.closedAt).toLocaleDateString('sv-SE')}
                  </p>
                )}
              </div>
            </div>
            {item.closed ? (
              <div className="flex items-center gap-2">
                <Badge variant="default">Stängd</Badge>
                {periodInLockedFiscalYear(item, fiscalYears.data) && (
                  /* NEUTRAL info-nivå: att året är låst är ett TILLSTÅND, inte
                     ett utfall. Signalfärgerna är reserverade för signaler. */
                  <span data-testid={`period-year-locked-${item.year}-${item.month}`}>
                    <Badge variant="info">Året stängt</Badge>
                  </span>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setDetail({ year: item.year, month: item.month })}
                >
                  {periodInLockedFiscalYear(item, fiscalYears.data) ? 'Historik' : 'Öppna igen'}
                </Button>
              </div>
            ) : item.reopenedCount > 0 ? (
              // Öppen EFTER en återöppning — historiken är det intressanta här,
              // inte att stänga igen (det gör man när posten väl är på plats).
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setDetail({ year: item.year, month: item.month })}
                >
                  Historik
                </Button>
                {mayClose && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setPending({ year: item.year, month: item.month })}
                  >
                    Stäng period
                  </Button>
                )}
              </div>
            ) : mayClose ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPending({ year: item.year, month: item.month })}
              >
                Stäng period
              </Button>
            ) : null}
          </div>
        ))}
      </div>

      <Modal
        open={pending != null}
        onClose={() => setPending(null)}
        title={pending ? `Stäng ${periodLabel(pending)}` : 'Stäng period'}
        description="Efter stängning kan inga nya verifikat bokföras i perioden."
      >
        {precheck.isLoading ? (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-xl bg-gray-100" />
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {blocking.map((c) => (
              <div key={c.code} className="flex gap-2 rounded-xl bg-red-50 p-3">
                <CircleAlert size={15} strokeWidth={1.8} className="mt-0.5 shrink-0 text-red-600" />
                <p className="text-[13px] text-red-700">{c.message}</p>
              </div>
            ))}
            {warnings.map((c) => (
              <div key={c.code} className="flex gap-2 rounded-xl bg-amber-50 p-3">
                <AlertTriangle
                  size={15}
                  strokeWidth={1.8}
                  className="mt-0.5 shrink-0 text-amber-600"
                />
                <p className="text-[13px] text-amber-900">{c.message}</p>
              </div>
            ))}
            {blocking.length === 0 && warnings.length === 0 && (
              <p className="rounded-xl bg-emerald-50 p-3 text-[13px] text-emerald-800">
                Inget att anmärka på i perioden.
              </p>
            )}
            {warnings.length > 0 && blocking.length === 0 && (
              <p className="text-[12px] text-gray-500">
                Varningarna hindrar inte stängning — du avgör om perioden är klar.
              </p>
            )}
            <p className="text-[12px] text-gray-500">
              Behöver perioden öppnas igen kan kontoägaren göra det — men bara om en post saknas,
              och alltid med angivet skäl som sparas i historiken.
            </p>
          </div>
        )}

        <ModalFooter>
          <Button variant="secondary" onClick={() => setPending(null)}>
            Avbryt
          </Button>
          <Button
            variant="primary"
            disabled={close.isPending || precheck.isLoading || !precheck.data?.canClose}
            onClick={handleClose}
          >
            {close.isPending ? 'Stänger…' : 'Stäng perioden'}
          </Button>
        </ModalFooter>
      </Modal>

      {detail && <ReopenPeriodModal period={detail} onClose={() => setDetail(null)} />}
    </div>
  )
}
