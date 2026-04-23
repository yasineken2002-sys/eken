import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchNews } from '@/api/portal.api'
import { Spinner } from '@/components/ui/Spinner'
import { ErrorCard } from '@/components/ui/ErrorCard'
import styles from './NewsPage.module.css'

function formatDateSv(dateStr: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(dateStr))
}

export function NewsPage() {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['portal', 'news'],
    queryFn: fetchNews,
  })

  if (isLoading) return <Spinner size="md" label="Laddar nyheter..." />
  if (isError || !data) {
    return <ErrorCard isUnderConstruction onRetry={() => void refetch()} />
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
          {data.map((post) => {
            const isExpanded = expandedId === post.id
            return (
              <div key={post.id} className={styles.card}>
                {post.imageUrl && (
                  <img
                    src={post.imageUrl}
                    alt={post.title}
                    className={styles.image}
                    loading="lazy"
                  />
                )}
                <div className={styles.cardBody}>
                  <p className={styles.date}>{formatDateSv(post.publishedAt)}</p>
                  <h2 className={styles.title}>{post.title}</h2>
                  <p className={`${styles.body} ${isExpanded ? styles.bodyExpanded : ''}`}>
                    {post.body}
                  </p>
                  <button
                    className={styles.toggleBtn}
                    onClick={() => setExpandedId(isExpanded ? null : post.id)}
                  >
                    {isExpanded ? 'Stäng' : 'Läs mer'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
