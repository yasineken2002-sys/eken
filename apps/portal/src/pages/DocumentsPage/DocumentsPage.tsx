import { useQuery } from '@tanstack/react-query'
import { fetchDocuments } from '@/api/portal.api'
import { useSessionStore } from '@/store/session.store'
import { Spinner } from '@/components/ui/Spinner'
import { ErrorCard } from '@/components/ui/ErrorCard'
import type { PortalDocument } from '@/types/portal.types'
import styles from './DocumentsPage.module.css'

const CATEGORY_LABELS: Record<string, string> = {
  LEASE: 'Hyresavtal',
  INVOICE: 'Faktura',
  INSPECTION: 'Besiktning',
  NOTICE: 'Meddelande',
  OTHER: 'Övrigt',
}

function getFileIconStyle(mimeType: string): { bg: string; color: string } {
  if (mimeType === 'application/pdf') return { bg: '#fce8e8', color: '#ef4444' }
  if (mimeType.startsWith('image/')) return { bg: '#e0f2fe', color: '#0284c7' }
  return { bg: '#f1f5f9', color: '#64748b' }
}

function FileIcon({ mimeType }: { mimeType: string }) {
  if (mimeType === 'application/pdf') {
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <rect x="3" y="2" width="14" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M7 6h6M7 9h6M7 12h4"
          stroke="currentColor"
          strokeWidth="1"
          strokeLinecap="round"
          opacity="0.7"
        />
        <path d="M12 2v4h4" stroke="currentColor" strokeWidth="1" opacity="0.4" />
      </svg>
    )
  }
  if (mimeType.startsWith('image/')) {
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <rect x="2" y="4" width="16" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="7" cy="9" r="1.5" stroke="currentColor" strokeWidth="1" />
        <path
          d="M2 13l4-4 4 4 3-3 5 5"
          stroke="currentColor"
          strokeWidth="1"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.7"
        />
      </svg>
    )
  }
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <rect x="3" y="2" width="14" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <line x1="6" y1="7" x2="14" y2="7" stroke="currentColor" strokeWidth="1" opacity="0.6" />
      <line x1="6" y1="10" x2="14" y2="10" stroke="currentColor" strokeWidth="1" opacity="0.4" />
      <line x1="6" y1="13" x2="10" y2="13" stroke="currentColor" strokeWidth="1" opacity="0.3" />
    </svg>
  )
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDateSv(dateStr: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(dateStr))
}

function DocumentCard({ doc }: { doc: PortalDocument }) {
  const sessionToken = useSessionStore((s) => s.sessionToken)
  const iconStyle = getFileIconStyle(doc.mimeType)
  const category = CATEGORY_LABELS[doc.category] ?? doc.category

  function handleDownload() {
    const url = `/api/portal/documents/${doc.id}/download?session=${sessionToken ?? ''}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className={styles.card}>
      <div className={styles.cardLeft}>
        <div
          className={styles.fileIcon}
          style={{ background: iconStyle.bg, color: iconStyle.color }}
        >
          <FileIcon mimeType={doc.mimeType} />
        </div>
        <div className={styles.docInfo}>
          <p className={styles.docName}>{doc.name}</p>
          <p className={styles.docMeta}>
            {category} · {formatFileSize(doc.fileSize)} · {formatDateSv(doc.createdAt)}
          </p>
          {doc.description && <p className={styles.docDesc}>{doc.description}</p>}
        </div>
      </div>
      <button className={styles.downloadBtn} onClick={handleDownload}>
        Ladda ned
      </button>
    </div>
  )
}

export function DocumentsPage() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['portal', 'documents'],
    queryFn: fetchDocuments,
  })

  if (isLoading) return <Spinner size="md" label="Laddar dokument..." />
  if (isError || !data) {
    return <ErrorCard isUnderConstruction onRetry={() => void refetch()} />
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.pageTitle}>Mina dokument</h1>
      </div>

      {data.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyIconWrap}>
            <svg width="32" height="32" viewBox="0 0 22 22" fill="none">
              <rect x="5" y="3" width="12" height="16" rx="2" stroke="#aaa" strokeWidth="1.5" />
              <line x1="8" y1="8" x2="14" y2="8" stroke="#aaa" strokeWidth="1" opacity="0.6" />
              <line x1="8" y1="11" x2="14" y2="11" stroke="#aaa" strokeWidth="1" opacity="0.4" />
            </svg>
          </div>
          <p className={styles.emptyText}>Inga dokument uppladdade ännu</p>
        </div>
      ) : (
        <div className={styles.list}>
          {data.map((doc) => (
            <DocumentCard key={doc.id} doc={doc} />
          ))}
        </div>
      )}
    </div>
  )
}
