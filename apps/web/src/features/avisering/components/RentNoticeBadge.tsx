import type { RentNoticeStatus } from '../api/avisering.api'

interface Props {
  status: RentNoticeStatus
}

const CONFIG: Record<RentNoticeStatus, { label: string; className: string }> = {
  PENDING: { label: 'Väntande', className: 'bg-amber-50 text-amber-700' },
  SENT: { label: 'Skickad', className: 'bg-blue-50 text-blue-700' },
  PAID: { label: 'Betald', className: 'bg-emerald-50 text-emerald-700' },
  OVERDUE: { label: 'Försenad', className: 'bg-red-50 text-red-600' },
  CANCELLED: { label: 'Avbruten', className: 'bg-gray-100 text-gray-500' },
}

export function RentNoticeBadge({ status }: Props) {
  const { label, className } = CONFIG[status] ?? {
    label: status,
    className: 'bg-gray-100 text-gray-500',
  }
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] font-medium ${className}`}
    >
      {label}
    </span>
  )
}
