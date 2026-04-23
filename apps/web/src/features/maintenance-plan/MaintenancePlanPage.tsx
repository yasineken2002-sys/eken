import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CalendarRange, Plus, ListTodo, Coins, CalendarDays, CheckCircle2 } from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { StatCard } from '@/components/ui/StatCard'
import { EmptyState } from '@/components/ui/EmptyState'
import {
  MaintenancePlanStatusBadge,
  MaintenancePlanCategoryIcon,
  CATEGORY_LABELS,
} from './components/MaintenancePlanBadges'
import { CreateMaintenancePlanModal } from './components/CreateMaintenancePlanModal'
import { MaintenancePlanDetailPanel } from './components/MaintenancePlanDetailPanel'
import { useYearlySummary, usePlans } from './hooks/useMaintenancePlan'
import { formatCurrency } from '@eken/shared'
import { cn } from '@/lib/cn'
import type { MaintenancePlan, MaintenancePlanStatus } from './api/maintenance-plan.api'

const currentYear = new Date().getFullYear()

const STATUS_TABS: { value: MaintenancePlanStatus | 'ALL'; label: string }[] = [
  { value: 'ALL', label: 'Alla' },
  { value: 'PLANNED', label: 'Planerade' },
  { value: 'APPROVED', label: 'Godkända' },
  { value: 'IN_PROGRESS', label: 'Pågående' },
  { value: 'COMPLETED', label: 'Slutförda' },
]

const PRIORITY_BORDER: Record<number, string> = {
  3: 'border-l-red-400',
  2: 'border-l-amber-400',
  1: 'border-l-gray-200',
}

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.04 } } }
const item = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.18 } },
}

export function MaintenancePlanPage() {
  const [fromYear, setFromYear] = useState(currentYear)
  const [toYear, setToYear] = useState(currentYear + 5)
  const [statusFilter, setStatusFilter] = useState<MaintenancePlanStatus | 'ALL'>('ALL')
  const [selectedPlan, setSelectedPlan] = useState<MaintenancePlan | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const { data: summary, isLoading } = useYearlySummary(fromYear, toYear)
  const { data: allPlans } = usePlans()

  const totalCount = summary?.reduce((s, y) => s + y.count, 0) ?? 0
  const totalCost = summary?.reduce((s, y) => s + y.totalEstimated, 0) ?? 0
  const thisYearCount = summary?.find((y) => y.year === currentYear)?.count ?? 0
  const completedCount = allPlans?.filter((p) => p.status === 'COMPLETED').length ?? 0

  const filteredSummary = summary?.map((yearEntry) => ({
    ...yearEntry,
    plans:
      statusFilter === 'ALL'
        ? yearEntry.plans
        : yearEntry.plans.filter((p) => p.status === statusFilter),
  }))

  const YEARS = Array.from(
    { length: Math.max(0, toYear - currentYear + 2) },
    (_, i) => currentYear + i,
  )

  return (
    <PageWrapper id="maintenance-plan">
      <PageHeader
        title="Underhållsplan"
        description="Planera och budgetera underhållsåtgärder för de kommande åren"
        action={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus size={14} strokeWidth={2} />
            Lägg till åtgärd
          </Button>
        }
      />

      {/* KPI cards */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Planerade åtgärder"
          value={totalCount}
          icon={ListTodo}
          iconColor="#2563EB"
          delay={0}
        />
        <StatCard
          title="Total budgeterad kostnad"
          value={formatCurrency(totalCost)}
          icon={Coins}
          iconColor="#D97706"
          delay={0.04}
        />
        <StatCard
          title="Åtgärder i år"
          value={thisYearCount}
          icon={CalendarDays}
          iconColor="#7C3AED"
          delay={0.08}
        />
        <StatCard
          title="Slutförda"
          value={completedCount}
          icon={CheckCircle2}
          iconColor="#059669"
          delay={0.12}
        />
      </div>

      {/* Controls */}
      <div className="mt-6 flex flex-wrap items-center gap-4">
        {/* Year range */}
        <div className="flex items-center gap-2 text-[13px] text-gray-600">
          <span className="font-medium">Visa år</span>
          <select
            value={fromYear}
            onChange={(e) => setFromYear(Number(e.target.value))}
            className="h-8 rounded-lg border border-[#DDDFE4] px-2 text-[13px] text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {YEARS.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <span>–</span>
          <select
            value={toYear}
            onChange={(e) => setToYear(Number(e.target.value))}
            className="h-8 rounded-lg border border-[#DDDFE4] px-2 text-[13px] text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {YEARS.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>

        {/* Status filter */}
        <div className="flex gap-1 rounded-xl bg-gray-100 p-1">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setStatusFilter(tab.value)}
              className={cn(
                'h-8 rounded-lg px-3 text-[13px] font-medium transition-colors',
                statusFilter === tab.value
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Timeline + detail panel */}
      <div className={cn('mt-4 flex items-start gap-4')}>
        <div className="min-w-0 flex-1">
          {isLoading ? (
            <div className="flex h-32 items-center justify-center text-[13px] text-gray-400">
              Laddar underhållsplan...
            </div>
          ) : totalCount === 0 && statusFilter === 'ALL' ? (
            <EmptyState
              icon={CalendarRange}
              title="Ingen underhållsplan"
              description="Lägg till den första planerade åtgärden för att bygga upp din underhållsplan"
              action={
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  <Plus size={14} strokeWidth={2} />
                  Lägg till åtgärd
                </Button>
              }
            />
          ) : (
            <div className="space-y-6">
              {filteredSummary?.map((yearEntry) => (
                <motion.div key={yearEntry.year} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  {/* Year header */}
                  <div className="mb-3 flex items-baseline justify-between">
                    <h2 className="text-[18px] font-semibold text-gray-900">{yearEntry.year}</h2>
                    {yearEntry.totalEstimated > 0 && (
                      <span className="text-[13px] font-medium text-gray-500">
                        {formatCurrency(yearEntry.totalEstimated)}
                      </span>
                    )}
                  </div>
                  <div className="mb-3 h-px bg-[#EAEDF0]" />

                  {yearEntry.plans.length === 0 ? (
                    <p className="text-[13px] italic text-gray-400">
                      {statusFilter === 'ALL'
                        ? 'Inga planerade åtgärder'
                        : 'Inga matchande åtgärder'}
                    </p>
                  ) : (
                    <motion.div
                      variants={stagger}
                      initial="hidden"
                      animate="show"
                      className="space-y-2"
                    >
                      {yearEntry.plans.map((plan) => (
                        <motion.div
                          key={plan.id}
                          variants={item}
                          onClick={() =>
                            setSelectedPlan(selectedPlan?.id === plan.id ? null : plan)
                          }
                          className={cn(
                            'flex cursor-pointer items-center gap-3 rounded-xl border border-l-4 border-[#EAEDF0] bg-white px-4 py-3 transition-all hover:shadow-sm',
                            PRIORITY_BORDER[plan.priority] ?? 'border-l-gray-200',
                            selectedPlan?.id === plan.id && 'ring-1 ring-blue-200',
                          )}
                        >
                          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-gray-50">
                            <MaintenancePlanCategoryIcon
                              category={plan.category}
                              size={14}
                              className="text-gray-600"
                            />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-[13.5px] font-medium text-gray-900">{plan.title}</p>
                            <p className="text-[12px] text-gray-500">
                              {plan.property.name} · {CATEGORY_LABELS[plan.category]}
                            </p>
                          </div>
                          <div className="flex flex-shrink-0 items-center gap-3">
                            <span className="text-[13px] font-medium text-gray-700">
                              {formatCurrency(Number(plan.estimatedCost))}
                            </span>
                            <MaintenancePlanStatusBadge status={plan.status} />
                          </div>
                        </motion.div>
                      ))}
                    </motion.div>
                  )}
                </motion.div>
              ))}
            </div>
          )}
        </div>

        {/* Detail panel */}
        <AnimatePresence>
          {selectedPlan && (
            <MaintenancePlanDetailPanel plan={selectedPlan} onClose={() => setSelectedPlan(null)} />
          )}
        </AnimatePresence>
      </div>

      {/* Modals */}
      <AnimatePresence>
        {createOpen && (
          <CreateMaintenancePlanModal open={createOpen} onClose={() => setCreateOpen(false)} />
        )}
      </AnimatePresence>
    </PageWrapper>
  )
}
