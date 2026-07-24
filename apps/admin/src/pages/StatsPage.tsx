import { useQuery } from '@tanstack/react-query'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ResponsiveContainer,
  CartesianGrid,
  Tooltip,
  Cell,
} from 'recharts'
import { PageHeader } from '@/components/ui/PageHeader'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { DataTable } from '@/components/ui/DataTable'
import { PlanBadge, OrgStatusBadge } from '@/components/ui/Badge'
import { get } from '@/lib/api'

interface TopOrg {
  id: string
  name: string
  plan: 'TRIAL' | 'STARTER' | 'MINI' | 'STANDARD' | 'PLUS' | 'PRO'
  status: 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED'
  propertyCount: number
  tenantCount: number
  userCount: number
}

const PLAN_COLORS: Record<string, string> = {
  TRIAL: '#F59E0B',
  STARTER: '#9CA3AF',
  MINI: '#6B7280',
  STANDARD: '#3B82F6',
  PLUS: '#6366F1',
  PRO: '#10B981',
}

export function StatsPage() {
  const top = useQuery({
    queryKey: ['platform', 'stats', 'top'],
    queryFn: () => get<TopOrg[]>('/platform/stats/top-organizations'),
  })
  const breakdown = useQuery({
    queryKey: ['platform', 'stats', 'plan-breakdown'],
    queryFn: () => get<Record<string, number>>('/platform/stats/plan-breakdown'),
  })

  const planData = breakdown.data
    ? Object.entries(breakdown.data).map(([plan, count]) => ({ plan, count }))
    : []

  return (
    <>
      <PageHeader title="Statistik" description="Fördjupade siffror över plattformen" />

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <h3 className="text-[14px] font-semibold">Fördelning per plan</h3>
          </CardHeader>
          <CardBody>
            <div className="h-64">
              <ResponsiveContainer>
                <BarChart data={planData}>
                  <CartesianGrid stroke="#F1F3F5" vertical={false} />
                  <XAxis
                    dataKey="plan"
                    tick={{ fontSize: 11, fill: '#6B7280' }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fontSize: 11, fill: '#6B7280' }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      fontSize: 12,
                      borderRadius: 8,
                      border: '1px solid var(--ev-border)',
                    }}
                  />
                  <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                    {planData.map((d) => (
                      <Cell key={d.plan} fill={PLAN_COLORS[d.plan] ?? '#6B7280'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <h3 className="text-[14px] font-semibold">Topp-10 kunder per fastighet</h3>
          </CardHeader>
          <CardBody className="p-0">
            <DataTable
              wrapper={false}
              data={top.data ?? []}
              keyExtractor={(o) => o.id}
              loading={top.isLoading}
              emptyMessage="Inga kunder ännu."
              columns={[
                {
                  key: 'name',
                  header: 'Kund',
                  cell: (o) => (
                    <div className="flex items-center gap-2">
                      <span>{o.name}</span>
                      <OrgStatusBadge status={o.status} />
                    </div>
                  ),
                },
                { key: 'plan', header: 'Plan', cell: (o) => <PlanBadge plan={o.plan} /> },
                {
                  key: 'properties',
                  header: 'Fast.',
                  align: 'right',
                  cellClassName: 'text-[13px]',
                  cell: (o) => o.propertyCount,
                },
                {
                  key: 'tenants',
                  header: 'Hyresg.',
                  align: 'right',
                  cellClassName: 'text-[13px]',
                  cell: (o) => o.tenantCount,
                },
              ]}
            />
          </CardBody>
        </Card>
      </div>
    </>
  )
}
