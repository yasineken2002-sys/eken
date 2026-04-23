import {
  Home,
  Building2,
  Frame,
  Droplets,
  Zap,
  Flame,
  ArrowUpDown,
  Users2,
  Paintbrush,
  Layers,
  Wrench,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import type { MaintenancePlanStatus, MaintenancePlanCategory } from '../api/maintenance-plan.api'

export const CATEGORY_LABELS: Record<MaintenancePlanCategory, string> = {
  ROOF: 'Tak',
  FACADE: 'Fasad',
  WINDOWS: 'Fönster',
  PLUMBING: 'VVS',
  ELECTRICAL: 'El',
  HEATING: 'Värme',
  ELEVATOR: 'Hiss',
  COMMON_AREAS: 'Gemensamma utrymmen',
  PAINTING: 'Målning',
  FLOORING: 'Golv',
  OTHER: 'Övrigt',
}

export const CATEGORY_ICONS: Record<MaintenancePlanCategory, React.ElementType> = {
  ROOF: Home,
  FACADE: Building2,
  WINDOWS: Frame,
  PLUMBING: Droplets,
  ELECTRICAL: Zap,
  HEATING: Flame,
  ELEVATOR: ArrowUpDown,
  COMMON_AREAS: Users2,
  PAINTING: Paintbrush,
  FLOORING: Layers,
  OTHER: Wrench,
}

interface BadgeProps {
  className?: string
}

export function MaintenancePlanStatusBadge({
  status,
  className,
}: BadgeProps & { status: MaintenancePlanStatus }) {
  const map: Record<MaintenancePlanStatus, { label: string; cls: string; dot: string }> = {
    PLANNED: { label: 'Planerad', cls: 'bg-gray-100 text-gray-600', dot: 'bg-gray-400' },
    APPROVED: { label: 'Godkänd', cls: 'bg-blue-50 text-blue-700', dot: 'bg-blue-500' },
    IN_PROGRESS: { label: 'Pågår', cls: 'bg-amber-50 text-amber-700', dot: 'bg-amber-500' },
    COMPLETED: { label: 'Slutförd', cls: 'bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' },
    CANCELLED: { label: 'Avbruten', cls: 'bg-red-50 text-red-600', dot: 'bg-red-500' },
  }
  const { label, cls, dot } = map[status]
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-medium',
        cls,
        className,
      )}
    >
      <span className={cn('mr-1.5 h-1.5 w-1.5 rounded-full', dot)} />
      {label}
    </span>
  )
}

export function MaintenancePlanCategoryIcon({
  category,
  size = 14,
  className,
}: {
  category: MaintenancePlanCategory
  size?: number
  className?: string
}) {
  const Icon = CATEGORY_ICONS[category]
  return <Icon size={size} strokeWidth={1.8} className={className} />
}
