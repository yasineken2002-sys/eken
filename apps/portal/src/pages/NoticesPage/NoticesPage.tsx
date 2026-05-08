import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  fetchInvoices,
  fetchRentNotices,
  downloadInvoicePdf,
  downloadRentNoticePdf,
  extractApiError,
} from '@/api/portal.api'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Spinner } from '@/components/ui/Spinner'
import { ErrorCard } from '@/components/ui/ErrorCard'
import type { PortalInvoice, PortalRentNotice } from '@/types/portal.types'
import styles from './NoticesPage.module.css'

type TopTab = 'rent-notices' | 'invoices'
type Filter = 'all' | 'unpaid' | 'paid'

const UNPAID_INVOICE_STATUSES = new Set(['SENT', 'OVERDUE', 'PARTIAL'])
const PAID_INVOICE_STATUSES = new Set(['PAID'])

const UNPAID_NOTICE_STATUSES = new Set(['SENT', 'OVERDUE'])
const PAID_NOTICE_STATUSES = new Set(['PAID'])

function formatCurrencySv(amount: number): string {
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'SEK',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount)
}

function formatDateSv(dateStr: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(dateStr))
}

function formatMonthYear(month: number, year: number): string {
  return new Intl.DateTimeFormat('sv-SE', { month: 'long', year: 'numeric' }).format(
    new Date(year, month - 1, 1),
  )
}

function isInvoiceOverdue(invoice: PortalInvoice): boolean {
  return (
    invoice.status === 'OVERDUE' ||
    (UNPAID_INVOICE_STATUSES.has(invoice.status) && new Date(invoice.dueDate) < new Date())
  )
}

function isNoticeOverdue(notice: PortalRentNotice): boolean {
  return (
    notice.status === 'OVERDUE' ||
    (notice.status === 'SENT' && new Date(notice.dueDate) < new Date())
  )
}

function DownloadIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 2v8m0 0l-3-3m3 3l3-3M3 12v1a1 1 0 001 1h8a1 1 0 001-1v-1"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function NoticesPage() {
  const [topTab, setTopTab] = useState<TopTab>('rent-notices')
  const [filter, setFilter] = useState<Filter>('all')
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [errorByRow, setErrorByRow] = useState<Record<string, string>>({})

  const invoicesQuery = useQuery({
    queryKey: ['portal', 'invoices'],
    queryFn: fetchInvoices,
    enabled: topTab === 'invoices',
  })

  const noticesQuery = useQuery({
    queryKey: ['portal', 'rent-notices'],
    queryFn: fetchRentNotices,
    enabled: topTab === 'rent-notices',
  })

  async function handleDownload(id: string, label: string, fn: () => Promise<void>): Promise<void> {
    setDownloadingId(id)
    setErrorByRow((prev) => {
      if (!(id in prev)) return prev
      const next: Record<string, string> = {}
      for (const k of Object.keys(prev)) {
        if (k !== id) next[k] = prev[k] as string
      }
      return next
    })
    try {
      await fn()
    } catch (err) {
      setErrorByRow((prev) => ({
        ...prev,
        [id]: extractApiError(err, `Kunde inte ladda ner ${label}`),
      }))
    } finally {
      setDownloadingId(null)
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.pageTitle}>Avier & fakturor</h1>
      </div>

      {/* Top tabs */}
      <div className={styles.tabs} role="tablist">
        <button
          role="tab"
          aria-selected={topTab === 'rent-notices'}
          className={`${styles.tab} ${topTab === 'rent-notices' ? styles.tabActive : ''}`}
          onClick={() => {
            setTopTab('rent-notices')
            setFilter('all')
          }}
        >
          Avier
        </button>
        <button
          role="tab"
          aria-selected={topTab === 'invoices'}
          className={`${styles.tab} ${topTab === 'invoices' ? styles.tabActive : ''}`}
          onClick={() => {
            setTopTab('invoices')
            setFilter('all')
          }}
        >
          Fakturor
        </button>
      </div>

      {/* Status-filter */}
      <div className={styles.filters}>
        {(['all', 'unpaid', 'paid'] as const).map((f) => (
          <button
            key={f}
            className={`${styles.filterChip} ${filter === f ? styles.filterChipActive : ''}`}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'Alla' : f === 'unpaid' ? 'Obetalda' : 'Betalda'}
          </button>
        ))}
      </div>

      {topTab === 'rent-notices' ? (
        <RentNoticesList
          query={noticesQuery}
          filter={filter}
          downloadingId={downloadingId}
          errorByRow={errorByRow}
          onDownload={(notice) =>
            void handleDownload(notice.id, 'avin', () =>
              downloadRentNoticePdf(notice.id, notice.noticeNumber),
            )
          }
        />
      ) : (
        <InvoicesList
          query={invoicesQuery}
          filter={filter}
          downloadingId={downloadingId}
          errorByRow={errorByRow}
          onDownload={(inv) =>
            void handleDownload(inv.id, 'fakturan', () =>
              downloadInvoicePdf(inv.id, inv.invoiceNumber),
            )
          }
        />
      )}
    </div>
  )
}

// ── Hyresavier ────────────────────────────────────────────────────────────────

function RentNoticesList({
  query,
  filter,
  downloadingId,
  errorByRow,
  onDownload,
}: {
  query: ReturnType<typeof useQuery<PortalRentNotice[]>>
  filter: Filter
  downloadingId: string | null
  errorByRow: Record<string, string>
  onDownload: (notice: PortalRentNotice) => void
}) {
  if (query.isLoading) return <Spinner size="md" label="Laddar avier..." />
  if (query.isError || !query.data) {
    return <ErrorCard isUnderConstruction onRetry={() => void query.refetch()} />
  }

  const filtered = query.data
    .filter((n) => {
      if (filter === 'unpaid') return UNPAID_NOTICE_STATUSES.has(n.status)
      if (filter === 'paid') return PAID_NOTICE_STATUSES.has(n.status)
      return true
    })
    .sort((a, b) => {
      const aUnpaid = UNPAID_NOTICE_STATUSES.has(a.status) ? 0 : 1
      const bUnpaid = UNPAID_NOTICE_STATUSES.has(b.status) ? 0 : 1
      if (aUnpaid !== bUnpaid) return aUnpaid - bUnpaid
      return new Date(b.dueDate).getTime() - new Date(a.dueDate).getTime()
    })

  if (filtered.length === 0) return <EmptyState label="Inga avier att visa" />

  return (
    <div className={styles.list}>
      {filtered.map((notice) => {
        const overdue = isNoticeOverdue(notice)
        return (
          <div key={notice.id} className={`${styles.card} ${overdue ? styles.cardOverdue : ''}`}>
            <div className={styles.cardTop}>
              <p className={styles.cardMonth} style={{ textTransform: 'capitalize' }}>
                {formatMonthYear(notice.month, notice.year)}
              </p>
              <StatusBadge type="rent-notice" status={notice.status} />
            </div>

            <p className={styles.cardAmount}>{formatCurrencySv(notice.totalAmount)}</p>

            <div className={styles.cardDueRow}>
              <span
                className={`${styles.cardDueLabel} ${overdue ? styles.cardDueLabelOverdue : ''}`}
              >
                {overdue ? '⚠️ Förfallen' : 'Förfaller'}
              </span>
              <span className={styles.cardDueDate}>{formatDateSv(notice.dueDate)}</span>
            </div>

            {notice.paidAt && (
              <div className={styles.paidRow}>
                <span className={styles.paidText}>✓ Betald {formatDateSv(notice.paidAt)}</span>
              </div>
            )}

            <div className={styles.cardOcr}>
              <span className={styles.cardOcrLabel}>OCR-nummer</span>
              <span className={styles.cardOcrValue}>{notice.ocrNumber}</span>
            </div>

            <div className={styles.cardFooter}>
              <span className={styles.cardProperty}>
                {notice.propertyName} · {notice.unitName}
              </span>
              <button
                className={styles.downloadBtn}
                onClick={() => onDownload(notice)}
                disabled={downloadingId === notice.id}
              >
                <DownloadIcon />
                {downloadingId === notice.id ? 'Laddar…' : 'Ladda ned PDF'}
              </button>
            </div>
            {errorByRow[notice.id] && <p className={styles.errorRow}>{errorByRow[notice.id]}</p>}
          </div>
        )
      })}
    </div>
  )
}

// ── Fakturor ──────────────────────────────────────────────────────────────────

function InvoicesList({
  query,
  filter,
  downloadingId,
  errorByRow,
  onDownload,
}: {
  query: ReturnType<typeof useQuery<PortalInvoice[]>>
  filter: Filter
  downloadingId: string | null
  errorByRow: Record<string, string>
  onDownload: (inv: PortalInvoice) => void
}) {
  if (query.isLoading) return <Spinner size="md" label="Laddar fakturor..." />
  if (query.isError || !query.data) {
    return <ErrorCard isUnderConstruction onRetry={() => void query.refetch()} />
  }

  const filtered = query.data
    .filter((inv) => {
      if (filter === 'unpaid') return UNPAID_INVOICE_STATUSES.has(inv.status)
      if (filter === 'paid') return PAID_INVOICE_STATUSES.has(inv.status)
      return true
    })
    .sort((a, b) => {
      const aUnpaid = UNPAID_INVOICE_STATUSES.has(a.status) ? 0 : 1
      const bUnpaid = UNPAID_INVOICE_STATUSES.has(b.status) ? 0 : 1
      if (aUnpaid !== bUnpaid) return aUnpaid - bUnpaid
      return new Date(b.dueDate).getTime() - new Date(a.dueDate).getTime()
    })

  if (filtered.length === 0) return <EmptyState label="Inga fakturor att visa" />

  return (
    <div className={styles.list}>
      {filtered.map((invoice) => {
        const overdue = isInvoiceOverdue(invoice)
        return (
          <div key={invoice.id} className={`${styles.card} ${overdue ? styles.cardOverdue : ''}`}>
            <div className={styles.cardTop}>
              <p className={styles.cardMonth} style={{ textTransform: 'capitalize' }}>
                {formatDateSv(invoice.issueDate)}
              </p>
              <StatusBadge type="invoice" status={invoice.status} />
            </div>

            <p className={styles.cardAmount}>{formatCurrencySv(invoice.total)}</p>

            <div className={styles.cardDueRow}>
              <span
                className={`${styles.cardDueLabel} ${overdue ? styles.cardDueLabelOverdue : ''}`}
              >
                {overdue ? '⚠️ Förfallen' : 'Förfaller'}
              </span>
              <span className={styles.cardDueDate}>{formatDateSv(invoice.dueDate)}</span>
            </div>

            {invoice.paidAt && (
              <div className={styles.paidRow}>
                <span className={styles.paidText}>✓ Betald {formatDateSv(invoice.paidAt)}</span>
              </div>
            )}

            <div className={styles.cardOcr}>
              <span className={styles.cardOcrLabel}>Fakturanummer</span>
              <span className={styles.cardOcrValue}>{invoice.invoiceNumber}</span>
            </div>

            <div className={styles.cardFooter}>
              <span className={styles.cardProperty}>
                {invoice.propertyName} · {invoice.unitName}
              </span>
              <button
                className={styles.downloadBtn}
                onClick={() => onDownload(invoice)}
                disabled={downloadingId === invoice.id}
              >
                <DownloadIcon />
                {downloadingId === invoice.id ? 'Laddar…' : 'Ladda ned PDF'}
              </button>
            </div>
            {errorByRow[invoice.id] && <p className={styles.errorRow}>{errorByRow[invoice.id]}</p>}
          </div>
        )
      })}
    </div>
  )
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ label }: { label: string }) {
  return (
    <div className={styles.empty}>
      <div className={styles.emptyIconWrap}>
        <svg width="32" height="32" viewBox="0 0 22 22" fill="none">
          <rect x="3" y="4" width="16" height="15" rx="2" stroke="#aaa" strokeWidth="1.5" />
          <line x1="3" y1="8" x2="19" y2="8" stroke="#aaa" strokeWidth="1" />
          <line x1="7" y1="12" x2="15" y2="12" stroke="#aaa" strokeWidth="1" opacity="0.6" />
          <line x1="7" y1="15" x2="12" y2="15" stroke="#aaa" strokeWidth="1" opacity="0.4" />
        </svg>
      </div>
      <p className={styles.emptyText}>{label}</p>
    </div>
  )
}
