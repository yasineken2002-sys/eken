import { useState, useRef, useCallback } from 'react'
import { motion } from 'framer-motion'
import {
  ArrowLeftRight,
  Upload,
  CheckCircle2,
  XCircle,
  Link2,
  Link2Off,
  ChevronDown,
  ChevronUp,
  FileText,
  Search,
  Sparkles,
} from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { StatCard } from '@/components/ui/StatCard'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { InvoiceStatusBadge } from '@/components/ui/Badge'
import {
  useTransactions,
  useReconciliationStats,
  useImportStatement,
  useManualMatch,
  useIgnoreTransaction,
  useUnmatchTransaction,
  useAutoMatch,
} from './hooks/useReconciliation'
import type { BankFormat } from './api/reconciliation.api'
import { useInvoices } from '@/features/invoices/hooks/useInvoiceQueries'
import { formatCurrency, formatDate } from '@eken/shared'
import type { BankTransaction, ImportResult, Invoice } from '@eken/shared'
import { cn } from '@/lib/cn'

// ─── Status badge ─────────────────────────────────────────────────────────────

function BankTransactionStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; variant: 'warning' | 'success' | 'default' }> = {
    UNMATCHED: { label: 'Omatchad', variant: 'warning' },
    MATCHED: { label: 'Matchad', variant: 'success' },
    IGNORED: { label: 'Ignorerad', variant: 'default' },
  }
  const { label, variant } = map[status] ?? { label: status, variant: 'default' as const }
  return (
    <Badge variant={variant} dot>
      {label}
    </Badge>
  )
}

// ─── Filter tabs ──────────────────────────────────────────────────────────────

type TabId = 'ALL' | 'UNMATCHED' | 'MATCHED' | 'IGNORED'
const TABS: { id: TabId; label: string }[] = [
  { id: 'ALL', label: 'Alla' },
  { id: 'UNMATCHED', label: 'Omatchade' },
  { id: 'MATCHED', label: 'Matchade' },
  { id: 'IGNORED', label: 'Ignorerade' },
]

// ─── Import modal ─────────────────────────────────────────────────────────────

type ImportStep = 'upload' | 'result'

function ImportModal({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean
  onClose: () => void
  onSuccess: () => void
}) {
  const [step, setStep] = useState<ImportStep>('upload')
  const [file, setFile] = useState<File | null>(null)
  const [bank, setBank] = useState<BankFormat | 'AUTO'>('AUTO')
  const [dragOver, setDragOver] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [showErrors, setShowErrors] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const importMutation = useImportStatement()

  const handleFile = (f: File) => {
    const ext = f.name.toLowerCase().split('.').pop() ?? ''
    if (!['csv', 'xlsx', 'xls'].includes(ext)) return
    setFile(f)
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files[0]
    if (f) handleFile(f)
  }, [])

  const handleImport = () => {
    if (!file) return
    importMutation.mutate(
      { file, ...(bank !== 'AUTO' ? { bank } : {}) },
      {
        onSuccess: (data) => {
          setResult(data)
          setStep('result')
          onSuccess()
        },
      },
    )
  }

  const handleClose = () => {
    setStep('upload')
    setFile(null)
    setBank('AUTO')
    setResult(null)
    setShowErrors(false)
    onClose()
  }

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={step === 'upload' ? 'Importera kontoutdrag' : 'Import klar!'}
      size="md"
    >
      {step === 'upload' && (
        <div className="space-y-4">
          {/* Drop zone */}
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileRef.current?.click()}
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 transition-colors',
              dragOver
                ? 'border-[#218F52] bg-blue-600/5'
                : file
                  ? 'border-[#218F52] bg-blue-600/5'
                  : 'border-[#D4D9E0] hover:border-[#218F52]/50 hover:bg-gray-50/60',
            )}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) handleFile(f)
              }}
            />
            {file ? (
              <>
                <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-[#218F52]/30 bg-blue-600/10">
                  <FileText size={22} strokeWidth={1.5} className="text-blue-600" />
                </div>
                <p className="mt-3 text-[13.5px] font-semibold text-gray-800">{file.name}</p>
                <p className="text-[12px] text-gray-400">{formatBytes(file.size)}</p>
                <p className="mt-1 text-[12px] text-blue-600">Klicka för att byta fil</p>
              </>
            ) : (
              <>
                <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-gray-100 bg-gray-50">
                  <Upload size={22} strokeWidth={1.5} className="text-gray-300" />
                </div>
                <p className="mt-3 text-[13.5px] font-semibold text-gray-700">
                  Dra och släpp din bankfil här
                </p>
                <p className="mt-0.5 text-[12.5px] text-gray-400">eller klicka för att välja fil</p>
                <p className="mt-2 rounded-md bg-gray-100 px-2.5 py-1 text-[11.5px] text-gray-400">
                  CSV, Excel (.xlsx, .xls) — max 10 MB
                </p>
              </>
            )}
          </div>

          {/* Bank-väljare */}
          <div>
            <label className="mb-1 block text-[12.5px] font-medium text-gray-700">
              Bank (valfritt)
            </label>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  { id: 'AUTO', label: 'Auto-detektera' },
                  { id: 'HANDELSBANKEN', label: 'Handelsbanken' },
                  { id: 'SEB', label: 'SEB' },
                  { id: 'SWEDBANK', label: 'Swedbank' },
                  { id: 'GENERIC', label: 'Generisk CSV' },
                ] as { id: BankFormat | 'AUTO'; label: string }[]
              ).map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => setBank(b.id)}
                  className={cn(
                    'rounded-lg border px-3 py-1.5 text-[12.5px] font-medium transition-colors',
                    bank === b.id
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-[#DDDFE4] bg-white text-gray-600 hover:bg-gray-50',
                  )}
                >
                  {b.label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11.5px] text-gray-400">
              Lämna på Auto-detektera om du är osäker — vi känner igen formaten automatiskt.
            </p>
          </div>

          {/* Format guide */}
          <FormatGuide />

          {importMutation.isError && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-600">
              Import misslyckades. Kontrollera filformatet och försök igen.
            </p>
          )}
        </div>
      )}

      {step === 'result' && result && (
        <div className="space-y-4">
          <div className="flex flex-col items-center py-2">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100">
              <CheckCircle2 size={28} className="text-emerald-600" strokeWidth={1.8} />
            </div>
            <p className="mt-3 text-[16px] font-semibold text-gray-900">Import klar!</p>
          </div>

          <div className="space-y-2 rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
            {result.bank && (
              <p className="text-[12px] text-gray-500">
                Format:{' '}
                <span className="font-semibold text-gray-700">{bankLabel(result.bank)}</span>
              </p>
            )}
            <ResultRow
              icon="check"
              text={`${result.imported} transaktioner importerade`}
              color="emerald"
            />
            <ResultRow
              icon="check"
              text={`${result.autoMatched} automatiskt matchade via OCR`}
              color="emerald"
            />
            <ResultRow
              icon="arrow"
              text={`${result.unmatched} väntar på matchning`}
              color="amber"
            />
            <ResultRow
              icon="skip"
              text={`${result.duplicates} dubbletter hoppades över`}
              color="gray"
            />
          </div>

          {result.errors.length > 0 && (
            <div>
              <button
                onClick={() => setShowErrors((v) => !v)}
                className="flex w-full items-center gap-1.5 text-[12.5px] text-red-600 hover:text-red-700"
              >
                {showErrors ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                {result.errors.length} rader med fel
              </button>
              {showErrors && (
                <div className="mt-2 max-h-32 space-y-1 overflow-y-auto rounded-lg bg-red-50 p-2.5">
                  {result.errors.map((e, i) => (
                    <p key={i} className="text-[12px] text-red-600">
                      {e}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <ModalFooter>
        {step === 'upload' ? (
          <>
            <Button variant="ghost" onClick={handleClose}>
              Avbryt
            </Button>
            <Button
              variant="primary"
              onClick={handleImport}
              disabled={!file}
              loading={importMutation.isPending}
            >
              <Upload size={14} /> Importera
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={handleClose}>
            Stäng
          </Button>
        )}
      </ModalFooter>
    </Modal>
  )
}

function bankLabel(bank: string): string {
  switch (bank) {
    case 'HANDELSBANKEN':
      return 'Handelsbanken'
    case 'SEB':
      return 'SEB'
    case 'SWEDBANK':
      return 'Swedbank'
    case 'GENERIC':
      return 'Generisk CSV'
    default:
      return bank
  }
}

function ResultRow({
  icon,
  text,
  color,
}: {
  icon: 'check' | 'arrow' | 'skip'
  text: string
  color: 'emerald' | 'amber' | 'gray'
}) {
  const colorMap = {
    emerald: 'text-emerald-600',
    amber: 'text-amber-600',
    gray: 'text-gray-400',
  }
  const iconMap = {
    check: <CheckCircle2 size={14} strokeWidth={2} />,
    arrow: <ArrowLeftRight size={14} strokeWidth={2} />,
    skip: <XCircle size={14} strokeWidth={2} />,
  }
  return (
    <div className={cn('flex items-center gap-2 text-[12.5px] font-medium', colorMap[color])}>
      {iconMap[icon]}
      {text}
    </div>
  )
}

function FormatGuide() {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-xl border border-gray-100">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3.5 py-2.5 text-[12.5px] font-medium text-gray-600 hover:text-gray-800"
      >
        <span>Vilket format stöds?</span>
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>
      {open && (
        <div className="space-y-1.5 border-t border-gray-100 px-3.5 py-3">
          <p className="text-[12px] text-gray-500">Förväntade kolumner (svenska eller engelska):</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            {[
              ['Datum', 'datum, date, bokföringsdag'],
              ['Beskrivning', 'text, description, meddelande'],
              ['Belopp', 'belopp, amount, kredit'],
              ['Saldo', 'saldo, balance (valfritt)'],
              ['Referens/OCR', 'referens, reference, ocr'],
            ].map(([col, keys]) => (
              <div key={col}>
                <p className="text-[11.5px] font-semibold text-gray-700">{col}</p>
                <p className="text-[11px] text-gray-400">{keys}</p>
              </div>
            ))}
          </div>
          <p className="mt-1 text-[11.5px] text-gray-400">
            Belopp: använd positivt tal för inbetalningar (debitering ignoreras)
          </p>
        </div>
      )}
    </div>
  )
}

// ─── Manual match modal ───────────────────────────────────────────────────────

function ManualMatchModal({
  transaction,
  onClose,
}: {
  transaction: BankTransaction
  onClose: () => void
}) {
  const [search, setSearch] = useState('')
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null)
  const { data: invoices = [], isLoading } = useInvoices()
  const matchMutation = useManualMatch()

  const candidates = invoices.filter(
    (inv) =>
      ['SENT', 'OVERDUE', 'PARTIAL'].includes(inv.status) &&
      (search === '' ||
        inv.invoiceNumber.toLowerCase().includes(search.toLowerCase()) ||
        String(inv.total).includes(search)),
  )

  const handleMatch = () => {
    if (!selectedInvoiceId) return
    matchMutation.mutate(
      { transactionId: transaction.id, invoiceId: selectedInvoiceId },
      { onSuccess: onClose },
    )
  }

  const amountMatches = (inv: Invoice) => Math.abs(inv.total - transaction.amount) <= 1

  return (
    <Modal open onClose={onClose} title="Matcha transaktion" size="md">
      {/* Transaction details */}
      <div className="mb-4 rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Datum</p>
            <p className="mt-0.5 text-[13px] font-medium text-gray-800">
              {formatDate(transaction.date)}
            </p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Belopp
            </p>
            <p className="mt-0.5 text-[13px] font-semibold text-emerald-600">
              {formatCurrency(transaction.amount)}
            </p>
          </div>
          <div className="col-span-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Beskrivning
            </p>
            <p className="mt-0.5 text-[13px] text-gray-700">{transaction.description}</p>
          </div>
          {transaction.rawOcr && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">OCR</p>
              <p className="mt-0.5 font-mono text-[13px] text-gray-700">{transaction.rawOcr}</p>
            </div>
          )}
        </div>
      </div>

      {/* Invoice search */}
      <div className="relative mb-3">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Sök faktura..."
          className="h-9 w-full rounded-lg border border-[#E5E7EB] pl-8 pr-3 text-[13px] focus:border-[#218F52] focus:outline-none focus:ring-2 focus:ring-[#218F52]/20"
        />
      </div>

      <div className="max-h-52 overflow-y-auto rounded-xl border border-gray-100">
        {isLoading ? (
          <div className="py-8 text-center text-[13px] text-gray-400">Laddar fakturor...</div>
        ) : candidates.length === 0 ? (
          <div className="py-8 text-center text-[13px] text-gray-400">Inga fakturor hittades</div>
        ) : (
          candidates.map((inv, i) => (
            <button
              key={inv.id}
              onClick={() => setSelectedInvoiceId(inv.id)}
              className={cn(
                'flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors',
                i !== candidates.length - 1 && 'border-b border-gray-100',
                selectedInvoiceId === inv.id
                  ? 'bg-blue-600/8 ring-1 ring-inset ring-[#218F52]/30'
                  : amountMatches(inv)
                    ? 'bg-emerald-50/60 hover:bg-emerald-50'
                    : 'hover:bg-gray-50',
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold text-gray-800">
                    {inv.invoiceNumber}
                  </span>
                  {amountMatches(inv) && (
                    <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10.5px] font-semibold text-emerald-700">
                      Belopp stämmer
                    </span>
                  )}
                </div>
                <p className="text-[12px] text-gray-500">Förfaller {formatDate(inv.dueDate)}</p>
              </div>
              <div className="flex flex-shrink-0 flex-col items-end gap-1">
                <span className="text-[13px] font-semibold text-gray-700">
                  {formatCurrency(inv.total)}
                </span>
                <InvoiceStatusBadge status={inv.status} />
              </div>
            </button>
          ))
        )}
      </div>

      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>
          Avbryt
        </Button>
        <Button
          variant="primary"
          onClick={handleMatch}
          disabled={!selectedInvoiceId}
          loading={matchMutation.isPending}
        >
          <Link2 size={14} /> Matcha
        </Button>
      </ModalFooter>
    </Modal>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
}
const item = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
}

export function ReconciliationPage() {
  const [tab, setTab] = useState<TabId>('ALL')
  const [importOpen, setImportOpen] = useState(false)
  const [matchingTx, setMatchingTx] = useState<BankTransaction | null>(null)
  const [autoMatchFlash, setAutoMatchFlash] = useState<string | null>(null)

  const filters = tab === 'ALL' ? undefined : { status: tab }
  const { data: transactions = [], isLoading } = useTransactions(filters)
  const { data: stats } = useReconciliationStats()
  const ignoreMutation = useIgnoreTransaction()
  const unmatchMutation = useUnmatchTransaction()
  const autoMatchMutation = useAutoMatch()

  const unmatchedCount = stats?.unmatched ?? 0

  const handleAutoMatch = () => {
    autoMatchMutation.mutate(undefined, {
      onSuccess: (data) => {
        setAutoMatchFlash(
          data.matched > 0
            ? `${data.matched} matchade · ${data.unmatched} väntar fortfarande`
            : 'Inga nya matchningar hittades',
        )
        setTimeout(() => setAutoMatchFlash(null), 4000)
      },
    })
  }

  return (
    <PageWrapper id="reconciliation">
      <PageHeader
        title="Bankavstämning"
        description={
          unmatchedCount > 0
            ? `${unmatchedCount} transaktion${unmatchedCount !== 1 ? 'er' : ''} väntar på matchning`
            : 'Alla transaktioner är matchade'
        }
        action={
          <div className="flex items-center gap-2">
            {autoMatchFlash && (
              <span className="text-[12px] font-medium text-emerald-600">{autoMatchFlash}</span>
            )}
            <Button
              onClick={handleAutoMatch}
              disabled={unmatchedCount === 0}
              loading={autoMatchMutation.isPending}
            >
              <Sparkles size={14} /> Auto-matcha
            </Button>
            <Button variant="primary" onClick={() => setImportOpen(true)}>
              <Upload size={14} /> Importera kontoutdrag
            </Button>
          </div>
        }
      />

      {/* Stats */}
      <motion.div
        variants={stagger}
        initial="hidden"
        animate="show"
        className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        <motion.div variants={item}>
          <StatCard
            title="Totalt importerade"
            value={stats?.total ?? 0}
            icon={ArrowLeftRight}
            iconColor="#6B7280"
            delay={0}
          />
        </motion.div>
        <motion.div variants={item}>
          <StatCard
            title="Matchade"
            value={`${stats?.matched ?? 0}`}
            icon={CheckCircle2}
            iconColor="#2563EB"
            delay={0.05}
            {...(stats?.matchedAmount ? { changeLabel: formatCurrency(stats.matchedAmount) } : {})}
          />
        </motion.div>
        <motion.div variants={item}>
          <StatCard
            title="Omatchade"
            value={stats?.unmatched ?? 0}
            icon={ArrowLeftRight}
            iconColor="#D97706"
            delay={0.1}
          />
        </motion.div>
        <motion.div variants={item}>
          <StatCard
            title="Ignorerade"
            value={stats?.ignored ?? 0}
            icon={XCircle}
            iconColor="#9CA3AF"
            delay={0.15}
          />
        </motion.div>
      </motion.div>

      {/* Filter tabs */}
      <div className="mt-6">
        <div className="flex w-fit gap-1 rounded-xl bg-gray-100/70 p-1">
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
      </div>

      {/* Table */}
      <div className="mt-4">
        {isLoading ? (
          <div className="flex h-32 items-center justify-center text-[13px] text-gray-400">
            Laddar transaktioner...
          </div>
        ) : transactions.length === 0 ? (
          <EmptyState
            icon={ArrowLeftRight}
            title="Inga transaktioner"
            description="Importera ett kontoutdrag för att komma igång med bankavstämning."
            action={
              <Button variant="primary" onClick={() => setImportOpen(true)}>
                <Upload size={14} /> Importera kontoutdrag
              </Button>
            }
          />
        ) : (
          <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white">
            <table className="w-full">
              <thead>
                <tr style={{ borderBottom: '1px solid #EAEDF0' }}>
                  {['Datum', 'Beskrivning', 'Referens/OCR', 'Belopp', 'Status', 'Faktura', ''].map(
                    (h) => (
                      <th
                        key={h}
                        className="px-4 py-2.5 text-left text-[11.5px] font-semibold uppercase tracking-wide"
                        style={{ color: '#9CA3AF' }}
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <motion.tbody variants={stagger} initial="hidden" animate="show">
                {transactions.map((tx) => (
                  <motion.tr
                    key={tx.id}
                    variants={item}
                    className="border-b border-gray-100 transition-colors last:border-0 hover:bg-gray-50/80"
                  >
                    <td className="px-4 py-3 text-[13px] text-gray-600">{formatDate(tx.date)}</td>
                    <td className="max-w-[200px] px-4 py-3">
                      <p className="truncate text-[13px] text-gray-800" title={tx.description}>
                        {tx.description.length > 40
                          ? tx.description.slice(0, 40) + '…'
                          : tx.description}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      {(tx.rawOcr ?? tx.reference) ? (
                        <span className="font-mono text-[12.5px] text-gray-600">
                          {tx.rawOcr ?? tx.reference}
                        </span>
                      ) : (
                        <span className="text-[13px] text-gray-300">–</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-[13px] font-semibold text-emerald-600">
                        {formatCurrency(tx.amount)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <BankTransactionStatusBadge status={tx.status} />
                    </td>
                    <td className="px-4 py-3">
                      {tx.invoice ? (
                        <Badge variant="info">{tx.invoice.invoiceNumber}</Badge>
                      ) : (
                        <span className="text-[13px] text-gray-300">–</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        {tx.status === 'UNMATCHED' && (
                          <>
                            <Button size="xs" variant="outline" onClick={() => setMatchingTx(tx)}>
                              <Link2 size={11} /> Matcha
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => ignoreMutation.mutate(tx.id)}
                              loading={
                                ignoreMutation.isPending && ignoreMutation.variables === tx.id
                              }
                            >
                              Ignorera
                            </Button>
                          </>
                        )}
                        {tx.status === 'MATCHED' && (
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => unmatchMutation.mutate(tx.id)}
                            loading={
                              unmatchMutation.isPending && unmatchMutation.variables === tx.id
                            }
                          >
                            <Link2Off size={11} /> Häv matchning
                          </Button>
                        )}
                        {tx.status === 'IGNORED' && (
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => unmatchMutation.mutate(tx.id)}
                            loading={
                              unmatchMutation.isPending && unmatchMutation.variables === tx.id
                            }
                          >
                            Återställ
                          </Button>
                        )}
                      </div>
                    </td>
                  </motion.tr>
                ))}
              </motion.tbody>
            </table>
          </div>
        )}
      </div>

      {/* Import modal */}
      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onSuccess={() => {
          /* data refetches via invalidation */
        }}
      />

      {/* Manual match modal */}
      {matchingTx && (
        <ManualMatchModal transaction={matchingTx} onClose={() => setMatchingTx(null)} />
      )}
    </PageWrapper>
  )
}
