import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchMaintenanceTickets,
  addTicketComment,
  submitMaintenanceRequest,
} from '@/api/portal.api'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Spinner } from '@/components/ui/Spinner'
import { ErrorCard } from '@/components/ui/ErrorCard'
import type { PortalMaintenanceTicket } from '@/types/portal.types'
import styles from './MaintenancePage.module.css'

const CATEGORIES: { value: string; label: string; bg: string; color: string }[] = [
  { value: 'PLUMBING', label: 'VVS', bg: '#e0f2fe', color: '#0284c7' },
  { value: 'ELECTRICAL', label: 'El', bg: '#fef9c3', color: '#ca8a04' },
  { value: 'HEATING', label: 'Värme/Ventilation', bg: '#fee2e2', color: '#dc2626' },
  { value: 'LOCKS', label: 'Lås/Dörrar', bg: '#f3e8ff', color: '#9333ea' },
  { value: 'WINDOWS', label: 'Fönster', bg: '#dcfce7', color: '#16a34a' },
  { value: 'APPLIANCES', label: 'Reparation', bg: '#fff7ed', color: '#ea580c' },
  { value: 'OTHER', label: 'Övrigt', bg: '#f1f5f9', color: '#64748b' },
]

function getCategoryStyle(value: string) {
  return CATEGORIES.find((c) => c.value === value) ?? CATEGORIES[CATEGORIES.length - 1]!
}

function formatDateSv(dateStr: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(dateStr))
}

function CategoryDot({ category }: { category: string }) {
  const cat = getCategoryStyle(category)
  return (
    <div
      style={{
        width: 40,
        height: 40,
        borderRadius: '50%',
        background: cat.bg,
        color: cat.color,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        fontSize: 13,
        fontWeight: 700,
      }}
    >
      {cat.label.slice(0, 2)}
    </div>
  )
}

function TicketCard({ ticket }: { ticket: PortalMaintenanceTicket }) {
  const [expanded, setExpanded] = useState(false)
  const [comment, setComment] = useState('')
  const [sending, setSending] = useState(false)
  const queryClient = useQueryClient()

  const publicComments = ticket.comments.filter((c) => !c.isInternal)

  async function handleComment() {
    if (!comment.trim()) return
    setSending(true)
    try {
      await addTicketComment(ticket.id, comment.trim())
      setComment('')
      await queryClient.invalidateQueries({ queryKey: ['portal', 'maintenance'] })
    } finally {
      setSending(false)
    }
  }

  return (
    <div className={styles.ticketCard}>
      <div className={styles.ticketRow} onClick={() => setExpanded((v) => !v)}>
        <CategoryDot category={ticket.category} />
        <div className={styles.ticketCenter}>
          <p className={styles.ticketTitle}>{ticket.title}</p>
          <p className={styles.ticketDate}>{formatDateSv(ticket.createdAt)}</p>
        </div>
        <div className={styles.ticketRight}>
          <StatusBadge type="maintenance" status={ticket.status} />
          <span className={styles.ticketChevron}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {expanded && (
        <div className={styles.ticketBody}>
          <p className={styles.ticketDescription}>{ticket.description}</p>

          {publicComments.length > 0 && (
            <div className={styles.comments}>
              <p className={styles.commentsTitle}>Meddelanden</p>
              {publicComments.map((c) => (
                <div key={c.id} className={styles.comment}>
                  <p className={styles.commentContent}>{c.content}</p>
                  <p className={styles.commentDate}>{formatDateSv(c.createdAt)}</p>
                </div>
              ))}
            </div>
          )}

          <div className={styles.commentForm}>
            <textarea
              className={styles.commentInput}
              placeholder="Lägg till ett meddelande..."
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
            />
            <button
              className={styles.commentBtn}
              onClick={() => void handleComment()}
              disabled={!comment.trim() || sending}
            >
              {sending ? 'Skickar...' : 'Skicka'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function MaintenancePage() {
  const [showSheet, setShowSheet] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('OTHER')
  const [images, setImages] = useState<File[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['portal', 'maintenance'],
    queryFn: fetchMaintenanceTickets,
  })

  const handleSubmit = async () => {
    if (!title.trim() || !description.trim()) return
    setIsSubmitting(true)
    try {
      await submitMaintenanceRequest({
        title: title.trim(),
        description: description.trim(),
        category,
      })
      setShowSheet(false)
      setTitle('')
      setDescription('')
      setImages([])
      setCategory('OTHER')
      void refetch()
    } catch {
      alert('Kunde inte skicka felanmälan. Försök igen.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.pageTitle}>Felanmälningar</h1>
      </div>

      {isLoading && <Spinner size="md" label="Laddar ärenden..." />}
      {(isError || (!data && !isLoading)) && (
        <ErrorCard isUnderConstruction onRetry={() => void refetch()} />
      )}

      {data && (
        <div className={styles.list}>
          {data.length === 0 ? (
            <div className={styles.empty}>
              <div className={styles.emptyIconWrap}>
                <svg width="32" height="32" viewBox="0 0 22 22" fill="none">
                  <circle cx="11" cy="8" r="3.5" stroke="#aaa" strokeWidth="1.5" />
                  <path
                    d="M4 20 Q4 14 11 14 Q18 14 18 20"
                    stroke="#aaa"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
              <p className={styles.emptyTitle}>Inga felanmälningar</p>
              <p className={styles.emptyText}>Tryck på + för att rapportera ett fel</p>
            </div>
          ) : (
            data.map((ticket) => <TicketCard key={ticket.id} ticket={ticket} />)
          )}
        </div>
      )}

      {/* Floating action button */}
      <button className={styles.fab} onClick={() => setShowSheet(true)} aria-label="Ny felanmälan">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <line
            x1="12"
            y1="5"
            x2="12"
            y2="19"
            stroke="white"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          <line
            x1="5"
            y1="12"
            x2="19"
            y2="12"
            stroke="white"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {/* Bottom sheet backdrop */}
      {showSheet && <div className={styles.backdrop} onClick={() => setShowSheet(false)} />}

      {/* Bottom sheet */}
      <div
        style={{
          position: 'fixed',
          bottom: 0,
          left: '50%',
          transform: showSheet
            ? 'translateX(-50%) translateY(0)'
            : 'translateX(-50%) translateY(100%)',
          width: '100%',
          maxWidth: 480,
          background: 'white',
          borderRadius: '24px 24px 0 0',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 200,
          transition: 'transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)',
        }}
      >
        {/* Fixed header — not scrollable */}
        <div style={{ padding: '16px 20px 0', flexShrink: 0 }}>
          <div className={styles.sheetHandle} />
          <h2 className={styles.sheetTitle}>Ny felanmälan</h2>
        </div>
        {/* Scrollable content */}
        <div style={{ overflowY: 'auto', flex: 1, padding: '0 20px 20px' }}>
          <div className={styles.form}>
            {/* Category chips */}
            <div className={styles.categoryRow}>
              {CATEGORIES.map((cat) => (
                <button
                  key={cat.value}
                  type="button"
                  className={`${styles.catChip} ${category === cat.value ? styles.catChipActive : ''}`}
                  style={
                    category === cat.value
                      ? { background: cat.bg, color: cat.color, borderColor: cat.color }
                      : {}
                  }
                  onClick={() => setCategory(cat.value)}
                >
                  {cat.label}
                </button>
              ))}
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="mt-title">
                Rubrik *
              </label>
              <input
                id="mt-title"
                className={styles.input}
                type="text"
                placeholder="Kortfattad beskrivning av problemet"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="mt-desc">
                Beskrivning *
              </label>
              <textarea
                id="mt-desc"
                className={styles.textarea}
                placeholder="Beskriv problemet i detalj"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
              />
            </div>

            {/* Image upload */}
            <div style={{ marginTop: '16px' }}>
              <p style={{ fontSize: '13px', color: '#888', marginBottom: '8px' }}>
                Bilder (valfritt, max 5)
              </p>
              <label
                style={{
                  display: 'block',
                  border: '1.5px dashed #ccc',
                  borderRadius: '12px',
                  padding: '16px',
                  textAlign: 'center',
                  cursor: 'pointer',
                  color: '#888',
                  fontSize: '13px',
                }}
              >
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []).slice(0, 5)
                    setImages(files)
                  }}
                />
                {images.length > 0 ? `${images.length} bild(er) valda` : '+ Lägg till bilder'}
              </label>
              {images.length > 0 && (
                <div style={{ display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' }}>
                  {images.map((img, i) => (
                    <div
                      key={i}
                      style={{
                        width: '60px',
                        height: '60px',
                        borderRadius: '8px',
                        background: '#f0f0f0',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '11px',
                        color: '#888',
                        overflow: 'hidden',
                      }}
                    >
                      <img
                        src={URL.createObjectURL(img)}
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        alt=""
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Cancel link */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '8px' }}>
              <button
                type="button"
                className={styles.cancelBtn}
                onClick={() => setShowSheet(false)}
              >
                Avbryt
              </button>
            </div>

            {/* Full-width submit button */}
            <button
              onClick={() => void handleSubmit()}
              disabled={isSubmitting || !title.trim() || !description.trim()}
              style={{
                width: '100%',
                padding: '14px',
                background: isSubmitting ? '#888' : '#1a6b3c',
                color: 'white',
                border: 'none',
                borderRadius: '12px',
                fontSize: '15px',
                fontWeight: 500,
                cursor:
                  isSubmitting || !title.trim() || !description.trim() ? 'not-allowed' : 'pointer',
                marginTop: '16px',
                opacity: !title.trim() || !description.trim() ? 0.6 : 1,
              }}
            >
              {isSubmitting ? 'Skickar...' : 'Skicka felanmälan'}
            </button>
          </div>
        </div>{' '}
        {/* end scrollable */}
      </div>
    </div>
  )
}
