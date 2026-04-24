import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Plus, Search } from 'lucide-react'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
import { Card } from '@/components/ui/Card'
import { OrgStatusBadge, PlanBadge } from '@/components/ui/Badge'
import { get } from '@/lib/api'
import { formatCurrency, formatDate } from '@/lib/format'

type Status = 'ACTIVE' | 'SUSPENDED' | 'CANCELLED'
type Plan = 'TRIAL' | 'BASIC' | 'STANDARD' | 'PREMIUM'

interface OrgListItem {
  id: string
  name: string
  orgNumber: string | null
  email: string
  plan: Plan
  status: Status
  trialEndsAt: string | null
  monthlyFee: number
  createdAt: string
  propertyCount: number
  tenantCount: number
  userCount: number
}

interface ListResponse {
  total: number
  page: number
  pageSize: number
  items: OrgListItem[]
}

export function OrganizationsPage() {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'' | Status>('')
  const [plan, setPlan] = useState<'' | Plan>('')

  const params = useMemo(
    () => ({
      ...(search ? { search } : {}),
      ...(status ? { status } : {}),
      ...(plan ? { plan } : {}),
      pageSize: 100,
    }),
    [search, status, plan],
  )

  const { data } = useQuery({
    queryKey: ['platform', 'organizations', params],
    queryFn: () => get<ListResponse>('/platform/organizations', params),
  })

  return (
    <>
      <PageHeader
        title="Kunder"
        description="Alla organisationer på plattformen"
        action={
          <Link to="/organizations/new">
            <Button>
              <Plus size={14} /> Ny kund
            </Button>
          </Link>
        }
      />

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div className="relative w-80">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            className="pl-9"
            placeholder="Sök namn, orgnummer, e-post…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select
          value={status}
          onChange={(e) => setStatus(e.target.value as Status | '')}
          className="w-40"
        >
          <option value="">Alla statusar</option>
          <option value="ACTIVE">Aktiv</option>
          <option value="SUSPENDED">Suspenderad</option>
          <option value="CANCELLED">Avslutad</option>
        </Select>
        <Select
          value={plan}
          onChange={(e) => setPlan(e.target.value as Plan | '')}
          className="w-40"
        >
          <option value="">Alla planer</option>
          <option value="TRIAL">Trial</option>
          <option value="BASIC">Basic</option>
          <option value="STANDARD">Standard</option>
          <option value="PREMIUM">Premium</option>
        </Select>
      </div>

      <Card className="mt-4 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[#EAEDF0]">
              <th className="px-5 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Namn
              </th>
              <th className="px-5 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Plan
              </th>
              <th className="px-5 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Status
              </th>
              <th className="px-5 py-3 text-right text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Fastigheter
              </th>
              <th className="px-5 py-3 text-right text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Hyresgäster
              </th>
              <th className="px-5 py-3 text-right text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                MRR
              </th>
              <th className="px-5 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Skapad
              </th>
            </tr>
          </thead>
          <tbody>
            {(data?.items ?? []).map((o) => (
              <tr
                key={o.id}
                className="border-b border-[#EAEDF0] last:border-0 hover:bg-gray-50/80"
              >
                <td className="px-5 py-3">
                  <Link
                    to={`/organizations/${o.id}`}
                    className="font-medium text-gray-900 hover:text-blue-600"
                  >
                    {o.name}
                  </Link>
                  <div className="text-[11.5px] text-gray-500">
                    {o.orgNumber ?? '—'} · {o.email}
                  </div>
                </td>
                <td className="px-5 py-3">
                  <PlanBadge plan={o.plan} />
                </td>
                <td className="px-5 py-3">
                  <OrgStatusBadge status={o.status} />
                </td>
                <td className="px-5 py-3 text-right text-[13px]">{o.propertyCount}</td>
                <td className="px-5 py-3 text-right text-[13px]">{o.tenantCount}</td>
                <td className="px-5 py-3 text-right text-[13px]">{formatCurrency(o.monthlyFee)}</td>
                <td className="px-5 py-3 text-[13px] text-gray-600">{formatDate(o.createdAt)}</td>
              </tr>
            ))}
            {data && data.items.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-5 py-10 text-center text-[13px] text-gray-500">
                  Inga kunder matchar filtret.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Card>
    </>
  )
}
