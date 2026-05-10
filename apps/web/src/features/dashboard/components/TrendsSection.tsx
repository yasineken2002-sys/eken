import { useState, useMemo } from 'react'
import { motion } from 'framer-motion'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts'
import { TrendingUp } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'
import { formatCurrency } from '@eken/shared'
import { useDashboardTimeseries } from '../hooks/useDashboard'
import type { DashboardPeriod, TimeseriesPoint } from '../api/dashboard.api'
import { cn } from '@/lib/cn'

const PERIODS: { value: DashboardPeriod; label: string }[] = [
  { value: '6months', label: '6 mån' },
  { value: '12months', label: '12 mån' },
  { value: '24months', label: '24 mån' },
]

const SV_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'Maj',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Okt',
  'Nov',
  'Dec',
]

function formatMonthLabel(ym: string): string {
  // ym = "2026-05"
  const [yearStr, monthStr] = ym.split('-')
  const m = parseInt(monthStr ?? '1', 10)
  return `${SV_MONTHS[m - 1] ?? ''} ${yearStr?.slice(2) ?? ''}`
}

export function TrendsSection() {
  const [period, setPeriod] = useState<DashboardPeriod>('12months')
  const { data, isLoading } = useDashboardTimeseries(period)

  const chartData = useMemo(
    () =>
      (data ?? []).map((p) => ({
        ...p,
        label: formatMonthLabel(p.month),
      })),
    [data],
  )

  const hasAnyData = useMemo(
    () =>
      chartData.some(
        (p) => p.revenue > 0 || p.paidRevenue > 0 || p.newLeases > 0 || p.openTickets > 0,
      ),
    [chartData],
  )

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1 }}
      className="mt-8"
    >
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-[18px] font-semibold tracking-tight text-gray-900">Trender</h2>
          <p className="mt-0.5 text-[13px] text-gray-500">
            Utveckling över tid — intäkter, kontrakt, beläggning och felanmälningar
          </p>
        </div>
        <div className="flex w-fit gap-1 rounded-xl bg-gray-100 p-1">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => setPeriod(p.value)}
              className={cn(
                'h-8 rounded-lg px-3 text-[13px] font-medium transition-colors',
                period === p.value
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <TrendsSkeleton />
      ) : !hasAnyData ? (
        <EmptyState
          icon={TrendingUp}
          title="Inga trender att visa ännu"
          description="Trender visas när du har fakturor, kontrakt och felanmälningar i systemet."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <RevenueChart data={chartData} />
          <LeasesChart data={chartData} />
          <OccupancyChart data={chartData} />
          <TicketsChart data={chartData} />
        </div>
      )}
    </motion.div>
  )
}

function TrendsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-[260px] animate-pulse rounded-2xl bg-gray-100" />
      ))}
    </div>
  )
}

interface ChartCardProps {
  title: string
  subtitle?: string
  children: React.ReactNode
}

function ChartCard({ title, subtitle, children }: ChartCardProps) {
  return (
    <div className="rounded-2xl border border-[#EAEDF0] bg-white p-5">
      <div className="mb-3">
        <p className="text-[14px] font-semibold text-gray-900">{title}</p>
        {subtitle && <p className="mt-0.5 text-[12px] text-gray-500">{subtitle}</p>}
      </div>
      <div className="h-[200px]">{children}</div>
    </div>
  )
}

const AXIS_STYLE = {
  fontSize: 11,
  fill: '#6B7280',
}

const TOOLTIP_STYLE = {
  background: '#fff',
  border: '1px solid #EAEDF0',
  borderRadius: 8,
  fontSize: 12,
  padding: '8px 10px',
  boxShadow: '0 4px 16px rgba(0,0,0,0.06)',
}

interface ChartProps {
  data: (TimeseriesPoint & { label: string })[]
}

function RevenueChart({ data }: ChartProps) {
  return (
    <ChartCard title="Intäkter över tid" subtitle="Fakturerat vs faktiskt betalat">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" vertical={false} />
          <XAxis dataKey="label" tick={AXIS_STYLE} axisLine={false} tickLine={false} />
          <YAxis
            tick={AXIS_STYLE}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => `${Math.round(v / 1000)}k`}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(value: number) => formatCurrency(value)}
            labelStyle={{ color: '#111827', fontWeight: 600 }}
          />
          <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="circle" iconSize={8} />
          <Line
            type="monotone"
            dataKey="revenue"
            name="Fakturerat"
            stroke="#2563EB"
            strokeWidth={2}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="paidRevenue"
            name="Betalat"
            stroke="#10B981"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

function LeasesChart({ data }: ChartProps) {
  return (
    <ChartCard title="Kontrakt per månad" subtitle="Nya kontrakt vs avslutade">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" vertical={false} />
          <XAxis dataKey="label" tick={AXIS_STYLE} axisLine={false} tickLine={false} />
          <YAxis tick={AXIS_STYLE} axisLine={false} tickLine={false} allowDecimals={false} />
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="circle" iconSize={8} />
          <Bar dataKey="newLeases" name="Nya" fill="#10B981" radius={[4, 4, 0, 0]} />
          <Bar dataKey="terminatedLeases" name="Avslutade" fill="#EF4444" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

function OccupancyChart({ data }: ChartProps) {
  return (
    <ChartCard title="Beläggning över tid" subtitle="% av enheter med aktivt kontrakt">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" vertical={false} />
          <XAxis dataKey="label" tick={AXIS_STYLE} axisLine={false} tickLine={false} />
          <YAxis
            domain={[0, 100]}
            tick={AXIS_STYLE}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => `${v}%`}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(value: number) => `${value.toFixed(1)}%`}
          />
          <Line
            type="monotone"
            dataKey="occupancy"
            name="Beläggning"
            stroke="#8B5CF6"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

function TicketsChart({ data }: ChartProps) {
  return (
    <ChartCard title="Öppna felanmälningar" subtitle="Antal öppna ärenden vid månadens slut">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" vertical={false} />
          <XAxis dataKey="label" tick={AXIS_STYLE} axisLine={false} tickLine={false} />
          <YAxis tick={AXIS_STYLE} axisLine={false} tickLine={false} allowDecimals={false} />
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          <Line
            type="monotone"
            dataKey="openTickets"
            name="Öppna ärenden"
            stroke="#F59E0B"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}
