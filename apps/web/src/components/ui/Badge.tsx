import { cn } from '@/lib/cn'

type Variant = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'ghost' | 'purple'

const variants: Record<Variant, string> = {
  default: 'bg-gray-100 text-gray-600',
  success: 'bg-emerald-50 text-emerald-700',
  warning: 'bg-amber-50 text-amber-700',
  danger: 'bg-red-50 text-red-600',
  info: 'bg-blue-50 text-blue-700',
  ghost: 'border border-gray-200 text-gray-500 bg-transparent',
  purple: 'bg-purple-50 text-purple-700',
}

const dotColors: Record<Variant, string> = {
  default: 'bg-gray-400',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
  info: 'bg-blue-500',
  ghost: 'bg-gray-400',
  purple: 'bg-purple-500',
}

interface Props {
  children: React.ReactNode
  variant?: Variant
  dot?: boolean
  className?: string
}

export function Badge({ children, variant = 'default', dot, className }: Props) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[12px] font-medium',
        variants[variant],
        className,
      )}
    >
      {dot && <span className={cn('h-1.5 w-1.5 flex-shrink-0 rounded-full', dotColors[variant])} />}
      {children}
    </span>
  )
}

export function UnitStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; variant: Variant }> = {
    OCCUPIED: { label: 'Uthyrd', variant: 'success' },
    VACANT: { label: 'Ledig', variant: 'warning' },
    UNDER_RENOVATION: { label: 'Renovering', variant: 'info' },
    RESERVED: { label: 'Reserverad', variant: 'ghost' },
  }
  const { label, variant } = map[status] ?? { label: status, variant: 'default' as Variant }
  return (
    <Badge variant={variant} dot>
      {label}
    </Badge>
  )
}

export function InvoiceStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; variant: Variant }> = {
    DRAFT: { label: 'Utkast', variant: 'ghost' },
    SENT: { label: 'Skickad', variant: 'info' },
    PARTIAL: { label: 'Delvis betald', variant: 'warning' },
    PAID: { label: 'Betald', variant: 'success' },
    OVERDUE: { label: 'Försenad', variant: 'danger' },
    VOID: { label: 'Makulerad', variant: 'default' },
    SENT_TO_COLLECTION: { label: 'Hos inkasso', variant: 'danger' },
  }
  const { label, variant } = map[status] ?? { label: status, variant: 'default' as Variant }
  return (
    <Badge variant={variant} dot>
      {label}
    </Badge>
  )
}

export function LeaseStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; variant: Variant }> = {
    DRAFT: { label: 'Utkast', variant: 'ghost' },
    ACTIVE: { label: 'Aktivt', variant: 'success' },
    TERMINATED: { label: 'Uppsagt', variant: 'danger' },
    EXPIRED: { label: 'Utgånget', variant: 'default' },
  }
  const { label, variant } = map[status] ?? { label: status, variant: 'default' as Variant }
  return (
    <Badge variant={variant} dot>
      {label}
    </Badge>
  )
}

export function DepositStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; variant: Variant }> = {
    PENDING: { label: 'Fakturerad', variant: 'ghost' },
    PAID: { label: 'Betald', variant: 'success' },
    REFUND_PENDING: { label: 'Väntar återbetalning', variant: 'warning' },
    REFUNDED: { label: 'Återbetald', variant: 'info' },
    PARTIALLY_REFUNDED: { label: 'Delvis återbetald', variant: 'info' },
    FORFEITED: { label: 'Förverkad', variant: 'danger' },
  }
  const { label, variant } = map[status] ?? { label: status, variant: 'default' as Variant }
  return (
    <Badge variant={variant} dot>
      {label}
    </Badge>
  )
}

export function RentIncreaseStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; variant: Variant }> = {
    DRAFT: { label: 'Utkast', variant: 'ghost' },
    NOTICE_SENT: { label: 'Aviserad', variant: 'info' },
    ACCEPTED: { label: 'Godkänd', variant: 'success' },
    REJECTED: { label: 'Nekad', variant: 'danger' },
    WITHDRAWN: { label: 'Återkallad', variant: 'default' },
    APPLIED: { label: 'Tillämpad', variant: 'success' },
  }
  const { label, variant } = map[status] ?? { label: status, variant: 'default' as Variant }
  return (
    <Badge variant={variant} dot>
      {label}
    </Badge>
  )
}

export function PropertyTypeBadge({ type }: { type: string }) {
  const map: Record<string, { label: string; variant: Variant }> = {
    RESIDENTIAL: { label: 'Bostäder', variant: 'info' },
    COMMERCIAL: { label: 'Kommersiell', variant: 'warning' },
    MIXED: { label: 'Blandat', variant: 'default' },
    INDUSTRIAL: { label: 'Industri', variant: 'ghost' },
    LAND: { label: 'Mark', variant: 'ghost' },
  }
  const { label, variant } = map[type] ?? { label: type, variant: 'default' as Variant }
  return <Badge variant={variant}>{label}</Badge>
}
