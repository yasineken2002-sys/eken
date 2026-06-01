import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Brain, Check, Clock, CreditCard, Info, Sparkles, TrendingUp, Zap } from 'lucide-react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { PLAN_LIMITS, PLAN_ORDER, CREDIT_PACKAGES, formatCurrency, formatDate } from '@eken/shared'
import { toast } from 'sonner'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { useAiUsageCurrent, useAiUsageHistory, useBuyAiCredits } from '../hooks/usePlan'
import { cn } from '@/lib/cn'

export function PlanPanel() {
  const { data: current, isLoading } = useAiUsageCurrent()
  const { data: history } = useAiUsageHistory(30)
  const [creditsModalOpen, setCreditsModalOpen] = useState(false)
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false)
  const [purchaseResult, setPurchaseResult] = useState<{
    invoiceNumber: string
    amountGrossSek: number
  } | null>(null)

  const buyCredits = useBuyAiCredits()

  const daysUntilTrialEnd = useMemo(() => {
    if (!current?.trialEndsAt) return null
    const diffMs = new Date(current.trialEndsAt).getTime() - Date.now()
    return Math.max(0, Math.ceil(diffMs / (24 * 60 * 60 * 1000)))
  }, [current?.trialEndsAt])

  if (isLoading || !current) {
    return (
      <div className="space-y-5">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-40 animate-pulse rounded-2xl bg-gray-100" />
        ))}
      </div>
    )
  }

  const planLimit = PLAN_LIMITS[current.plan]
  const percentageClamped = Math.min(100, current.percentage)
  const overLimit = current.used >= current.limit
  const progressColor =
    percentageClamped >= 100
      ? 'bg-red-500'
      : percentageClamped >= 95
        ? 'bg-amber-500'
        : percentageClamped >= 80
          ? 'bg-amber-400'
          : 'bg-blue-500'
  const monthlyResetText = formatDate(current.resetsAt)

  return (
    <div className="space-y-5">
      {/* ── Trial-banner ───────────────────────────────────────────────────── */}
      {current.status === 'TRIAL' && daysUntilTrialEnd !== null && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          className="rounded-2xl border border-blue-100 bg-blue-50 p-4"
        >
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-100">
              <Sparkles size={16} strokeWidth={1.8} className="text-blue-600" />
            </div>
            <div>
              <h3 className="text-[14px] font-semibold text-blue-900">
                Trial-period aktiv — {daysUntilTrialEnd} dagar kvar
              </h3>
              <p className="mt-0.5 text-[13px] text-blue-700">
                Välj en plan innan {formatDate(current.trialEndsAt!)} för att fortsätta använda
                Eveno utan avbrott.
              </p>
            </div>
          </div>
        </motion.div>
      )}

      {/* ── Plan-card ──────────────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-gray-100 bg-white p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <h2 className="text-[14px] font-semibold text-gray-800">Din plan</h2>
              <span className="inline-flex items-center rounded-full bg-blue-50 px-2.5 py-0.5 text-[12px] font-medium text-blue-700">
                {planLimit.name}
              </span>
            </div>
            <p className="text-[13px] text-gray-500">{planLimit.description}</p>
            <div className="mt-4 flex flex-wrap items-baseline gap-x-2">
              <span className="text-[26px] font-semibold tracking-tight text-gray-900">
                {planLimit.monthlyFee === 0 ? 'Gratis' : formatCurrency(planLimit.monthlyFee)}
              </span>
              {planLimit.monthlyFee > 0 && (
                <span className="text-[13px] text-gray-500">/mån exkl moms</span>
              )}
            </div>
            <p className="mt-2 text-[12px] text-gray-500">
              Plan aktiverad {formatDate(current.planStartedAt)} · Upp till {planLimit.maxObjects}{' '}
              hyresobjekt
            </p>
          </div>
          <Button variant="primary" size="sm" onClick={() => setUpgradeModalOpen(true)}>
            <TrendingUp size={13} strokeWidth={1.8} className="mr-1.5" />
            Byt plan
          </Button>
        </div>
      </section>

      {/* ── AI-användning ─────────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-gray-100 bg-white p-5">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-50">
              <Brain size={13} strokeWidth={1.8} className="text-blue-600" />
            </div>
            <h2 className="text-[14px] font-semibold text-gray-800">AI-användning denna månad</h2>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setCreditsModalOpen(true)}>
            <CreditCard size={13} strokeWidth={1.8} className="mr-1.5" />
            Köp extra credits
          </Button>
        </div>

        {/* Progress */}
        <div className="flex items-baseline justify-between">
          <div>
            <span className="text-[26px] font-semibold tracking-tight text-gray-900">
              {current.used.toLocaleString('sv-SE')}
            </span>
            <span className="text-[14px] text-gray-500">
              {' '}
              / {current.limit.toLocaleString('sv-SE')} anrop
            </span>
          </div>
          <span
            className={cn(
              'text-[12px] font-medium',
              overLimit
                ? 'text-red-600'
                : current.percentage >= 80
                  ? 'text-amber-600'
                  : 'text-gray-500',
            )}
          >
            {Math.round(current.percentage)}%
          </span>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-gray-100">
          <motion.div
            className={cn('h-full rounded-full', progressColor)}
            initial={{ width: 0 }}
            animate={{ width: `${percentageClamped}%` }}
            transition={{ duration: 0.4 }}
          />
        </div>
        <div className="mt-3 flex items-center justify-between text-[12px] text-gray-500">
          <span className="inline-flex items-center gap-1">
            <Clock size={12} strokeWidth={1.8} />
            Nollställs {monthlyResetText}
          </span>
          {current.creditsBalance > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700">
              <Zap size={11} strokeWidth={2} />
              {current.creditsBalance} extra credits
            </span>
          )}
        </div>

        {/* Info-banner */}
        <div className="mt-5 flex items-start gap-2 rounded-xl border border-blue-100 bg-blue-50/50 p-3">
          <Info size={13} strokeWidth={1.8} className="mt-0.5 flex-shrink-0 text-blue-600" />
          <p className="text-[12px] text-blue-800">
            Automatiska AI-aktiviteter (morgonrapporter, OCR, hyresgäst-AI, kontraktsskanning) ingår
            i basplanen och räknas <strong>inte</strong> mot detta tak. Bara manuella anrop från din
            AI-assistent räknas.
          </p>
        </div>
      </section>

      {/* ── Användningsgraf ───────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-gray-100 bg-white p-5">
        <h2 className="mb-4 text-[14px] font-semibold text-gray-800">
          Användning senaste 30 dagarna
        </h2>
        <div className="h-[260px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={history ?? []} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#EAEDF0" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: '#6B7280' }}
                tickFormatter={(d: string) => d.slice(5)}
              />
              <YAxis tick={{ fontSize: 11, fill: '#6B7280' }} />
              <Tooltip
                contentStyle={{
                  borderRadius: 12,
                  border: '1px solid #EAEDF0',
                  fontSize: 12,
                }}
                labelFormatter={(d: string) => formatDate(d)}
              />
              <Legend iconSize={10} wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
              <Line
                type="monotone"
                dataKey="manualCalls"
                name="Manuella (räknas mot tak)"
                stroke="#2563EB"
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="automatedCalls"
                name="Automatiska (ingår)"
                stroke="#10B981"
                strokeWidth={2}
                dot={false}
                strokeDasharray="4 3"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* ── Köp credits modal ─────────────────────────────────────────────── */}
      <Modal
        open={creditsModalOpen}
        onClose={() => {
          setCreditsModalOpen(false)
          setPurchaseResult(null)
        }}
        title="Köp extra AI-credits"
        description="1 credit = 1 extra AI-anrop när månadens tak är nått"
        size="md"
      >
        {purchaseResult ? (
          <div className="py-2">
            <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-100">
                  <Check size={16} strokeWidth={2.4} className="text-emerald-700" />
                </div>
                <div>
                  <p className="text-[14px] font-semibold text-emerald-900">
                    Faktura {purchaseResult.invoiceNumber} skapad
                  </p>
                  <p className="mt-1 text-[13px] text-emerald-700">
                    Vi skickar betalningsinstruktioner till din mail. När fakturan är betald läggs
                    crediten till på ditt konto automatiskt.
                  </p>
                  <p className="mt-2 text-[12px] text-emerald-700">
                    Att betala: {formatCurrency(purchaseResult.amountGrossSek)} inkl moms
                  </p>
                </div>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  setCreditsModalOpen(false)
                  setPurchaseResult(null)
                }}
              >
                Klart
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 py-2">
            {CREDIT_PACKAGES.map((pkg) => (
              <button
                key={pkg.amount}
                className={cn(
                  'group flex w-full items-center justify-between gap-3 rounded-xl border p-4 text-left transition-all hover:border-blue-300 active:scale-[0.99]',
                  pkg.recommended ? 'border-blue-200 bg-blue-50/30' : 'border-gray-100 bg-white',
                )}
                disabled={buyCredits.isPending}
                onClick={async () => {
                  const result = await buyCredits.mutateAsync(pkg.amount)
                  setPurchaseResult({
                    invoiceNumber: result.invoiceNumber,
                    amountGrossSek: result.amountGrossSek,
                  })
                }}
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[15px] font-semibold text-gray-900">{pkg.label}</span>
                    {pkg.recommended && (
                      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                        Rekommenderas
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[12px] text-gray-500">1 credit = 1 extra AI-anrop</p>
                </div>
                <div className="text-right">
                  <div className="text-[15px] font-semibold text-gray-900">
                    {formatCurrency(pkg.priceSek)}
                  </div>
                  <div className="text-[11px] text-gray-500">exkl moms</div>
                </div>
              </button>
            ))}
            <p className="pt-1 text-[12px] text-gray-500">
              En faktura skapas direkt. Crediten läggs till så snart vi registrerat betalningen.
            </p>
          </div>
        )}
      </Modal>

      {/* ── Uppgradera plan modal ─────────────────────────────────────────── */}
      <Modal
        open={upgradeModalOpen}
        onClose={() => setUpgradeModalOpen(false)}
        title="Välj plan"
        description="Alla planer har samma funktioner — du betalar för antal hyresobjekt och AI-anrop."
        size="xl"
      >
        <div className="grid grid-cols-1 gap-4 py-2 sm:grid-cols-2 lg:grid-cols-3">
          {PLAN_ORDER.filter((p) => p !== 'TRIAL').map((p) => {
            const limit = PLAN_LIMITS[p]
            const isCurrent = current.plan === p
            return (
              <div
                key={p}
                className={cn(
                  'flex flex-col rounded-2xl border p-5',
                  isCurrent ? 'border-blue-300 bg-blue-50/30' : 'border-gray-100 bg-white',
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[14px] font-semibold text-gray-800">{limit.name}</span>
                  {isCurrent && (
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                      Din plan
                    </span>
                  )}
                </div>
                <div className="mt-3 flex items-baseline gap-1">
                  <span className="text-[24px] font-semibold tracking-tight text-gray-900">
                    {formatCurrency(limit.monthlyFee)}
                  </span>
                  <span className="text-[12px] text-gray-500">/mån</span>
                </div>
                <p className="text-[11px] text-gray-500">exkl moms</p>
                <ul className="mt-4 space-y-2 text-[13px] text-gray-700">
                  <li className="flex items-center gap-2">
                    <Check size={13} strokeWidth={2} className="text-emerald-600" />
                    {limit.maxObjects} hyresobjekt
                  </li>
                  <li className="flex items-center gap-2">
                    <Check size={13} strokeWidth={2} className="text-emerald-600" />
                    {limit.monthlyAiCalls.toLocaleString('sv-SE')} AI-anrop/mån
                  </li>
                  <li className="flex items-center gap-2">
                    <Check size={13} strokeWidth={2} className="text-emerald-600" />
                    Obegränsad automatisk AI
                  </li>
                  <li className="flex items-center gap-2">
                    <Check size={13} strokeWidth={2} className="text-emerald-600" />
                    Alla funktioner inkluderade
                  </li>
                </ul>
                <Button
                  variant={isCurrent ? 'secondary' : 'primary'}
                  size="sm"
                  className="mt-5 w-full"
                  disabled={isCurrent}
                  onClick={() => {
                    toast.info(
                      `För att byta till ${limit.name}: kontakta supporten på support@eveno.se så hjälper vi dig direkt.`,
                      { duration: 8000 },
                    )
                  }}
                >
                  {isCurrent ? 'Din nuvarande plan' : `Byt till ${limit.name}`}
                </Button>
              </div>
            )
          })}
        </div>
      </Modal>
    </div>
  )
}
