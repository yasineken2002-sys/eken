import { Badge } from '@/components/ui/Badge'
import type {
  MaintenanceStatus,
  MaintenancePriority,
  MaintenanceCategory,
} from '../api/maintenance.api'

export function MaintenanceStatusBadge({ status }: { status: MaintenanceStatus }) {
  const map: Record<
    MaintenanceStatus,
    { label: string; variant: 'info' | 'warning' | 'purple' | 'success' | 'default' | 'danger' }
  > = {
    NEW: { label: 'Ny', variant: 'info' },
    IN_PROGRESS: { label: 'Pågår', variant: 'warning' },
    SCHEDULED: { label: 'Schemalagd', variant: 'purple' },
    COMPLETED: { label: 'Åtgärdad', variant: 'success' },
    CLOSED: { label: 'Stängd', variant: 'default' },
    CANCELLED: { label: 'Avbruten', variant: 'danger' },
  }
  const { label, variant } = map[status] ?? { label: status, variant: 'default' as const }
  return (
    <Badge variant={variant} dot>
      {label}
    </Badge>
  )
}

export function MaintenancePriorityBadge({ priority }: { priority: MaintenancePriority }) {
  const map: Record<
    MaintenancePriority,
    { label: string; variant: 'danger' | 'warning' | 'default' | 'info' }
  > = {
    URGENT: { label: 'Akut', variant: 'danger' },
    HIGH: { label: 'Hög', variant: 'warning' },
    NORMAL: { label: 'Normal', variant: 'default' },
    LOW: { label: 'Låg', variant: 'info' },
  }
  const { label, variant } = map[priority] ?? { label: priority, variant: 'default' as const }
  return <Badge variant={variant}>{label}</Badge>
}

export function MaintenanceCategoryLabel({ category }: { category: MaintenanceCategory }) {
  const labels: Record<MaintenanceCategory, string> = {
    PLUMBING: 'VVS',
    ELECTRICAL: 'El',
    HEATING: 'Värme',
    APPLIANCES: 'Vitvaror',
    WINDOWS_DOORS: 'Fönster/Dörrar',
    LOCKS: 'Lås',
    FACADE: 'Fasad',
    ROOF: 'Tak',
    COMMON_AREAS: 'Gemensamma utrymmen',
    CLEANING: 'Städning',
    OTHER: 'Övrigt',
  }
  return <span>{labels[category] ?? category}</span>
}
