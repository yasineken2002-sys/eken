import { useState, useMemo } from 'react'
import { motion } from 'framer-motion'
import { CreditCard, Wallet, AlertCircle } from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { StatCard } from '@/components/ui/StatCard'
import { DataTable } from '@/components/ui/DataTable'
import { EmptyState } from '@/components/ui/EmptyState'
import { DepositStatusBadge } from '@/components/ui/Badge'
import { useDeposits } from './hooks/useDeposits'
import { formatCurrency, formatDate } from '@eken/shared'
import type { DepositStatus, Tenant } from '@eken/shared'
import type { DepositDetail } from './api/deposits.api'
import type { Route } from '@/App'
import { cn } from '@/lib/cn'

type Tab = 'ALL' | DepositStatus
const TABS: { id: Tab; label: string }[] = [
  { id: 'ALL', label: 'Alla' },
  { id: 'PENDING', label: 'Fakturerade' },
  { id: 'PAID', label: 'Betalda' },
  { id: 'REFUND_PENDING', label: 'Väntar återbetalning' },
  { id: 'REFUNDED', label: 'Återbetalda' },
  { id: 'PARTIALLY_REFUNDED', label: 'Delvis återbetalda' },
  { id: 'FORFEITED', label: 'Förverkade' },
]

function tenantName(t: Tenant): string {
  if (t.type === 'INDIVIDUAL') {
    return [t.firstName, t.lastName].filter(Boolean).join(' ') || '–'
  }
  return t.companyName ?? '–'
}

interface DepositsPageProps {
  onNavigate?: (route: Route) => void
}

export function DepositsPage({ onNavigate }: DepositsPageProps = {}) {
  const [tab, setTab] = useState<Tab>('ALL')
  const { data: deposits = [], isLoading } = useDeposits()

  const filtered = useMemo(() => {
    if (tab === 'ALL') return deposits
    return deposits.filter((d) => d.status === tab)
  }, [deposits, tab])

  const totalManaged = deposits
    .filter((d) => d.status === 'PAID' || d.status === 'REFUND_PENDING')
    .reduce((s, d) => s + Number(d.amount), 0)
  const refundPending = deposits.filter((d) => d.status === 'REFUND_PENDING').length
  const totalAll = deposits.length

  const columns = [
    {
      key: 'tenant',
      header: 'Hyresgäst',
      cell: (d: DepositDetail) => (
        <span className="text-[13px] font-medium text-gray-900">{tenantName(d.tenant)}</span>
      ),
    },
    {
      key: 'unit',
      header: 'Enhet',
      cell: (d: DepositDetail) => (
        <div>
          <p className="text-[13px] text-gray-700">{d.lease.unit.name}</p>
          <p className="text-[11px] text-gray-400">{d.lease.unit.property.name}</p>
        </div>
      ),
    },
    {
      key: 'amount',
      header: 'Belopp',
      align: 'right' as const,
      cell: (d: DepositDetail) => (
        <span className="font-semibold text-gray-800">{formatCurrency(Number(d.amount))}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (d: DepositDetail) => <DepositStatusBadge status={d.status} />,
    },
    {
      key: 'created',
      header: 'Registrerad',
      cell: (d: DepositDetail) => (
        <span className="text-[12.5px] text-gray-500">{formatDate(d.createdAt)}</span>
      ),
    },
  ]

  return (
    <PageWrapper id="deposits">
      <PageHeader
        title="Depositioner"
        description={`${totalAll} ${totalAll === 1 ? 'deposition' : 'depositioner'}`}
      />

      <motion.div
        initial="hidden"
        animate="show"
        variants={{ hidden: {}, show: { transition: { staggerChildren: 0.05 } } }}
        className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3"
      >
        <StatCard
          title="Förvaltat depositionskapital"
          value={formatCurrency(totalManaged)}
          icon={Wallet}
          iconColor="#2563EB"
        />
        <StatCard
          title="Väntar återbetalning"
          value={refundPending}
          icon={AlertCircle}
          iconColor="#D97706"
        />
        <StatCard title="Totalt" value={totalAll} icon={CreditCard} iconColor="#6B7280" />
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
            Laddar depositioner…
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={CreditCard}
            title="Inga depositioner"
            description="Skapa en deposition från ett hyresavtal för att komma igång."
          />
        ) : (
          <DataTable
            columns={columns}
            data={filtered}
            keyExtractor={(d) => d.id}
            onRowClick={() => onNavigate?.('leases')}
          />
        )}
      </div>
    </PageWrapper>
  )
}
