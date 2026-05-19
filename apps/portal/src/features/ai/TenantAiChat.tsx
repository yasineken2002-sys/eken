import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { confirmAiAction, sendAiMessage, type TenantAiPendingAction } from '@/api/portal.api'
import { EvSparkles, EvSend, EvMic, EvX } from '@/components/ui/EvenoIcons'
import { useSessionStore } from '@/store/session.store'
import styles from './TenantAiChat.module.css'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}

const SUGGESTIONS = ['Hur betalar jag min hyra?', 'Lämna en felanmälan', 'Boka tid för besiktning']

interface Props {
  open: boolean
  onClose: () => void
  initialMessage?: string | undefined
}

function getInitials(): string {
  const tenant = useSessionStore.getState().tenant
  if (!tenant) return 'JD'
  if (tenant.type === 'COMPANY' && tenant.companyName) {
    const parts = tenant.companyName.trim().split(/\s+/)
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'EV'
  }
  const a = tenant.firstName?.[0] ?? ''
  const b = tenant.lastName?.[0] ?? ''
  return (a + b).toUpperCase() || 'EV'
}

function getFirstName(): string {
  const tenant = useSessionStore.getState().tenant
  if (!tenant) return ''
  if (tenant.type === 'COMPANY') return tenant.companyName ?? ''
  return tenant.firstName ?? ''
}

export function TenantAiChat({ open, onClose, initialMessage }: Props) {
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [pendingAction, setPendingAction] = useState<TenantAiPendingAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const initialSentRef = useRef<string | null>(null)
  const queryClient = useQueryClient()

  const sendMutation = useMutation({
    mutationFn: (msg: string) => sendAiMessage(msg, conversationId ?? undefined),
    onSuccess: (res, sentMsg) => {
      if (res.conversationId !== conversationId) {
        setConversationId(res.conversationId)
      }
      const next: ChatMessage[] = [
        ...messages,
        { id: `u-${Date.now()}`, role: 'user', content: sentMsg },
      ]
      if (res.pendingAction) {
        setPendingAction(res.pendingAction)
      } else if (res.reply) {
        next.push({ id: `a-${Date.now()}`, role: 'assistant', content: res.reply })
      }
      setMessages(next)
    },
    onError: (err: unknown) => {
      const message =
        err instanceof Error
          ? err.message
          : 'Något gick fel. Försök igen om en stund eller kontakta din hyresvärd direkt.'
      setError(message)
    },
  })

  const confirmMutation = useMutation({
    mutationFn: (confirmed: boolean) => {
      if (!pendingAction || !conversationId) {
        throw new Error('Ingen pågående åtgärd')
      }
      return confirmAiAction({
        toolName: pendingAction.toolName,
        toolInput: pendingAction.toolInput,
        conversationId,
        confirmed,
      })
    },
    onSuccess: (res) => {
      setPendingAction(null)
      if (res.reply) {
        setMessages((prev) => [
          ...prev,
          { id: `a-${Date.now()}`, role: 'assistant', content: res.reply },
        ])
      }
      void queryClient.invalidateQueries({ queryKey: ['portal'] })
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Åtgärden gick inte att slutföra.'
      setError(message)
    },
  })

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, pendingAction, sendMutation.isPending])

  useEffect(() => {
    if (!open) return
    if (initialMessage && initialMessage !== initialSentRef.current) {
      initialSentRef.current = initialMessage
      sendMutation.mutate(initialMessage)
    }
  }, [open, initialMessage, sendMutation])

  if (!open) return null

  const handleSend = (text?: string) => {
    const msg = (text ?? input).trim()
    if (!msg || sendMutation.isPending) return
    setError(null)
    setInput('')
    if (inputRef.current) inputRef.current.style.height = 'auto'
    sendMutation.mutate(msg)
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const ta = inputRef.current
    if (ta) {
      ta.style.height = 'auto'
      ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const showWelcome = messages.length === 0 && !sendMutation.isPending
  const initials = getInitials()
  const firstName = getFirstName()

  return (
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label="AI-assistent"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className={styles.drawer}>
        <div className="ev-sub-header">
          <button type="button" className="ev-icon-btn" onClick={onClose} aria-label="Stäng">
            <EvX size={20} />
          </button>
          <div className="ev-sub-header-title">
            <span
              style={{
                width: 24,
                height: 24,
                borderRadius: 7,
                background: 'var(--gradient-ai)',
                display: 'inline-grid',
                placeItems: 'center',
                color: '#fff',
              }}
            >
              <EvSparkles size={13} stroke={2} />
            </span>
            Eveno hjälp
          </div>
          <div style={{ width: 36 }} />
        </div>

        <div className={styles.messagesScroll}>
          <div className="ev-page" style={{ paddingBottom: 16 }}>
            {showWelcome && (
              <div className="ev-ai-hero">
                <div className="ev-ai-hero-inner">
                  <div className="ev-ai-hero-title">Hej {firstName || 'där'} 👋</div>
                  <div className="ev-ai-hero-text">
                    Jag kan hjälpa dig med avier, kontrakt och felanmälningar. Fråga vad som helst —
                    eller välj en av snabbfrågorna nedan.
                  </div>
                  <div>
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s}
                        type="button"
                        className="ev-ai-suggestion"
                        onClick={() => handleSend(s)}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div className="ev-chat-list">
              {messages.map((m) => (
                <div key={m.id} className={`ev-msg ${m.role === 'user' ? 'user' : 'ai'}`}>
                  <div className="ev-msg-avatar">
                    {m.role === 'assistant' ? <EvSparkles size={13} stroke={2} /> : initials}
                  </div>
                  <div className="ev-msg-bubble">{m.content}</div>
                </div>
              ))}

              {sendMutation.isPending && (
                <div className="ev-msg ai">
                  <div className="ev-msg-avatar">
                    <EvSparkles size={13} stroke={2} />
                  </div>
                  <div className="ev-msg-bubble">
                    <span className="ev-chat-dots" aria-label="Tänker">
                      <span />
                      <span />
                      <span />
                    </span>
                  </div>
                </div>
              )}

              {error && (
                <div
                  style={{
                    background: 'var(--color-danger-bg)',
                    color: 'var(--color-danger)',
                    border: '0.5px solid var(--color-danger)',
                    fontSize: 12.5,
                    padding: '10px 12px',
                    borderRadius: 10,
                  }}
                >
                  {error}
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {pendingAction && (
              <div className="ev-ai-confirm">
                <div className="ev-ai-confirm-title">{pendingAction.confirmationMessage}</div>
                <div className="ev-ai-confirm-details">
                  {Object.entries(pendingAction.details).map(([k, v]) => (
                    <span key={k} style={{ display: 'contents' }}>
                      <span className="ev-ai-confirm-key">{k}:</span>
                      <span>{v}</span>
                    </span>
                  ))}
                </div>
                <div className="ev-ai-confirm-actions">
                  <button
                    type="button"
                    className="ev-ai-confirm-cancel"
                    onClick={() => confirmMutation.mutate(false)}
                    disabled={confirmMutation.isPending}
                  >
                    Avbryt
                  </button>
                  <button
                    type="button"
                    className="ev-ai-confirm-accept"
                    onClick={() => confirmMutation.mutate(true)}
                    disabled={confirmMutation.isPending}
                  >
                    {confirmMutation.isPending ? 'Skickar…' : 'Bekräfta'}
                  </button>
                </div>
              </div>
            )}

            <div className="ev-chat-composer">
              <textarea
                ref={inputRef}
                value={input}
                onChange={handleInput}
                onKeyDown={handleKeyDown}
                placeholder="Ställ en fråga…"
                rows={1}
                disabled={sendMutation.isPending || !!pendingAction}
              />
              <button
                type="button"
                className="ev-chat-composer-btn"
                aria-label="Tal"
                disabled
                title="Röstinmatning kommer snart"
              >
                <EvMic size={15} />
              </button>
              <button
                type="button"
                className="ev-chat-composer-btn send"
                onClick={() => handleSend()}
                disabled={!input.trim() || sendMutation.isPending || !!pendingAction}
                aria-label="Skicka"
              >
                <EvSend size={14} stroke={2} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

interface FabProps {
  onClick: () => void
  hidden?: boolean
}

export function TenantAiFab({ onClick, hidden }: FabProps) {
  if (hidden) return null
  return (
    <button
      type="button"
      className={styles.fab}
      onClick={onClick}
      aria-label="Öppna AI-assistent"
      title="AI-hjälp"
    >
      <EvSparkles size={22} stroke={2} />
    </button>
  )
}

export { SUGGESTIONS }
