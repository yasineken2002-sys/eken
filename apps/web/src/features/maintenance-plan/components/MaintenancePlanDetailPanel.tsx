import { motion } from 'framer-motion'
import { X, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import {
  MaintenancePlanStatusBadge,
  MaintenancePlanCategoryIcon,
  CATEGORY_LABELS,
} from './MaintenancePlanBadges'
import { useUpdatePlan, useDeletePlan } from '../hooks/useMaintenancePlan'
import { formatCurrency } from '@eken/shared'
import type { MaintenancePlan } from '../api/maintenance-plan.api'

interface Props {
  plan: MaintenancePlan
  onClose: () => void
}

function InfoItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</p>
      <p className="mt-0.5 text-[13px] font-medium text-gray-800">{value ?? '—'}</p>
    </div>
  )
}

const PRIORITY_LABELS: Record<number, string> = { 1: '● Låg', 2: '●● Normal', 3: '●●● Hög' }

export function MaintenancePlanDetailPanel({ plan, onClose }: Props) {
  const update = useUpdatePlan()
  const deletePlan = useDeletePlan()

  const handleStatus = (status: MaintenancePlan['status']) => {
    void update.mutateAsync({ id: plan.id, dto: { status } })
  }

  const handleDelete = async () => {
    await deletePlan.mutateAsync(plan.id)
    onClose()
  }

  return (
    <motion.aside
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      transition={{ duration: 0.2 }}
      className="flex h-full w-[450px] flex-shrink-0 flex-col overflow-hidden rounded-2xl border border-[#EAEDF0] bg-white shadow-sm"
    >
      {/* Header */}
      <div className="flex items-start justify-between border-b border-[#EAEDF0] px-5 py-4">
        <div className="min-w-0 flex-1 pr-3">
          <div className="mb-1 flex items-center gap-2">
            <MaintenancePlanStatusBadge status={plan.status} />
            <span className="text-[12px] text-gray-400">{plan.plannedYear}</span>
          </div>
          <h3 className="text-[15px] font-semibold leading-snug text-gray-900">{plan.title}</h3>
          <p className="mt-0.5 text-[12px] text-gray-500">{plan.property.name}</p>
        </div>
        <button
          onClick={onClose}
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
        >
          <X size={14} strokeWidth={1.8} />
        </button>
      </div>

      <div className="flex flex-1 flex-col overflow-y-auto px-5 py-4">
        <div className="flex-1 space-y-5">
          {/* Info grid */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <InfoItem
              label="Kategori"
              value={
                <span className="flex items-center gap-1.5">
                  <MaintenancePlanCategoryIcon
                    category={plan.category}
                    size={13}
                    className="text-gray-500"
                  />
                  {CATEGORY_LABELS[plan.category]}
                </span>
              }
            />
            <InfoItem label="Planerat år" value={plan.plannedYear} />
            <InfoItem label="Beräknad kostnad" value={formatCurrency(Number(plan.estimatedCost))} />
            {plan.actualCost != null && (
              <InfoItem label="Faktisk kostnad" value={formatCurrency(Number(plan.actualCost))} />
            )}
            <InfoItem label="Prioritet" value={PRIORITY_LABELS[plan.priority] ?? plan.priority} />
            {plan.interval && <InfoItem label="Intervall" value={`Vart ${plan.interval}:e år`} />}
            {plan.lastDoneYear && <InfoItem label="Senast utfört" value={plan.lastDoneYear} />}
            {plan.completedAt && (
              <InfoItem label="Slutförd" value={new Date(plan.completedAt).getFullYear()} />
            )}
          </div>

          {/* Description */}
          {plan.description && (
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                Beskrivning
              </p>
              <p className="text-[13px] leading-relaxed text-gray-700">{plan.description}</p>
            </div>
          )}

          {/* Notes */}
          {plan.notes && (
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                Anteckningar
              </p>
              <p className="text-[13px] leading-relaxed text-gray-700">{plan.notes}</p>
            </div>
          )}

          {/* Status actions */}
          {plan.status !== 'COMPLETED' && plan.status !== 'CANCELLED' && (
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                Åtgärder
              </p>
              <div className="flex flex-wrap gap-2">
                {plan.status === 'PLANNED' && (
                  <Button
                    size="sm"
                    variant="primary"
                    loading={update.isPending}
                    onClick={() => handleStatus('APPROVED')}
                  >
                    Godkänn åtgärd
                  </Button>
                )}
                {plan.status === 'APPROVED' && (
                  <Button
                    size="sm"
                    variant="primary"
                    loading={update.isPending}
                    onClick={() => handleStatus('IN_PROGRESS')}
                  >
                    Påbörja åtgärd
                  </Button>
                )}
                {plan.status === 'IN_PROGRESS' && (
                  <Button
                    size="sm"
                    variant="primary"
                    loading={update.isPending}
                    onClick={() => handleStatus('COMPLETED')}
                  >
                    Slutför åtgärd
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-gray-400"
                  loading={update.isPending}
                  onClick={() => handleStatus('CANCELLED')}
                >
                  Avbryt åtgärd
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Delete */}
        <div className="mt-6 border-t border-[#EAEDF0] pt-4">
          <Button
            variant="ghost"
            size="sm"
            className="text-red-500 hover:bg-red-50 hover:text-red-600"
            loading={deletePlan.isPending}
            onClick={() => void handleDelete()}
          >
            <Trash2 size={13} strokeWidth={1.8} />
            Ta bort åtgärd
          </Button>
        </div>
      </div>
    </motion.aside>
  )
}
