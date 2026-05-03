import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Gavel, Pause, Play, Send, FileDown, Package, AlertTriangle } from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { InvoiceStatusBadge } from '@/components/ui/Badge'
import { formatCurrency, formatDate } from '@eken/shared'
import {
  fetchOverdueStatus,
  exportSingleCollection,
  exportBulkCollections,
  pauseReminders,
  resumeReminders,
  type CollectionBucket,
  type OverdueInvoice,
} from './api/collections.api'

const TABS: Array<{ id: CollectionBucket; label: string; description: string }> = [
  {
    id: 'in-progress',
    label: 'Påminnelser pågår',
    description: 'Vänlig eller formell påminnelse skickad',
  },
  {
    id: 'ready',
    label: 'Redo för inkasso',
    description: 'Förfallna ≥ 30 dagar — generera underlag',
  },
  {
    id: 'sent',
    label: 'Skickade till inkasso',
    description: 'Ärenden hos externt inkassobolag',
  },
]

const REMINDER_LABEL: Record<string, string> = {
  REMINDER_FRIENDLY: 'Vänlig påminnelse',
  REMINDER_FORMAL: 'Formell påminnelse',
  READY_FOR_COLLECTION: 'Markerad redo för inkasso',
}

export function CollectionsPage() {
  const [bucket, setBucket] = useState<CollectionBucket>('in-progress')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const queryClient = useQueryClient()

  const { data: invoices = [], isLoading } = useQuery({
    queryKey: ['collections', 'overdue', bucket],
    queryFn: () => fetchOverdueStatus(bucket),
    staleTime: 30_000,
  })

  const exportSingle = useMutation({
    mutationFn: (invoiceId: string) => exportSingleCollection(invoiceId),
    onSuccess: (res) => {
      window.open(res.pdfUrl, '_blank', 'noopener')
      void queryClient.invalidateQueries({ queryKey: ['collections'] })
    },
  })

  const exportBulk = useMutation({
    mutationFn: () => exportBulkCollections([...selected]),
    onSuccess: (res) => {
      window.open(res.zipUrl, '_blank', 'noopener')
      setSelected(new Set())
      void queryClient.invalidateQueries({ queryKey: ['collections'] })
    },
  })

  const pause = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => pauseReminders(id, reason),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['collections'] }),
  })

  const resume = useMutation({
    mutationFn: (id: string) => resumeReminders(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['collections'] }),
  })

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allSelected = invoices.length > 0 && invoices.every((i) => selected.has(i.id))
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(invoices.map((i) => i.id)))
  }

  const summary = useMemo(() => {
    const totalAmount = invoices.reduce((s, i) => s + i.total, 0)
    const totalFees = invoices.reduce(
      (s, i) => s + i.reminders.reduce((rs, r) => rs + r.feeAmount, 0),
      0,
    )
    return { count: invoices.length, totalAmount, totalFees }
  }, [invoices])

  return (
    <PageWrapper id="collections">
      <PageHeader
        title="Inkasso"
        description="Hantera förfallna fakturor och förbered underlag till valt inkassobolag"
        action={
          bucket === 'ready' && selected.size > 0 ? (
            <Button
              variant="primary"
              onClick={() => exportBulk.mutate()}
              disabled={exportBulk.isPending}
            >
              <Package size={14} className="mr-1.5" />
              Exportera {selected.size} fakturor som ZIP
            </Button>
          ) : null
        }
      />

      {/* KPI-kort */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard label="Antal fakturor" value={String(summary.count)} />
        <KpiCard label="Totalbelopp" value={formatCurrency(summary.totalAmount)} />
        <KpiCard label="Påminnelseavgifter" value={formatCurrency(summary.totalFees)} />
      </div>

      {/* Filterflikar */}
      <div className="mt-6 flex w-fit gap-1 rounded-xl bg-gray-100 p-1">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => {
              setBucket(tab.id)
              setSelected(new Set())
            }}
            className={`h-8 rounded-lg px-3 text-[13px] font-medium transition ${
              bucket === tab.id
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[12px] text-gray-500">
        {TABS.find((t) => t.id === bucket)?.description}
      </p>

      {/* Inkasso-info-banner */}
      {bucket === 'ready' && (
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[13px] text-amber-800">
          <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
          <p>
            Eveno bedriver inte inkassoverksamhet. Underlag (PDF + CSV) genereras här och skickas av
            dig till ditt valda inkassobolag — t.ex. Visma Collectors, Intrum eller Lindorff.
          </p>
        </div>
      )}

      {/* Tabell */}
      <div className="mt-4 overflow-hidden rounded-2xl border border-[#EAEDF0] bg-white">
        {isLoading ? (
          <div className="p-8 text-center text-[13px] text-gray-500">Laddar...</div>
        ) : invoices.length === 0 ? (
          <div className="p-12 text-center">
            <Gavel size={28} className="mx-auto mb-3 text-gray-300" />
            <p className="text-[13.5px] font-medium text-gray-700">
              {bucket === 'sent'
                ? 'Inga fakturor har skickats till inkasso ännu.'
                : 'Inga fakturor i denna kategori just nu.'}
            </p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-[#EAEDF0] bg-gray-50/50 text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                {bucket === 'ready' && (
                  <th className="px-4 py-3 text-left">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      aria-label="Välj alla"
                    />
                  </th>
                )}
                <th className="px-4 py-3 text-left">Faktura</th>
                <th className="px-4 py-3 text-left">Hyresgäst</th>
                <th className="px-4 py-3 text-right">Belopp</th>
                <th className="px-4 py-3 text-left">Förfall</th>
                <th className="px-4 py-3 text-left">Påminnelser</th>
                <th className="px-4 py-3 text-right">Åtgärder</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <CollectionRow
                  key={inv.id}
                  invoice={inv}
                  bucket={bucket}
                  selected={selected.has(inv.id)}
                  onToggle={() => toggleSelect(inv.id)}
                  onExport={() => exportSingle.mutate(inv.id)}
                  onPause={() => {
                    const reason = window.prompt(
                      'Anledning till paus (t.ex. avbetalningsplan avtalad):',
                      '',
                    )
                    if (!reason) return
                    pause.mutate({ id: inv.id, reason })
                  }}
                  onResume={() => resume.mutate(inv.id)}
                  exporting={exportSingle.isPending}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </PageWrapper>
  )
}

interface RowProps {
  invoice: OverdueInvoice
  bucket: CollectionBucket
  selected: boolean
  onToggle: () => void
  onExport: () => void
  onPause: () => void
  onResume: () => void
  exporting: boolean
}

function CollectionRow({
  invoice,
  bucket,
  selected,
  onToggle,
  onExport,
  onPause,
  onResume,
  exporting,
}: RowProps) {
  return (
    <motion.tr
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="border-b border-[#EAEDF0] last:border-0 hover:bg-gray-50/80"
    >
      {bucket === 'ready' && (
        <td className="px-4 py-3">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            aria-label={`Välj ${invoice.invoiceNumber}`}
          />
        </td>
      )}
      <td className="px-4 py-3 text-[13.5px] font-medium text-gray-900">
        {invoice.invoiceNumber}
        {invoice.remindersPaused && (
          <span className="ml-2 inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
            <Pause size={10} /> Pausad
          </span>
        )}
      </td>
      <td className="px-4 py-3 text-[13.5px] text-gray-700">
        <div className="font-medium">{invoice.tenantName}</div>
        {invoice.tenantEmail && (
          <div className="text-[11.5px] text-gray-400">{invoice.tenantEmail}</div>
        )}
      </td>
      <td className="px-4 py-3 text-right text-[13.5px] font-medium text-gray-900">
        {formatCurrency(invoice.total)}
      </td>
      <td className="px-4 py-3 text-[13px] text-gray-700">
        <div>{formatDate(invoice.dueDate)}</div>
        <div className="text-[11.5px] text-red-600">
          {invoice.daysOverdue > 0
            ? `${invoice.daysOverdue} dagar sedan förfall`
            : 'Förfaller idag'}
        </div>
      </td>
      <td className="px-4 py-3 text-[12.5px] text-gray-600">
        {invoice.reminders.length === 0 ? (
          <span className="text-gray-400">Inga än</span>
        ) : (
          <ul className="space-y-0.5">
            {invoice.reminders.map((r) => (
              <li key={r.sentAt}>
                <span className="font-medium text-gray-700">
                  {REMINDER_LABEL[r.type] ?? r.type}
                </span>
                <span className="text-gray-400"> · {formatDate(r.sentAt)}</span>
                {r.feeAmount > 0 && (
                  <span className="text-amber-600"> · {formatCurrency(r.feeAmount)}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <InvoiceStatusBadge status={invoice.status} />
          {bucket === 'sent' ? null : invoice.remindersPaused ? (
            <Button variant="secondary" size="sm" onClick={onResume}>
              <Play size={12} className="mr-1" />
              Återuppta
            </Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={onPause}>
              <Pause size={12} className="mr-1" />
              Pausa
            </Button>
          )}
          {bucket === 'ready' && (
            <Button variant="primary" size="sm" onClick={onExport} disabled={exporting}>
              <Send size={12} className="mr-1" />
              Skicka till inkasso
            </Button>
          )}
          {bucket === 'sent' && (
            <Button variant="secondary" size="sm" onClick={onExport} disabled={exporting}>
              <FileDown size={12} className="mr-1" />
              Hämta underlag
            </Button>
          )}
        </div>
      </td>
    </motion.tr>
  )
}

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-[#EAEDF0] bg-white p-4">
      <p className="text-[12px] text-gray-500">{label}</p>
      <p className="mt-1 text-[22px] font-semibold tracking-tight text-gray-900">{value}</p>
    </div>
  )
}
