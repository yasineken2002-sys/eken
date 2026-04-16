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

  return (
    <PageWrapper id="dashboard">
      <PageHeader
        title="Översikt"
        description={new Date().toLocaleDateString('sv-SE', {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
        })}
      />

      {/* KPI Grid */}
      {isLoading ? (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl bg-gray-100" />
          ))}
        </div>
      ) : (
        <motion.div
          variants={stagger}
          initial="hidden"
          animate="show"
          className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          <motion.div variants={item}>
            <StatCard
              title="Totala intäkter"
              value={formatCurrency(stats?.invoices.totalRevenue ?? 0)}
              icon={Banknote}
              iconColor="#218F52"
              delay={0}
            />
          </motion.div>
          <motion.div variants={item}>
            <StatCard
              title="Försenat belopp"
              value={formatCurrency(stats?.invoices.overdueAmount ?? 0)}
              icon={AlertTriangle}
              iconColor="#DC2626"
              delay={0.06}
            />
          </motion.div>
          <motion.div variants={item}>
            <StatCard
              title="Aktiva kontrakt"
              value={stats?.leases.active ?? 0}
              icon={FileText}
              iconColor="#0B84D0"
              delay={0.12}
            />
          </motion.div>
          <motion.div variants={item}>
            <StatCard
              title="Hyresgäster"
              value={stats?.tenants.total ?? 0}
              icon={Users}
              iconColor="#7C3AED"
              delay={0.18}
            />
          </motion.div>
          <motion.div variants={item}>
            <StatCard
              title="Fastigheter"
              value={stats?.properties.total ?? 0}
              icon={Building2}
              iconColor="#64748B"
              delay={0.24}
            />
          </motion.div>
          <motion.div variants={item}>
            <StatCard
              title="Osänt (utkast)"
              value={stats?.invoices.draft ?? 0}
              icon={TrendingUp}
              iconColor="#F59E0B"
              delay={0.3}
            />
          </motion.div>
        </motion.div>
      )}

      {/* AI Insights card */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.28 }}
        className="mt-6 overflow-hidden rounded-2xl border border-blue-100 bg-gradient-to-r from-blue-50 to-indigo-50"
      >
        <div className="flex items-center gap-4 px-5 py-4">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-blue-100 bg-white shadow-sm">
            <Sparkles size={18} strokeWidth={1.8} className="text-blue-600" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-gray-900">AI-insikter</p>
            <p className="text-[12.5px] text-gray-500">
              Låt Eken AI analysera din portfölj och ge konkreta råd
            </p>
          </div>
          <div className="flex flex-shrink-0 gap-2">
            {[
              { label: 'Förfallna fakturor', prompt: 'Analysera förfallna fakturor' },
              { label: 'Beläggning', prompt: 'Hur ser beläggningen ut?' },
              { label: 'Utgående avtal', prompt: 'Vilka kontrakt löper ut snart?' },
            ].map((chip) => (
              <button
                key={chip.label}
                onClick={() => onNavigate?.('ai')}
                className="flex items-center gap-1.5 rounded-full border border-blue-200 bg-white px-3 py-1.5 text-[12px] font-medium text-blue-700 transition-all hover:border-blue-600 hover:bg-blue-600 hover:text-white active:scale-[0.97]"
              >
                {chip.label}
                <ChevronRight size={11} strokeWidth={2} />
              </button>
            ))}
          </div>
        </div>
      </motion.div>

      {/* Recent invoices */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="mt-6 overflow-hidden rounded-2xl border border-[#EAEDF0] bg-white"
      >
        <div className="border-b border-[#EAEDF0] px-5 py-4">
          <h2 className="text-[14px] font-semibold text-gray-900">Senaste fakturor</h2>
        </div>

        {isLoading ? (
          <div className="divide-y divide-[#EAEDF0]">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-3.5">
                <div className="h-4 w-24 animate-pulse rounded bg-gray-100" />
                <div className="h-4 w-32 animate-pulse rounded bg-gray-100" />
                <div className="ml-auto h-4 w-20 animate-pulse rounded bg-gray-100" />
              </div>
            ))}
          </div>
        ) : stats?.recentInvoices.length === 0 ? (
          <div className="py-10 text-center text-[13px] text-gray-400">Inga fakturor ännu</div>
        ) : (
          <div className="divide-y divide-[#EAEDF0]">
            {/* Header row */}
            <div className="grid grid-cols-5 gap-4 px-5 py-2.5">
              {['Fakturanr', 'Hyresgäst', 'Belopp', 'Förfaller', 'Status'].map((h) => (
                <p
                  key={h}
                  className="text-[12px] font-semibold uppercase tracking-wide text-gray-400"
                >
                  {h}
                </p>
              ))}
            </div>
            {stats?.recentInvoices.map((inv, i) => (
              <motion.div
                key={inv.id}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.35 + i * 0.05 }}
                onClick={() => onNavigate?.('invoices')}
                className="grid cursor-pointer grid-cols-5 gap-4 px-5 py-3.5 transition-colors hover:bg-gray-50/80"
              >
                <div className="flex items-center gap-2">
                  <Receipt size={13} strokeWidth={1.8} className="text-gray-400" />
                  <span className="text-[13px] font-medium text-gray-800">{inv.invoiceNumber}</span>
                </div>
                <span className="truncate text-[13px] text-gray-600">{inv.tenantName}</span>
                <span className="text-[13px] font-semibold text-gray-800">
                  {formatCurrency(Number(inv.total))}
                </span>
                <span className="text-[13px] text-gray-500">{formatDate(inv.dueDate)}</span>
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
