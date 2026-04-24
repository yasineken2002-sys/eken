import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Building2, CreditCard, Pause, Rocket, TrendingUp } from 'lucide-react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/ui/PageHeader'
import { KpiCard } from '@/components/ui/Kpi'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { get } from '@/lib/api'
import { formatCurrency, relativeTime } from '@/lib/format'
import { OrgStatusBadge, PlanBadge, SeverityBadge } from '@/components/ui/Badge'

interface Overview {
  totalOrgs: number
  activeOrgs: number
  suspendedOrgs: number
  trialOrgs: number
  totalRevenue: number
  mrr: number
  criticalErrors: number
}

type ActivityEvent =
  | { type: 'ORG_CREATED'; timestamp: string; data: { id: string; name: string; plan: string } }
  | {
      type: 'PAYMENT_RECEIVED'
      timestamp: string
      data: {
        id: string
        amount: number
        invoiceNumber: string
        organization: { id: string; name: string }
      }
    }
  | {
      type: 'CRITICAL_ERROR'
      timestamp: string
      data: {
        id: string
        message: string
        source: string
        organization: { id: string; name: string } | null
      }
    }

export function DashboardPage() {
  const overview = useQuery({
    queryKey: ['platform', 'overview'],
    queryFn: () => get<Overview>('/platform/stats/overview'),
  })
  const growth = useQuery({
    queryKey: ['platform', 'growth'],
    queryFn: () =>
      get<{ date: string; count: number }[]>('/platform/stats/growth', { period: '30d' }),
  })
  const activity = useQuery({
    queryKey: ['platform', 'activity'],
    queryFn: () => get<ActivityEvent[]>('/platform/stats/activity', { limit: 15 }),
  })

  return (
    <>
      <PageHeader title="Översikt" description="Snabbstatus över plattformen" />

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Totalt kunder"
          value={overview.data?.totalOrgs ?? '—'}
          icon={<Building2 size={16} className="text-gray-400" />}
          hint={`${overview.data?.activeOrgs ?? 0} aktiva`}
        />
        <KpiCard
          label="Trial-konton"
          value={overview.data?.trialOrgs ?? '—'}
          icon={<Rocket size={16} className="text-amber-500" />}
        />
        <KpiCard
          label="Suspenderade"
          value={overview.data?.suspendedOrgs ?? '—'}
          icon={<Pause size={16} className="text-gray-400" />}
          {...(overview.data && overview.data.suspendedOrgs > 0
            ? { tone: 'warning' as const }
            : {})}
        />
        <KpiCard
          label="Olösta kritiska fel"
          value={overview.data?.criticalErrors ?? '—'}
          icon={<AlertTriangle size={16} className="text-red-500" />}
          {...(overview.data && overview.data.criticalErrors > 0
            ? { tone: 'danger' as const }
            : {})}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="MRR"
          value={formatCurrency(overview.data?.mrr ?? 0)}
          icon={<TrendingUp size={16} className="text-emerald-500" />}
          hint="Månadsintäkt (ACTIVE)"
        />
        <KpiCard
          label="Total omsättning"
          value={formatCurrency(overview.data?.totalRevenue ?? 0)}
          icon={<CreditCard size={16} className="text-blue-500" />}
          hint="Summa betalda plattformsfakturor"
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <h3 className="text-[14px] font-semibold text-gray-900">Tillväxt – 30 dagar</h3>
          </CardHeader>
          <CardBody>
            {growth.data ? (
              <div className="h-56 w-full">
                <ResponsiveContainer>
                  <LineChart data={growth.data}>
                    <CartesianGrid stroke="#F1F3F5" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 11, fill: '#9CA3AF' }}
                      tickFormatter={(v: string) => v.slice(5)}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      allowDecimals={false}
                      tick={{ fontSize: 11, fill: '#9CA3AF' }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip
                      contentStyle={{
                        fontSize: 12,
                        borderRadius: 8,
                        border: '1px solid #EAEDF0',
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="count"
                      stroke="#2563EB"
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="h-56 animate-pulse rounded bg-gray-50" />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <h3 className="text-[14px] font-semibold text-gray-900">Senaste aktivitet</h3>
          </CardHeader>
          <CardBody className="space-y-3">
            {!activity.data ? (
              <div className="text-[13px] text-gray-500">Laddar…</div>
            ) : activity.data.length === 0 ? (
              <div className="text-[13px] text-gray-500">Inget att visa.</div>
            ) : (
              activity.data.map((e, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className="mt-0.5 h-2 w-2 rounded-full bg-blue-500" />
                  <div className="flex-1">
                    {e.type === 'ORG_CREATED' ? (
                      <>
                        <div className="text-[13px] text-gray-900">
                          Ny kund:{' '}
                          <Link
                            to={`/organizations/${e.data.id}`}
                            className="font-medium text-blue-600 hover:underline"
                          >
                            {e.data.name}
                          </Link>
                        </div>
                        <div className="mt-0.5 flex items-center gap-2">
                          <PlanBadge
                            plan={e.data.plan as 'TRIAL' | 'BASIC' | 'STANDARD' | 'PREMIUM'}
                          />
                          <span className="text-[11.5px] text-gray-500">
                            {relativeTime(e.timestamp)}
                          </span>
                        </div>
                      </>
                    ) : e.type === 'PAYMENT_RECEIVED' ? (
                      <>
                        <div className="text-[13px] text-gray-900">
                          Betalning: {formatCurrency(e.data.amount)} – {e.data.organization.name}
                        </div>
                        <div className="mt-0.5 text-[11.5px] text-gray-500">
                          {e.data.invoiceNumber} • {relativeTime(e.timestamp)}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="truncate text-[13px] text-gray-900">
                          Kritiskt fel: {e.data.message}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2">
                          <SeverityBadge severity="CRITICAL" />
                          {e.data.organization ? (
                            <span className="text-[11.5px] text-gray-500">
                              {e.data.organization.name}
                            </span>
                          ) : null}
                          <span className="text-[11.5px] text-gray-500">
                            {relativeTime(e.timestamp)}
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              ))
            )}
          </CardBody>
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <h3 className="text-[14px] font-semibold text-gray-900">Kund-status-fördelning</h3>
          </CardHeader>
          <CardBody>
            {overview.data ? (
              <div className="flex items-center gap-6 text-[13px]">
                <div className="flex items-center gap-2">
                  <OrgStatusBadge status="ACTIVE" />{' '}
                  <span className="font-medium">{overview.data.activeOrgs}</span>
                </div>
                <div className="flex items-center gap-2">
                  <OrgStatusBadge status="SUSPENDED" />{' '}
                  <span className="font-medium">{overview.data.suspendedOrgs}</span>
                </div>
                <div className="flex items-center gap-2">
                  <PlanBadge plan="TRIAL" />{' '}
                  <span className="font-medium">{overview.data.trialOrgs}</span>
                </div>
              </div>
            ) : null}
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <h3 className="text-[14px] font-semibold text-gray-900">Snabblänkar</h3>
          </CardHeader>
          <CardBody>
            <ul className="space-y-2 text-[13.5px]">
              <li>
                <Link to="/organizations" className="text-blue-600 hover:underline">
                  → Alla kunder
                </Link>
              </li>
              <li>
                <Link to="/billing" className="text-blue-600 hover:underline">
                  → Skapa ny faktura
                </Link>
              </li>
              <li>
                <Link to="/errors?resolved=false" className="text-blue-600 hover:underline">
                  → Olösta fel
                </Link>
              </li>
            </ul>
          </CardBody>
        </Card>
      </div>
    </>
  )
}
