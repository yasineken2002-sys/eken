import type { ReactNode } from 'react'
import { Card } from './Card'

export function KpiCard({
  label,
  value,
  hint,
  icon,
  tone,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  icon?: ReactNode
  tone?: 'danger' | 'warning' | 'success'
}) {
  const toneCls =
    tone === 'danger'
      ? 'text-red-600'
      : tone === 'warning'
        ? 'text-amber-600'
        : tone === 'success'
          ? 'text-emerald-600'
          : 'text-gray-900'
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <div className="text-[12px] font-medium uppercase tracking-wide text-gray-500">{label}</div>
        {icon}
      </div>
      <div className={`mt-2 text-[26px] font-semibold tracking-tight ${toneCls}`}>{value}</div>
      {hint ? <div className="mt-1 text-[12px] text-gray-500">{hint}</div> : null}
    </Card>
  )
}
