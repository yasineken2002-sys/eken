import { useState } from 'react'
import { motion } from 'framer-motion'
import {
  Plus,
  Filter,
  History,
  Pencil,
  Trash2,
  Send,
  CircleDollarSign,
  XCircle,
  Download,
  Mail,
  Zap,
} from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Input, Select } from '@/components/ui/Input'
import { DataTable } from '@/components/ui/DataTable'
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
import { cn } from '@/lib/cn'

type DetailTab = 'detaljer' | 'historik'

type Tab = 'ALL' | 'DRAFT' | 'SENT' | 'PAID' | 'OVERDUE'
const TABS: { id: Tab; label: string; color?: string }[] = [
  { id: 'ALL', label: 'Alla' },
  { id: 'SENT', label: 'Skickade' },
  { id: 'PAID', label: 'Betalda', color: 'text-emerald-600' },
  { id: 'OVERDUE', label: 'Försenade', color: 'text-red-600' },
  { id: 'DRAFT', label: 'Utkast' },
]

function getTenantName(id: string, tenants: Tenant[]) {
  const t = tenants.find((t) => t.id === id)
  if (!t) return '–'
  return t.type === 'INDIVIDUAL' ? `${t.firstName} ${t.lastName}` : (t.companyName ?? '–')
}

// ─── Betalningsformulär (sub-form för statusövergång till PAID) ───────────────

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
  const [tab, setTab] = useState<Tab>('ALL')
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

  // ── Mutations ─────────────────────────────────────────────────────────────
  const createMutation = useCreateInvoice()
  const updateMutation = useUpdateInvoice()
  const deleteMutation = useDeleteInvoice()
  const statusMutation = useTransitionStatus()
  const sendEmailMutation = useSendInvoiceEmail()

  // ── Statistik (beräknas från hämtad data, tab=ALL) ─────────────────────────
  const { data: allInvoices = [] } = useInvoices()
  const totalPaid = allInvoices
    .filter((i) => i.status === 'PAID')
    .reduce((s, i) => s + Number(i.total), 0)
  const totalOverdue = allInvoices
    .filter((i) => i.status === 'OVERDUE')
    .reduce((s, i) => s + Number(i.total), 0)
  const totalDraft = allInvoices
    .filter((i) => i.status === 'DRAFT')
    .reduce((s, i) => s + Number(i.total), 0)

  function handleSelectInvoice(invoice: Invoice) {
    setSelected(invoice)
    setDetailTab('detaljer')
  }

  function handleCreate(data: CreateInvoiceInput) {
    createMutation.mutate(data, {
      onSuccess: () => setShowCreate(false),
    })
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
    SENT: allInvoices.filter((i) => i.status === 'SENT').length,
    PAID: allInvoices.filter((i) => i.status === 'PAID').length,
    OVERDUE: allInvoices.filter((i) => i.status === 'OVERDUE').length,
    DRAFT: allInvoices.filter((i) => i.status === 'DRAFT').length,
  }

  return (
    <PageWrapper id="invoices">
      <PageHeader
        title="Fakturor"
        description={`${allInvoices.length} fakturor totalt`}
        action={
          <div className="flex items-center gap-2">
            <Button size="sm">
              <Filter size={13} />
              Filter
            </Button>
            <Button size="sm" onClick={() => setShowBulk(true)}>
              <Zap size={14} strokeWidth={2.2} />
              Bulk-fakturering
            </Button>
            <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
              <Plus size={14} />
              Ny faktura
            </Button>
          </div>
        }
      />

      {/* Statistikkort */}
      <div className="mt-6 grid grid-cols-3 gap-4">
        {[
          {
            label: 'Betalt denna period',
            value: formatCurrency(totalPaid),
            color: 'emerald',
            tag: `${allInvoices.filter((i) => i.status === 'PAID').length} fakturor`,
          },
          {
            label: 'Försenat belopp',
            value: formatCurrency(totalOverdue),
            color: 'red',
            tag: `${allInvoices.filter((i) => i.status === 'OVERDUE').length} fakturor`,
          },
          {
            label: 'Obesvarade utkast',
            value: formatCurrency(totalDraft),
            color: 'slate',
            tag: `${allInvoices.filter((i) => i.status === 'DRAFT').length} fakturor`,
          },
        ].map((s, i) => (
          <motion.div
            key={s.label}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.07 }}
            className="rounded-2xl border border-[#EAEDF0] bg-white p-5"
          >
            <p className="text-[12px] font-medium text-gray-400">{s.label}</p>
            <p
              className={`mt-1 text-[22px] font-semibold text-${s.color}-${s.color === 'slate' ? '700' : '600'}`}
            >
              {s.value}
            </p>
            <p className="mt-1 text-[12px] text-gray-400">{s.tag}</p>
          </motion.div>
        ))}
      </div>

      {/* Filterflikar */}
      <div className="mt-6 flex w-fit items-center gap-1 rounded-xl bg-gray-100 p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-all',
              tab === t.id
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700',
            )}
          >
            {t.label}
            <span
              className={cn(
                'rounded-full px-1.5 text-[11px] font-semibold',
                tab === t.id && t.color ? t.color : 'text-gray-400',
              )}
            >
              {tabCounts[t.id]}
            </span>
          </button>
        ))}
      </div>

      {/* Tabell */}
      <div className="mt-4">
        <DataTable
          data={isLoading ? [] : invoices}
          keyExtractor={(i) => i.id}
          onRowClick={handleSelectInvoice}
          columns={[
            {
              key: 'number',
              header: 'Fakturanr',
              cell: (i) => (
                <span className="font-mono text-[13px] font-medium text-gray-800">
                  {i.invoiceNumber}
                </span>
              ),
            },
            {
              key: 'tenant',
              header: 'Hyresgäst',
              cell: (i) => (
                <span className="text-gray-700">{getTenantName(i.tenantId, tenants)}</span>
              ),
            },
            {
              key: 'type',
              header: 'Typ',
              cell: (i) => (
                <span className="text-[12px] text-gray-500">
                  {i.type === 'RENT'
                    ? 'Hyra'
                    : i.type === 'DEPOSIT'
                      ? 'Deposition'
                      : i.type === 'SERVICE'
                        ? 'Tjänst'
                        : i.type === 'UTILITY'
                          ? 'Drift'
                          : i.type}
                </span>
              ),
            },
            {
              key: 'issue',
              header: 'Utfärdat',
              cell: (i) => (
                <span className="text-[12.5px] text-gray-500">{formatDate(i.issueDate)}</span>
              ),
            },
            {
              key: 'due',
              header: 'Förfaller',
              cell: (i) => (
                <span
                  className={`text-[12.5px] font-medium ${i.status === 'OVERDUE' ? 'text-red-600' : 'text-gray-500'}`}
                >
                  {formatDate(i.dueDate)}
                </span>
              ),
            },
            {
              key: 'total',
              header: 'Belopp',
              align: 'right',
              cell: (i) => (
                <span className="font-semibold text-gray-800">
                  {formatCurrency(Number(i.total))}
                </span>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              cell: (i) => <InvoiceStatusBadge status={i.status} />,
            },
          ]}
        />
      </div>

      {/* Detaljmodal */}
      {selected && (
        <Modal
          open
          onClose={() => setSelected(null)}
          title={selected.invoiceNumber}
          description={getTenantName(selected.tenantId, tenants)}
          size="lg"
        >
          {/* Flikar */}
          <div className="mb-5 flex w-fit items-center gap-1 rounded-xl bg-gray-100 p-1">
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

              {/* Fakturarader */}
              <div className="overflow-hidden rounded-xl border border-[#EAEDF0]">
                <div className="border-b border-[#EAEDF0] bg-gray-50 px-4 py-2.5">
                  <p className="text-[12px] font-semibold text-gray-500">Fakturarader</p>
                </div>
                {selected.lines.map((line) => (
                  <div
                    key={line.id}
                    className="flex items-center justify-between border-b border-[#EAEDF0] px-4 py-3 last:border-0"
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
                <div className="flex items-center gap-2 rounded-xl border border-emerald-100 bg-emerald-50 p-3">
                  <span className="text-[12px] font-medium text-emerald-700">
                    Betald {formatDate(selected.paidAt)}
                  </span>
                </div>
              )}

              {/* Åtgärdsknappar baserade på status */}
              <div className="flex flex-wrap items-center gap-2 border-t border-[#EAEDF0] pt-4">
                {/* DRAFT: redigera, skicka, ta bort */}
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

                {/* SENT/OVERDUE: redigera (ej möjligt), registrera betalning, makulera */}
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

                {/* PDF download — available for all statuses */}
                <Button size="sm" onClick={() => downloadInvoicePdf(selected.id)}>
                  <Download size={13} strokeWidth={1.8} />
                  Ladda ner PDF
                </Button>

                {/* Email — available for DRAFT and SENT */}
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

                {/* Email success flash */}
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

      {/* Skapa faktura */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Ny faktura" size="full">
        <InvoiceForm
          onSubmit={handleCreate}
          onCancel={() => setShowCreate(false)}
          isSubmitting={createMutation.isPending}
        />
      </Modal>

      {/* Redigera faktura */}
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
              tenantId: selected.tenantId,
              leaseId: selected.leaseId ?? undefined,
              dueDate: new Date(selected.dueDate).toISOString().split('T')[0] ?? '',
              issueDate: new Date(selected.issueDate).toISOString().split('T')[0] ?? '',
              reference: selected.reference ?? undefined,
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

      {/* Registrera betalning */}
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

      {/* Bekräfta borttagning */}
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

      {/* Bulk-fakturering */}
      <BulkInvoiceModal open={showBulk} onClose={() => setShowBulk(false)} />
    </PageWrapper>
  )
}
