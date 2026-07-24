import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Plus, Search } from 'lucide-react'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
import { Card } from '@/components/ui/Card'
import { DataTable } from '@/components/ui/DataTable'
import { OrgStatusBadge, PlanBadge } from '@/components/ui/Badge'
import { get } from '@/lib/api'
import { formatCurrency, formatDate } from '@/lib/format'

type Status = 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED'
type Plan = 'TRIAL' | 'STARTER' | 'MINI' | 'STANDARD' | 'PLUS' | 'PRO'

interface OrgListItem {
  id: string
  name: string
  customerNumber: string | null
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
            placeholder="Sök kundnr, namn, orgnummer, e-post…"
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
          <option value="TRIAL">Trial</option>
          <option value="ACTIVE">Aktiv</option>
          <option value="PAST_DUE">Förfallen</option>
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
          <option value="STARTER">Starter</option>
          <option value="MINI">Mini</option>
          <option value="STANDARD">Standard</option>
          <option value="PLUS">Plus</option>
          <option value="PRO">Pro</option>
        </Select>
      </div>

      <Card className="mt-4 overflow-hidden">
        <DataTable
          wrapper={false}
          data={data?.items ?? []}
          keyExtractor={(o) => o.id}
          loading={!data}
          emptyMessage="Inga kunder matchar filtret."
          columns={[
            {
              key: 'name',
              header: 'Namn',
              cell: (o) => (
                <>
                  <Link
                    to={`/organizations/${o.id}`}
                    className="font-medium text-gray-900 hover:text-blue-600"
                  >
                    {o.name}
                  </Link>
                  <div className="text-[11.5px] text-gray-500">
                    {o.customerNumber ?? '—'} · {o.orgNumber ?? '—'} · {o.email}
                  </div>
                </>
              ),
            },
            { key: 'plan', header: 'Plan', cell: (o) => <PlanBadge plan={o.plan} /> },
            { key: 'status', header: 'Status', cell: (o) => <OrgStatusBadge status={o.status} /> },
            {
              key: 'properties',
              header: 'Fastigheter',
              align: 'right',
              cellClassName: 'text-[13px]',
              cell: (o) => o.propertyCount,
            },
            {
              key: 'tenants',
              header: 'Hyresgäster',
              align: 'right',
              cellClassName: 'text-[13px]',
              cell: (o) => o.tenantCount,
            },
            {
              key: 'mrr',
              header: 'MRR',
              align: 'right',
              cellClassName: 'text-[13px]',
              cell: (o) => formatCurrency(o.monthlyFee),
            },
            {
              key: 'createdAt',
              header: 'Skapad',
              cellClassName: 'text-[13px] text-gray-600',
              cell: (o) => formatDate(o.createdAt),
            },
          ]}
        />
      </Card>
    </>
  )
}
