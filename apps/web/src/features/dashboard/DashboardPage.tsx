import { useMemo, useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  AlertTriangle,
  Receipt,
  TrendingUp,
  Sparkles,
  ChevronRight,
  CalendarClock,
  Plus,
  UserPlus,
  Wrench,
  Check,
  FileText,
  AlertCircle,
  KeyRound,
} from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'
import { InvoiceStatusBadge } from '@/components/ui/Badge'
import { useDashboardStats } from './hooks/useDashboard'
import { TrendsSection } from './components/TrendsSection'
import { useLeases } from '@/features/leases/hooks/useLeases'
import { useDeposits } from '@/features/deposits/hooks/useDeposits'
import { useRentIncreases } from '@/features/rent-increases/hooks/useRentIncreases'
import { useAuthStore } from '@/stores/auth.store'
import { formatCurrency, formatDate } from '@eken/shared'
import { cn } from '@/lib/cn'
import type { Route } from '@/App'

interface DashboardPageProps {
  onNavigate?: (route: Route) => void
}

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } }
const item = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
}

function getGreeting() {
  const h = new Date().getHours()
  if (h < 5) return 'God natt'
  if (h < 10) return 'God morgon'
  if (h < 17) return 'Hej'
  return 'God kväll'
}

export function DashboardPage({ onNavigate }: DashboardPageProps = {}) {
  const user = useAuthStore((s) => s.user)
  const { data: stats, isLoading, isError } = useDashboardStats()
  const { data: leases = [] } = useLeases()
  const { data: deposits = [] } = useDeposits()
  const { data: rentIncreases = [] } = useRentIncreases()
  const [showAi, setShowAi] = useState(true)

  const upcomingRentIncreases = useMemo(() => {
    const now = Date.now()
    const cutoff = now + 30 * 86_400_000
    return rentIncreases.filter(
      (r) =>
        r.status === 'ACCEPTED' &&
        new Date(r.effectiveDate).getTime() >= now &&
        new Date(r.effectiveDate).getTime() <= cutoff,
    ).length
  }, [rentIncreases])

  const depositStats = useMemo(() => {
    const refundPending = deposits.filter((d) => d.status === 'REFUND_PENDING').length
    return { refundPending }
  }, [deposits])

  const expiringLeases = useMemo(() => {
    const now = Date.now()
    const cutoff = now + 90 * 86_400_000
    return leases
      .filter((l) => l.status === 'ACTIVE' && l.endDate)
      .map((l) => ({ lease: l, endMs: new Date(l.endDate as string).getTime() }))
      .filter(({ endMs }) => endMs >= now && endMs <= cutoff)
      .sort((a, b) => a.endMs - b.endMs)
  }, [leases])

  if (isError) {
    return (
      <div className="mx-auto max-w-[1280px] px-8 py-7">
        <EmptyState
          icon={AlertTriangle}
          title="Något gick fel"
          description="Kunde inte ladda översikten. Försök igen."
        />
      </div>
    )
  }

  const today = new Date().toLocaleDateString('sv-SE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
  const dateLabel = today.charAt(0).toUpperCase() + today.slice(1)
  const firstName = user?.firstName ?? ''

  const totalRevenue = stats?.invoices.totalRevenue ?? 0
  const overdueAmount = stats?.invoices.overdueAmount ?? 0
  const overdueCount = stats?.invoices.overdue ?? 0
  const totalUnits = stats?.leases.total ?? 0
  const activeLeases = stats?.leases.active ?? 0
  const occupancy = totalUnits > 0 ? Math.round((activeLeases / totalUnits) * 100) : 0
  const openTickets = (stats?.invoices.draft ?? 0) + depositStats.refundPending

  return (
    <motion.div
      key="dashboard"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.18 }}
      className="mx-auto flex max-w-[1280px] flex-col gap-5 px-8 pb-10 pt-7"
    >
      {/* Welcome */}
      <div className="flex items-end justify-between gap-4 pb-1">
        <div>
          <h1
            className="m-0 text-[28px] font-medium leading-[1.15] tracking-[-0.025em]"
            style={{ color: 'var(--ev-color-fg-1)' }}
          >
            {getGreeting()}
            {firstName ? `, ${firstName}` : ''}
          </h1>
          <div className="mt-1 text-[14px]" style={{ color: 'var(--ev-color-fg-2)' }}>
            Här är vad som händer idag
          </div>
        </div>
        <div
          className="rounded-full px-3 py-1 text-[12.5px]"
          style={{
            color: 'var(--ev-color-fg-2)',
            background: 'var(--ev-color-surface)',
            border: '0.5px solid var(--ev-color-border)',
          }}
        >
          {dateLabel}
        </div>
      </div>

      {/* AI insight */}
      <AnimatePresence initial={false}>
        {showAi && overdueCount > 0 && (
          <AiInsight
            overdueCount={overdueCount}
            overdueAmount={overdueAmount}
            onPrimary={() => {
              onNavigate?.('collections')
              setShowAi(false)
            }}
            onDismiss={() => setShowAi(false)}
          />
        )}
        {showAi && overdueCount === 0 && (
          <AiInsight
            empty
            onPrimary={() => onNavigate?.('ai')}
            onDismiss={() => setShowAi(false)}
          />
        )}
      </AnimatePresence>

      {/* KPI row */}
      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="ev-card h-[140px] animate-pulse" />
          ))}
        </div>
      ) : (
        <motion.div
          variants={stagger}
          initial="hidden"
          animate="show"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          <motion.div variants={item}>
            <KpiCard
              label="Intäkter denna månad"
              value={formatCurrency(totalRevenue)}
              icon={TrendingUp}
              iconBg="rgba(15,31,71,0.08)"
              iconColor="var(--ev-color-primary)"
              sub={
                <>
                  <span style={{ color: 'var(--ev-color-success)', fontWeight: 600 }}>↑</span>
                  <span style={{ color: 'var(--ev-color-fg-3)' }}>denna månad</span>
                </>
              }
            />
          </motion.div>
          <motion.div variants={item}>
            <KpiCard
              tone="danger"
              label="Utestående"
              value={formatCurrency(overdueAmount)}
              icon={AlertCircle}
              iconBg="var(--ev-color-danger-bg)"
              iconColor="var(--ev-color-danger)"
              sub={
                <>
                  <span style={{ color: 'var(--ev-color-danger)', fontWeight: 500 }}>
                    {overdueCount} förfallna
                  </span>
                  <span style={{ color: 'var(--ev-color-fg-3)' }}>· att hantera</span>
                </>
              }
            />
          </motion.div>
          <motion.div variants={item}>
            <KpiCard
              label="Uthyrning"
              value={
                <>
                  {occupancy}
                  <span className="ev-kpi-unit">%</span>
                </>
              }
              icon={KeyRound}
              iconBg="var(--ev-color-success-bg)"
              iconColor="var(--ev-color-success)"
              sub={
                <span style={{ color: 'var(--ev-color-fg-2)' }}>
                  {activeLeases} av {totalUnits} kontrakt
                </span>
              }
            />
          </motion.div>
          <motion.div variants={item}>
            <KpiCard
              {...(openTickets > 0 ? { tone: 'warning' as const } : {})}
              label="Öppna ärenden"
              value={openTickets}
              icon={Wrench}
              iconBg="var(--ev-color-warning-bg)"
              iconColor="var(--ev-color-warning)"
              sub={
                upcomingRentIncreases > 0 ? (
                  <>
                    <span style={{ color: 'var(--ev-color-warning)', fontWeight: 500 }}>
                      {upcomingRentIncreases} hyreshöjningar
                    </span>
                    <span style={{ color: 'var(--ev-color-fg-3)' }}>· inom 30 dagar</span>
                  </>
                ) : (
                  <span style={{ color: 'var(--ev-color-fg-3)' }}>Inga prioriterade</span>
                )
              }
            />
          </motion.div>
        </motion.div>
      )}

      {/* Activity + Quick actions split */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[6fr_4fr]">
        <ActivityCard
          isLoading={isLoading}
          invoices={stats?.recentInvoices ?? []}
          onShowAll={() => onNavigate?.('invoices')}
          onOpenInvoice={() => onNavigate?.('invoices')}
        />
        <QuickActions {...(onNavigate ? { onNavigate } : {})} />
      </div>

      {/* Expiring leases (preserved from previous functionality) */}
      {expiringLeases.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="ev-card overflow-hidden"
        >
          <button
            onClick={() => onNavigate?.('leases')}
            className="flex w-full items-center justify-between border-b px-6 py-4 text-left transition-colors hover:bg-[var(--ev-color-subtle)]"
            style={{ borderColor: 'var(--ev-color-border)' }}
          >
            <div className="flex items-center gap-3">
              <div
                className="flex h-9 w-9 items-center justify-center rounded-xl"
                style={{
                  background: 'var(--ev-color-warning-bg)',
                  color: 'var(--ev-color-warning)',
                }}
              >
                <CalendarClock size={18} strokeWidth={1.8} />
              </div>
              <div>
                <p className="text-[14px] font-medium" style={{ color: 'var(--ev-color-fg-1)' }}>
                  {expiringLeases.length} kontrakt löper ut inom 90 dagar
                </p>
                <p className="text-[12.5px]" style={{ color: 'var(--ev-color-fg-2)' }}>
                  Förnya eller säg upp innan de förfaller automatiskt
                </p>
              </div>
            </div>
            <ChevronRight size={14} style={{ color: 'var(--ev-color-fg-3)' }} />
          </button>
          <div>
            {expiringLeases.slice(0, 5).map(({ lease, endMs }) => {
              const days = Math.ceil((endMs - Date.now()) / 86_400_000)
              const tone =
                days < 30
                  ? 'var(--ev-color-danger)'
                  : days < 60
                    ? 'var(--ev-color-warning)'
                    : 'var(--ev-color-fg-2)'
              const tenant =
                lease.tenant.type === 'INDIVIDUAL'
                  ? [lease.tenant.firstName, lease.tenant.lastName].filter(Boolean).join(' ')
                  : (lease.tenant.companyName ?? '–')
              return (
                <button
                  key={lease.id}
                  onClick={() => onNavigate?.('leases')}
                  className="grid w-full grid-cols-4 items-center gap-4 border-t px-6 py-3 text-left transition-colors hover:bg-[var(--ev-color-subtle)]"
                  style={{ borderColor: 'var(--ev-color-border)' }}
                >
                  <span
                    className="truncate text-[13px] font-medium"
                    style={{ color: 'var(--ev-color-fg-1)' }}
                  >
                    {tenant}
                  </span>
                  <span
                    className="truncate text-[12.5px]"
                    style={{ color: 'var(--ev-color-fg-2)' }}
                  >
                    {lease.unit.name} · {lease.unit.property.name}
                  </span>
                  <span className="text-[12.5px]" style={{ color: 'var(--ev-color-fg-2)' }}>
                    {formatDate(lease.endDate!)}
                  </span>
                  <span className="text-[12.5px] font-semibold" style={{ color: tone }}>
                    {days <= 0 ? 'Idag' : `${days} ${days === 1 ? 'dag' : 'dagar'} kvar`}
                  </span>
                </button>
              )
            })}
          </div>
        </motion.div>
      )}

      {/* Trends section preserved */}
      <TrendsSection />
    </motion.div>
  )
}

// ─────────────────────────────────────────────────────────────
// AI insight gradient card
// ─────────────────────────────────────────────────────────────
function AiInsight({
  overdueCount,
  overdueAmount,
  empty,
  onPrimary,
  onDismiss,
}: {
  overdueCount?: number
  overdueAmount?: number
  empty?: boolean
  onPrimary: () => void
  onDismiss: () => void
}) {
  const [stamp, setStamp] = useState('Uppdaterad nyss')
  useEffect(() => {
    const t = setTimeout(() => setStamp('Uppdaterad nyss'), 60_000)
    return () => clearTimeout(t)
  }, [])
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.2 }}
      className="ev-ai-card relative flex items-center gap-5 px-6 py-5"
    >
      <div className="relative z-10">
        <div
          className="flex h-12 w-12 items-center justify-center rounded-[14px]"
          style={{
            background: 'rgba(255, 255, 255, 0.16)',
            border: '0.5px solid rgba(255, 255, 255, 0.22)',
          }}
        >
          <Sparkles size={22} strokeWidth={1.8} className="text-white" />
        </div>
      </div>
      <div className="relative z-10 min-w-0 flex-1">
        <div className="mb-1.5 flex items-center gap-2.5">
          <span
            className="inline-flex h-[22px] items-center gap-1.5 rounded-full px-2.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-white"
            style={{
              background: 'rgba(255, 255, 255, 0.16)',
              border: '0.5px solid rgba(255, 255, 255, 0.22)',
            }}
          >
            <Sparkles size={11} strokeWidth={2} />
            AI-insikt
          </span>
          <span
            className="text-[11.5px] font-medium uppercase tracking-[0.04em]"
            style={{ color: 'rgba(255,255,255,0.65)' }}
          >
            {stamp}
          </span>
        </div>
        {empty ? (
          <p
            className="m-0 max-w-[640px] text-[14.5px] leading-[1.5] tracking-[-0.005em]"
            style={{ color: 'rgba(255,255,255,0.92)' }}
          >
            Allt ser bra ut just nu. Inga förfallna fakturor, ingen pågående eskalering. Vill du att
            jag <strong className="font-semibold text-white">analyserar din portfölj</strong> och
            föreslår nästa åtgärd?
          </p>
        ) : (
          <p
            className="m-0 max-w-[640px] text-[14.5px] leading-[1.5] tracking-[-0.005em]"
            style={{ color: 'rgba(255,255,255,0.92)' }}
          >
            Du har <strong className="font-semibold text-white">{overdueCount} förfallna</strong>{' '}
            fakturor på totalt{' '}
            <strong className="font-semibold text-white">
              {formatCurrency(overdueAmount ?? 0)}
            </strong>
            . Vill du att jag startar inkassoflödet eller skickar påminnelser först?
          </p>
        )}
      </div>
      <div className="relative z-10 flex flex-shrink-0 flex-col gap-2">
        <button
          onClick={onPrimary}
          className="h-9 whitespace-nowrap rounded-[10px] border-0 px-[18px] text-[13.5px] font-medium transition-transform hover:opacity-95 active:scale-[0.97]"
          style={{ background: '#fff', color: 'var(--ev-color-primary)' }}
        >
          {empty ? 'Be om förslag' : 'Hantera nu'}
        </button>
        <button
          onClick={onDismiss}
          className="h-9 whitespace-nowrap rounded-[10px] px-[18px] text-[13.5px] font-medium transition-colors active:scale-[0.97]"
          style={{
            background: 'transparent',
            color: 'rgba(255,255,255,0.85)',
            border: '0.5px solid rgba(255,255,255,0.28)',
          }}
        >
          Ignorera
        </button>
      </div>
    </motion.div>
  )
}

// ─────────────────────────────────────────────────────────────
// KPI card
// ─────────────────────────────────────────────────────────────
function KpiCard({
  tone,
  label,
  value,
  icon: Icon,
  iconBg,
  iconColor,
  sub,
}: {
  tone?: 'danger' | 'warning'
  label: string
  value: React.ReactNode
  icon: React.ElementType
  iconBg: string
  iconColor: string
  sub?: React.ReactNode
}) {
  return (
    <div className={cn('ev-kpi', tone === 'danger' && 'danger', tone === 'warning' && 'warning')}>
      <div className="mb-4 flex items-center justify-between gap-1.5">
        <span className="ev-kpi-label">{label}</span>
        <span className="ev-kpi-icon" style={{ background: iconBg, color: iconColor }}>
          <Icon size={15} strokeWidth={2} />
        </span>
      </div>
      <div className="ev-kpi-value">{value}</div>
      {sub && <div className="ev-kpi-sub">{sub}</div>}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Activity / recent invoices card
// ─────────────────────────────────────────────────────────────
function ActivityCard({
  isLoading,
  invoices,
  onShowAll,
  onOpenInvoice,
}: {
  isLoading: boolean
  invoices: Array<{
    id: string
    invoiceNumber: string
    status: string
    total: number
    dueDate: string
    tenantName: string
  }>
  onShowAll: () => void
  onOpenInvoice: (id: string) => void
}) {
  return (
    <div className="ev-card flex flex-col">
      <div
        className="flex items-center justify-between border-b px-5 py-4"
        style={{ borderColor: 'var(--ev-color-border)' }}
      >
        <h2
          className="m-0 text-[15px] font-medium leading-[1.3] tracking-[-0.01em]"
          style={{ color: 'var(--ev-color-fg-1)' }}
        >
          Senaste aktivitet
        </h2>
        <button
          onClick={onShowAll}
          className="inline-flex items-center gap-0.5 text-[13px] font-medium hover:underline"
          style={{ color: 'var(--ev-color-primary-accent)' }}
        >
          Visa alla <ChevronRight size={13} strokeWidth={2} />
        </button>
      </div>
      <div>
        {isLoading ? (
          <div className="px-5 py-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="my-3 flex items-center gap-3.5 [&:not(:first-child)]:border-t [&:not(:first-child)]:pt-3.5"
                style={{ borderColor: 'var(--ev-color-border)' }}
              >
                <div className="h-9 w-9 animate-pulse rounded-[10px] bg-[var(--ev-color-subtle)]" />
                <div className="flex-1">
                  <div className="h-3.5 w-2/3 animate-pulse rounded bg-[var(--ev-color-subtle)]" />
                  <div className="mt-1.5 h-3 w-1/2 animate-pulse rounded bg-[var(--ev-color-subtle)]" />
                </div>
              </div>
            ))}
          </div>
        ) : invoices.length === 0 ? (
          <div
            className="py-12 text-center text-[13.5px]"
            style={{ color: 'var(--ev-color-fg-3)' }}
          >
            Inga aktiviteter ännu
          </div>
        ) : (
          invoices.slice(0, 5).map((inv, i) => {
            const kind: 'success' | 'danger' | 'info' | 'warning' =
              inv.status === 'PAID'
                ? 'success'
                : inv.status === 'OVERDUE'
                  ? 'danger'
                  : inv.status === 'SENT'
                    ? 'info'
                    : 'warning'
            const ActionIcon =
              inv.status === 'PAID' ? Check : inv.status === 'OVERDUE' ? AlertCircle : Receipt
            return (
              <button
                key={inv.id}
                onClick={() => onOpenInvoice(inv.id)}
                className="flex w-full items-center gap-3.5 px-5 py-3.5 text-left transition-colors hover:bg-[var(--ev-color-subtle)]"
                style={i > 0 ? { borderTop: '0.5px solid var(--ev-color-border)' } : undefined}
              >
                <div className={cn('ev-activity-icon', kind)}>
                  <ActionIcon size={16} strokeWidth={2} />
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className="mb-0.5 text-[14px] font-medium tracking-[-0.005em]"
                    style={{ color: 'var(--ev-color-fg-1)' }}
                  >
                    {inv.tenantName} · {inv.invoiceNumber}
                  </div>
                  <div className="truncate text-[12.5px]" style={{ color: 'var(--ev-color-fg-2)' }}>
                    Förfaller {formatDate(inv.dueDate)}
                  </div>
                </div>
                <div className="flex flex-shrink-0 flex-col items-end gap-1">
                  <div
                    className="text-[13px] font-semibold tabular-nums tracking-[-0.005em]"
                    style={{ color: 'var(--ev-color-fg-1)' }}
                  >
                    {formatCurrency(Number(inv.total))}
                  </div>
                  <InvoiceStatusBadge
                    status={inv.status as Parameters<typeof InvoiceStatusBadge>[0]['status']}
                  />
                </div>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Quick actions
// ─────────────────────────────────────────────────────────────
function QuickActions({ onNavigate }: { onNavigate?: (route: Route) => void }) {
  const actions: Array<{
    label: string
    hint: string
    icon: React.ElementType
    kind: 'primary' | 'accent' | 'soft'
    route: Route
  }> = [
    {
      label: 'Ny faktura',
      hint: 'Skapa & skicka',
      icon: Plus,
      kind: 'primary',
      route: 'invoices',
    },
    {
      label: 'Ny hyresgäst',
      hint: 'Lägg till profil',
      icon: UserPlus,
      kind: 'accent',
      route: 'tenants',
    },
    {
      label: 'Skicka hyresavier',
      hint: 'Avisera nästa månad',
      icon: Receipt,
      kind: 'soft',
      route: 'avisering',
    },
    {
      label: 'Skapa ärende',
      hint: 'För felanmälan',
      icon: Wrench,
      kind: 'soft',
      route: 'maintenance',
    },
    {
      label: 'Nytt kontrakt',
      hint: 'Hyresavtal',
      icon: FileText,
      kind: 'soft',
      route: 'leases',
    },
  ]
  return (
    <div className="ev-card flex flex-col">
      <div
        className="flex items-center justify-between border-b px-5 py-4"
        style={{ borderColor: 'var(--ev-color-border)' }}
      >
        <h2
          className="m-0 text-[15px] font-medium leading-[1.3] tracking-[-0.01em]"
          style={{ color: 'var(--ev-color-fg-1)' }}
        >
          Snabbåtgärder
        </h2>
      </div>
      <div className="flex flex-col gap-1 p-2">
        {actions.map((a) => (
          <button key={a.label} className="ev-quick-btn" onClick={() => onNavigate?.(a.route)}>
            <span className={cn('ev-quick-icon', a.kind)}>
              <a.icon size={17} strokeWidth={2} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span
                className="text-[13.5px] font-medium tracking-[-0.005em]"
                style={{ color: 'var(--ev-color-fg-1)' }}
              >
                {a.label}
              </span>
              <span className="text-[12px]" style={{ color: 'var(--ev-color-fg-3)' }}>
                {a.hint}
              </span>
            </span>
            <ChevronRight size={14} strokeWidth={2} style={{ color: 'var(--ev-color-fg-3)' }} />
          </button>
        ))}
      </div>
    </div>
  )
}
