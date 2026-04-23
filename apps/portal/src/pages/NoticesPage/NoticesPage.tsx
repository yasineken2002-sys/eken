import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchInvoices } from '@/api/portal.api'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Spinner } from '@/components/ui/Spinner'
import { ErrorCard } from '@/components/ui/ErrorCard'
import type { PortalInvoice } from '@/types/portal.types'
import styles from './NoticesPage.module.css'

type Filter = 'all' | 'unpaid' | 'paid'

const UNPAID_STATUSES = new Set(['SENT', 'OVERDUE', 'PARTIAL'])
const PAID_STATUSES = new Set(['PAID'])

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

function formatMonthYear(dateStr: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    month: 'long',
    year: 'numeric',
  }).format(new Date(dateStr))
}

function isOverdue(invoice: PortalInvoice): boolean {
  return (
    invoice.status === 'OVERDUE' ||
    (UNPAID_STATUSES.has(invoice.status) && new Date(invoice.dueDate) < new Date())
  )
}

export function NoticesPage() {
  const [filter, setFilter] = useState<Filter>('all')

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['portal', 'invoices'],
    queryFn: fetchInvoices,
  })

  if (isLoading) return <Spinner size="md" label="Laddar avier..." />
  if (isError || !data) {
    return <ErrorCard isUnderConstruction onRetry={() => void refetch()} />
  }

  const filtered = data
    .filter((inv) => {
      if (filter === 'unpaid') return UNPAID_STATUSES.has(inv.status)
      if (filter === 'paid') return PAID_STATUSES.has(inv.status)
      return true
    })
    .sort((a, b) => {
      const aUnpaid = UNPAID_STATUSES.has(a.status) ? 0 : 1
      const bUnpaid = UNPAID_STATUSES.has(b.status) ? 0 : 1
      if (aUnpaid !== bUnpaid) return aUnpaid - bUnpaid
      return new Date(b.dueDate).getTime() - new Date(a.dueDate).getTime()
    })

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.pageTitle}>Mina hyresavier</h1>
      </div>

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

      {filtered.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyIconWrap}>
            <svg width="32" height="32" viewBox="0 0 22 22" fill="none">
              <rect x="3" y="4" width="16" height="15" rx="2" stroke="#aaa" strokeWidth="1.5" />
              <line x1="3" y1="8" x2="19" y2="8" stroke="#aaa" strokeWidth="1" />
              <line x1="7" y1="12" x2="15" y2="12" stroke="#aaa" strokeWidth="1" opacity="0.6" />
              <line x1="7" y1="15" x2="12" y2="15" stroke="#aaa" strokeWidth="1" opacity="0.4" />
            </svg>
          </div>
          <p className={styles.emptyText}>Inga avier att visa</p>
        </div>
      ) : (
        <div className={styles.list}>
          {filtered.map((invoice) => (
            <div
              key={invoice.id}
              className={`${styles.card} ${isOverdue(invoice) ? styles.cardOverdue : ''}`}
            >
              <div className={styles.cardTop}>
                <p className={styles.cardMonth} style={{ textTransform: 'capitalize' }}>
                  {formatMonthYear(invoice.issueDate)}
                </p>
                <StatusBadge type="invoice" status={invoice.status} />
              </div>

              <p className={styles.cardAmount}>{formatCurrencySv(invoice.total)}</p>

              <div className={styles.cardDueRow}>
                <span
                  className={`${styles.cardDueLabel} ${isOverdue(invoice) ? styles.cardDueLabelOverdue : ''}`}
                >
                  {isOverdue(invoice) ? '⚠️ Förfallen' : 'Förfaller'}
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
                <button className={styles.downloadBtn} disabled>
                  Ladda ned PDF
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
