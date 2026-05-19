import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchMaintenanceTickets,
  addTicketComment,
  submitMaintenanceRequest,
  uploadMaintenanceImages,
} from '@/api/portal.api'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Spinner } from '@/components/ui/Spinner'
import { ErrorCard } from '@/components/ui/ErrorCard'
import {
  EvWrench,
  EvDroplet,
  EvZap,
  EvFlame,
  EvHammer,
  EvCamera,
  EvSparkles,
  EvX,
  EvPlus,
} from '@/components/ui/EvenoIcons'
import type { PortalMaintenanceTicket } from '@/types/portal.types'

interface CategoryDef {
  value: string
  label: string
  Icon: typeof EvWrench
}

const CATEGORIES: CategoryDef[] = [
  { value: 'PLUMBING', label: 'VVS / Vatten', Icon: EvDroplet },
  { value: 'ELECTRICAL', label: 'El', Icon: EvZap },
  { value: 'HEATING', label: 'Värme', Icon: EvFlame },
  { value: 'OTHER', label: 'Övrigt', Icon: EvHammer },
]

const ROOMS = ['Kök', 'Badrum', 'Sovrum', 'Vardagsrum', 'Hall', 'Annat']

function formatDateSv(dateStr: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(dateStr))
}

function categoryStyle(value: string): { Icon: typeof EvWrench } {
  return CATEGORIES.find((c) => c.value === value) ?? { Icon: EvHammer }
}

function TicketCard({ ticket }: { ticket: PortalMaintenanceTicket }) {
  const [expanded, setExpanded] = useState(false)
  const [comment, setComment] = useState('')
  const [sending, setSending] = useState(false)
  const queryClient = useQueryClient()

  const publicComments = ticket.comments.filter((c) => !c.isInternal)
  const { Icon } = categoryStyle(ticket.category)

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
    <div className="ev-ticket-card">
      <div
        className="ev-ticket-row"
        onClick={() => setExpanded((v) => !v)}
        role="button"
        tabIndex={0}
      >
        <div className="ev-ticket-icon">
          <Icon size={18} />
        </div>
        <div className="ev-ticket-center">
          <div className="ev-ticket-title">{ticket.title}</div>
          <div className="ev-ticket-date">{formatDateSv(ticket.createdAt)}</div>
        </div>
        <div className="ev-ticket-right">
          <StatusBadge type="maintenance" status={ticket.status} />
          <span className="ev-ticket-chevron">{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {expanded && (
        <div className="ev-ticket-body">
          <p className="ev-ticket-desc">{ticket.description}</p>

          {publicComments.length > 0 && (
            <div className="ev-ticket-comments">
              <div className="ev-ticket-comments-title">Meddelanden</div>
              {publicComments.map((c) => (
                <div key={c.id} className="ev-ticket-comment">
                  <div className="ev-ticket-comment-text">{c.content}</div>
                  <div className="ev-ticket-comment-date">{formatDateSv(c.createdAt)}</div>
                </div>
              ))}
            </div>
          )}

          <div className="ev-ticket-comment-form">
            <textarea
              placeholder="Lägg till ett meddelande…"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
            />
            <button
              type="button"
              className="ev-btn ev-btn-primary"
              style={{ height: 38 }}
              onClick={() => void handleComment()}
              disabled={!comment.trim() || sending}
            >
              {sending ? 'Skickar…' : 'Skicka'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function MaintenancePage() {
  const [showSheet, setShowSheet] = useState(false)
  const [category, setCategory] = useState<string>('OTHER')
  const [room, setRoom] = useState<string | null>(null)
  const [description, setDescription] = useState('')
  const [urgent, setUrgent] = useState(false)
  const [images, setImages] = useState<File[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['portal', 'maintenance'],
    queryFn: fetchMaintenanceTickets,
  })

  const showAiTip = description.trim().length > 0 && description.trim().length < 30
  const canSubmit = !!room && description.trim().length > 8

  function improveText() {
    if (!description.trim()) return
    setDescription(
      'Det läcker vatten från avloppsröret under diskbänken i köket. Pölen växer ' +
        'när vi använder kranen och vi har lagt en hink under för att samla upp vattnet.',
    )
  }

  function resetForm() {
    setCategory('OTHER')
    setRoom(null)
    setDescription('')
    setUrgent(false)
    setImages([])
  }

  function addImagesFromInput(files: FileList | null) {
    if (!files) return
    const next = [...images, ...Array.from(files)].slice(0, 5)
    setImages(next)
  }

  function removeImage(index: number) {
    setImages(images.filter((_, i) => i !== index))
  }

  async function handleSubmit() {
    if (!canSubmit) return
    setIsSubmitting(true)
    try {
      const title = `${CATEGORIES.find((c) => c.value === category)?.label ?? 'Övrigt'} – ${room ?? 'Annat'}`
      const body =
        `${description.trim()}\n\nRum: ${room ?? '–'}` + (urgent ? '\n⚠️ Brådskande: ja' : '')
      const ticket = await submitMaintenanceRequest({
        title,
        description: body,
        category,
      })
      if (images.length > 0) {
        try {
          await uploadMaintenanceImages(ticket.id, images)
        } catch (err) {
          console.error('[maintenance] kunde inte ladda upp bilder', err)
        }
      }
      setShowSheet(false)
      resetForm()
      void refetch()
    } catch {
      // Sonner-mutationcache visar redan API-felmeddelandet
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="ev-page ev-view-enter">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 16,
        }}
      >
        <h1
          style={{
            fontSize: 22,
            fontWeight: 500,
            letterSpacing: '-0.02em',
            color: 'var(--color-fg-1)',
          }}
        >
          Mina ärenden
        </h1>
        <button
          type="button"
          className="ev-btn ev-btn-primary"
          style={{ height: 36, padding: '0 14px', fontSize: 13.5 }}
          onClick={() => setShowSheet(true)}
        >
          <EvPlus size={14} stroke={2.2} />
          Nytt
        </button>
      </div>

      {isLoading && <Spinner size="md" label="Laddar ärenden..." />}
      {(isError || (!data && !isLoading)) && (
        <ErrorCard isUnderConstruction onRetry={() => void refetch()} />
      )}

      {data && (
        <div className="ev-stack" style={{ gap: 10 }}>
          {data.length === 0 ? (
            <div className="ev-empty">
              <div className="ev-empty-icon">
                <EvWrench size={24} />
              </div>
              <div className="ev-empty-title">Inga felanmälningar</div>
              <div className="ev-empty-text">
                Tryck på "Nytt" högst upp för att rapportera ett fel i din lägenhet.
              </div>
              <button type="button" className="ev-empty-cta" onClick={() => setShowSheet(true)}>
                + Ny felanmälan
              </button>
            </div>
          ) : (
            data.map((ticket) => <TicketCard key={ticket.id} ticket={ticket} />)
          )}
        </div>
      )}

      {showSheet && (
        <>
          <div className="ev-sheet-backdrop" onClick={() => setShowSheet(false)} />
          <div className="ev-sheet">
            <div style={{ padding: '4px 20px 0', flexShrink: 0 }}>
              <div className="ev-sheet-handle" />
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingTop: 8,
                }}
              >
                <h2
                  style={{
                    fontSize: 17,
                    fontWeight: 500,
                    letterSpacing: '-0.02em',
                    color: 'var(--color-fg-1)',
                  }}
                >
                  Ny felanmälan
                </h2>
                <button
                  type="button"
                  className="ev-icon-btn"
                  onClick={() => setShowSheet(false)}
                  aria-label="Stäng"
                >
                  <EvX size={18} />
                </button>
              </div>
            </div>

            <div style={{ overflowY: 'auto', flex: 1, padding: '16px 20px 0' }}>
              {/* Category */}
              <div className="ev-field">
                <label className="ev-field-label">Vad gäller det?</label>
                <div className="ev-cat-grid">
                  {CATEGORIES.map((c) => {
                    const Icon = c.Icon
                    return (
                      <button
                        key={c.value}
                        type="button"
                        className={`ev-cat-tile${category === c.value ? 'selected' : ''}`}
                        onClick={() => setCategory(c.value)}
                      >
                        <div className="ev-cat-tile-icon">
                          <Icon size={18} />
                        </div>
                        <div className="ev-cat-tile-label">{c.label}</div>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Room */}
              <div className="ev-field">
                <label className="ev-field-label">Var i lägenheten?</label>
                <div className="ev-chip-row">
                  {ROOMS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      className={`ev-chip${room === r ? 'selected' : ''}`}
                      onClick={() => setRoom(r)}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>

              {/* Description */}
              <div className="ev-field">
                <label className="ev-field-label" htmlFor="desc">
                  Beskrivning
                </label>
                <textarea
                  id="desc"
                  className="ev-textarea"
                  placeholder="Beskriv felet så detaljerat som möjligt…"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>

              {/* AI tip */}
              {showAiTip && (
                <div className="ev-ai-tip" style={{ marginBottom: 20 }}>
                  <div className="ev-ai-tip-icon">
                    <EvSparkles size={18} />
                  </div>
                  <div className="ev-ai-tip-body">
                    <div className="ev-ai-tip-title">
                      Beskrivningen kan bli tydligare. Vill du att jag förbättrar texten?
                    </div>
                    <button type="button" className="ev-ai-tip-btn" onClick={improveText}>
                      <EvSparkles size={12} stroke={2} />
                      Ja, förbättra
                    </button>
                  </div>
                </div>
              )}

              {/* Photos */}
              <div className="ev-field">
                <label className="ev-field-label">Bilder</label>
                <label className="ev-upload">
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    style={{ display: 'none' }}
                    onChange={(e) => addImagesFromInput(e.target.files)}
                  />
                  <div className="ev-upload-icon">
                    <EvCamera size={18} />
                  </div>
                  <div className="ev-upload-text">
                    {images.length === 0 ? 'Lägg till bild eller ta bild' : 'Lägg till fler'}
                  </div>
                  <div className="ev-upload-hint">
                    {images.length} / 5 bilder · jpg, png · max 10 MB
                  </div>
                  {images.length > 0 && (
                    <div
                      className="ev-upload-thumbs"
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                      }}
                    >
                      {images.map((img, i) => (
                        <div key={i} className="ev-thumb">
                          <img src={URL.createObjectURL(img)} alt="" />
                          <button
                            type="button"
                            className="ev-thumb-x"
                            onClick={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              removeImage(i)
                            }}
                            aria-label="Ta bort"
                          >
                            <EvX size={10} stroke={2.4} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </label>
              </div>

              {/* Urgent toggle */}
              <div className="ev-field">
                <div
                  className="ev-toggle-row"
                  onClick={() => setUrgent(!urgent)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="ev-toggle-row-body">
                    <div className="ev-toggle-row-title">Brådskande?</div>
                    <div className="ev-toggle-row-sub">Ja, jag behöver hjälp snabbt</div>
                  </div>
                  <div className={`ev-toggle${urgent ? 'on' : ''}`}></div>
                </div>
              </div>
            </div>

            {/* Submit (sticky inside sheet) */}
            <div
              style={{
                padding: '12px 20px calc(16px + env(safe-area-inset-bottom))',
                borderTop: '0.5px solid var(--color-border)',
                background: 'var(--color-surface)',
                flexShrink: 0,
              }}
            >
              <button
                type="button"
                className="ev-btn ev-btn-primary ev-btn-full"
                style={{ height: 48 }}
                disabled={!canSubmit || isSubmitting}
                onClick={() => void handleSubmit()}
              >
                {isSubmitting ? 'Skickar…' : 'Skicka felanmälan'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
