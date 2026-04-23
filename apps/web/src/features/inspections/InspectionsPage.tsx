import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ClipboardCheck, Plus, Calendar, Activity, CheckCircle2, PenLine } from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { StatCard } from '@/components/ui/StatCard'
import { EmptyState } from '@/components/ui/EmptyState'
import { InspectionTypeBadge, InspectionStatusBadge } from './components/InspectionBadges'
import { CreateInspectionModal } from './components/CreateInspectionModal'
import { InspectionDetailPanel } from './components/InspectionDetailPanel'
import { useInspections, useInspectionStats } from './hooks/useInspections'
import { formatDate } from '@eken/shared'
import { cn } from '@/lib/cn'
import type { Inspection, InspectionType, InspectionStatus } from './api/inspections.api'

const TYPE_TABS: { value: InspectionType | 'ALL'; label: string }[] = [
  { value: 'ALL', label: 'Alla' },
  { value: 'MOVE_IN', label: 'Inflyttning' },
  { value: 'MOVE_OUT', label: 'Utflyttning' },
  { value: 'PERIODIC', label: 'Periodisk' },
  { value: 'DAMAGE', label: 'Skada' },
]

const container = { hidden: {}, show: { transition: { staggerChildren: 0.04 } } }
const item = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.18 } },
}

function tenantName(inspection: Inspection): string {
  if (!inspection.tenant) return '—'
  if (inspection.tenant.type === 'INDIVIDUAL') {
    return (
      `${inspection.tenant.firstName ?? ''} ${inspection.tenant.lastName ?? ''}`.trim() ||
      inspection.tenant.email
    )
  }
  return inspection.tenant.companyName ?? inspection.tenant.email
}

export function InspectionsPage() {
  const [typeFilter, setTypeFilter] = useState<InspectionType | 'ALL'>('ALL')
  const [statusFilter, setStatusFilter] = useState<InspectionStatus | ''>('')
  const [selectedInspection, setSelectedInspection] = useState<Inspection | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const filters = {
    ...(typeFilter !== 'ALL' ? { type: typeFilter } : {}),
    ...(statusFilter ? { status: statusFilter } : {}),
  }

  const { data: inspections, isLoading } = useInspections(filters)
  const { data: stats } = useInspectionStats()

  const STATUS_TABS: { value: InspectionStatus | ''; label: string }[] = [
    { value: '', label: 'Alla' },
    { value: 'SCHEDULED', label: 'Schemalagda' },
    { value: 'IN_PROGRESS', label: 'Pågående' },
    { value: 'COMPLETED', label: 'Slutförda' },
    { value: 'SIGNED', label: 'Signerade' },
  ]

  return (
    <PageWrapper id="inspections">
      <PageHeader
        title="Besiktningar"
        description="Dokumentera in- och utflyttningsbesiktningar och periodiska kontroller"
        action={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus size={14} strokeWidth={2} />
            Ny besiktning
          </Button>
        }
      />

      {/* KPI cards */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Schemalagda"
          value={stats?.scheduled ?? 0}
          icon={Calendar}
          iconColor="#D97706"
          delay={0}
        />
        <StatCard
          title="Pågående"
          value={stats?.inProgress ?? 0}
          icon={Activity}
          iconColor="#2563EB"
          delay={0.04}
        />
        <StatCard
          title="Slutförda"
          value={stats?.completed ?? 0}
          icon={CheckCircle2}
          iconColor="#7C3AED"
          delay={0.08}
        />
        <StatCard
          title="Signerade"
          value={stats?.signed ?? 0}
          icon={PenLine}
          iconColor="#059669"
          delay={0.12}
        />
      </div>

      {/* Type filter tabs */}
      <div className="mt-6 flex flex-wrap items-center gap-4">
        <div className="flex gap-1 rounded-xl bg-gray-100 p-1">
          {TYPE_TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setTypeFilter(tab.value)}
              className={cn(
                'h-8 rounded-lg px-3 text-[13px] font-medium transition-colors',
                typeFilter === tab.value
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700',
              )}
            >
              {tab.label}
            </button>
          ))}
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

      {/* Content */}
      <div className={cn('mt-4 flex gap-4', selectedInspection ? 'items-start' : '')}>
        <div className="min-w-0 flex-1">
          {isLoading ? (
            <div className="flex h-32 items-center justify-center text-[13px] text-gray-400">
              Laddar besiktningar...
            </div>
          ) : !inspections?.length ? (
            <EmptyState
              icon={ClipboardCheck}
              title="Inga besiktningar"
              description="Skapa din första besiktning för att dokumentera lägenhetens skick"
              action={
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  <Plus size={14} strokeWidth={2} />
                  Ny besiktning
                </Button>
              }
            />
          ) : (
            <div className="overflow-hidden rounded-2xl border border-[#EAEDF0] bg-white">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[#EAEDF0]">
                    <th className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                      Typ
                    </th>
                    <th className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                      Fastighet / Enhet
                    </th>
                    <th className="hidden px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400 sm:table-cell">
                      Hyresgäst
                    </th>
                    <th className="hidden px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400 md:table-cell">
                      Datum
                    </th>
                    <th className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                      Status
                    </th>
                  </tr>
                </thead>
                <motion.tbody variants={container} initial="hidden" animate="show">
                  {inspections.map((insp) => (
                    <motion.tr
                      key={insp.id}
                      variants={item}
                      onClick={() =>
                        setSelectedInspection(selectedInspection?.id === insp.id ? null : insp)
                      }
                      className={cn(
                        'cursor-pointer border-b border-[#EAEDF0] transition-colors last:border-0 hover:bg-gray-50/80',
                        selectedInspection?.id === insp.id && 'bg-blue-50/40',
                      )}
                    >
                      <td className="px-4 py-3">
                        <InspectionTypeBadge type={insp.type} />
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-[13px] font-medium text-gray-900">
                          {insp.property.name}
                        </p>
                        <p className="text-[12px] text-gray-400">
                          {insp.unit.name} ({insp.unit.unitNumber})
                        </p>
                      </td>
                      <td className="hidden px-4 py-3 sm:table-cell">
                        <p className="text-[13px] text-gray-700">{tenantName(insp)}</p>
                      </td>
                      <td className="hidden px-4 py-3 md:table-cell">
                        <p className="text-[13px] text-gray-700">
                          {formatDate(insp.scheduledDate)}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <InspectionStatusBadge status={insp.status} />
                      </td>
                    </motion.tr>
                  ))}
                </motion.tbody>
              </table>
            </div>
          )}
        </div>

        {/* Detail panel */}
        <AnimatePresence>
          {selectedInspection && (
            <InspectionDetailPanel
              inspection={selectedInspection}
              onClose={() => setSelectedInspection(null)}
            />
          )}
        </AnimatePresence>
      </div>

      {/* Modals */}
      <AnimatePresence>
        {createOpen && (
          <CreateInspectionModal open={createOpen} onClose={() => setCreateOpen(false)} />
        )}
      </AnimatePresence>
    </PageWrapper>
  )
}
