import { useState } from 'react'
import { motion } from 'framer-motion'
import { BarChart3, Scale, Percent, Download, FileX, FileSpreadsheet } from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { StatCard } from '@/components/ui/StatCard'
import { EmptyState } from '@/components/ui/EmptyState'
import { formatCurrency } from '@eken/shared'
import { cn } from '@/lib/cn'
import { useBalanceSheet, useProfitLoss, useVatReport } from './hooks/useReports'
import { downloadSie4 } from './api/reports.api'
import type { BalanceSheet, ProfitLossReport, ReportAccountAmount, VatReport } from '@eken/shared'

type Tab = 'profit-loss' | 'balance-sheet' | 'vat' | 'sie4'

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: 'profit-loss', label: 'Resultaträkning', icon: BarChart3 },
  { id: 'balance-sheet', label: 'Balansräkning', icon: Scale },
  { id: 'vat', label: 'Momsrapport', icon: Percent },
  { id: 'sie4', label: 'SIE4-export', icon: FileSpreadsheet },
]

// Standardperiod: innevarande kalenderår t.o.m. idag (vanligaste räkenskapsår).
function defaultRange() {
  const now = new Date()
  const year = now.getFullYear()
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  return { from: `${year}-01-01`, to: iso(now) }
}

function LoadingRows() {
  return (
    <div className="mt-5 space-y-3">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="h-12 animate-pulse rounded-xl bg-gray-100" />
      ))}
    </div>
  )
}

function ErrorState() {
  return (
    <div className="mt-5">
      <EmptyState
        icon={FileX}
        title="Kunde inte hämta rapporten"
        description="Kontrollera perioden och försök igen."
      />
    </div>
  )
}

// ─── Resultaträkning ──────────────────────────────────────────────────────────

function CostGroup({
  label,
  group,
}: {
  label: string
  group: { total: number; accounts: ReportAccountAmount[] }
}) {
  if (group.accounts.length === 0) return null
  return (
    <>
      <tr className="bg-gray-50/60">
        <td
          colSpan={2}
          className="px-4 py-2 text-[12px] font-semibold uppercase tracking-wide text-gray-400"
        >
          {label}
        </td>
        <td className="px-4 py-2 text-right text-[13px] font-semibold text-gray-700">
          {formatCurrency(group.total)}
        </td>
      </tr>
      {group.accounts.map((a) => (
        <tr key={a.number} className="border-b border-[#EAEDF0] last:border-0 hover:bg-gray-50/80">
          <td className="px-4 py-2.5 text-[13px] tabular-nums text-gray-400">{a.number}</td>
          <td className="px-4 py-2.5 text-[13px] text-gray-700">{a.name}</td>
          <td className="px-4 py-2.5 text-right text-[13px] tabular-nums text-gray-900">
            {formatCurrency(a.amount)}
          </td>
        </tr>
      ))}
    </>
  )
}

function ProfitLossView({ data }: { data: ProfitLossReport }) {
  return (
    <div className="mt-5 space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard title="Intäkter" value={formatCurrency(data.revenue.total)} icon={BarChart3} />
        <StatCard title="Kostnader" value={formatCurrency(data.costs.total)} icon={Percent} />
        <StatCard
          title="Resultat"
          value={formatCurrency(data.result)}
          icon={Scale}
          iconColor={data.result >= 0 ? '#059669' : '#DC2626'}
        />
      </div>

      {data.note && (
        <p className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-2.5 text-[12.5px] text-amber-700">
          {data.note}
        </p>
      )}

      <div className="overflow-hidden rounded-2xl border border-[#EAEDF0] bg-white">
        <table className="w-full">
          <tbody>
            <CostGroup label="Intäkter" group={data.revenue} />
            <CostGroup label="Driftkostnader" group={data.costs.operating} />
            <CostGroup label="Administration" group={data.costs.admin} />
            <CostGroup label="Personal" group={data.costs.personnel} />
            <CostGroup label="Avskrivningar" group={data.costs.depreciation} />
            <CostGroup label="Finansiellt" group={data.costs.financial} />
            <tr className="border-t-2 border-gray-200 bg-gray-50">
              <td colSpan={2} className="px-4 py-3 text-[13.5px] font-semibold text-gray-900">
                Periodens resultat
              </td>
              <td
                className={cn(
                  'px-4 py-3 text-right text-[14px] font-semibold tabular-nums',
                  data.result >= 0 ? 'text-emerald-600' : 'text-red-600',
                )}
              >
                {formatCurrency(data.result)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Balansräkning ────────────────────────────────────────────────────────────

function BalanceColumn({
  title,
  total,
  accounts,
}: {
  title: string
  total: number
  accounts: BalanceSheet['assets']['accounts']
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-[#EAEDF0] bg-white">
      <div className="flex items-center justify-between border-b border-[#EAEDF0] px-4 py-3">
        <span className="text-[13.5px] font-semibold text-gray-900">{title}</span>
        <span className="text-[13.5px] font-semibold tabular-nums text-gray-900">
          {formatCurrency(total)}
        </span>
      </div>
      <table className="w-full">
        <tbody>
          {accounts.map((a) => (
            <tr
              key={a.number}
              className="border-b border-[#EAEDF0] last:border-0 hover:bg-gray-50/80"
            >
              <td className="px-4 py-2.5 text-[13px] tabular-nums text-gray-400">{a.number}</td>
              <td className="px-4 py-2.5 text-[13px] text-gray-700">{a.name}</td>
              <td className="px-4 py-2.5 text-right text-[13px] tabular-nums text-gray-900">
                {formatCurrency(a.balance)}
              </td>
            </tr>
          ))}
          {accounts.length === 0 && (
            <tr>
              <td colSpan={3} className="px-4 py-6 text-center text-[13px] text-gray-400">
                Inga poster
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function BalanceSheetView({ data }: { data: BalanceSheet }) {
  const balanced = Math.abs(data.difference) < 0.5
  return (
    <div className="mt-5 space-y-4">
      <div
        className={cn(
          'rounded-xl px-4 py-2.5 text-[12.5px] font-medium',
          balanced ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600',
        )}
      >
        {balanced
          ? 'Balansräkningen balanserar (tillgångar = skulder + eget kapital).'
          : `Differens ${formatCurrency(data.difference)} — boken balanserar inte.`}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BalanceColumn
          title="Tillgångar"
          total={data.assets.total}
          accounts={data.assets.accounts}
        />
        <BalanceColumn
          title="Skulder & eget kapital"
          total={data.liabilitiesAndEquity.total}
          accounts={data.liabilitiesAndEquity.accounts}
        />
      </div>
    </div>
  )
}

// ─── Momsrapport ──────────────────────────────────────────────────────────────

function VatView({ data }: { data: VatReport }) {
  const pay = data.netToPay >= 0
  const rows: { label: string; value: number }[] = [
    { label: 'Utgående moms 25 %', value: data.outgoing.vat25 },
    { label: 'Utgående moms 12 %', value: data.outgoing.vat12 },
    { label: 'Utgående moms 6 %', value: data.outgoing.vat6 },
    { label: 'Summa utgående moms', value: data.outgoing.total },
    { label: 'Ingående moms', value: -data.incoming.total },
  ]
  return (
    <div className="mt-5 space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          title="Utgående moms"
          value={formatCurrency(data.outgoing.total)}
          icon={Percent}
        />
        <StatCard
          title="Ingående moms"
          value={formatCurrency(data.incoming.total)}
          icon={Percent}
        />
        <StatCard
          title={pay ? 'Att betala' : 'Att få tillbaka'}
          value={formatCurrency(Math.abs(data.netToPay))}
          icon={Scale}
          iconColor={pay ? '#DC2626' : '#059669'}
        />
      </div>
      <div className="overflow-hidden rounded-2xl border border-[#EAEDF0] bg-white">
        <table className="w-full">
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.label}
                className={cn(
                  'border-b border-[#EAEDF0] last:border-0',
                  r.label.startsWith('Summa') && 'bg-gray-50/60 font-semibold',
                )}
              >
                <td className="px-4 py-3 text-[13px] text-gray-700">{r.label}</td>
                <td className="px-4 py-3 text-right text-[13px] tabular-nums text-gray-900">
                  {formatCurrency(r.value)}
                </td>
              </tr>
            ))}
            <tr className="border-t-2 border-gray-200 bg-gray-50">
              <td className="px-4 py-3 text-[13.5px] font-semibold text-gray-900">
                {pay ? 'Moms att betala' : 'Moms att få tillbaka'}
              </td>
              <td
                className={cn(
                  'px-4 py-3 text-right text-[14px] font-semibold tabular-nums',
                  pay ? 'text-red-600' : 'text-emerald-600',
                )}
              >
                {formatCurrency(Math.abs(data.netToPay))}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Sida ─────────────────────────────────────────────────────────────────────

export function ReportsPage() {
  const [tab, setTab] = useState<Tab>('profit-loss')
  const initial = defaultRange()
  const [from, setFrom] = useState(initial.from)
  const [to, setTo] = useState(initial.to)
  const [asOf, setAsOf] = useState(initial.to)
  const [downloading, setDownloading] = useState(false)
  const [sieError, setSieError] = useState<string | null>(null)

  const validRange = Boolean(from && to && from <= to)
  const pl = useProfitLoss({ from, to }, tab === 'profit-loss' && validRange)
  const bs = useBalanceSheet(asOf, tab === 'balance-sheet' && Boolean(asOf))
  const vat = useVatReport({ from, to }, tab === 'vat' && validRange)

  const handleDownload = async () => {
    setSieError(null)
    setDownloading(true)
    try {
      await downloadSie4(from, to)
    } catch {
      setSieError('Kunde inte generera SIE4-filen. Kontrollera perioden.')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <PageWrapper id="reports">
      <PageHeader
        title="Rapporter"
        description="Resultaträkning, balansräkning, momsrapport och SIE4-export"
      />

      {/* Flikar */}
      <div className="mt-6 flex w-fit flex-wrap items-center gap-1 rounded-xl bg-gray-100/70 p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'flex h-8 items-center gap-1.5 rounded-lg px-3.5 text-[13px] font-medium transition-all',
              tab === t.id
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700',
            )}
          >
            <t.icon size={14} strokeWidth={1.8} />
            {t.label}
          </button>
        ))}
      </div>

      {/* Datumkontroller */}
      <div className="mt-5 flex flex-wrap items-end gap-3">
        {tab === 'balance-sheet' ? (
          <Input
            label="Per datum"
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            className="w-44"
          />
        ) : (
          <>
            <Input
              label="Från"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-44"
            />
            <Input
              label="Till"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-44"
            />
          </>
        )}
        {tab === 'sie4' && (
          <Button
            variant="primary"
            loading={downloading}
            disabled={!validRange}
            onClick={() => void handleDownload()}
          >
            <Download size={15} strokeWidth={1.8} />
            Ladda ner SIE4
          </Button>
        )}
      </div>
      {!validRange && tab !== 'balance-sheet' && (
        <p className="mt-2 text-[12px] text-red-500">
          Från-datum måste vara samma eller före till-datum.
        </p>
      )}

      {/* Innehåll */}
      <motion.div
        key={tab}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
      >
        {tab === 'profit-loss' &&
          (pl.isLoading ? (
            <LoadingRows />
          ) : pl.isError ? (
            <ErrorState />
          ) : pl.data ? (
            <ProfitLossView data={pl.data} />
          ) : null)}

        {tab === 'balance-sheet' &&
          (bs.isLoading ? (
            <LoadingRows />
          ) : bs.isError ? (
            <ErrorState />
          ) : bs.data ? (
            <BalanceSheetView data={bs.data} />
          ) : null)}

        {tab === 'vat' &&
          (vat.isLoading ? (
            <LoadingRows />
          ) : vat.isError ? (
            <ErrorState />
          ) : vat.data ? (
            <VatView data={vat.data} />
          ) : null)}

        {tab === 'sie4' && (
          <div className="mt-5">
            <EmptyState
              icon={FileSpreadsheet}
              title="SIE4-export"
              description="Exportera periodens verifikationer och kontoplan som SIE4-fil — importeras i Fortnox, Visma och de flesta bokslutsprogram. Välj period ovan och ladda ner."
            />
            {sieError && <p className="mt-3 text-center text-[13px] text-red-500">{sieError}</p>}
          </div>
        )}
      </motion.div>
    </PageWrapper>
  )
}
