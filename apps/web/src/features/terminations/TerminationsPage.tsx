import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { toast } from 'sonner'
import { LogOut, Clock, Check, X, KeyRound } from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { StatCard } from '@/components/ui/StatCard'
import { DataTable } from '@/components/ui/DataTable'
import { EmptyState } from '@/components/ui/EmptyState'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import {
  useTerminations,
  useApproveTermination,
  useRejectTermination,
} from './hooks/useTerminations'
import type { TerminationRequestDetail, TerminationStatus } from './api/terminations.api'
import { formatDate } from '@eken/shared'
import type { Tenant } from '@eken/shared'
import { useCanDelete } from '@/hooks/useCanWrite'
import { useKeys } from '@/features/keys/hooks/useKeys'
import { cn } from '@/lib/cn'

type Tab = 'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL'
const TABS: { id: Tab; label: string }[] = [
  { id: 'PENDING', label: 'Väntar' },
  { id: 'APPROVED', label: 'Godkända' },
  { id: 'REJECTED', label: 'Avslagna' },
  { id: 'ALL', label: 'Alla' },
]

const STATUS_META: Record<TerminationStatus, { label: string; className: string }> = {
  PENDING: { label: 'Väntar svar', className: 'bg-amber-50 text-amber-700' },
  APPROVED: { label: 'Godkänd', className: 'bg-emerald-50 text-emerald-700' },
  REJECTED: { label: 'Avslagen', className: 'bg-red-50 text-red-600' },
}

function tenantName(t: Tenant): string {
  if (t.type === 'INDIVIDUAL') return [t.firstName, t.lastName].filter(Boolean).join(' ') || '–'
  return t.companyName ?? '–'
}

function StatusBadge({ status }: { status: TerminationStatus }) {
  const m = STATUS_META[status]
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-medium',
        m.className,
      )}
    >
      {m.label}
    </span>
  )
}

// Förberäknat BINDANDE slutdatum: senare av önskat datum och idag +
// uppsägningstid (JB 12 kap 5 §). Hyresvärden bekräftar/justerar det.
function suggestedEndDate(r: TerminationRequestDetail): string {
  const floor = new Date()
  floor.setHours(0, 0, 0, 0)
  floor.setMonth(
    floor.getMonth() + (r.lease.noticePeriodMonths > 0 ? r.lease.noticePeriodMonths : 3),
  )
  const requested = new Date(r.requestedEndDate)
  const chosen = requested.getTime() > floor.getTime() ? requested : floor
  return chosen.toISOString().slice(0, 10)
}

export function TerminationsPage() {
  const [tab, setTab] = useState<Tab>('PENDING')
  const { data: requests = [], isLoading } = useTerminations()
  const canReview = useCanDelete()
  const [approving, setApproving] = useState<TerminationRequestDetail | null>(null)
  const [rejecting, setRejecting] = useState<TerminationRequestDetail | null>(null)

  const filtered = useMemo(
    () => (tab === 'ALL' ? requests : requests.filter((r) => r.status === tab)),
    [requests, tab],
  )
  const pendingCount = useMemo(
    () => requests.filter((r) => r.status === 'PENDING').length,
    [requests],
  )

  const columns = [
    {
      key: 'tenant',
      header: 'Hyresgäst',
      cell: (r: TerminationRequestDetail) => (
        <span className="text-[13px] font-medium text-gray-900">{tenantName(r.tenant)}</span>
      ),
    },
    {
      key: 'unit',
      header: 'Enhet',
      cell: (r: TerminationRequestDetail) => (
        <div>
          <p className="text-[13px] text-gray-700">{r.lease.unit.name}</p>
          <p className="text-[11px] text-gray-400">{r.lease.unit.property.name}</p>
        </div>
      ),
    },
    {
      key: 'requested',
      header: 'Önskat slutdatum',
      cell: (r: TerminationRequestDetail) => (
        <span className="text-[12.5px] text-gray-600">{formatDate(r.requestedEndDate)}</span>
      ),
    },
    {
      key: 'reason',
      header: 'Skäl',
      cell: (r: TerminationRequestDetail) => (
        <span className="text-[12.5px] text-gray-500">{r.reason || '—'}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (r: TerminationRequestDetail) => <StatusBadge status={r.status} />,
    },
    {
      key: 'actions',
      header: '',
      cell: (r: TerminationRequestDetail) =>
        r.status === 'PENDING' && canReview ? (
          <div className="flex justify-end gap-2">
            <Button size="xs" variant="primary" onClick={() => setApproving(r)}>
              <Check size={11} strokeWidth={1.8} />
              Godkänn
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setRejecting(r)}>
              <X size={11} strokeWidth={1.8} />
              Avslå
            </Button>
          </div>
        ) : null,
    },
  ]

  return (
    <PageWrapper id="terminations">
      <PageHeader
        title="Uppsägningar"
        description={`${requests.length} ${requests.length === 1 ? 'begäran' : 'begäranden'}`}
      />

      <motion.div
        initial="hidden"
        animate="show"
        variants={{ hidden: {}, show: { transition: { staggerChildren: 0.05 } } }}
        className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3"
      >
        <StatCard title="Väntar på beslut" value={pendingCount} icon={Clock} iconColor="#D97706" />
        <StatCard
          title="Godkända"
          value={requests.filter((r) => r.status === 'APPROVED').length}
          icon={Check}
          iconColor="#10B981"
        />
        <StatCard
          title="Avslagna"
          value={requests.filter((r) => r.status === 'REJECTED').length}
          icon={X}
          iconColor="#DC2626"
        />
      </motion.div>

      <div className="mt-6 flex w-fit flex-wrap gap-1 rounded-xl bg-gray-100/70 p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'h-8 rounded-lg px-3 text-[13px] font-medium transition-all',
              tab === t.id
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {isLoading ? (
          <div className="flex h-32 items-center justify-center text-[13px] text-gray-400">
            Laddar uppsägningar…
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={LogOut}
            title="Inga uppsägningar"
            description="Här dyker hyresgästers uppsägningsbegäranden upp för granskning och beslut."
          />
        ) : (
          <DataTable columns={columns} data={filtered} keyExtractor={(r) => r.id} />
        )}
      </div>

      {approving && (
        <Modal open onClose={() => setApproving(null)} title="Godkänn uppsägning" size="md">
          <ApproveForm request={approving} onClose={() => setApproving(null)} />
        </Modal>
      )}
      {rejecting && (
        <Modal open onClose={() => setRejecting(null)} title="Avslå uppsägning" size="sm">
          <RejectForm request={rejecting} onClose={() => setRejecting(null)} />
        </Modal>
      )}
    </PageWrapper>
  )
}

// ─── Godkänn-formulär ───────────────────────────────────────────────────────────

function ApproveForm({
  request,
  onClose,
}: {
  request: TerminationRequestDetail
  onClose: () => void
}) {
  const approve = useApproveTermination()
  const [effectiveDate, setEffectiveDate] = useState(suggestedEndDate(request))
  const minDate = useMemo(() => new Date().toISOString().slice(0, 10), [])

  // Mjuk påminnelse: visa hur många nycklar som ännu inte återlämnats för
  // avtalet. Blockerar INTE godkännandet — bara en nudge inför avflyttningen.
  const { data: openKeys = [] } = useKeys({ leaseId: request.leaseId, status: 'ISSUED' })

  const submit = () => {
    if (!effectiveDate) return
    approve.mutate(
      { id: request.id, effectiveDate },
      {
        onSuccess: () => {
          toast.success('Uppsägning godkänd — kontraktet sägs upp och hyresgästen meddelas')
          onClose()
        },
        onError: () => toast.error('Kunde inte godkänna uppsägningen'),
      },
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-gray-600">
        Hyresgästen <strong>{tenantName(request.tenant)}</strong> har begärt uppsägning av{' '}
        <strong>{request.lease.unit.name}</strong> per {formatDate(request.requestedEndDate)}.
      </p>
      <p className="rounded-lg bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800">
        Slutdatumet är förberäknat till det senare av önskat datum och uppsägningstiden (
        {request.lease.noticePeriodMonths || 3} mån). Justera vid behov — det är detta datum
        kontraktet sägs upp till.
      </p>
      {openKeys.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800">
          <KeyRound size={14} strokeWidth={1.8} className="mt-0.5 shrink-0" />
          <span>
            <strong>
              {openKeys.length} {openKeys.length === 1 ? 'nyckel' : 'nycklar'} ej återlämnade
            </strong>{' '}
            för det här avtalet. Påminn hyresgästen om att lämna tillbaka samtliga nycklar senast på
            avflyttningsdagen.
          </span>
        </div>
      )}
      <Input
        label="Bindande slutdatum"
        type="date"
        value={effectiveDate}
        min={minDate}
        onChange={(e) => setEffectiveDate(e.target.value)}
      />
      <ModalFooter>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={approve.isPending}>
          Avbryt
        </Button>
        <Button
          variant="primary"
          size="sm"
          loading={approve.isPending}
          disabled={!effectiveDate}
          onClick={submit}
        >
          Godkänn & säg upp
        </Button>
      </ModalFooter>
    </div>
  )
}

// ─── Avslå-formulär ─────────────────────────────────────────────────────────────

function RejectForm({
  request,
  onClose,
}: {
  request: TerminationRequestDetail
  onClose: () => void
}) {
  const reject = useRejectTermination()
  const [reason, setReason] = useState('')

  const submit = () => {
    reject.mutate(
      { id: request.id, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      {
        onSuccess: () => {
          toast.success('Uppsägningsbegäran avslagen — hyresgästen meddelas')
          onClose()
        },
        onError: () => toast.error('Kunde inte avslå begäran'),
      },
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-gray-600">
        Avslå uppsägningsbegäran från <strong>{tenantName(request.tenant)}</strong>. Hyresgästen
        meddelas via e-post.
      </p>
      <Input
        label="Motivering (valfri, mejlas till hyresgästen)"
        placeholder="t.ex. Uppsägningstiden är inte uppfylld"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <ModalFooter>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={reject.isPending}>
          Avbryt
        </Button>
        <Button variant="primary" size="sm" loading={reject.isPending} onClick={submit}>
          Avslå begäran
        </Button>
      </ModalFooter>
    </div>
  )
}
