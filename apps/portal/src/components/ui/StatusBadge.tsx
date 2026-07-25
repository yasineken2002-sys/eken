interface BadgeStyle {
  label: string
  bg: string
  color: string
}

const INVOICE_LABELS: Record<string, BadgeStyle> = {
  DRAFT: { label: 'Utkast', bg: 'var(--ev-neutral-200)', color: 'var(--ev-neutral-800)' },
  SENT: { label: 'Skickad', bg: '#eff6ff', color: '#1d4ed8' },
  PARTIAL: { label: 'Delvis betald', bg: 'var(--ev-warning-50)', color: 'var(--ev-warning-900)' },
  PAID: { label: 'Betald', bg: 'var(--ev-success-50)', color: 'var(--ev-success-800)' },
  OVERDUE: { label: 'Förfallen', bg: 'var(--ev-danger-50)', color: 'var(--ev-danger-700)' },
  VOID: { label: 'Makulerad', bg: 'var(--ev-neutral-50)', color: 'var(--ev-text-muted)' },
}

const LEASE_LABELS: Record<string, BadgeStyle> = {
  DRAFT: { label: 'Utkast', bg: 'var(--ev-neutral-200)', color: 'var(--ev-neutral-800)' },
  ACTIVE: { label: 'Aktivt', bg: 'var(--ev-success-50)', color: 'var(--ev-success-800)' },
  TERMINATED: { label: 'Uppsagt', bg: 'var(--ev-danger-50)', color: 'var(--ev-danger-700)' },
  EXPIRED: { label: 'Utgånget', bg: 'var(--ev-neutral-50)', color: 'var(--ev-text-muted)' },
}

const MAINTENANCE_LABELS: Record<string, BadgeStyle> = {
  NEW: { label: 'Ny', bg: '#eff6ff', color: '#1d4ed8' },
  IN_PROGRESS: { label: 'Pågår', bg: 'var(--ev-warning-50)', color: 'var(--ev-warning-900)' },
  SCHEDULED: { label: 'Planerad', bg: '#f5f3ff', color: '#6d28d9' },
  COMPLETED: { label: 'Åtgärdad', bg: 'var(--ev-success-50)', color: 'var(--ev-success-800)' },
  CLOSED: { label: 'Stängd', bg: 'var(--ev-neutral-50)', color: 'var(--ev-text-muted)' },
  CANCELLED: { label: 'Avbruten', bg: 'var(--ev-neutral-50)', color: 'var(--ev-text-muted)' },
}

const RENT_NOTICE_LABELS: Record<string, BadgeStyle> = {
  PENDING: { label: 'Förbereds', bg: 'var(--ev-neutral-200)', color: 'var(--ev-neutral-800)' },
  SENT: { label: 'Skickad', bg: '#eff6ff', color: '#1d4ed8' },
  PAID: { label: 'Betald', bg: 'var(--ev-success-50)', color: 'var(--ev-success-800)' },
  OVERDUE: { label: 'Förfallen', bg: 'var(--ev-danger-50)', color: 'var(--ev-danger-700)' },
  CANCELLED: { label: 'Makulerad', bg: 'var(--ev-neutral-50)', color: 'var(--ev-text-muted)' },
  FAILED: { label: 'Skickfel', bg: 'var(--ev-danger-50)', color: 'var(--ev-danger-700)' },
}

interface StatusBadgeProps {
  type: 'invoice' | 'lease' | 'maintenance' | 'rent-notice'
  status: string
}

export function StatusBadge({ type, status }: StatusBadgeProps) {
  const map =
    type === 'invoice'
      ? INVOICE_LABELS
      : type === 'lease'
        ? LEASE_LABELS
        : type === 'rent-notice'
          ? RENT_NOTICE_LABELS
          : MAINTENANCE_LABELS

  const style = map[status] ?? {
    label: status,
    bg: 'var(--ev-neutral-200)',
    color: 'var(--ev-neutral-800)',
  }

  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 10px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        background: style.bg,
        color: style.color,
      }}
    >
      {style.label}
    </span>
  )
}
