import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  CreditCard,
  FileText,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Wallet,
} from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { KpiCard } from '@/components/ui/Kpi'
import { Input, Label, Select } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Badge } from '@/components/ui/Badge'
import { get, post, del } from '@/lib/api'
import { formatCurrency, formatDate } from '@/lib/format'
import { cn } from '@/lib/cn'

type InvoiceStatus = 'DRAFT' | 'SENT' | 'PENDING' | 'PAID' | 'OVERDUE' | 'VOID'
type InvoiceType = 'PLAN_FEE' | 'AI_CREDITS' | 'OTHER'
type PaymentMethod = 'BANKGIRO' | 'SWISH' | 'MANUAL'

interface Invoice {
  id: string
  invoiceNumber: string
  amountNetSek: number
  amountGrossSek: number
  vatRate: number
  status: InvoiceStatus
  type: InvoiceType
  description: string | null
  dueDate: string
  sentAt: string | null
  paidAt: string | null
  paymentMethod: string | null
  paymentReference: string | null
  planPeriodStart: string | null
  planPeriodEnd: string | null
  notes: string | null
  reminderCount: number
  lastReminderAt: string | null
  ocrNumber: string
  createdAt: string
  organization: { id: string; name: string; email: string; billingEmail: string | null }
}

interface Org {
  id: string
  name: string
}

interface Stats {
  invoicedThisMonthSek: number
  paidThisMonthSek: number
  outstandingSek: number
  overdueCount: number
  mrrSek: number
}

interface MonthlyPreview {
  period: { start: string; end: string; label: string }
  eligible: number
  alreadyInvoiced: number
  expectedNetTotal: number
  expectedGrossTotal: number
  autoSend: boolean
  orgs: {
    id: string
    name: string
    plan: string
    planMonthlyFee: number
    alreadyHasInvoice: boolean
  }[]
}

interface GenerationResult {
  created: number
  sent: number
  failed: number
  skipped: number
  failures: string[]
}

type TabFilter = 'all' | 'DRAFT' | 'SENT' | 'PAID' | 'OVERDUE'

const TABS: { id: TabFilter; label: string }[] = [
  { id: 'all', label: 'Alla' },
  { id: 'DRAFT', label: 'DRAFT' },
  { id: 'SENT', label: 'SENT' },
  { id: 'PAID', label: 'PAID' },
  { id: 'OVERDUE', label: 'OVERDUE' },
]

function StatusBadge({ status }: { status: InvoiceStatus }) {
  const tone =
    status === 'PAID'
      ? 'success'
      : status === 'OVERDUE'
        ? 'danger'
        : status === 'DRAFT'
          ? 'default'
          : status === 'VOID'
            ? 'ghost'
            : 'info'
  const label: Record<InvoiceStatus, string> = {
    DRAFT: 'Utkast',
    SENT: 'Skickad',
    PENDING: 'Skickad',
    PAID: 'Betald',
    OVERDUE: 'Förfallen',
    VOID: 'Makulerad',
  }
  return <Badge tone={tone}>{label[status]}</Badge>
}

function TypeBadge({ type }: { type: InvoiceType }) {
  const map: Record<InvoiceType, { label: string; tone: 'info' | 'default' | 'success' }> = {
    PLAN_FEE: { label: 'Plan', tone: 'info' },
    AI_CREDITS: { label: 'AI-credits', tone: 'success' },
    OTHER: { label: 'Övrigt', tone: 'default' },
  }
  return <Badge tone={map[type].tone}>{map[type].label}</Badge>
}

export function BillingPage() {
  const [tab, setTab] = useState<TabFilter>('all')
  const [createOpen, setCreateOpen] = useState(false)
  const [generateMode, setGenerateMode] = useState<'now' | 'backfill' | null>(null)
  const [failures, setFailures] = useState<string[] | null>(null)
  const [markPaidInvoice, setMarkPaidInvoice] = useState<Invoice | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Invoice | null>(null)
  const qc = useQueryClient()

  const handleGenerationResult = (r: GenerationResult) => {
    setGenerateMode(null)
    qc.invalidateQueries({ queryKey: ['platform', 'invoices'] })
    const summary = `${r.created} skapade, ${r.sent} skickade, ${r.skipped} hoppade över, ${r.failed} misslyckade`
    if (r.failed > 0 || r.failures.length > 0) {
      toast.error(`Fakturagenerering klar med fel: ${summary}`, {
        action: { label: 'Visa detaljer', onClick: () => setFailures(r.failures) },
      })
    } else {
      toast.success(`Fakturagenerering klar: ${summary}`)
    }
  }

  const params = useMemo(() => {
    const p: Record<string, string | number> = { pageSize: 200 }
    if (tab !== 'all') p.status = tab
    return p
  }, [tab])

  const { data, isLoading } = useQuery({
    queryKey: ['platform', 'invoices', params],
    queryFn: () => get<{ items: Invoice[] }>('/platform/invoices', params),
  })
  const stats = useQuery({
    queryKey: ['platform', 'invoices', 'stats'],
    queryFn: () => get<Stats>('/platform/invoices/stats'),
  })

  const sendInvoice = useMutation({
    mutationFn: (id: string) => post(`/platform/invoices/${id}/send`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform', 'invoices'] }),
  })
  const deleteInvoice = useMutation({
    mutationFn: (id: string) => del(`/platform/invoices/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platform', 'invoices'] })
      setConfirmDelete(null)
    },
  })

  const invoices = data?.items ?? []

  return (
    <>
      <PageHeader
        title="Plattformsfakturor"
        description="Fakturor som Eveno skickar till sina kunder"
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setGenerateMode('backfill')}>
              <CalendarClock size={14} /> Skapa missade fakturor
            </Button>
            <Button variant="secondary" onClick={() => setGenerateMode('now')}>
              <RefreshCw size={14} /> Generera fakturor nu
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus size={14} /> Skapa ny faktura
            </Button>
          </div>
        }
      />

      {/* KPI-rad */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <KpiCard
          label="Fakturerat (denna mån)"
          value={stats.data ? formatCurrency(stats.data.invoicedThisMonthSek) : '—'}
          icon={<FileText className="text-blue-500" size={16} strokeWidth={1.8} />}
        />
        <KpiCard
          label="Betalt (denna mån)"
          value={stats.data ? formatCurrency(stats.data.paidThisMonthSek) : '—'}
          icon={<CheckCircle2 className="text-emerald-500" size={16} strokeWidth={1.8} />}
        />
        <KpiCard
          label="Utestående"
          value={stats.data ? formatCurrency(stats.data.outstandingSek) : '—'}
          icon={<Wallet className="text-amber-500" size={16} strokeWidth={1.8} />}
        />
        <KpiCard
          label="Förfallna"
          value={stats.data?.overdueCount ?? '—'}
          {...(stats.data && stats.data.overdueCount > 0 ? { tone: 'danger' as const } : {})}
          icon={<AlertCircle className="text-red-500" size={16} strokeWidth={1.8} />}
        />
        <KpiCard
          label="MRR"
          value={stats.data ? formatCurrency(stats.data.mrrSek) : '—'}
          hint="Aktiva planavgifter"
          icon={<CreditCard className="text-blue-500" size={16} strokeWidth={1.8} />}
        />
      </div>

      {/* Filter-flikar */}
      <div className="mt-6 flex w-fit gap-1 rounded-xl bg-gray-100/70 p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'h-8 rounded-lg px-3 text-[13px] font-medium transition-all',
              tab === t.id
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
            <tr className="border-b border-[#EAEDF0]">
              <th className="px-5 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Nummer
              </th>
              <th className="px-3 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Kund
              </th>
              <th className="px-3 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Typ
              </th>
              <th className="px-3 py-3 text-right text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Belopp
              </th>
              <th className="px-3 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Skapad
              </th>
              <th className="px-3 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Förfaller
              </th>
              <th className="px-3 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Status
              </th>
              <th className="px-5 py-3 text-right text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Åtgärder
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={8} className="px-5 py-10 text-center text-[13px] text-gray-500">
                  Laddar…
                </td>
              </tr>
            )}
            {!isLoading && invoices.length === 0 && (
              <tr>
                <td colSpan={8} className="px-5 py-10 text-center text-[13px] text-gray-500">
                  Inga fakturor matchar filtret.
                </td>
              </tr>
            )}
            {invoices.map((i) => (
              <tr
                key={i.id}
                className="border-b border-[#EAEDF0] last:border-0 hover:bg-gray-50/80"
              >
                <td className="px-5 py-3 font-mono text-[13px]">{i.invoiceNumber}</td>
                <td className="px-3 py-3 text-[13.5px]">{i.organization.name}</td>
                <td className="px-3 py-3">
                  <TypeBadge type={i.type} />
                </td>
                <td className="px-3 py-3 text-right text-[13.5px] tabular-nums">
                  <div className="font-medium text-gray-900">
                    {formatCurrency(i.amountGrossSek)}
                  </div>
                  <div className="text-[11px] text-gray-500">
                    {formatCurrency(i.amountNetSek)} exkl moms
                  </div>
                </td>
                <td className="px-3 py-3 text-[12.5px] text-gray-600">{formatDate(i.createdAt)}</td>
                <td className="px-3 py-3 text-[12.5px] text-gray-600">{formatDate(i.dueDate)}</td>
                <td className="px-3 py-3">
                  <StatusBadge status={i.status} />
                  {i.reminderCount > 0 && (
                    <div className="mt-0.5 text-[11px] text-amber-600">
                      {i.reminderCount} påminnelser
                    </div>
                  )}
                </td>
                <td className="px-5 py-3">
                  <div className="flex flex-wrap justify-end gap-1.5">
                    <a
                      href={`/api/v1/platform/invoices/${i.id}/pdf`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Button size="sm" variant="ghost">
                        Visa PDF
                      </Button>
                    </a>
                    {(i.status === 'DRAFT' ||
                      i.status === 'SENT' ||
                      i.status === 'PENDING' ||
                      i.status === 'OVERDUE') && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => sendInvoice.mutate(i.id)}
                        loading={sendInvoice.isPending && sendInvoice.variables === i.id}
                      >
                        <Send size={12} />
                        {i.status === 'DRAFT' ? 'Skicka' : 'Skicka igen'}
                      </Button>
                    )}
                    {(i.status === 'SENT' || i.status === 'PENDING' || i.status === 'OVERDUE') && (
                      <Button size="sm" variant="primary" onClick={() => setMarkPaidInvoice(i)}>
                        Markera betald
                      </Button>
                    )}
                    {i.status === 'DRAFT' && (
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(i)}>
                        <Trash2 size={12} />
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <CreateInvoiceModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false)
          qc.invalidateQueries({ queryKey: ['platform', 'invoices'] })
        }}
      />

      <MarkPaidModal
        invoice={markPaidInvoice}
        onClose={() => setMarkPaidInvoice(null)}
        onDone={() => {
          setMarkPaidInvoice(null)
          qc.invalidateQueries({ queryKey: ['platform', 'invoices'] })
        }}
      />

      <Modal
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title="Radera utkast?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(null)}>
              Avbryt
            </Button>
            <Button
              onClick={() => confirmDelete && deleteInvoice.mutate(confirmDelete.id)}
              loading={deleteInvoice.isPending}
            >
              Radera
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-gray-700">
          Är du säker på att du vill radera faktura <strong>{confirmDelete?.invoiceNumber}</strong>?
        </p>
      </Modal>

      <GenerationModal
        mode={generateMode}
        onClose={() => setGenerateMode(null)}
        onDone={handleGenerationResult}
      />

      <Modal
        open={failures !== null}
        onClose={() => setFailures(null)}
        title="Fel vid fakturagenerering"
        size="lg"
      >
        <ul className="max-h-[50vh] space-y-1.5 overflow-y-auto text-[12.5px]">
          {failures?.map((f, i) => (
            <li key={i} className="rounded-lg bg-red-50 px-3 py-2 text-red-700">
              {f}
            </li>
          ))}
        </ul>
      </Modal>
    </>
  )
}

// ────────────────────────────────────────────────────────────────────────────

function CreateInvoiceModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: () => void
}) {
  const [form, setForm] = useState({
    organizationId: '',
    type: 'PLAN_FEE' as InvoiceType,
    amountNetSek: 0,
    description: '',
    dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    planPeriodStart: '',
    planPeriodEnd: '',
    notes: '',
  })
  const { data: orgs } = useQuery({
    queryKey: ['platform', 'organizations', 'minimal'],
    queryFn: () => get<{ items: Org[] }>('/platform/organizations', { pageSize: 500 }),
    enabled: open,
  })
  const mutation = useMutation({
    mutationFn: () =>
      post('/platform/invoices', {
        organizationId: form.organizationId,
        type: form.type,
        amountNetSek: Number(form.amountNetSek),
        dueDate: new Date(form.dueDate).toISOString(),
        ...(form.description ? { description: form.description } : {}),
        ...(form.type === 'PLAN_FEE' && form.planPeriodStart
          ? { planPeriodStart: new Date(form.planPeriodStart).toISOString() }
          : {}),
        ...(form.type === 'PLAN_FEE' && form.planPeriodEnd
          ? { planPeriodEnd: new Date(form.planPeriodEnd).toISOString() }
          : {}),
        ...(form.notes ? { notes: form.notes } : {}),
      }),
    onSuccess: onCreated,
  })

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Skapa ny plattformsfaktura"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Avbryt
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            loading={mutation.isPending}
            disabled={!form.organizationId || form.amountNetSek <= 0}
          >
            Skapa utkast
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <Label>Kund</Label>
          <Select
            value={form.organizationId}
            onChange={(e) => setForm((f) => ({ ...f, organizationId: e.target.value }))}
          >
            <option value="">Välj kund…</option>
            {orgs?.items.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Typ</Label>
          <Select
            value={form.type}
            onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as InvoiceType }))}
          >
            <option value="PLAN_FEE">Planavgift</option>
            <option value="AI_CREDITS">AI-credits</option>
            <option value="OTHER">Övrigt</option>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Belopp exkl moms (SEK)</Label>
            <Input
              type="number"
              step="0.01"
              value={form.amountNetSek}
              onChange={(e) => setForm((f) => ({ ...f, amountNetSek: Number(e.target.value) }))}
            />
          </div>
          <div>
            <Label>Förfaller</Label>
            <Input
              type="date"
              value={form.dueDate}
              onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))}
            />
          </div>
        </div>
        {form.type === 'PLAN_FEE' && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Period start</Label>
              <Input
                type="date"
                value={form.planPeriodStart}
                onChange={(e) => setForm((f) => ({ ...f, planPeriodStart: e.target.value }))}
              />
            </div>
            <div>
              <Label>Period slut</Label>
              <Input
                type="date"
                value={form.planPeriodEnd}
                onChange={(e) => setForm((f) => ({ ...f, planPeriodEnd: e.target.value }))}
              />
            </div>
          </div>
        )}
        <div>
          <Label>Beskrivning</Label>
          <Input
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            placeholder={
              form.type === 'PLAN_FEE'
                ? 'Eveno månadsavgift 2026-05'
                : form.type === 'AI_CREDITS'
                  ? '100 extra AI-credits'
                  : 'Konsultarvode'
            }
          />
        </div>
        <div>
          <Label>Interna anteckningar</Label>
          <Input
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            placeholder="Visas inte i PDF"
          />
        </div>
        {form.amountNetSek > 0 && (
          <div className="rounded-xl bg-gray-50 p-3 text-[12.5px] text-gray-700">
            Att betala (inkl 25% moms):{' '}
            <strong>{formatCurrency(Math.round(form.amountNetSek * 1.25 * 100) / 100)}</strong>
          </div>
        )}
      </div>
    </Modal>
  )
}

// ────────────────────────────────────────────────────────────────────────────

function MarkPaidModal({
  invoice,
  onClose,
  onDone,
}: {
  invoice: Invoice | null
  onClose: () => void
  onDone: () => void
}) {
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('BANKGIRO')
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10))
  const [paymentReference, setPaymentReference] = useState('')

  // Auto-fyll OCR vid byte av faktura
  if (invoice && !paymentReference) {
    setPaymentReference(invoice.ocrNumber)
  }

  const mutation = useMutation({
    mutationFn: () =>
      post(`/platform/invoices/${invoice!.id}/mark-paid`, {
        paymentMethod,
        paidAt: new Date(paidAt).toISOString(),
        ...(paymentReference ? { paymentReference } : {}),
      }),
    onSuccess: () => {
      setPaymentReference('')
      onDone()
    },
  })

  return (
    <Modal
      open={invoice !== null}
      onClose={onClose}
      title={`Markera ${invoice?.invoiceNumber ?? ''} som betald`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Avbryt
          </Button>
          <Button onClick={() => mutation.mutate()} loading={mutation.isPending}>
            Bekräfta betalning
          </Button>
        </>
      }
    >
      {invoice && (
        <div className="space-y-3">
          <div className="rounded-xl bg-gray-50 p-3 text-[13px]">
            <div className="flex justify-between">
              <span className="text-gray-500">Kund</span>
              <span className="font-medium">{invoice.organization.name}</span>
            </div>
            <div className="mt-1 flex justify-between">
              <span className="text-gray-500">Belopp</span>
              <span className="font-medium">{formatCurrency(invoice.amountGrossSek)}</span>
            </div>
            {invoice.type === 'AI_CREDITS' && (
              <div className="mt-2 rounded-lg bg-emerald-50 p-2 text-[12px] text-emerald-700">
                Credits läggs automatiskt till på kundens konto vid bekräftelse.
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Betalningsmetod</Label>
              <Select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
              >
                <option value="BANKGIRO">Bankgiro</option>
                <option value="SWISH">Swish</option>
                <option value="MANUAL">Manuell</option>
              </Select>
            </div>
            <div>
              <Label>Betaldatum</Label>
              <Input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
            </div>
          </div>
          <div>
            <Label>Betalreferens / OCR</Label>
            <Input
              value={paymentReference}
              onChange={(e) => setPaymentReference(e.target.value)}
              placeholder={invoice.ocrNumber}
            />
          </div>
        </div>
      )}
    </Modal>
  )
}

// ────────────────────────────────────────────────────────────────────────────

const MONTHS_SV = [
  'Januari',
  'Februari',
  'Mars',
  'April',
  'Maj',
  'Juni',
  'Juli',
  'Augusti',
  'September',
  'Oktober',
  'November',
  'December',
]

function GenerationModal({
  mode,
  onClose,
  onDone,
}: {
  mode: 'now' | 'backfill' | null
  onClose: () => void
  onDone: (r: GenerationResult) => void
}) {
  const open = mode !== null
  const now = new Date()
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const [year, setYear] = useState(prev.getFullYear())
  const [month, setMonth] = useState(prev.getMonth() + 1)

  const years: number[] = []
  for (let y = 2025; y <= now.getFullYear(); y += 1) years.push(y)

  const previewParams =
    mode === 'backfill' ? { year, month } : (undefined as Record<string, number> | undefined)

  const preview = useQuery({
    queryKey: [
      'platform',
      'invoices',
      'preview',
      mode,
      mode === 'backfill' ? year : null,
      mode === 'backfill' ? month : null,
    ],
    queryFn: () => get<MonthlyPreview>('/platform/invoices/cron/monthly/preview', previewParams),
    enabled: open,
  })

  const mutation = useMutation({
    mutationFn: () =>
      mode === 'backfill'
        ? post<GenerationResult>('/platform/invoices/cron/monthly/backfill', { year, month })
        : post<GenerationResult>('/platform/invoices/cron/monthly', {}),
    onSuccess: (r) => onDone(r),
  })

  const p = preview.data

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === 'backfill' ? 'Skapa missade fakturor' : 'Generera plattformsfakturor'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Avbryt
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            loading={mutation.isPending}
            disabled={preview.isLoading || !!preview.error}
          >
            {mode === 'backfill' ? 'Skapa fakturor' : 'Generera och skicka'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {mode === 'backfill' ? (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Månad</Label>
              <Select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
                {MONTHS_SV.map((m, i) => (
                  <option key={m} value={i + 1}>
                    {m}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label>År</Label>
              <Select value={year} onChange={(e) => setYear(Number(e.target.value))}>
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        ) : (
          <p className="text-[13px] leading-relaxed text-gray-700">
            Detta skapar och skickar fakturor för föregående månad
            {p ? ` (${p.period.label})` : ''} till alla aktiva organisationer med en betald plan.
            Organisationer med status ACTIVE och planMonthlyFee &gt; 0 påverkas. Fakturor som redan
            finns för perioden hoppas över (idempotent). Körs annars automatiskt den 1:a varje månad
            kl 08:00.
          </p>
        )}

        {preview.isLoading && (
          <div className="rounded-xl bg-gray-50 p-4 text-center text-[13px] text-gray-500">
            Beräknar…
          </div>
        )}
        {preview.error && (
          <div className="rounded-xl bg-red-50 p-3 text-[12.5px] text-red-700">
            Kunde inte hämta förhandsvisning. Kontrollera att perioden ligger i det förflutna.
          </div>
        )}

        {p && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-xl bg-gray-50 p-3">
                <div className="text-[11px] uppercase tracking-wide text-gray-400">Period</div>
                <div className="mt-1 text-[13.5px] font-medium text-gray-900">{p.period.label}</div>
              </div>
              <div className="rounded-xl bg-gray-50 p-3">
                <div className="text-[11px] uppercase tracking-wide text-gray-400">
                  Antal fakturor
                </div>
                <div className="mt-1 text-[13.5px] font-medium text-gray-900">
                  {p.eligible} (
                  {p.eligible === 1 ? '1 organisation' : `${p.eligible} organisationer`})
                </div>
              </div>
              <div className="rounded-xl bg-gray-50 p-3">
                <div className="text-[11px] uppercase tracking-wide text-gray-400">
                  Belopp inkl moms
                </div>
                <div className="mt-1 text-[13.5px] font-medium text-gray-900">
                  {formatCurrency(p.expectedGrossTotal)}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 text-[12.5px]">
              <span className="text-gray-500">Auto-utskick:</span>
              <Badge tone={p.autoSend ? 'success' : 'default'}>
                {p.autoSend ? 'PÅ – skickas direkt' : 'AV – skapas som utkast'}
              </Badge>
            </div>

            {p.alreadyInvoiced > 0 && (
              <div className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-[12.5px] text-amber-700">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                <span>
                  OBS: {p.alreadyInvoiced} organisation(er) har redan en faktura för denna period
                  och kommer hoppas över.
                </span>
              </div>
            )}

            {p.orgs.length > 0 && (
              <div className="max-h-[28vh] overflow-y-auto rounded-xl border border-[#EAEDF0]">
                <table className="w-full">
                  <tbody>
                    {p.orgs.map((o) => (
                      <tr key={o.id} className="border-b border-[#EAEDF0] last:border-0">
                        <td className="px-3 py-2 text-[13px]">{o.name}</td>
                        <td className="px-3 py-2 text-[12px] text-gray-500">{o.plan}</td>
                        <td className="px-3 py-2 text-right text-[13px] tabular-nums">
                          {formatCurrency(o.planMonthlyFee)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {o.alreadyHasInvoice ? (
                            <Badge tone="default">Finns redan</Badge>
                          ) : (
                            <Badge tone="info">Faktureras</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
