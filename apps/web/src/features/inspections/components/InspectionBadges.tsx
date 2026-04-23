import { cn } from '@/lib/cn'
import type {
  InspectionType,
  InspectionStatus,
  InspectionItemCondition,
} from '../api/inspections.api'

interface BadgeProps {
  className?: string
}

export function InspectionTypeBadge({ type, className }: BadgeProps & { type: InspectionType }) {
  const map: Record<InspectionType, { label: string; cls: string }> = {
    MOVE_IN: { label: 'Inflyttning', cls: 'bg-emerald-50 text-emerald-700' },
    MOVE_OUT: { label: 'Utflyttning', cls: 'bg-blue-50 text-blue-700' },
    PERIODIC: { label: 'Periodisk', cls: 'bg-gray-100 text-gray-600' },
    DAMAGE: { label: 'Skada', cls: 'bg-red-50 text-red-600' },
  }
  const { label, cls } = map[type]
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-medium',
        cls,
        className,
      )}
    >
      {label}
    </span>
  )
}

export function InspectionStatusBadge({
  status,
  className,
}: BadgeProps & { status: InspectionStatus }) {
  const map: Record<InspectionStatus, { label: string; cls: string }> = {
    SCHEDULED: { label: 'Schemalagd', cls: 'bg-amber-50 text-amber-700' },
    IN_PROGRESS: { label: 'Pågår', cls: 'bg-blue-50 text-blue-700' },
    COMPLETED: { label: 'Slutförd', cls: 'bg-violet-50 text-violet-700' },
    SIGNED: { label: 'Signerad', cls: 'bg-emerald-50 text-emerald-700' },
  }
  const { label, cls } = map[status]
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-medium',
        cls,
        className,
      )}
    >
      <span
        className={cn('mr-1.5 h-1.5 w-1.5 rounded-full', {
          'bg-amber-500': status === 'SCHEDULED',
          'bg-blue-500': status === 'IN_PROGRESS',
          'bg-violet-500': status === 'COMPLETED',
          'bg-emerald-500': status === 'SIGNED',
        })}
      />
      {label}
    </span>
  )
}

export function InspectionConditionBadge({
  condition,
  className,
}: BadgeProps & { condition: InspectionItemCondition }) {
  const map: Record<InspectionItemCondition, { label: string; cls: string }> = {
    GOOD: { label: 'Bra', cls: 'bg-emerald-50 text-emerald-700' },
    ACCEPTABLE: { label: 'Acceptabelt', cls: 'bg-amber-50 text-amber-700' },
    DAMAGED: { label: 'Skadat', cls: 'bg-red-50 text-red-600' },
    MISSING: { label: 'Saknas', cls: 'bg-red-50 text-red-600' },
  }
  const { label, cls } = map[condition]
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-medium',
        cls,
        className,
      )}
    >
      {label}
    </span>
  )
}
