interface BadgeStyle {
  label: string
  bg: string
  color: string
}

const INVOICE_LABELS: Record<string, BadgeStyle> = {
  DRAFT: { label: 'Utkast', bg: '#f3f4f6', color: '#374151' },
  SENT: { label: 'Skickad', bg: '#eff6ff', color: '#1d4ed8' },
  PARTIAL: { label: 'Delvis betald', bg: '#fffbeb', color: '#92400e' },
  PAID: { label: 'Betald', bg: '#ecfdf5', color: '#065f46' },
  OVERDUE: { label: 'Förfallen', bg: '#fef2f2', color: '#991b1b' },
  VOID: { label: 'Makulerad', bg: '#f9fafb', color: '#6b7280' },
}

const LEASE_LABELS: Record<string, BadgeStyle> = {
  DRAFT: { label: 'Utkast', bg: '#f3f4f6', color: '#374151' },
  ACTIVE: { label: 'Aktivt', bg: '#ecfdf5', color: '#065f46' },
  TERMINATED: { label: 'Uppsagt', bg: '#fef2f2', color: '#991b1b' },
  EXPIRED: { label: 'Utgånget', bg: '#f9fafb', color: '#6b7280' },
}

const MAINTENANCE_LABELS: Record<string, BadgeStyle> = {
  NEW: { label: 'Ny', bg: '#eff6ff', color: '#1d4ed8' },
  IN_PROGRESS: { label: 'Pågår', bg: '#fffbeb', color: '#92400e' },
  SCHEDULED: { label: 'Planerad', bg: '#f5f3ff', color: '#6d28d9' },
  COMPLETED: { label: 'Åtgärdad', bg: '#ecfdf5', color: '#065f46' },
  CLOSED: { label: 'Stängd', bg: '#f9fafb', color: '#6b7280' },
  CANCELLED: { label: 'Avbruten', bg: '#f9fafb', color: '#6b7280' },
}

interface StatusBadgeProps {
  type: 'invoice' | 'lease' | 'maintenance'
  status: string
}

export function StatusBadge({ type, status }: StatusBadgeProps) {
  const map =
    type === 'invoice' ? INVOICE_LABELS : type === 'lease' ? LEASE_LABELS : MAINTENANCE_LABELS

  const style = map[status] ?? { label: status, bg: '#f3f4f6', color: '#374151' }

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
