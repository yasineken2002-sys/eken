import { useState, useEffect } from 'react'
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
  MailX,
  Receipt,
  CornerDownRight,
} from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Input, Select } from '@/components/ui/Input'
import { DataTable } from '@/components/ui/DataTable'
import { InvoiceStatusBadge, Badge } from '@/components/ui/Badge'
import { InvoiceTimeline } from './components/InvoiceTimeline'
import { InvoiceForm } from './components/InvoiceForm'
import { CreditNoteModal } from './components/CreditNoteModal'
import {
  useInvoices,
  useInvoice,
  useInvoiceEvents,
  useCreateInvoice,
  useUpdateInvoice,
  useDeleteInvoice,
  useTransitionStatus,
  useRegisterPayment,
  useSendInvoiceEmail,
  useCreditNotePreview,
} from './hooks/useInvoiceQueries'
import type { InvoiceWithOutstanding } from './hooks/useInvoiceQueries'
import { formatCurrency, formatDate } from '@eken/shared'
import type { Invoice, InvoiceStatus, CreateInvoiceInput, Tenant } from '@eken/shared'
import { downloadInvoicePdf } from './api/invoices.api'
import { useTenants } from '@/features/tenants/hooks/useTenants'
import { useFocusStore } from '@/stores/focus.store'
import { useCanWrite } from '@/hooks/useCanWrite'
import { cn } from '@/lib/cn'

// Stagger på listor — designsystemets standard.
const listContainer = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } }
const listItem = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
}

type DetailTab = 'detaljer' | 'historik'

type Tab = 'ALL' | 'DRAFT' | 'SENT' | 'PAID' | 'OVERDUE' | 'VOID'
const TABS: { id: Tab; label: string; color?: string }[] = [
  { id: 'ALL', label: 'Alla' },
  { id: 'SENT', label: 'Skickade' },
  { id: 'PAID', label: 'Betalda', color: 'text-emerald-600' },
  { id: 'OVERDUE', label: 'Försenade', color: 'text-red-600' },
  { id: 'DRAFT', label: 'Utkast' },
  // Makulerade fakturor (VOID) döljs i "Alla"-vyn men är åtkomliga här —
  // räkenskapsinformation raderas aldrig, så de måste gå att granska (BFL).
  { id: 'VOID', label: 'Makulerade', color: 'text-gray-500' },
]

function getTenantName(id: string | undefined, tenants: Tenant[]) {
  if (!id) return '–'
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
  // #349: TYPEN ÄR SPÄRREN. Kräver `outstanding` — utan det kunde formuläret
  // förifylla bruttot på en delbetald faktura och föreslå en överbetalning.
  invoice: InvoiceWithOutstanding
  onConfirm: (data: PaymentFormState) => void
  onCancel: () => void
  isSubmitting: boolean
}) {
  const [form, setForm] = useState<PaymentFormState>({
    // #349: RESTSKULDEN, inte bruttot. På en faktura där 9 000 av 10 000 är
    // allokerat föreslog fältet 10 000 kr, och operatören som klickade igenom
    // fick ett överbetalningsförsök. Backend avvisar det (markAsPaidManually
    // grindar mot computeInvoiceDebt), så det var aldrig ett penningfel — men
    // förifyllningen är ett BELOPPSPÅSTÅENDE om vad som ska betalas, och den
    // sa fel sak.
    amount: String(Number(invoice.outstanding)),
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
  const [selected, setSelected] = useState<Invoice | null>(null)
  const [detailTab, setDetailTab] = useState<DetailTab>('detaljer')
  const [showCreate, setShowCreate] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [showPayment, setShowPayment] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [emailSentTo, setEmailSentTo] = useState<string | null>(null)
  const [showCreditNote, setShowCreditNote] = useState(false)
  const [creditNoteFlash, setCreditNoteFlash] = useState<string | null>(null)

  // ── Data ──────────────────────────────────────────────────────────────────
  const { data: invoices = [], isLoading } = useInvoices(
    tab === 'ALL' ? undefined : { status: tab as InvoiceStatus },
  )
  // I "Alla"-vyn döljs makulerade fakturor (VOID) — de syns bara i fliken
  // "Makulerade". Ett makulerat utkast känns därmed "borttaget" men bevaras
  // som räkenskapsinformation (soft-delete, BFL 1999:1078).
  const displayedInvoices = tab === 'ALL' ? invoices.filter((i) => i.status !== 'VOID') : invoices
  const { data: selectedEvents = [], isError: historikNekad } = useInvoiceEvents(selected?.id ?? '')
  // #349: betalningsmodalens belopp ska vara RESTSKULDEN, och den finns bara på
  // detaljsvaret (och listsvaret). Hämtas när modalen är öppen — `useInvoice`
  // är `enabled: !!id`, så tom sträng betyder ingen förfrågan.
  const { data: paymentInvoice } = useInvoice(showPayment && selected ? selected.id : '')
  // #517 — detaljsvaret bär kopplingen åt båda håll: originalets kreditnotor,
  // och kreditnotans original. Listsvaret gör det inte, så det hämtas här.
  const { data: selectedFull } = useInvoice(selected?.id ?? '')
  // Bedömningen av om kreditering är möjlig kommer från SERVERN, samma
  // `assessCreditability` som spärrar skrivningen. Gränssnittet härleder inga
  // egna villkor — då hade knappen förr eller senare erbjudit något API:et
  // nekar, eller gömt något som faktiskt går.
  const { data: creditPreview } = useCreditNotePreview(
    selected?.id,
    !!selected && detailTab === 'detaljer' && !selected.isCreditNote,
  )
  const { data: tenants = [] } = useTenants()

  // ── Mutations ─────────────────────────────────────────────────────────────
  const createMutation = useCreateInvoice()
  const updateMutation = useUpdateInvoice()
  const deleteMutation = useDeleteInvoice()
  const statusMutation = useTransitionStatus()
  const payMutation = useRegisterPayment()
  const sendEmailMutation = useSendInvoiceEmail()

  // ── Statistik (beräknas från hämtad data, tab=ALL) ─────────────────────────
  const { data: allInvoices = [] } = useInvoices()
  // Makulerade (VOID) räknas inte som aktiva fakturor — de visas bara i egen
  // flik. Använd activeInvoices för totaler/räknare så de matchar "Alla"-vyn.
  const activeInvoices = allInvoices.filter((i) => i.status !== 'VOID')
  const voidCount = allInvoices.length - activeInvoices.length
  const totalPaid = allInvoices
    .filter((i) => i.status === 'PAID')
    .reduce((s, i) => s + Number(i.total), 0)
  // #325 — RESTSKULDEN, inte ursprungsbeloppet. En OVERDUE-faktura kan bära
  // allokeringar (PARTIAL → OVERDUE är en giltig kant), och då räknade den här
  // raden hela det fakturerade beloppet som försenat. `outstanding` beräknas av
  // API:et med samma uttryck som dashboarden — summera aldrig `payments` här,
  // det vore ännu en kopia av beräkningen.
  //
  // Fakturor utan kvarvarande skuld räknas inte, symmetriskt med
  // OverdueDebtService: en reglerad faktura är inget försenat belopp. BELOPPET
  // OCH ANTALET MÅSTE MÄTA SAMMA MÄNGD — därför härleds badgen "N fakturor" ur
  // exakt den här listan, inte ur ett eget filter.
  const overdueOpen = allInvoices.filter((i) => i.status === 'OVERDUE' && Number(i.outstanding) > 0)
  const totalOverdue = overdueOpen.reduce((s, i) => s + Number(i.outstanding), 0)
  // #517 — KREDITNOTOR RÄKNAS INTE SOM UTKAST. De skapas med status DRAFT
  // eftersom de aldrig ska förfalla, men de är färdiga, bokförda dokument som
  // MINSKAR en fordran. Låg de kvar här summerades ett krediterat belopp in i
  // "obesvarade utkast" — ett belopp någon skulle tro var utestående, alltså
  // exakt den sortens siffra hela #517 handlar om att inte visa.
  const draftInvoices = allInvoices.filter((i) => i.status === 'DRAFT' && !i.isCreditNote)
  const totalDraft = draftInvoices.reduce((s, i) => s + Number(i.total), 0)
  // #378 — ÖVERBETALT. Beloppet klampades tidigare bort av `max(0, claim)` och
  // fanns bara kvar som ett tecken som en enda grind i hela kodbasen läste;
  // pengarna var alltså osynliga för operatören. `overpaid` räknas av API:et
  // med samma uttryck som `outstanding` — summera aldrig `payments` här.
  //
  // Beloppet är INTE bokfört. Kontot för kundtillgodohavande är en öppen
  // revisorsfråga (#505); kortet säger att pengarna finns, inte hur de konteras.
  const overpaidInvoices = allInvoices.filter((i) => Number(i.overpaid) > 0)
  const totalOverpaid = overpaidInvoices.reduce((s, i) => s + Number(i.overpaid), 0)

  function handleSelectInvoice(invoice: Invoice) {
    setSelected(invoice)
    setDetailTab('detaljer')
  }

  // Deep-link från notifikationer (INVOICE-typade) — öppna detaljpanelen
  // när focus matchar och fakturan finns i listan.
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
    // Går via /pay (markAsPaidManually) som bokför inbetalningen — inte /status,
    // som skulle flippa till PAID utan verifikat.
    payMutation.mutate(
      {
        id: selected.id,
        amount: Number(form.amount),
        paymentMethod: form.paymentMethod,
        reference: form.reference,
      },
      {
        onSuccess: (updated) => {
          setSelected(updated)
          setShowPayment(false)
        },
      },
    )
  }

  // Flashen hör till den faktura den skapades på. Utan den här nollställningen
  // följde den med när operatören öppnade en ANNAN faktura, och påstod där att
  // något hänt som inte hänt.
  useEffect(() => {
    setCreditNoteFlash(null)
  }, [selected?.id])

  function handleVoid() {
    if (!selected) return
    statusMutation.mutate(
      { id: selected.id, status: 'VOID' },
      { onSuccess: (updated) => setSelected(updated) },
    )
  }

  const tabCounts = {
    // "Alla" räknar exklusive makulerade (de visas i egen flik).
    ALL: activeInvoices.length,
    SENT: allInvoices.filter((i) => i.status === 'SENT').length,
    PAID: allInvoices.filter((i) => i.status === 'PAID').length,
    OVERDUE: allInvoices.filter((i) => i.status === 'OVERDUE').length,
    // Samma mängd som beloppet ovan — en flik som räknar fler poster än
    // KPI:n summerar är två påståenden om samma sak.
    DRAFT: draftInvoices.length,
    VOID: allInvoices.filter((i) => i.status === 'VOID').length,
  }

  return (
    <PageWrapper id="invoices">
      <PageHeader
        title="Fakturor"
        description={
          voidCount > 0
            ? `${activeInvoices.length} fakturor · ${voidCount} makulerade`
            : `${activeInvoices.length} fakturor totalt`
        }
        action={
          <div className="flex items-center gap-2">
            <Button size="sm">
              <Filter size={13} />
              Filter
            </Button>
            {canWrite && (
              <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
                <Plus size={14} />
                Ny faktura
              </Button>
            )}
          </div>
        }
      />

      {/* Statistikkort */}
      <div className={`mt-6 grid gap-4 ${totalOverpaid > 0 ? 'grid-cols-4' : 'grid-cols-3'}`}>
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
            // #325 — samma mängd som beloppet summerar (se `overdueOpen`). Stod
            // här förut: ett eget filter över ALLA OVERDUE, vilket efter bytet
            // till restskuld hade kunnat visa "3 fakturor" ovanför ett belopp
            // som bara avsåg 2 av dem.
            tag: `${overdueOpen.length} fakturor`,
          },
          {
            label: 'Obesvarade utkast',
            value: formatCurrency(totalDraft),
            color: 'slate',
            tag: `${draftInvoices.length} fakturor`,
          },
          // #378 — visas BARA när det finns något att visa. Ett permanent
          // "0 kr överbetalt" hade lärt operatören att ignorera kortet, och då
          // syns inte heller de gånger det faktiskt står ett belopp där.
          //
          // Beloppet OCH antalet härleds ur samma lista (`overpaidInvoices`),
          // av samma skäl som står vid "Försenat belopp": två tal som mäter
          // olika mängder ovanför varandra är värre än ett tal.
          ...(totalOverpaid > 0
            ? [
                {
                  label: 'Överbetalt',
                  value: formatCurrency(totalOverpaid),
                  color: 'amber',
                  tag: `${overpaidInvoices.length} fakturor · ej bokfört`,
                },
              ]
            : []),
        ].map((s, i) => (
          <motion.div
            key={s.label}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.07 }}
            className="rounded-2xl border border-gray-100 bg-white p-5"
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
      <div className="mt-6 flex w-fit items-center gap-1 rounded-xl bg-gray-100/70 p-1">
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
          data={isLoading ? [] : displayedInvoices}
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
              cell: (i) =>
                i.isCreditNote ? (
                  // Minustecknet är PRESENTATION, inte data: raden lagras med
                  // positivt belopp och betydelsen kommer från `isCreditNote`.
                  // Att lagra negativa belopp hade gjort varje summering till
                  // en fälla.
                  <span className="font-semibold text-purple-700">
                    −{formatCurrency(Number(i.total))}
                  </span>
                ) : (
                  <span className="font-semibold text-gray-800">
                    {formatCurrency(Number(i.total))}
                  </span>
                ),
            },
            {
              key: 'status',
              header: 'Status',
              cell: (i) => (
                <div className="flex items-center gap-1.5">
                  {/* #517 — en kreditnota har ingen meningsfull fakturastatus.
                      Den lagras som DRAFT för att aldrig förfalla, men "Utkast"
                      vore ett direkt felaktigt påstående om ett bokfört
                      dokument. Dokumenttypen står här i stället. */}
                  {i.isCreditNote ? (
                    <Badge variant="purple">Kreditnota</Badge>
                  ) : (
                    <InvoiceStatusBadge status={i.status} />
                  )}
                  {i.sendError && (
                    <span
                      title={`Utskick misslyckades: ${i.sendError}`}
                      className="inline-flex items-center text-red-600"
                    >
                      <MailX size={14} strokeWidth={1.8} />
                    </span>
                  )}
                </div>
              ),
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

              {/* Fakturarader */}
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

              {/* Synligt fel vid misslyckat utskick — hyresvärden kan skicka om
                  via "Skicka via e-post"/"Skicka faktura" nedan. */}
              {selected.sendError && selected.status !== 'PAID' && (
                <div className="rounded-xl border border-red-100 bg-red-50 p-3">
                  <p className="flex items-center gap-1.5 text-[12px] font-semibold text-red-600">
                    <MailX size={13} strokeWidth={1.8} />
                    Utskick misslyckades
                  </p>
                  <p className="mt-1 text-[12px] text-red-600/90">{selected.sendError}</p>
                  <p className="mt-1.5 text-[11px] text-gray-500">
                    Fakturan skickades aldrig. Försök skicka igen nedan.
                  </p>
                </div>
              )}

              {/* #517 — ÄR DETTA EN KREDITNOTA? Visa vilken faktura den avser.
                  Utan den här rutan är dokumentet ett belopp utan sammanhang. */}
              {selectedFull?.creditedInvoice && (
                <div className="rounded-xl border border-purple-100 bg-purple-50 p-3">
                  <p className="flex items-center gap-1.5 text-[12px] font-semibold text-purple-700">
                    <CornerDownRight size={13} strokeWidth={1.8} />
                    Kreditnota
                  </p>
                  <p className="mt-1 text-[12.5px] text-purple-800/90">
                    Avser faktura{' '}
                    <span className="font-mono font-medium">
                      {selectedFull.creditedInvoice.invoiceNumber}
                    </span>{' '}
                    på {formatCurrency(Number(selectedFull.creditedInvoice.total))}.
                  </p>
                </div>
              )}

              {/* #517 — ANDRA RIKTNINGEN: originalets kreditnotor. Det är här
                  någon letar efter varför fordran krympte. */}
              {selectedFull?.creditNotes && selectedFull.creditNotes.length > 0 && (
                <div className="overflow-hidden rounded-xl border border-gray-100">
                  <div className="border-b border-gray-100 bg-gray-50 px-4 py-2.5">
                    <p className="text-[12px] font-semibold text-gray-500">
                      Kreditnotor ({selectedFull.creditNotes.length})
                    </p>
                  </div>
                  <motion.div variants={listContainer} initial="hidden" animate="show">
                    {selectedFull.creditNotes.map((cn) => (
                      <motion.button
                        key={cn.id}
                        variants={listItem}
                        type="button"
                        onClick={() => {
                          const rad = invoices.find((i) => i.id === cn.id)
                          if (rad) handleSelectInvoice(rad)
                        }}
                        className="flex w-full items-center justify-between border-b border-gray-100 px-4 py-3 text-left last:border-0 hover:bg-[var(--ev-row-hover)]"
                      >
                        <div className="min-w-0">
                          <p className="font-mono text-[13px] font-medium text-gray-800">
                            {cn.invoiceNumber}
                          </p>
                          <p className="truncate text-[12px] text-gray-400">
                            {formatDate(cn.issueDate)}
                            {cn.reason ? ` · ${cn.reason}` : ''}
                          </p>
                        </div>
                        <p className="ml-3 flex-shrink-0 text-[13.5px] font-medium text-purple-700">
                          −{formatCurrency(Number(cn.total))}
                        </p>
                      </motion.button>
                    ))}
                  </motion.div>
                  <div className="flex justify-between bg-gray-50 px-4 py-3">
                    <p className="text-[13px] font-semibold text-gray-700">Kvar att betala</p>
                    <p className="text-[14px] font-bold text-gray-900">
                      {formatCurrency(Number(selectedFull.outstanding))}
                    </p>
                  </div>
                </div>
              )}

              {/* #517 — VARFÖR knappen är stängd, i stället för att gömma den.
                  En operatör som inte hittar funktionen ska förstå att den finns
                  och varför den inte går just här. Texten kommer från servern,
                  samma bedömning som spärrar skrivningen. */}
              {creditPreview && !creditPreview.allowed && (
                <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                  <p className="flex items-center gap-1.5 text-[12px] font-semibold text-gray-600">
                    <Receipt size={13} strokeWidth={1.8} />
                    Kreditering inte möjlig
                  </p>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-gray-500">
                    {creditPreview.blockedReason}
                  </p>
                </div>
              )}

              {creditNoteFlash && (
                <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-3">
                  <p className="text-[12.5px] font-medium text-emerald-700">{creditNoteFlash}</p>
                </div>
              )}

              {/* Åtgärdsknappar baserade på status */}
              <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-4">
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

                {/* #517 — Kreditera. Möjlig BARA när servern säger att den är
                    det; är den inte det står skälet i rutan ovanför, så
                    funktionen aldrig försvinner tyst. */}
                {canWrite && creditPreview?.allowed && (
                  <Button size="sm" onClick={() => setShowCreditNote(true)}>
                    <Receipt size={13} strokeWidth={1.8} />
                    Kreditera
                  </Button>
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

          {detailTab === 'historik' &&
            /* Panelen påstod "Ingen historik ännu" vid 403 — GET /invoices/:id/events
               är ACCOUNTANT+ sedan #440. Panelnivå, så ingen helsidesvy. (#442) */
            (historikNekad ? (
              <div className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
                <p className="text-[13px] text-gray-400">
                  Din roll får inte se fakturans historik.
                </p>
              </div>
            ) : (
              <InvoiceTimeline events={selectedEvents} />
            ))}
        </Modal>
      )}

      {/* #517 — kreditnota */}
      {selected && (
        <CreditNoteModal
          invoiceId={selected.id}
          invoiceNumber={selected.invoiceNumber}
          open={showCreditNote}
          onClose={() => setShowCreditNote(false)}
          onCreated={(nummer, belopp) => {
            setCreditNoteFlash(
              `Kreditnota ${nummer} skapad på ${formatCurrency(belopp)}. Fordran har minskat.`,
            )
            setTimeout(() => setCreditNoteFlash(null), 8000)
          }}
        />
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

      {/* Registrera betalning */}
      {selected && (
        <Modal
          open={showPayment}
          onClose={() => setShowPayment(false)}
          title="Registrera betalning"
          description={
            paymentInvoice
              ? `${paymentInvoice.invoiceNumber} · ${formatCurrency(Number(paymentInvoice.outstanding))} att betala`
              : selected.invoiceNumber
          }
        >
          {/* #349: formuläret får fakturan från DETALJQUERYN, inte från `selected`.
              `selected` sätts både från listan och från mutationssvar (setSelected(updated)),
              och mutationssvaren bär inte restskulden — att typa hela state:t hade
              tvingat fram `outstanding` på fyra endpoints och en DB-läsning per
              mutation. Att hämta här är dessutom MER korrekt: beloppet bygger på
              serverns sanning när modalen öppnas, inte på en möjligen inaktuell
              listrad. */}
          {paymentInvoice ? (
            <PaymentSubForm
              invoice={paymentInvoice}
              onConfirm={handlePayment}
              onCancel={() => setShowPayment(false)}
              isSubmitting={payMutation.isPending}
            />
          ) : (
            <p className="py-6 text-center text-[13px] text-gray-500">Hämtar restskuld…</p>
          )}
        </Modal>
      )}

      {/* Bekräfta borttagning */}
      {selected && (
        <Modal
          open={showDeleteConfirm}
          onClose={() => setShowDeleteConfirm(false)}
          title="Ta bort utkast"
          description={`Utkastet ${selected.invoiceNumber} makuleras och flyttas till "Makulerade". Fakturan raderas inte – den bevaras som räkenskapsinformation (Bokföringslagen).`}
        >
          <ModalFooter>
            <Button onClick={() => setShowDeleteConfirm(false)}>Avbryt</Button>
            <Button
              variant="primary"
              className="bg-red-600 hover:bg-red-700"
              disabled={deleteMutation.isPending}
              onClick={handleDelete}
            >
              {deleteMutation.isPending ? 'Makulerar…' : 'Ta bort utkast'}
            </Button>
          </ModalFooter>
        </Modal>
      )}
    </PageWrapper>
  )
}
