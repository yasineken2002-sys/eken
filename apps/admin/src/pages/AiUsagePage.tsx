import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  Mail,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react'
import { PageHeader } from '@/components/ui/PageHeader'
import { Card } from '@/components/ui/Card'
import { KpiCard } from '@/components/ui/Kpi'
import { PlanBadge, OrgStatusBadge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Input, Select } from '@/components/ui/Input'
import { get, post } from '@/lib/api'
import { formatCurrency } from '@/lib/format'
import { cn } from '@/lib/cn'

type Plan = 'TRIAL' | 'STARTER' | 'MINI' | 'STANDARD' | 'PLUS' | 'PRO'

interface UsageRow {
  id: string
  name: string
  plan: Plan
  planName: string
  orgStatus: 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED'
  manualCalls: number
  automatedCalls: number
  limit: number
  percentage: number
  aiCostUsd: number
  aiCostSek: number
  revenueSek: number
  marginSek: number
  creditsBalance: number
  trialEndsAt: string | null
  trialDaysLeft: number | null
  status: 'ok' | 'warning' | 'over'
}

interface Kpis {
  perPlan: Record<Plan, number>
  mrrSek: number
  totalCostUsd: number
  totalCostSek: number
  marginSek: number
  orgsOverEightyPct: number
  totalActiveOrgs: number
  totalTrialOrgs: number
}

type Filter = 'all' | 'over80' | 'over100' | 'trialEnding' | 'highCost'

export function AiUsagePage() {
  const qc = useQueryClient()
  const [filter, setFilter] = useState<Filter>('all')
  const [creditsRow, setCreditsRow] = useState<UsageRow | null>(null)
  const [planRow, setPlanRow] = useState<UsageRow | null>(null)
  const [creditsAmount, setCreditsAmount] = useState(100)
  const [creditsNote, setCreditsNote] = useState('')
  const [newPlan, setNewPlan] = useState<Plan>('STANDARD')

  const params = useMemo(() => {
    const p: Record<string, string> = {}
    if (filter === 'over80') p.overEightyPct = 'true'
    if (filter === 'over100') p.overOneHundredPct = 'true'
    if (filter === 'trialEnding') p.trialEndingSoon = 'true'
    if (filter === 'highCost') p.highCostUsd = '20'
    return p
  }, [filter])

  const rowsQuery = useQuery({
    queryKey: ['platform', 'ai-usage', params],
    queryFn: () => get<UsageRow[]>('/platform/ai-usage', params),
  })
  const kpisQuery = useQuery({
    queryKey: ['platform', 'ai-usage', 'kpis'],
    queryFn: () => get<Kpis>('/platform/ai-usage/kpis'),
  })

  const addCredits = useMutation({
    mutationFn: ({ id, amount, note }: { id: string; amount: number; note?: string }) =>
      post<{ newBalance: number }>(`/platform/ai-usage/${id}/credits`, { amount, note }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['platform', 'ai-usage'] })
      setCreditsRow(null)
      setCreditsAmount(100)
      setCreditsNote('')
    },
  })

  const changePlan = useMutation({
    mutationFn: ({ id, plan }: { id: string; plan: Plan }) =>
      post<{ subscriptionPlan: Plan }>(`/platform/ai-usage/${id}/plan`, { plan }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['platform', 'ai-usage'] })
      setPlanRow(null)
    },
  })

  const rows = rowsQuery.data ?? []
  const kpis = kpisQuery.data

  return (
    <>
      <PageHeader
        title="AI-användning"
        description="Manuella anrop, kostnad och vinstmarginal per kund"
      />

      {/* KPI-rad */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Månadens MRR"
          value={kpis ? formatCurrency(kpis.mrrSek) : '—'}
          hint="Summa planavgifter (aktiva kunder)"
          icon={<Wallet className="text-blue-500" size={16} strokeWidth={1.8} />}
        />
        <KpiCard
          label="AI-kostnad"
          value={kpis ? formatCurrency(kpis.totalCostSek) : '—'}
          hint={kpis ? `≈ $${kpis.totalCostUsd.toFixed(2)} USD` : ''}
          icon={<CreditCard className="text-amber-500" size={16} strokeWidth={1.8} />}
        />
        <KpiCard
          label="Margin"
          value={kpis ? formatCurrency(kpis.marginSek) : '—'}
          hint="Intäkt − AI-kostnad"
          tone={kpis && kpis.marginSek < 0 ? 'danger' : 'success'}
          icon={<TrendingUp className="text-emerald-500" size={16} strokeWidth={1.8} />}
        />
        <KpiCard
          label="Över 80% av tak"
          value={kpis?.orgsOverEightyPct ?? '—'}
          hint="Kräver bevakning"
          {...(kpis && kpis.orgsOverEightyPct > 0 ? { tone: 'warning' as const } : {})}
          icon={<AlertTriangle className="text-amber-500" size={16} strokeWidth={1.8} />}
        />
      </div>

      {/* Plan-fördelning som mini-stat */}
      {kpis && (
        <Card className="mt-4 p-5">
          <div className="flex flex-wrap items-center gap-4 text-[13px]">
            <Users size={14} className="text-gray-400" />
            <span className="text-gray-500">Kunder per plan:</span>
            {(['TRIAL', 'STARTER', 'MINI', 'STANDARD', 'PLUS', 'PRO'] as Plan[]).map((p) => (
              <span key={p} className="inline-flex items-center gap-1">
                <PlanBadge plan={p} />
                <span className="font-medium text-gray-700">{kpis.perPlan[p] ?? 0}</span>
              </span>
            ))}
          </div>
        </Card>
      )}

      {/* Filterflikar */}
      <div className="mt-6 flex w-fit gap-1 rounded-xl bg-gray-100/70 p-1">
        {(
          [
            { id: 'all', label: 'Alla' },
            { id: 'over80', label: 'Över 80%' },
            { id: 'over100', label: 'Tak nått' },
            { id: 'trialEnding', label: 'Trial löper ut' },
            { id: 'highCost', label: 'Hög kostnad' },
          ] as { id: Filter; label: string }[]
        ).map((t) => (
          <button
            key={t.id}
            onClick={() => setFilter(t.id)}
            className={cn(
              'h-8 rounded-lg px-3 text-[13px] font-medium transition-all',
              filter === t.id
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tabell */}
      <Card className="mt-4 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-100 text-[12px] font-semibold uppercase tracking-wide text-gray-400">
              <th className="px-5 py-3 text-left">Kund</th>
              <th className="px-3 py-3 text-left">Plan</th>
              <th className="px-3 py-3 text-right">Anrop</th>
              <th className="px-3 py-3 text-left">% av tak</th>
              <th className="px-3 py-3 text-right">AI-kost</th>
              <th className="px-3 py-3 text-right">Margin</th>
              <th className="px-3 py-3 text-center">Status</th>
              <th className="px-5 py-3 text-right">Åtgärder</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !rowsQuery.isLoading ? (
              <tr>
                <td colSpan={8} className="px-5 py-10 text-center text-[13px] text-gray-500">
                  Inga kunder matchar filtret.
                </td>
              </tr>
            ) : null}
            {rows.map((row) => {
              const statusIcon =
                row.status === 'over' ? (
                  <AlertCircle size={14} className="text-red-500" />
                ) : row.status === 'warning' ? (
                  <AlertTriangle size={14} className="text-amber-500" />
                ) : (
                  <CheckCircle2 size={14} className="text-emerald-500" />
                )
              return (
                <tr
                  key={row.id}
                  className="border-b border-gray-100 last:border-0 hover:bg-gray-50/80"
                >
                  <td className="px-5 py-3">
                    <Link
                      to={`/organizations/${row.id}`}
                      className="font-medium text-gray-900 hover:text-blue-600"
                    >
                      {row.name}
                    </Link>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-gray-500">
                      <OrgStatusBadge status={row.orgStatus} />
                      {row.trialDaysLeft !== null && (
                        <span>{row.trialDaysLeft} dagar kvar i trial</span>
                      )}
                      {row.creditsBalance > 0 && (
                        <span className="text-emerald-600">+{row.creditsBalance} credits</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <PlanBadge plan={row.plan} />
                  </td>
                  <td className="px-3 py-3 text-right text-[13px] tabular-nums">
                    <span className="font-medium text-gray-900">
                      {row.manualCalls.toLocaleString('sv-SE')}
                    </span>
                    <span className="text-gray-400"> / {row.limit.toLocaleString('sv-SE')}</span>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-gray-100">
                        <div
                          className={cn(
                            'h-full rounded-full',
                            row.status === 'over'
                              ? 'bg-red-500'
                              : row.status === 'warning'
                                ? 'bg-amber-400'
                                : 'bg-blue-500',
                          )}
                          style={{ width: `${Math.min(100, row.percentage)}%` }}
                        />
                      </div>
                      <span className="text-[12px] tabular-nums text-gray-600">
                        {Math.round(row.percentage)}%
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right text-[13px] tabular-nums text-gray-700">
                    {formatCurrency(row.aiCostSek)}
                  </td>
                  <td
                    className={cn(
                      'px-3 py-3 text-right text-[13px] font-medium tabular-nums',
                      row.marginSek < 0 ? 'text-red-600' : 'text-emerald-700',
                    )}
                  >
                    {formatCurrency(row.marginSek)}
                  </td>
                  <td className="px-3 py-3 text-center">{statusIcon}</td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setCreditsRow(row)
                        }}
                      >
                        + Credits
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setPlanRow(row)
                          setNewPlan(row.plan)
                        }}
                      >
                        Byt plan
                      </Button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Card>

      {/* Lägg till credits-modal */}
      <Modal
        open={creditsRow !== null}
        onClose={() => setCreditsRow(null)}
        title={`Lägg till credits — ${creditsRow?.name ?? ''}`}
        size="md"
      >
        {creditsRow && (
          <div className="space-y-4 py-2">
            <p className="text-[13px] text-gray-500">
              Används när du markerat en credits-faktura som betald.
            </p>
            <div className="grid grid-cols-2 gap-3 rounded-xl bg-gray-50 p-3 text-[13px]">
              <div>
                <div className="text-gray-500">Nuvarande saldo</div>
                <div className="font-semibold text-gray-900">
                  {creditsRow.creditsBalance} credits
                </div>
              </div>
              <div>
                <div className="text-gray-500">Plan</div>
                <div>
                  <PlanBadge plan={creditsRow.plan} />
                </div>
              </div>
            </div>
            <div>
              <label className="mb-1 block text-[13px] font-medium text-gray-700">
                Antal credits att lägga till
              </label>
              <Input
                type="number"
                min={1}
                value={creditsAmount}
                onChange={(e) => setCreditsAmount(Number(e.target.value))}
              />
            </div>
            <div>
              <label className="mb-1 block text-[13px] font-medium text-gray-700">
                Notering (intern)
              </label>
              <Input
                value={creditsNote}
                onChange={(e) => setCreditsNote(e.target.value)}
                placeholder="t.ex. Faktura CR-202605-0001 betald"
              />
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-100 pt-4">
              <Button variant="secondary" size="sm" onClick={() => setCreditsRow(null)}>
                Avbryt
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={addCredits.isPending || creditsAmount <= 0}
                onClick={() =>
                  addCredits.mutate({
                    id: creditsRow.id,
                    amount: creditsAmount,
                    ...(creditsNote ? { note: creditsNote } : {}),
                  })
                }
              >
                Lägg till {creditsAmount} credits
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Byt plan-modal */}
      <Modal
        open={planRow !== null}
        onClose={() => setPlanRow(null)}
        title={`Byt plan — ${planRow?.name ?? ''}`}
        size="md"
      >
        {planRow && (
          <div className="space-y-4 py-2">
            <p className="text-[13px] text-gray-500">
              Planen byts omedelbart och en ny planStartedAt sätts.
            </p>
            <div className="rounded-xl bg-gray-50 p-3 text-[13px]">
              <div className="text-gray-500">Nuvarande plan</div>
              <div className="mt-1">
                <PlanBadge plan={planRow.plan} />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-[13px] font-medium text-gray-700">Ny plan</label>
              <Select value={newPlan} onChange={(e) => setNewPlan(e.target.value as Plan)}>
                <option value="TRIAL">Trial</option>
                <option value="STARTER">Starter — 390 kr/mån</option>
                <option value="MINI">Mini — 990 kr/mån</option>
                <option value="STANDARD">Standard — 2 490 kr/mån</option>
                <option value="PLUS">Plus — 4 990 kr/mån</option>
                <option value="PRO">Pro — 9 990 kr/mån</option>
              </Select>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-100 pt-4">
              <Button variant="secondary" size="sm" onClick={() => setPlanRow(null)}>
                Avbryt
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={changePlan.isPending}
                onClick={() => changePlan.mutate({ id: planRow.id, plan: newPlan })}
              >
                Byt till {newPlan}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <div className="mt-4 flex items-center gap-2 rounded-xl border border-blue-100 bg-blue-50/50 p-3 text-[12px] text-blue-800">
        <Mail size={13} strokeWidth={1.8} className="flex-shrink-0" />
        Påminnelsemejl skickas automatiskt vid 80%, 95% och 100% av tak. Trial-mejl skickas dag 14,
        25 och 29.
      </div>
    </>
  )
}
