import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Wrench,
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Plus,
  Droplets,
  Zap,
  Flame,
  Settings,
  DoorOpen,
  Lock,
} from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { StatCard } from '@/components/ui/StatCard'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import {
  MaintenanceStatusBadge,
  MaintenancePriorityBadge,
  MaintenanceCategoryLabel,
} from './components/MaintenanceBadges'
import { CreateTicketModal } from './components/CreateTicketModal'
import { TicketDetailPanel } from './components/TicketDetailPanel'
import { useTickets, useMaintenanceStats } from './hooks/useMaintenance'
import { formatDate } from '@eken/shared'
import { cn } from '@/lib/cn'
import type {
  MaintenanceTicket,
  MaintenanceStatus,
  MaintenancePriority,
  MaintenanceCategory,
} from './api/maintenance.api'

const container = { hidden: {}, show: { transition: { staggerChildren: 0.04 } } }
const item = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.18 } },
}

const STATUS_TABS: { value: MaintenanceStatus | 'ALL'; label: string }[] = [
  { value: 'ALL', label: 'Alla' },
  { value: 'NEW', label: 'Nya' },
  { value: 'IN_PROGRESS', label: 'Pågående' },
  { value: 'SCHEDULED', label: 'Schemalagda' },
  { value: 'COMPLETED', label: 'Avslutade' },
]

const CATEGORY_OPTIONS: { value: MaintenanceCategory | ''; label: string }[] = [
  { value: '', label: 'Alla kategorier' },
  { value: 'PLUMBING', label: 'VVS' },
  { value: 'ELECTRICAL', label: 'El' },
  { value: 'HEATING', label: 'Värme' },
  { value: 'APPLIANCES', label: 'Vitvaror' },
  { value: 'WINDOWS_DOORS', label: 'Fönster/Dörrar' },
  { value: 'LOCKS', label: 'Lås' },
  { value: 'FACADE', label: 'Fasad' },
  { value: 'ROOF', label: 'Tak' },
  { value: 'COMMON_AREAS', label: 'Gemensamma utrymmen' },
  { value: 'CLEANING', label: 'Städning' },
  { value: 'OTHER', label: 'Övrigt' },
]

const PRIORITY_OPTIONS: { value: MaintenancePriority | ''; label: string }[] = [
  { value: '', label: 'Alla prioriteter' },
  { value: 'URGENT', label: 'Akut' },
  { value: 'HIGH', label: 'Hög' },
  { value: 'NORMAL', label: 'Normal' },
  { value: 'LOW', label: 'Låg' },
]

function categoryIcon(category: MaintenanceCategory) {
  const map: Partial<Record<MaintenanceCategory, React.ElementType>> = {
    PLUMBING: Droplets,
    ELECTRICAL: Zap,
    HEATING: Flame,
    APPLIANCES: Settings,
    WINDOWS_DOORS: DoorOpen,
    LOCKS: Lock,
  }
  const Icon = map[category] ?? Wrench
  return <Icon size={13} strokeWidth={1.8} className="text-gray-400" />
}

export function MaintenancePage() {
  const [statusTab, setStatusTab] = useState<MaintenanceStatus | 'ALL'>('ALL')
  const [categoryFilter, setCategoryFilter] = useState<MaintenanceCategory | ''>('')
  const [priorityFilter, setPriorityFilter] = useState<MaintenancePriority | ''>('')
  const [selectedTicket, setSelectedTicket] = useState<MaintenanceTicket | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const { data: tickets = [], isLoading } = useTickets(
    statusTab !== 'ALL' || categoryFilter || priorityFilter
      ? {
          ...(statusTab !== 'ALL' ? { status: statusTab } : {}),
          ...(categoryFilter ? { category: categoryFilter } : {}),
          ...(priorityFilter ? { priority: priorityFilter } : {}),
        }
      : undefined,
  )

  const { data: stats } = useMaintenanceStats()

  const openCount =
    (stats?.byStatus.NEW ?? 0) +
    (stats?.byStatus.IN_PROGRESS ?? 0) +
    (stats?.byStatus.SCHEDULED ?? 0)
  const completedThisMonth = stats?.byStatus.COMPLETED ?? 0

  return (
    <PageWrapper id="maintenance">
      <div className="flex gap-6">
        <div className="min-w-0 flex-1">
          <PageHeader
            title="Underhåll"
            description={`${stats?.total ?? 0} ärenden totalt`}
            action={
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                <Plus size={14} strokeWidth={2} />
                Ny felanmälan
              </Button>
            }
          />

          {/* KPI Cards */}
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              title="Öppna ärenden"
              value={openCount}
              icon={Wrench}
              iconColor="#2563EB"
              delay={0}
            />
            <StatCard
              title="Akuta ärenden"
              value={stats?.urgent ?? 0}
              icon={AlertTriangle}
              iconColor={(stats?.urgent ?? 0) > 0 ? '#DC2626' : '#6B7280'}
              delay={0.04}
            />
            <StatCard
              title="Schemalagda"
              value={stats?.byStatus.SCHEDULED ?? 0}
              icon={Calendar}
              iconColor="#D97706"
              delay={0.08}
            />
            <StatCard
              title="Åtgärdade"
              value={completedThisMonth}
              icon={CheckCircle2}
              iconColor="#059669"
              delay={0.12}
            />
          </div>

          {/* Filter row */}
          <div className="mt-6 flex flex-wrap items-center gap-3">
            {/* Status tabs */}
            <div className="flex gap-1 rounded-xl bg-gray-100 p-1">
              {STATUS_TABS.map((tab) => (
                <button
                  key={tab.value}
                  onClick={() => setStatusTab(tab.value)}
                  className={cn(
                    'h-8 rounded-lg px-3 text-[13px] font-medium transition-all',
                    statusTab === tab.value
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700',
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <select
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value as MaintenancePriority | '')}
              className="h-8 rounded-lg border border-[#DDDFE4] px-3 text-[13px] text-gray-700 focus:border-blue-500 focus:outline-none"
            >
              {PRIORITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>

            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value as MaintenanceCategory | '')}
              className="h-8 rounded-lg border border-[#DDDFE4] px-3 text-[13px] text-gray-700 focus:border-blue-500 focus:outline-none"
            >
              {CATEGORY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {/* Table */}
          <div className="mt-4 overflow-hidden rounded-2xl border border-[#EAEDF0] bg-white">
            {isLoading ? (
              <div className="py-16 text-center text-[13px] text-gray-400">Laddar ärenden...</div>
            ) : tickets.length === 0 ? (
              <EmptyState
                icon={Wrench}
                title="Inga underhållsärenden"
                description="Skapa en ny felanmälan för att komma igång"
                action={
                  <Button variant="primary" onClick={() => setCreateOpen(true)}>
                    <Plus size={14} strokeWidth={2} />
                    Ny felanmälan
                  </Button>
                }
              />
            ) : (
              <motion.div variants={container} initial="hidden" animate="show">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-[#EAEDF0]">
                      {[
                        'Nr',
                        'Titel',
                        'Fastighet/Enhet',
                        'Kategori',
                        'Prioritet',
                        'Status',
                        'Datum',
                        '',
                      ].map((h) => (
                        <th
                          key={h}
                          className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tickets.map((ticket) => (
                      <motion.tr
                        key={ticket.id}
                        variants={item}
                        onClick={() => setSelectedTicket(ticket)}
                        className="cursor-pointer border-b border-[#EAEDF0] transition-colors last:border-0 hover:bg-gray-50/80"
                      >
                        <td className="px-4 py-3 text-[12px] font-semibold text-gray-500">
                          {ticket.ticketNumber}
                        </td>
                        <td className="max-w-[200px] px-4 py-3">
                          <p className="truncate text-[13px] font-medium text-gray-900">
                            {ticket.title}
                          </p>
                          {ticket.tenant && (
                            <p className="truncate text-[11.5px] text-gray-400">
                              {ticket.tenant.type === 'INDIVIDUAL'
                                ? `${ticket.tenant.firstName ?? ''} ${ticket.tenant.lastName ?? ''}`.trim()
                                : ticket.tenant.companyName}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-[13px] font-medium text-gray-800">
                            {ticket.property.name}
                          </p>
                          {ticket.unit && (
                            <p className="text-[11.5px] text-gray-400">{ticket.unit.name}</p>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5 text-[13px] text-gray-600">
                            {categoryIcon(ticket.category)}
                            <MaintenanceCategoryLabel category={ticket.category} />
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <MaintenancePriorityBadge priority={ticket.priority} />
                        </td>
                        <td className="px-4 py-3">
                          <MaintenanceStatusBadge status={ticket.status} />
                        </td>
                        <td className="px-4 py-3 text-[12.5px] text-gray-500">
                          {formatDate(ticket.createdAt)}
                        </td>
                        <td className="px-4 py-3">
                          {ticket.comments.length > 0 && (
                            <Badge variant="ghost" className="text-[11px]">
                              {ticket.comments.length} komm.
                            </Badge>
                          )}
                        </td>
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              </motion.div>
            )}
          </div>
        </div>

        {/* Detail panel */}
        <AnimatePresence>
          {selectedTicket && (
            <TicketDetailPanel ticket={selectedTicket} onClose={() => setSelectedTicket(null)} />
          )}
        </AnimatePresence>
      </div>

      <CreateTicketModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </PageWrapper>
  )
}
