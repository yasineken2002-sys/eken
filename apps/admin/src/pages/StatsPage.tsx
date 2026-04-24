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
import { PlanBadge, OrgStatusBadge } from '@/components/ui/Badge'
import { get } from '@/lib/api'

interface TopOrg {
  id: string
  name: string
  plan: 'TRIAL' | 'BASIC' | 'STANDARD' | 'PREMIUM'
  status: 'ACTIVE' | 'SUSPENDED' | 'CANCELLED'
  propertyCount: number
  tenantCount: number
  userCount: number
}

const PLAN_COLORS: Record<string, string> = {
  TRIAL: '#F59E0B',
  BASIC: '#9CA3AF',
  STANDARD: '#3B82F6',
  PREMIUM: '#10B981',
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
                    contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #EAEDF0' }}
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
            <table className="w-full">
              <thead>
                <tr className="border-b border-[#EAEDF0]">
                  <th className="px-5 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                    Kund
                  </th>
                  <th className="px-5 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                    Plan
                  </th>
                  <th className="px-5 py-3 text-right text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                    Fast.
                  </th>
                  <th className="px-5 py-3 text-right text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                    Hyresg.
                  </th>
                </tr>
              </thead>
              <tbody>
                {(top.data ?? []).map((o) => (
                  <tr key={o.id} className="border-b border-[#EAEDF0] last:border-0">
                    <td className="px-5 py-3 text-[13.5px]">
                      <div className="flex items-center gap-2">
                        <span>{o.name}</span>
                        <OrgStatusBadge status={o.status} />
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <PlanBadge plan={o.plan} />
                    </td>
                    <td className="px-5 py-3 text-right text-[13px]">{o.propertyCount}</td>
                    <td className="px-5 py-3 text-right text-[13px]">{o.tenantCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      </div>
    </>
  )
}
