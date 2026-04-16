import { motion } from 'framer-motion'
import {
  Building2,
  Banknote,
  FileText,
  AlertTriangle,
  Users,
  Receipt,
  TrendingUp,
  Sparkles,
  ChevronRight,
  ArrowUpRight,
} from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { StatCard } from '@/components/ui/StatCard'
import { EmptyState } from '@/components/ui/EmptyState'
import { InvoiceStatusBadge } from '@/components/ui/Badge'
import { useDashboardStats } from './hooks/useDashboard'
import { formatCurrency, formatDate } from '@eken/shared'
import type { Route } from '@/App'

interface DashboardPageProps {
  onNavigate?: (route: Route) => void
}

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } }
const item = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
}

const AI_CHIPS = [
  { label: 'Förfallna fakturor', prompt: 'Analysera förfallna fakturor' },
  { label: 'Beläggning', prompt: 'Hur ser beläggningen ut?' },
  { label: 'Utgående avtal', prompt: 'Vilka kontrakt löper ut snart?' },
]

export function DashboardPage({ onNavigate }: DashboardPageProps = {}) {
  const { data: stats, isLoading, isError } = useDashboardStats()

  if (isError) {
    return (
      <PageWrapper id="dashboard">
        <EmptyState
          icon={AlertTriangle}
          title="Något gick fel"
          description="Kunde inte ladda översikten. Försök igen."
        />
      </PageWrapper>
    )
  }

  const today = new Date().toLocaleDateString('sv-SE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })

  return (
    <PageWrapper id="dashboard">
      <PageHeader title="Översikt" description={today.charAt(0).toUpperCase() + today.slice(1)} />

      {/* KPI Grid */}
      {isLoading ? (
        <div className="mt-7 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-[110px] animate-pulse rounded-2xl bg-gray-100" />
          ))}
        </div>
      ) : (
        <motion.div
          variants={stagger}
          initial="hidden"
          animate="show"
          className="mt-7 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          <motion.div variants={item}>
            <StatCard
              title="Totala intäkter"
              value={formatCurrency(stats?.invoices.totalRevenue ?? 0)}
              icon={Banknote}
              iconColor="#2563EB"
            />
          </motion.div>
          <motion.div variants={item}>
            <StatCard
              title="Försenat belopp"
              value={formatCurrency(stats?.invoices.overdueAmount ?? 0)}
              icon={AlertTriangle}
              iconColor="#EF4444"
            />
          </motion.div>
          <motion.div variants={item}>
            <StatCard
              title="Aktiva kontrakt"
              value={stats?.leases.active ?? 0}
              icon={FileText}
              iconColor="#8B5CF6"
            />
          </motion.div>
          <motion.div variants={item}>
            <StatCard
              title="Hyresgäster"
              value={stats?.tenants.total ?? 0}
              icon={Users}
              iconColor="#0891B2"
            />
          </motion.div>
          <motion.div variants={item}>
            <StatCard
              title="Fastigheter"
              value={stats?.properties.total ?? 0}
              icon={Building2}
              iconColor="#64748B"
            />
          </motion.div>
          <motion.div variants={item}>
            <StatCard
              title="Osänt (utkast)"
              value={stats?.invoices.draft ?? 0}
              icon={TrendingUp}
              iconColor="#F59E0B"
            />
          </motion.div>
        </motion.div>
      )}

      {/* AI Insights card */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25 }}
        className="mt-6 overflow-hidden rounded-2xl border border-blue-100/60 bg-gradient-to-br from-blue-600 to-blue-700"
      >
        <div className="flex items-center gap-5 px-6 py-5">
          <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-white/15">
            <Sparkles size={20} strokeWidth={1.8} className="text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold text-white">AI-insikter</p>
            <p className="mt-0.5 text-[13px] text-blue-100/80">
              Låt Eken AI analysera din portfölj och ge konkreta råd
            </p>
          </div>
          <div className="hidden flex-shrink-0 gap-2 md:flex">
            {AI_CHIPS.map((chip) => (
              <button
                key={chip.label}
                onClick={() => onNavigate?.('ai')}
                className="flex items-center gap-1.5 rounded-full border border-white/20 bg-white/10 px-3.5 py-1.5 text-[12.5px] font-medium text-white transition-all hover:bg-white/20 active:scale-[0.97]"
              >
                {chip.label}
                <ChevronRight size={11} strokeWidth={2.5} />
              </button>
            ))}
          </div>
          <button onClick={() => onNavigate?.('ai')} className="flex-shrink-0 md:hidden">
            <ArrowUpRight size={18} className="text-white/70" />
          </button>
        </div>
      </motion.div>

      {/* Recent invoices */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="mt-6 overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-[0_1px_4px_rgba(0,0,0,0.04)]"
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <h2 className="text-[15px] font-semibold text-gray-900">Senaste fakturor</h2>
          <button
            onClick={() => onNavigate?.('invoices')}
            className="flex items-center gap-1 text-[13px] font-medium text-blue-600 transition-colors hover:text-blue-700"
          >
            Visa alla <ChevronRight size={13} strokeWidth={2} />
          </button>
        </div>

        {isLoading ? (
          <div className="divide-y divide-gray-50">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-6 py-4">
                <div className="h-4 w-24 animate-pulse rounded-full bg-gray-100" />
                <div className="h-4 w-36 animate-pulse rounded-full bg-gray-100" />
                <div className="ml-auto h-4 w-20 animate-pulse rounded-full bg-gray-100" />
              </div>
            ))}
          </div>
        ) : stats?.recentInvoices.length === 0 ? (
          <div className="py-12 text-center text-[13.5px] text-gray-400">Inga fakturor ännu</div>
        ) : (
          <div>
            {/* Header row */}
            <div className="grid grid-cols-5 gap-4 border-b border-gray-50 px-6 py-2.5">
              {['Fakturanr', 'Hyresgäst', 'Belopp', 'Förfaller', 'Status'].map((h) => (
                <p
                  key={h}
                  className="text-[11.5px] font-semibold uppercase tracking-wider text-gray-400"
                >
                  {h}
                </p>
              ))}
            </div>
            {stats?.recentInvoices.map((inv, i) => (
              <motion.div
                key={inv.id}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.32 + i * 0.04 }}
                onClick={() => onNavigate?.('invoices')}
                className="grid cursor-pointer grid-cols-5 gap-4 border-b border-gray-50 px-6 py-4 transition-colors last:border-0 hover:bg-gray-50/60"
              >
                <div className="flex items-center gap-2.5">
                  <Receipt size={13} strokeWidth={1.8} className="text-gray-300" />
                  <span className="text-[13.5px] font-medium text-gray-800">
                    {inv.invoiceNumber}
                  </span>
                </div>
                <span className="truncate text-[13.5px] text-gray-600">{inv.tenantName}</span>
                <span className="text-[13.5px] font-semibold text-gray-900">
                  {formatCurrency(Number(inv.total))}
                </span>
                <span className="text-[13.5px] text-gray-500">{formatDate(inv.dueDate)}</span>
                <InvoiceStatusBadge
                  status={inv.status as Parameters<typeof InvoiceStatusBadge>[0]['status']}
                />
              </motion.div>
            ))}
          </div>
        )}
      </motion.div>
    </PageWrapper>
  )
}
