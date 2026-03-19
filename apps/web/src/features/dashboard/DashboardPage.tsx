import { motion } from 'framer-motion'
import {
  Building2,
  Home,
  FileText,
  Receipt,
  AlertTriangle,
  Clock,
  ArrowUpRight,
  CheckCircle2,
  AlertCircle,
  Banknote,
} from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { StatCard } from '@/components/ui/StatCard'
import {
  dashboardStats,
  recentActivity,
  mockInvoices,
  mockLeases,
  mockProperties,
} from '@/lib/mock-data'
import { formatCurrency, formatDate } from '@eken/shared'

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } }

export function DashboardPage() {
  const overdue = mockInvoices.filter((i) => i.status === 'OVERDUE')
  const expiringLeases = mockLeases.filter((l) => {
    if (!l.endDate) return false
    const months = (new Date(l.endDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30)
    return months <= 3
  })

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
      <motion.div
        variants={stagger}
        initial="hidden"
        animate="show"
        className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4"
      >
        <StatCard
          title="Intäkter denna månad"
          value={formatCurrency(dashboardStats.totalRevenueMTD)}
          change={dashboardStats.revenueGrowth}
          changeLabel="vs förra mån"
          icon={Banknote}
          iconColor="text-blue-500"
          delay={0}
        />
        <StatCard
          title="Vakansgrad"
          value={`${dashboardStats.vacancyRate}%`}
          change={dashboardStats.vacancyChange}
          changeLabel="vs förra mån"
          icon={Home}
          iconColor="text-violet-500"
          delay={0.06}
        />
        <StatCard
          title="Aktiva avtal"
          value={dashboardStats.activeLeases}
          icon={FileText}
          iconColor="text-emerald-500"
          delay={0.12}
        />
        <StatCard
          title="Försenat belopp"
          value={formatCurrency(dashboardStats.overdueAmount)}
          icon={AlertTriangle}
          iconColor="text-red-500"
          delay={0.18}
        />
      </motion.div>

      <motion.div
        variants={stagger}
        initial="hidden"
        animate="show"
        className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4"
      >
        <StatCard
          title="Fastigheter"
          value={dashboardStats.totalProperties}
          icon={Building2}
          iconColor="text-slate-500"
          delay={0.1}
        />
        <StatCard
          title="Totalt objekt"
          value={dashboardStats.totalUnits}
          icon={Home}
          iconColor="text-teal-500"
          delay={0.16}
        />
        <StatCard
          title="Uthyrda objekt"
          value={dashboardStats.occupiedUnits}
          icon={CheckCircle2}
          iconColor="text-emerald-500"
          delay={0.22}
        />
        <StatCard
          title="Avtal utgår snart"
          value={expiringLeases.length}
          icon={Clock}
          iconColor="text-amber-500"
          delay={0.28}
        />
      </motion.div>

      <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-5">
        {/* Recent activity */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="overflow-hidden rounded-2xl border border-[#EAEDF0] bg-white lg:col-span-3"
        >
          <div className="border-b border-[#EAEDF0] px-5 py-4">
            <h2 className="text-[14px] font-semibold text-gray-900">Senaste aktivitet</h2>
          </div>
          <div className="divide-y divide-[#EAEDF0]">
            {recentActivity.map((a, i) => (
              <motion.div
                key={a.id}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.3 + i * 0.07 }}
                className="flex items-start gap-3 px-5 py-3.5"
              >
                <div
                  className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl ${
                    a.type === 'payment'
                      ? 'bg-emerald-50'
                      : a.type === 'alert'
                        ? 'bg-red-50'
                        : a.type === 'lease'
                          ? 'bg-amber-50'
                          : 'bg-blue-50'
                  }`}
                >
                  {a.type === 'payment' && <CheckCircle2 size={15} className="text-emerald-600" />}
                  {a.type === 'invoice' && <Receipt size={15} className="text-blue-600" />}
                  {a.type === 'alert' && <AlertCircle size={15} className="text-red-600" />}
                  {a.type === 'lease' && <Clock size={15} className="text-amber-600" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-medium text-gray-800">{a.title}</p>
                  <p className="mt-0.5 text-[12px] text-gray-400">{a.description}</p>
                </div>
                <div className="flex-shrink-0 text-right">
                  {a.amount !== undefined && (
                    <p className="text-[13px] font-semibold text-gray-700">
                      {formatCurrency(a.amount)}
                    </p>
                  )}
                  <p className="mt-0.5 text-[11px] text-gray-400">
                    {new Date(a.timestamp).toLocaleDateString('sv-SE', {
                      day: 'numeric',
                      month: 'short',
                    })}
                  </p>
                </div>
              </motion.div>
            ))}
          </div>
        </motion.div>

        {/* Right column */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="space-y-4 lg:col-span-2"
        >
          <div className="overflow-hidden rounded-2xl border border-[#EAEDF0] bg-white">
            <div className="border-b border-[#EAEDF0] px-5 py-4">
              <h2 className="text-[14px] font-semibold text-gray-900">Fastigheter</h2>
            </div>
            {mockProperties.map((p, i) => (
              <motion.div
                key={p.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.35 + i * 0.06 }}
                className="flex cursor-pointer items-center gap-3 border-b border-[#EAEDF0] px-5 py-3 transition-colors last:border-0 hover:bg-gray-50"
              >
                <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-blue-50">
                  <Building2 size={13} className="text-blue-600" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-gray-800">{p.name}</p>
                  <p className="truncate text-[11px] text-gray-400">
                    {p.address.city} · {p.totalArea} m²
                  </p>
                </div>
                <ArrowUpRight size={13} className="flex-shrink-0 text-gray-300" />
              </motion.div>
            ))}
          </div>

          {overdue.length > 0 && (
            <div className="overflow-hidden rounded-2xl border border-red-100 bg-red-50">
              <div className="flex items-center gap-2 border-b border-red-100 px-5 py-4">
                <AlertTriangle size={14} className="text-red-500" />
                <h2 className="text-[14px] font-semibold text-red-700">Försenade fakturor</h2>
              </div>
              {overdue.map((inv) => (
                <div key={inv.id} className="flex items-center justify-between px-5 py-3.5">
                  <div>
                    <p className="text-[13px] font-medium text-red-800">{inv.invoiceNumber}</p>
                    <p className="text-[12px] text-red-400">Förföll {formatDate(inv.dueDate)}</p>
                  </div>
                  <p className="text-[14px] font-bold text-red-700">{formatCurrency(inv.total)}</p>
                </div>
              ))}
            </div>
          )}
        </motion.div>
      </div>
    </PageWrapper>
  )
}
