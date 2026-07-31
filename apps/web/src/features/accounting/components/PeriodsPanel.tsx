import { useState } from 'react'
import { toast } from 'sonner'
import { Lock, LockOpen, AlertTriangle, CircleAlert } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/EmptyState'
import { extractApiError } from '@/lib/api'
import { usePeriods, usePeriodPrecheck, useClosePeriod } from '../hooks/useAccounting'
import type { PeriodOverviewItem } from '../api/accounting.api'

const MONTH_NAMES = [
  'januari',
  'februari',
  'mars',
  'april',
  'maj',
  'juni',
  'juli',
  'augusti',
  'september',
  'oktober',
  'november',
  'december',
]

function periodLabel(p: { year: number; month: number }): string {
  return `${MONTH_NAMES[p.month - 1]} ${p.year}`
}

/**
 * Bokföringsperioder — stänger och visar. Stängningen gick tidigare bara att nå
 * via AI-assistenten; spärren mot att bokföra i en stängd period är oförändrad
 * och ligger i backend.
 *
 * En stängning går inte att ångra i produkten ännu (återöppning byggs separat),
 * så bekräftelsen säger det rakt ut i stället för att låta operatören upptäcka
 * det efteråt.
 */
export function PeriodsPanel() {
  const periods = usePeriods()
  const [pending, setPending] = useState<{ year: number; month: number } | null>(null)
  const precheck = usePeriodPrecheck(pending)
  const close = useClosePeriod()

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
              <Badge variant="default">Stängd</Badge>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPending({ year: item.year, month: item.month })}
              >
                Stäng period
              </Button>
            )}
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
              Stängningen kan inte ångras i systemet ännu.
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
    </div>
  )
}
