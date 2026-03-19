import { cn } from '@/lib/cn'

type Variant = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'ghost' | 'purple'

const variants: Record<Variant, string> = {
  default: 'bg-[#EEF1F4] text-[#4A5568]',
  success: 'bg-[#E6F6ED] text-[#196638]',
  warning: 'bg-[#FFF3CD] text-[#7A5200]',
  danger: 'bg-[#FDECEE] text-[#B91C2A]',
  info: 'bg-[#E0F0FB] text-[#0B5A8A]',
  ghost: 'border border-[#D4D9E0] text-[#5A6A7A] bg-transparent',
  purple: 'bg-[#EDE9FE] text-[#5B21B6]',
}

const dotColors: Record<Variant, string> = {
  default: 'bg-[#8A9BB0]',
  success: 'bg-[#218F52]',
  warning: 'bg-[#D97706]',
  danger: 'bg-[#DC3545]',
  info: 'bg-[#0B84D0]',
  ghost: 'bg-[#8A9BB0]',
  purple: 'bg-[#7C3AED]',
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
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded px-2 py-0.5 text-[11.5px] font-medium',
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
    PARTIAL: { label: 'Delvis', variant: 'warning' },
    PAID: { label: 'Betald', variant: 'success' },
    OVERDUE: { label: 'Försenad', variant: 'danger' },
    VOID: { label: 'Makulerad', variant: 'default' },
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
