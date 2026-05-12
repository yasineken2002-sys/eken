import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'default' | 'ghost'

const toneClass: Record<Tone, string> = {
  success: 'bg-emerald-50 text-emerald-700',
  warning: 'bg-amber-50 text-amber-700',
  danger: 'bg-red-50 text-red-600',
  info: 'bg-blue-50 text-blue-700',
  default: 'bg-gray-100 text-gray-700',
  ghost: 'border border-gray-200 text-gray-500',
}

export function Badge({ tone = 'default', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-medium',
        toneClass[tone],
      )}
    >
      {children}
    </span>
  )
}

export type AdminPlan = 'TRIAL' | 'STARTER' | 'MINI' | 'STANDARD' | 'PLUS' | 'PRO'
export type AdminOrgStatus = 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED'

export function PlanBadge({ plan }: { plan: AdminPlan }) {
  const map: Record<AdminPlan, Tone> = {
    TRIAL: 'warning',
    STARTER: 'default',
    MINI: 'default',
    STANDARD: 'info',
    PLUS: 'info',
    PRO: 'success',
  }
  const label: Record<AdminPlan, string> = {
    TRIAL: 'Trial',
    STARTER: 'Starter',
    MINI: 'Mini',
    STANDARD: 'Standard',
    PLUS: 'Plus',
    PRO: 'Pro',
  }
  return <Badge tone={map[plan]}>{label[plan]}</Badge>
}

export function OrgStatusBadge({ status }: { status: AdminOrgStatus }) {
  const label: Record<AdminOrgStatus, string> = {
    TRIAL: 'Trial',
    ACTIVE: 'Aktiv',
    PAST_DUE: 'Förfallen',
    SUSPENDED: 'Suspenderad',
    CANCELLED: 'Avslutad',
  }
  const tone: Record<AdminOrgStatus, Tone> = {
    TRIAL: 'info',
    ACTIVE: 'success',
    PAST_DUE: 'warning',
    SUSPENDED: 'warning',
    CANCELLED: 'danger',
  }
  return <Badge tone={tone[status]}>{label[status]}</Badge>
}

export function SeverityBadge({ severity }: { severity: 'CRITICAL' | 'ERROR' | 'WARNING' }) {
  const tone: Record<typeof severity, Tone> = {
    CRITICAL: 'danger',
    ERROR: 'warning',
    WARNING: 'info',
  }
  return <Badge tone={tone[severity]}>{severity}</Badge>
}

export function InvoiceStatusBadge({
  status,
}: {
  status: 'PENDING' | 'PAID' | 'OVERDUE' | 'VOID'
}) {
  const label: Record<typeof status, string> = {
    PENDING: 'Väntar',
    PAID: 'Betald',
    OVERDUE: 'Förfallen',
    VOID: 'Makulerad',
  }
  const tone: Record<typeof status, Tone> = {
    PENDING: 'info',
    PAID: 'success',
    OVERDUE: 'danger',
    VOID: 'ghost',
  }
  return <Badge tone={tone[status]}>{label[status]}</Badge>
}
