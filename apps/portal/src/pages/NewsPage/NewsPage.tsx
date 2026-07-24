import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchNews } from '@/api/portal.api'
import { Spinner } from '@/components/ui/Spinner'
import { ErrorCard } from '@/components/ui/ErrorCard'
import type { PortalNews } from '@/types/portal.types'
import { useFocusTrap } from '@eken/ui/hooks'
import styles from './NewsPage.module.css'

function formatDateSv(dateStr: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(dateStr))
}

function timeAgoSv(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return 'just nu'
  if (minutes < 60) return `${minutes} min sedan`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h sedan`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'igår'
  if (days < 7) return `${days} dagar sedan`
  return formatDateSv(dateStr)
}

function snippet(body: string, max = 140): string {
  const trimmed = body.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(0, max).trimEnd() + '…'
}

export function NewsPage() {
  const [activePost, setActivePost] = useState<PortalNews | null>(null)
  // PR5: focus-trap + Escape (dialogen hade redan role/aria-modal/aria-labelledby).
  const sheetRef = useFocusTrap<HTMLDivElement>(!!activePost)

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['portal', 'news'],
    queryFn: fetchNews,
  })

  // Lås body-scroll när bottom-sheet är öppen — annars scrollar bakgrunden
  // när användaren swipar i sheeten på iOS.
  useEffect(() => {
    if (!activePost) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [activePost])

  // Escape stänger bottom-sheeten (WCAG).
  useEffect(() => {
    if (!activePost) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActivePost(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [activePost])

  if (isLoading) return <Spinner size="md" label="Laddar nyheter..." />
  if (isError || !data) {
    return <ErrorCard onRetry={() => void refetch()} />
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.pageTitle}>Nyheter</h1>
      </div>

      {data.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyIconWrap}>
            <svg width="32" height="32" viewBox="0 0 22 22" fill="none">
              <rect x="4" y="3" width="14" height="16" rx="2" stroke="#aaa" strokeWidth="1.5" />
              <line x1="7" y1="8" x2="15" y2="8" stroke="#aaa" strokeWidth="1" opacity="0.6" />
              <line x1="7" y1="11" x2="15" y2="11" stroke="#aaa" strokeWidth="1" opacity="0.4" />
              <line x1="7" y1="14" x2="11" y2="14" stroke="#aaa" strokeWidth="1" opacity="0.3" />
            </svg>
          </div>
          <p className={styles.emptyText}>Inga nyheter publicerade ännu</p>
        </div>
      ) : (
        <div className={styles.list}>
          {data.map((post) => (
            <button
              key={post.id}
              type="button"
              className={styles.card}
              onClick={() => setActivePost(post)}
              aria-label={`Öppna nyhet: ${post.title}`}
            >
              {post.imageUrl && (
                <img src={post.imageUrl} alt={post.title} className={styles.image} loading="lazy" />
              )}
              <div className={styles.cardBody}>
                <p className={styles.date}>{timeAgoSv(post.publishedAt)}</p>
                <h2 className={styles.title}>{post.title}</h2>
                <p className={styles.bodyPreview}>{snippet(post.body)}</p>
                <span className={styles.toggleBtn}>Läs mer →</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Bottom-sheet med fullt nyhetsinnehåll */}
      {activePost && (
        <>
          <div
            className={styles.sheetBackdrop}
            onClick={() => setActivePost(null)}
            aria-hidden="true"
          />
          <div
            ref={sheetRef}
            className={styles.sheet}
            role="dialog"
            aria-modal="true"
            aria-labelledby="news-sheet-title"
          >
            <div className={styles.sheetHeader}>
              <div className={styles.sheetHandle} />
              <button
                type="button"
                className={styles.sheetClose}
                onClick={() => setActivePost(null)}
                aria-label="Stäng"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M6 6 L18 18 M18 6 L6 18"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>

            <div className={styles.sheetScroll}>
              {activePost.imageUrl && (
                <img
                  src={activePost.imageUrl}
                  alt={activePost.title}
                  className={styles.sheetImage}
                />
              )}
              <div className={styles.sheetContent}>
                <p className={styles.sheetMeta}>
                  {activePost.organizationName && (
                    <span className={styles.sheetOrg}>{activePost.organizationName}</span>
                  )}
                  {activePost.organizationName && <span aria-hidden="true"> · </span>}
                  <span>{formatDateSv(activePost.publishedAt)}</span>
                  <span aria-hidden="true"> · </span>
                  <span>{timeAgoSv(activePost.publishedAt)}</span>
                </p>
                <h2 id="news-sheet-title" className={styles.sheetTitle}>
                  {activePost.title}
                </h2>
                <div className={styles.sheetBody}>{activePost.body}</div>
                {activePost.authorName && (
                  <p className={styles.sheetAuthor}>– {activePost.authorName}</p>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
