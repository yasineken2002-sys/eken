import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  fetchInvoices,
  fetchRentNotices,
  downloadInvoicePdf,
  downloadRentNoticePdf,
  extractApiError,
} from '@/api/portal.api'
import { Spinner } from '@/components/ui/Spinner'
import { ErrorCard } from '@/components/ui/ErrorCard'
import { EvDownload, EvReceipt } from '@/components/ui/EvenoIcons'
import type { PortalInvoice, PortalRentNotice } from '@/types/portal.types'

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

function formatDateIso(dateStr: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date(dateStr))
    .replace(/\//g, '-')
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

function rentBadge(status: PortalRentNotice['status'], overdue: boolean) {
  if (overdue) {
    return (
      <span className="ev-badge danger">
        <span className="ev-badge-dot"></span>
        Förfallen
      </span>
    )
  }
  if (status === 'PAID') {
    return (
      <span className="ev-badge success">
        <span className="ev-badge-dot"></span>
        Betald
      </span>
    )
  }
  if (status === 'SENT') {
    return (
      <span className="ev-badge info">
        <span className="ev-badge-dot"></span>
        Att betala
      </span>
    )
  }
  return (
    <span className="ev-badge ghost">
      <span className="ev-badge-dot"></span>
      {status === 'PENDING' ? 'Förbereds' : status === 'CANCELLED' ? 'Makulerad' : status}
    </span>
  )
}

function invoiceBadge(status: PortalInvoice['status'], overdue: boolean) {
  if (overdue) {
    return (
      <span className="ev-badge danger">
        <span className="ev-badge-dot"></span>
        Förfallen
      </span>
    )
  }
  if (status === 'PAID') {
    return (
      <span className="ev-badge success">
        <span className="ev-badge-dot"></span>
        Betald
      </span>
    )
  }
  if (status === 'SENT') {
    return (
      <span className="ev-badge info">
        <span className="ev-badge-dot"></span>
        Att betala
      </span>
    )
  }
  if (status === 'PARTIAL') {
    return (
      <span className="ev-badge warning">
        <span className="ev-badge-dot"></span>
        Delvis betald
      </span>
    )
  }
  return (
    <span className="ev-badge ghost">
      <span className="ev-badge-dot"></span>
      {status === 'DRAFT' ? 'Utkast' : status === 'VOID' ? 'Makulerad' : status}
    </span>
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
    <div className="ev-page ev-view-enter">
      {/* Top tabs — Avier vs Fakturor */}
      <div className="ev-tab-bar">
        <button
          type="button"
          className={`ev-tab${topTab === 'rent-notices' ? 'active' : ''}`}
          onClick={() => {
            setTopTab('rent-notices')
            setFilter('all')
          }}
        >
          Avier
        </button>
        <button
          type="button"
          className={`ev-tab${topTab === 'invoices' ? 'active' : ''}`}
          onClick={() => {
            setTopTab('invoices')
            setFilter('all')
          }}
        >
          Fakturor
        </button>
      </div>

      {/* Status filter */}
      <div className="ev-chip-row" style={{ marginBottom: 16 }}>
        {(['all', 'unpaid', 'paid'] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={`ev-chip${filter === f ? 'selected' : ''}`}
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
    <div className="ev-stack" style={{ gap: 10 }}>
      {filtered.map((notice) => {
        const overdue = isNoticeOverdue(notice)
        const paid = notice.status === 'PAID'
        return (
          <div key={notice.id}>
            <button
              type="button"
              className={`ev-invoice-row${overdue ? 'priority' : ''}${paid ? 'paid' : ''}`}
              onClick={() => {}}
            >
              <div className="ev-invoice-row-body">
                <div className="ev-invoice-row-title" style={{ textTransform: 'capitalize' }}>
                  Hyra {formatMonthYear(notice.month, notice.year)}
                  {rentBadge(notice.status, overdue)}
                </div>
                <div className="ev-invoice-row-sub">
                  {notice.propertyName} · {notice.unitName}
                </div>
                <div className="ev-invoice-row-meta">
                  {paid && notice.paidAt
                    ? `Betald ${formatDateIso(notice.paidAt)}`
                    : overdue
                      ? `Förföll ${formatDateIso(notice.dueDate)}`
                      : `Förfaller ${formatDateIso(notice.dueDate)}`}
                  {' · OCR '}
                  {notice.ocrNumber}
                </div>
              </div>
              <div className="ev-invoice-row-right">
                <div className="ev-invoice-row-amount">{formatCurrencySv(notice.totalAmount)}</div>
                <button
                  type="button"
                  className="ev-invoice-dl-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDownload(notice)
                  }}
                  disabled={downloadingId === notice.id}
                  aria-label="Ladda ner PDF"
                >
                  <EvDownload size={14} />
                </button>
              </div>
            </button>
            {errorByRow[notice.id] && (
              <p
                style={{
                  fontSize: 12,
                  color: 'var(--color-danger)',
                  marginTop: 4,
                  paddingLeft: 4,
                }}
              >
                {errorByRow[notice.id]}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}

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
    <div className="ev-stack" style={{ gap: 10 }}>
      {filtered.map((invoice) => {
        const overdue = isInvoiceOverdue(invoice)
        const paid = invoice.status === 'PAID'
        return (
          <div key={invoice.id}>
            <button
              type="button"
              className={`ev-invoice-row${overdue ? 'priority' : ''}${paid ? 'paid' : ''}`}
              onClick={() => {}}
            >
              <div className="ev-invoice-row-body">
                <div className="ev-invoice-row-title">
                  Faktura {invoice.invoiceNumber}
                  {invoiceBadge(invoice.status, overdue)}
                </div>
                <div className="ev-invoice-row-sub">
                  {invoice.propertyName} · {invoice.unitName}
                </div>
                <div className="ev-invoice-row-meta">
                  {paid && invoice.paidAt
                    ? `Betald ${formatDateIso(invoice.paidAt)}`
                    : overdue
                      ? `Förföll ${formatDateIso(invoice.dueDate)}`
                      : `Förfaller ${formatDateIso(invoice.dueDate)}`}
                </div>
              </div>
              <div className="ev-invoice-row-right">
                <div className="ev-invoice-row-amount">{formatCurrencySv(invoice.total)}</div>
                <button
                  type="button"
                  className="ev-invoice-dl-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDownload(invoice)
                  }}
                  disabled={downloadingId === invoice.id}
                  aria-label="Ladda ner PDF"
                >
                  <EvDownload size={14} />
                </button>
              </div>
            </button>
            {errorByRow[invoice.id] && (
              <p
                style={{
                  fontSize: 12,
                  color: 'var(--color-danger)',
                  marginTop: 4,
                  paddingLeft: 4,
                }}
              >
                {errorByRow[invoice.id]}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="ev-empty">
      <div className="ev-empty-icon">
        <EvReceipt size={24} />
      </div>
      <div className="ev-empty-title">{label}</div>
      <div className="ev-empty-text">När din hyresvärd skickar en ny avi visas den här direkt.</div>
    </div>
  )
}
