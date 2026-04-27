import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { TrendingUp, CheckCircle2, Clock } from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { StatCard } from '@/components/ui/StatCard'
import { DataTable } from '@/components/ui/DataTable'
import { EmptyState } from '@/components/ui/EmptyState'
import { RentIncreaseStatusBadge } from '@/components/ui/Badge'
import { useRentIncreases } from './hooks/useRentIncreases'
import { formatCurrency, formatDate } from '@eken/shared'
import type { RentIncreaseStatus, Tenant } from '@eken/shared'
import type { RentIncreaseDetail } from './api/rent-increases.api'
import type { Route } from '@/App'
import { cn } from '@/lib/cn'

type Tab = 'ALL' | RentIncreaseStatus
const TABS: { id: Tab; label: string }[] = [
  { id: 'ALL', label: 'Alla' },
  { id: 'DRAFT', label: 'Utkast' },
  { id: 'NOTICE_SENT', label: 'Aviserade' },
  { id: 'ACCEPTED', label: 'Godkända' },
  { id: 'APPLIED', label: 'Tillämpade' },
  { id: 'REJECTED', label: 'Nekade' },
  { id: 'WITHDRAWN', label: 'Återkallade' },
]

function tenantName(t: Tenant): string {
  if (t.type === 'INDIVIDUAL') {
    return [t.firstName, t.lastName].filter(Boolean).join(' ') || '–'
  }
  return t.companyName ?? '–'
}

interface Props {
  onNavigate?: (route: Route) => void
}

export function RentIncreasesPage({ onNavigate }: Props = {}) {
  const [tab, setTab] = useState<Tab>('ALL')
  const { data: increases = [], isLoading } = useRentIncreases()

  const filtered = useMemo(() => {
    if (tab === 'ALL') return increases
    return increases.filter((r) => r.status === tab)
  }, [increases, tab])

  const stats = useMemo(() => {
    const now = Date.now()
    const in30 = now + 30 * 86_400_000
    const upcoming = increases.filter(
      (r) =>
        r.status === 'ACCEPTED' &&
        new Date(r.effectiveDate).getTime() >= now &&
        new Date(r.effectiveDate).getTime() <= in30,
    ).length
    const awaiting = increases.filter((r) => r.status === 'NOTICE_SENT').length
    const applied = increases.filter((r) => r.status === 'APPLIED').length
    return { upcoming, awaiting, applied }
  }, [increases])

  const columns = [
    {
      key: 'tenant',
      header: 'Hyresgäst',
      cell: (r: RentIncreaseDetail) => (
        <span className="text-[13px] font-medium text-gray-900">{tenantName(r.lease.tenant)}</span>
      ),
    },
    {
      key: 'unit',
      header: 'Enhet',
      cell: (r: RentIncreaseDetail) => (
        <div>
          <p className="text-[13px] text-gray-700">{r.lease.unit.name}</p>
          <p className="text-[11px] text-gray-400">{r.lease.unit.property.name}</p>
        </div>
      ),
    },
    {
      key: 'change',
      header: 'Höjning',
      cell: (r: RentIncreaseDetail) => (
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-gray-700">
            {formatCurrency(Number(r.currentRent))} → {formatCurrency(Number(r.newRent))}
          </span>
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
            +{Number(r.increasePercent).toFixed(2)}%
          </span>
        </div>
      ),
    },
    {
      key: 'effective',
      header: 'Gäller från',
      cell: (r: RentIncreaseDetail) => (
        <span className="text-[12.5px] text-gray-500">{formatDate(r.effectiveDate)}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (r: RentIncreaseDetail) => <RentIncreaseStatusBadge status={r.status} />,
    },
  ]

  return (
    <PageWrapper id="rent-increases">
      <PageHeader
        title="Hyreshöjningar"
        description={`${increases.length} ${increases.length === 1 ? 'höjning' : 'höjningar'}`}
      />

      <motion.div
        initial="hidden"
        animate="show"
        variants={{ hidden: {}, show: { transition: { staggerChildren: 0.05 } } }}
        className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3"
      >
        <StatCard
          title="Träder i kraft inom 30 dagar"
          value={stats.upcoming}
          icon={Clock}
          iconColor="#D97706"
        />
        <StatCard
          title="Väntar svar"
          value={stats.awaiting}
          icon={TrendingUp}
          iconColor="#2563EB"
        />
        <StatCard
          title="Tillämpade"
          value={stats.applied}
          icon={CheckCircle2}
          iconColor="#10B981"
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
            Laddar hyreshöjningar…
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={TrendingUp}
            title="Inga hyreshöjningar"
            description="Skapa en hyreshöjning från ett hyresavtal för att komma igång."
          />
        ) : (
          <DataTable
            columns={columns}
            data={filtered}
            keyExtractor={(r) => r.id}
            onRowClick={() => onNavigate?.('leases')}
          />
        )}
      </div>
    </PageWrapper>
  )
}
