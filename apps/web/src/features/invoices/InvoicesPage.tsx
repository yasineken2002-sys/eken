import { useState, useEffect, useMemo } from 'react'
import { motion } from 'framer-motion'
import {
  Plus,
  Search,
  History,
  Pencil,
  Trash2,
  Send,
  CircleDollarSign,
  XCircle,
  Download,
  Mail,
  Zap,
  Sparkles,
  MoreHorizontal,
  ArrowUpRight,
  FileDown,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Input, Select } from '@/components/ui/Input'
import { InvoiceStatusBadge } from '@/components/ui/Badge'
import { InvoiceTimeline } from './components/InvoiceTimeline'
import { InvoiceForm } from './components/InvoiceForm'
import { BulkInvoiceModal } from './components/BulkInvoiceModal'
import {
  useInvoices,
  useInvoiceEvents,
  useCreateInvoice,
  useUpdateInvoice,
  useDeleteInvoice,
  useTransitionStatus,
  useSendInvoiceEmail,
} from './hooks/useInvoiceQueries'
import { formatCurrency, formatDate } from '@eken/shared'
import type { Invoice, InvoiceStatus, CreateInvoiceInput, Tenant } from '@eken/shared'
import { downloadInvoicePdf } from './api/invoices.api'
import { useTenants } from '@/features/tenants/hooks/useTenants'
import { useFocusStore } from '@/stores/focus.store'
import { useCanWrite } from '@/hooks/useCanWrite'
import { cn } from '@/lib/cn'

type DetailTab = 'detaljer' | 'historik'
type Tab = 'ALL' | 'DRAFT' | 'SENT' | 'PAID' | 'OVERDUE'

const TABS: { id: Tab; label: string; dangerAccent?: boolean }[] = [
  { id: 'ALL', label: 'Alla' },
  { id: 'DRAFT', label: 'Utkast' },
  { id: 'SENT', label: 'Skickade' },
  { id: 'PAID', label: 'Betalda' },
  { id: 'OVERDUE', label: 'Förfallna', dangerAccent: true },
]

const BADGE_TONE: Record<InvoiceStatus, 'red' | 'yellow' | 'blue' | 'green' | 'gray'> = {
  DRAFT: 'gray',
  SENT: 'blue',
  PAID: 'green',
  OVERDUE: 'red',
  PARTIAL: 'yellow',
  VOID: 'gray',
  SENT_TO_COLLECTION: 'red',
}

function statusLabel(invoice: Invoice): string {
  switch (invoice.status) {
    case 'DRAFT':
      return 'Utkast'
    case 'SENT':
      return 'Skickad'
    case 'PAID':
      return 'Betald'
    case 'OVERDUE': {
      const days = Math.max(
        0,
        Math.floor((Date.now() - new Date(invoice.dueDate).getTime()) / 86_400_000),
      )
      return `Förfallen · ${days} ${days === 1 ? 'dag' : 'dagar'}`
    }
    case 'PARTIAL':
      return 'Delvis betald'
    case 'VOID':
      return 'Makulerad'
    case 'SENT_TO_COLLECTION':
      return 'Hos inkasso'
    default:
      return invoice.status
  }
}

function accentForInvoice(invoice: Invoice): 'red' | 'yellow' | 'none' {
  if (invoice.status !== 'OVERDUE' && invoice.status !== 'SENT_TO_COLLECTION') return 'none'
  const days = Math.floor((Date.now() - new Date(invoice.dueDate).getTime()) / 86_400_000)
  if (days >= 7) return 'red'
  return 'yellow'
}

function dueText(invoice: Invoice): string {
  if (invoice.status === 'PAID' && invoice.paidAt) return `Betald ${formatDate(invoice.paidAt)}`
  if (invoice.status === 'DRAFT') return 'Ej skickad'
  if (invoice.status === 'OVERDUE' || invoice.status === 'SENT_TO_COLLECTION') {
    return `Förföll ${formatDate(invoice.dueDate)}`
  }
  return `Förfaller ${formatDate(invoice.dueDate)}`
}

function getTenantName(id: string | undefined, tenants: Tenant[]) {
  if (!id) return '–'
  const t = tenants.find((t) => t.id === id)
  if (!t) return '–'
  return t.type === 'INDIVIDUAL' ? `${t.firstName} ${t.lastName}` : (t.companyName ?? '–')
}

// ─── Betalningsformulär ─────────────────────────────────────────────────────

interface PaymentFormState {
  amount: string
  paymentMethod: string
  reference: string
}

function PaymentSubForm({
  invoice,
  onConfirm,
  onCancel,
  isSubmitting,
}: {
  invoice: Invoice
  onConfirm: (data: PaymentFormState) => void
  onCancel: () => void
  isSubmitting: boolean
}) {
  const [form, setForm] = useState<PaymentFormState>({
    amount: String(Number(invoice.total)),
    paymentMethod: 'Bankgiro',
    reference: invoice.reference ?? '',
  })

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Belopp (kr)"
          type="number"
          step="0.01"
          value={form.amount}
          onChange={(e) => setForm((p) => ({ ...p, amount: e.target.value }))}
        />
        <Select
          label="Betalningssätt"
          value={form.paymentMethod}
          onChange={(e) => setForm((p) => ({ ...p, paymentMethod: e.target.value }))}
          options={[
            { value: 'Bankgiro', label: 'Bankgiro' },
            { value: 'Plusgiro', label: 'Plusgiro' },
            { value: 'Swish', label: 'Swish' },
            { value: 'Kontant', label: 'Kontant' },
            { value: 'Autogiro', label: 'Autogiro' },
          ]}
        />
        <div className="col-span-2">
          <Input
            label="OCR / referens"
            placeholder="Referensnummer"
            value={form.reference}
            onChange={(e) => setForm((p) => ({ ...p, reference: e.target.value }))}
          />
        </div>
      </div>
      <ModalFooter>
        <Button type="button" onClick={onCancel} disabled={isSubmitting}>
          Avbryt
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={isSubmitting}
          onClick={() => onConfirm(form)}
        >
          {isSubmitting ? 'Registrerar…' : 'Registrera betalning'}
        </Button>
      </ModalFooter>
    </div>
  )
}

// ─── Huvud-komponent ──────────────────────────────────────────────────────────

export function InvoicesPage() {
  const canWrite = useCanWrite()
  const [tab, setTab] = useState<Tab>('ALL')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Invoice | null>(null)
  const [detailTab, setDetailTab] = useState<DetailTab>('detaljer')
  const [showCreate, setShowCreate] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [showPayment, setShowPayment] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [emailSentTo, setEmailSentTo] = useState<string | null>(null)
  const [showBulk, setShowBulk] = useState(false)

  // ── Data ──────────────────────────────────────────────────────────────────
  const { data: invoices = [], isLoading } = useInvoices(
    tab === 'ALL' ? undefined : { status: tab as InvoiceStatus },
  )
  const { data: selectedEvents = [] } = useInvoiceEvents(selected?.id ?? '')
  const { data: tenants = [] } = useTenants()
  const { data: allInvoices = [] } = useInvoices()

  // ── Mutations ─────────────────────────────────────────────────────────────
  const createMutation = useCreateInvoice()
  const updateMutation = useUpdateInvoice()
  const deleteMutation = useDeleteInvoice()
  const statusMutation = useTransitionStatus()
  const sendEmailMutation = useSendInvoiceEmail()

  // ── KPI:er ────────────────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    const billedThisMonth = allInvoices
      .filter((i) => {
        const d = new Date(i.issueDate)
        const now = new Date()
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
      })
      .reduce((s, i) => s + Number(i.total), 0)
    const overdueSum = allInvoices
      .filter((i) => i.status === 'OVERDUE' || i.status === 'SENT_TO_COLLECTION')
      .reduce((s, i) => s + Number(i.total), 0)
    const overdueCount = allInvoices.filter(
      (i) => i.status === 'OVERDUE' || i.status === 'SENT_TO_COLLECTION',
    ).length
    const draftCount = allInvoices.filter((i) => i.status === 'DRAFT').length
    const sentCount = allInvoices.filter((i) => i.status === 'SENT').length
    // MRR — estimate from active RENT invoices in the last 90 days
    const ninetyDaysAgo = Date.now() - 90 * 86_400_000
    const recentRent = allInvoices.filter(
      (i) => i.type === 'RENT' && new Date(i.issueDate).getTime() >= ninetyDaysAgo,
    )
    const mrr = recentRent.length > 0 ? recentRent.reduce((s, i) => s + Number(i.total), 0) / 3 : 0
    return {
      billedThisMonth,
      overdueSum,
      overdueCount,
      total: allInvoices.length,
      draftCount,
      sentCount,
      mrr,
    }
  }, [allInvoices])

  // ── Filtrering ────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    if (!search.trim()) return invoices
    const q = search.toLowerCase()
    return invoices.filter((i) => {
      const tenant = getTenantName(i.tenantId, tenants).toLowerCase()
      return i.invoiceNumber.toLowerCase().includes(q) || tenant.includes(q)
    })
  }, [invoices, search, tenants])

  function handleSelectInvoice(invoice: Invoice) {
    setSelected(invoice)
    setDetailTab('detaljer')
  }

  // Deep-link från notifikationer
  const focusTarget = useFocusStore((s) => s.target)
  const clearFocus = useFocusStore((s) => s.clear)
  useEffect(() => {
    if (focusTarget?.type !== 'INVOICE') return
    const match = allInvoices.find((i) => i.id === focusTarget.id)
    if (match) {
      handleSelectInvoice(match)
      clearFocus()
    }
  }, [focusTarget, allInvoices, clearFocus])

  function handleCreate(data: CreateInvoiceInput) {
    createMutation.mutate(data, { onSuccess: () => setShowCreate(false) })
  }
  function handleEdit(data: CreateInvoiceInput) {
    if (!selected) return
    updateMutation.mutate(
      { id: selected.id, ...data },
      {
        onSuccess: (updated) => {
          setSelected(updated)
          setShowEdit(false)
        },
      },
    )
  }
  function handleDelete() {
    if (!selected) return
    deleteMutation.mutate(selected.id, {
      onSuccess: () => {
        setSelected(null)
        setShowDeleteConfirm(false)
      },
    })
  }
  function handleSend() {
    if (!selected) return
    statusMutation.mutate(
      { id: selected.id, status: 'SENT' },
      { onSuccess: (updated) => setSelected(updated) },
    )
  }
  function handlePayment(form: PaymentFormState) {
    if (!selected) return
    statusMutation.mutate(
      {
        id: selected.id,
        status: 'PAID',
        payload: {
          amount: Number(form.amount),
          paymentMethod: form.paymentMethod,
          reference: form.reference,
        },
      },
      {
        onSuccess: (updated) => {
          setSelected(updated)
          setShowPayment(false)
        },
      },
    )
  }
  function handleVoid() {
    if (!selected) return
    statusMutation.mutate(
      { id: selected.id, status: 'VOID' },
      { onSuccess: (updated) => setSelected(updated) },
    )
  }

  const tabCounts = {
    ALL: allInvoices.length,
    SENT: kpis.sentCount,
    PAID: allInvoices.filter((i) => i.status === 'PAID').length,
    OVERDUE: kpis.overdueCount,
    DRAFT: kpis.draftCount,
  }

  return (
    <motion.div
      key="invoices"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.18 }}
      className="ev-fakt-root mx-auto max-w-[1280px] px-7 py-7"
    >
      {/* Page header */}
      <div className="flex items-end justify-between gap-4 pb-1">
        <div>
          <h1
            className="m-0 text-[28px] font-medium leading-[1.15] tracking-[-0.025em]"
            style={{ color: 'var(--ev-color-fg-1)' }}
          >
            Fakturor
          </h1>
          <p className="mt-1 text-[14px]" style={{ color: 'var(--ev-color-fg-2)' }}>
            {kpis.total} fakturor totalt · {kpis.draftCount} utkast · {kpis.sentCount} skickade
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="ev-fakt-search hidden md:block">
            <Search size={14} strokeWidth={1.8} />
            <input
              placeholder="Sök fakturanr eller hyresgäst"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {canWrite && (
            <>
              <button className="ev-fakt-btn-secondary" onClick={() => setShowBulk(true)}>
                <Zap size={13} strokeWidth={2.2} />
                Bulk
              </button>
              <button className="ev-fakt-btn-primary" onClick={() => setShowCreate(true)}>
                <Plus size={14} strokeWidth={2.2} />
                Ny faktura
              </button>
            </>
          )}
        </div>
      </div>

      {/* KPI row */}
      <div className="mt-6 grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        <div className="ev-fakt-kpi">
          <div className="ev-fakt-kpi-label">Fakturerat · denna månad</div>
          <div className="ev-fakt-kpi-value">{formatCurrency(kpis.billedThisMonth)}</div>
          <div className="ev-fakt-kpi-foot">
            <span style={{ color: 'var(--ev-color-fg-3)' }}>
              {
                allInvoices.filter((i) => {
                  const d = new Date(i.issueDate)
                  const now = new Date()
                  return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
                }).length
              }{' '}
              fakturor utfärdade
            </span>
          </div>
        </div>
        <div className={cn('ev-fakt-kpi', kpis.overdueSum > 0 && 'alert')}>
          <div className="ev-fakt-kpi-label">Utestående</div>
          <div className={cn('ev-fakt-kpi-value', kpis.overdueSum > 0 && 'danger')}>
            {formatCurrency(kpis.overdueSum)}
          </div>
          <div className="ev-fakt-kpi-foot">
            {kpis.overdueCount > 0
              ? `${kpis.overdueCount} ${kpis.overdueCount === 1 ? 'faktura' : 'fakturor'} över förfallodatum`
              : 'Inga förfallna fakturor'}
          </div>
        </div>
        <div className="ev-fakt-kpi">
          <div className="ev-fakt-kpi-label">Antal fakturor</div>
          <div className="ev-fakt-kpi-value">{kpis.total}</div>
          <div className="ev-fakt-kpi-foot">
            <span style={{ color: 'var(--ev-color-fg-3)' }}>
              {kpis.draftCount} utkast · {kpis.sentCount} skickade
            </span>
          </div>
        </div>
        <div className="ev-fakt-kpi">
          <div className="ev-fakt-kpi-label">MRR</div>
          <div className="ev-fakt-kpi-value">{formatCurrency(kpis.mrr)}</div>
          <div className="ev-fakt-kpi-foot">
            <span style={{ color: 'var(--ev-color-fg-3)' }}>Snitt över senaste 3 mån</span>
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <div className="ev-fakt-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'ev-fakt-tab',
                tab === t.id && 'active',
                t.dangerAccent && 'danger-accent',
              )}
            >
              {t.label}
              <span className="ev-fakt-tab-count">({tabCounts[t.id]})</span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="ev-fakt-search md:hidden">
            <Search size={14} strokeWidth={1.8} />
            <input placeholder="Sök" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <button className="ev-fakt-btn-secondary">
            <FileDown size={13} strokeWidth={1.8} />
            Exportera
          </button>
        </div>
      </div>

      {/* Invoice table */}
      <div className="ev-fakt-table mt-4">
        <div className="ev-thead">
          <div />
          <div>Fakturanr · Hyresgäst</div>
          <div>Typ</div>
          <div>Belopp</div>
          <div>Förfaller</div>
          <div>Status</div>
          <div />
        </div>

        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="ev-trow" style={{ cursor: 'default' }}>
              <div className="ev-accent none" />
              <div className="h-4 w-3/4 animate-pulse rounded bg-[var(--ev-color-subtle)]" />
              <div className="h-4 w-1/2 animate-pulse rounded bg-[var(--ev-color-subtle)]" />
              <div className="h-4 w-1/2 animate-pulse rounded bg-[var(--ev-color-subtle)]" />
              <div className="h-4 w-2/3 animate-pulse rounded bg-[var(--ev-color-subtle)]" />
              <div className="h-4 w-1/2 animate-pulse rounded bg-[var(--ev-color-subtle)]" />
              <div />
            </div>
          ))
        ) : filtered.length === 0 ? (
          <div
            className="px-8 py-12 text-center text-[13.5px]"
            style={{ color: 'var(--ev-color-fg-3)' }}
          >
            {search.trim() ? 'Inga fakturor matchar sökningen' : 'Inga fakturor ännu'}
          </div>
        ) : (
          filtered.map((inv) => {
            const accent = accentForInvoice(inv)
            const dim = inv.status === 'PAID' || inv.status === 'DRAFT'
            const tenantName = getTenantName(inv.tenantId, tenants)
            const tone = BADGE_TONE[inv.status]
            const muted = inv.status === 'DRAFT'
            const typeLabel =
              inv.type === 'RENT'
                ? 'Hyra'
                : inv.type === 'DEPOSIT'
                  ? 'Deposition'
                  : inv.type === 'SERVICE'
                    ? 'Tjänst'
                    : inv.type === 'UTILITY'
                      ? 'Drift'
                      : inv.type
            return (
              <div
                key={inv.id}
                className={cn('ev-trow', dim && 'muted')}
                onClick={() => handleSelectInvoice(inv)}
              >
                <div className={cn('ev-accent', accent)} />
                <div className="min-w-0">
                  <div className="ev-fakt-cell-num">{inv.invoiceNumber}</div>
                  <div className={cn('ev-fakt-cell-name truncate', muted && 'muted')}>
                    {tenantName}
                  </div>
                </div>
                <div className="truncate text-[13px]" style={{ color: 'var(--ev-color-fg-2)' }}>
                  {typeLabel}
                </div>
                <div className={cn('ev-fakt-cell-amt', muted && 'muted')}>
                  {formatCurrency(Number(inv.total))}
                </div>
                <div className="ev-fakt-cell-due">{dueText(inv)}</div>
                <div>
                  <span className={cn('ev-fakt-badge', tone)}>
                    <span className="ev-fakt-badge-dot" />
                    {statusLabel(inv)}
                  </span>
                </div>
                <div className="flex justify-end">
                  <button
                    aria-label="Mer"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleSelectInvoice(inv)
                    }}
                    className="flex h-7 w-7 items-center justify-center rounded-md"
                    style={{ color: 'var(--ev-color-fg-3)' }}
                  >
                    <MoreHorizontal size={14} strokeWidth={2} />
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* AI tip card (only if overdue invoices) */}
      {kpis.overdueCount > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="ev-fakt-ai-tip mt-4"
        >
          <div className="ev-fakt-ai-tip-icon">
            <Sparkles size={18} strokeWidth={1.8} style={{ color: '#fff' }} />
          </div>
          <div className="ev-fakt-ai-tip-text">
            <div className="ev-fakt-ai-tip-tag">AI · förslag</div>
            <div className="ev-fakt-ai-tip-msg">
              Vill du skicka påminnelser till alla {kpis.overdueCount} förfallna fakturor på en
              gång? Total utestående: {formatCurrency(kpis.overdueSum)}.
            </div>
          </div>
          <div className="ev-fakt-ai-tip-actions">
            <button className="ev-fakt-ai-tip-btn-ghost" onClick={() => setTab('OVERDUE')}>
              Granska först
            </button>
            <button className="ev-fakt-ai-tip-btn-primary" onClick={() => setTab('OVERDUE')}>
              Ja, gör det
              <ArrowUpRight size={13} strokeWidth={2} className="ml-1 inline-block" />
            </button>
          </div>
        </motion.div>
      )}

      {/* ─── Detail modal ─── */}
      {selected && (
        <Modal
          open
          onClose={() => setSelected(null)}
          title={selected.invoiceNumber}
          description={getTenantName(selected.tenantId, tenants)}
          size="lg"
        >
          <div className="mb-5 flex w-fit items-center gap-1 rounded-xl bg-gray-100/70 p-1">
            {(['detaljer', 'historik'] as DetailTab[]).map((t) => (
              <button
                key={t}
                onClick={() => setDetailTab(t)}
                className={cn(
                  'flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium capitalize transition-all',
                  detailTab === t
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700',
                )}
              >
                {t === 'historik' && <History size={12} strokeWidth={2} />}
                {t.charAt(0).toUpperCase() + t.slice(1)}
                {t === 'historik' && (
                  <span className="text-[11px] font-semibold text-gray-400">
                    {selectedEvents.length}
                  </span>
                )}
              </button>
            ))}
          </div>

          {detailTab === 'detaljer' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: 'Hyresgäst', value: getTenantName(selected.tenantId, tenants) },
                  { label: 'Status', value: <InvoiceStatusBadge status={selected.status} /> },
                  { label: 'Utfärdat', value: formatDate(selected.issueDate) },
                  { label: 'Förfaller', value: formatDate(selected.dueDate) },
                ].map((i) => (
                  <div key={i.label} className="rounded-xl bg-gray-50 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                      {i.label}
                    </p>
                    <div className="mt-0.5 text-[13px] font-medium text-gray-800">{i.value}</div>
                  </div>
                ))}
              </div>

              <div className="overflow-hidden rounded-xl border border-gray-100">
                <div className="border-b border-gray-100 bg-gray-50 px-4 py-2.5">
                  <p className="text-[12px] font-semibold text-gray-500">Fakturarader</p>
                </div>
                {selected.lines.map((line) => (
                  <div
                    key={line.id}
                    className="flex items-center justify-between border-b border-gray-100 px-4 py-3 last:border-0"
                  >
                    <div>
                      <p className="text-[13px] text-gray-800">{line.description}</p>
                      <p className="text-[12px] text-gray-400">
                        {Number(line.quantity)} × {formatCurrency(Number(line.unitPrice))} · Moms{' '}
                        {line.vatRate}%
                      </p>
                    </div>
                    <p className="text-[14px] font-semibold text-gray-800">
                      {formatCurrency(Number(line.total))}
                    </p>
                  </div>
                ))}
                <div className="flex justify-between bg-gray-50 px-4 py-3">
                  <p className="text-[13px] font-semibold text-gray-700">Totalt inkl moms</p>
                  <p className="text-[16px] font-bold text-gray-900">
                    {formatCurrency(Number(selected.total))}
                  </p>
                </div>
              </div>

              {selected.paidAt && (
                <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-3">
                  <p className="text-[12px] font-semibold text-emerald-700">
                    Betald {formatDate(selected.paidAt)}
                  </p>
                  {selected.bankTransactions && selected.bankTransactions.length > 0 && (
                    <div className="mt-2 space-y-1.5 border-t border-emerald-200/60 pt-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700/70">
                        Kopplad banktransaktion
                      </p>
                      {selected.bankTransactions.map((bt) => (
                        <div
                          key={bt.id}
                          className="flex items-center justify-between text-[12.5px] text-emerald-800"
                        >
                          <span className="truncate" title={bt.description}>
                            {formatDate(bt.date)} · {bt.description}
                          </span>
                          <span className="font-semibold">{formatCurrency(Number(bt.amount))}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-4">
                {selected.status === 'DRAFT' && (
                  <>
                    <Button size="sm" onClick={() => setShowEdit(true)}>
                      <Pencil size={13} strokeWidth={1.8} />
                      Redigera
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={statusMutation.isPending}
                      onClick={handleSend}
                    >
                      <Send size={13} strokeWidth={1.8} />
                      Skicka faktura
                    </Button>
                    <Button
                      size="sm"
                      className="ml-auto border-red-200 text-red-600 hover:border-red-300 hover:bg-red-50"
                      disabled={deleteMutation.isPending}
                      onClick={() => setShowDeleteConfirm(true)}
                    >
                      <Trash2 size={13} strokeWidth={1.8} />
                      Ta bort
                    </Button>
                  </>
                )}

                {(selected.status === 'SENT' || selected.status === 'OVERDUE') && (
                  <>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={statusMutation.isPending}
                      onClick={() => setShowPayment(true)}
                    >
                      <CircleDollarSign size={13} strokeWidth={1.8} />
                      Registrera betalning
                    </Button>
                    <Button
                      size="sm"
                      className="ml-auto border-red-200 text-red-600 hover:border-red-300 hover:bg-red-50"
                      disabled={statusMutation.isPending}
                      onClick={handleVoid}
                    >
                      <XCircle size={13} strokeWidth={1.8} />
                      Makulera
                    </Button>
                  </>
                )}

                <Button size="sm" onClick={() => downloadInvoicePdf(selected.id)}>
                  <Download size={13} strokeWidth={1.8} />
                  Ladda ner PDF
                </Button>

                {(selected.status === 'DRAFT' || selected.status === 'SENT') && (
                  <Button
                    size="sm"
                    loading={sendEmailMutation.isPending}
                    onClick={() => {
                      const tenantEmail = tenants.find((t) => t.id === selected.tenantId)?.email
                      sendEmailMutation.mutate(selected.id, {
                        onSuccess: () => {
                          const to = tenantEmail ?? 'hyresgästen'
                          setEmailSentTo(to)
                          setTimeout(() => setEmailSentTo(null), 4000)
                        },
                      })
                    }}
                  >
                    <Mail size={13} strokeWidth={1.8} />
                    Skicka via e-post
                  </Button>
                )}

                {emailSentTo && (
                  <span className="text-[12px] font-medium text-emerald-600">
                    E-post skickad till {emailSentTo}
                  </span>
                )}
              </div>
            </div>
          )}

          {detailTab === 'historik' && <InvoiceTimeline events={selectedEvents} />}
        </Modal>
      )}

      {/* Create / Edit / Payment / Delete / Bulk modals (unchanged) */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Ny faktura" size="full">
        <InvoiceForm
          onSubmit={handleCreate}
          onCancel={() => setShowCreate(false)}
          isSubmitting={createMutation.isPending}
        />
      </Modal>

      {selected && (
        <Modal
          open={showEdit}
          onClose={() => setShowEdit(false)}
          title="Redigera faktura"
          size="full"
        >
          <InvoiceForm
            defaultValues={{
              type: selected.type as CreateInvoiceInput['type'],
              ...(selected.leaseId ? { leaseId: selected.leaseId } : {}),
              dueDate: new Date(selected.dueDate).toISOString().split('T')[0] ?? '',
              issueDate: new Date(selected.issueDate).toISOString().split('T')[0] ?? '',
              notes: selected.notes ?? undefined,
              lines: selected.lines.map((l) => ({
                description: l.description,
                quantity: Number(l.quantity),
                unitPrice: Number(l.unitPrice),
                vatRate: l.vatRate as 0 | 6 | 12 | 25,
              })),
            }}
            onSubmit={handleEdit}
            onCancel={() => setShowEdit(false)}
            isSubmitting={updateMutation.isPending}
            submitLabel="Spara ändringar"
          />
        </Modal>
      )}

      {selected && (
        <Modal
          open={showPayment}
          onClose={() => setShowPayment(false)}
          title="Registrera betalning"
          description={`${selected.invoiceNumber} · ${formatCurrency(Number(selected.total))}`}
        >
          <PaymentSubForm
            invoice={selected}
            onConfirm={handlePayment}
            onCancel={() => setShowPayment(false)}
            isSubmitting={statusMutation.isPending}
          />
        </Modal>
      )}

      {selected && (
        <Modal
          open={showDeleteConfirm}
          onClose={() => setShowDeleteConfirm(false)}
          title="Ta bort faktura"
          description={`Vill du permanent ta bort ${selected.invoiceNumber}? Åtgärden kan inte ångras.`}
        >
          <ModalFooter>
            <Button onClick={() => setShowDeleteConfirm(false)}>Avbryt</Button>
            <Button
              variant="primary"
              className="bg-red-600 hover:bg-red-700"
              disabled={deleteMutation.isPending}
              onClick={handleDelete}
            >
              {deleteMutation.isPending ? 'Tar bort…' : 'Ta bort faktura'}
            </Button>
          </ModalFooter>
        </Modal>
      )}

      <BulkInvoiceModal open={showBulk} onClose={() => setShowBulk(false)} />
    </motion.div>
  )
}
