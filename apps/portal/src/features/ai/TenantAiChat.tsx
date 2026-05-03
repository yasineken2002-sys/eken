import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { confirmAiAction, sendAiMessage, type TenantAiPendingAction } from '@/api/portal.api'
import styles from './TenantAiChat.module.css'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}

const SUGGESTIONS = [
  'När förfaller min nästa hyra?',
  'Visa min betalningshistorik',
  'Hur säger jag upp lägenheten?',
  'Skapa felanmälan',
  'Var hittar jag mitt kontrakt?',
  'Vad är min uppsägningstid?',
]

interface Props {
  open: boolean
  onClose: () => void
  initialMessage?: string | undefined
}

export function TenantAiChat({ open, onClose, initialMessage }: Props) {
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [pendingAction, setPendingAction] = useState<TenantAiPendingAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
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
        next.push({
          id: `a-${Date.now()}`,
          role: 'assistant',
          content: res.reply,
        })
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
      // Felanmälan/uppsägning ändrar data — invalidera cache
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
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    sendMutation.mutate(msg)
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const ta = textareaRef.current
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
        <header className={styles.header}>
          <div>
            <div className={styles.headerTitle}>
              <span className={styles.headerBadge}>💬</span>
              Hjälpassistent
            </div>
            <div className={styles.headerSubtitle}>Frågor om hyra, kontrakt eller felanmälan</div>
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Stäng">
            ✕
          </button>
        </header>

        <div className={styles.messages}>
          {messages.length === 0 && !sendMutation.isPending && (
            <div className={styles.empty}>
              <p>
                Hej! 👋 Jag kan svara på frågor om din hyra, ditt kontrakt och din fastighet. Du kan
                också skapa felanmälan eller begära uppsägning via mig.
              </p>
              <div className={styles.suggestions}>
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={styles.suggestionChip}
                    onClick={() => handleSend(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) => (
            <div
              key={m.id}
              className={`${styles.bubble} ${
                m.role === 'user' ? styles.bubbleUser : styles.bubbleAssistant
              }`}
            >
              {m.content}
            </div>
          ))}

          {sendMutation.isPending && (
            <div className={`${styles.bubble} ${styles.bubbleAssistant}`}>
              <span className={styles.dots} aria-label="Tänker">
                <span />
                <span />
                <span />
              </span>
            </div>
          )}

          {error && <div className={styles.error}>{error}</div>}

          <div ref={messagesEndRef} />
        </div>

        {pendingAction && (
          <div className={styles.confirm}>
            <p className={styles.confirmTitle}>{pendingAction.confirmationMessage}</p>
            <div className={styles.confirmDetails}>
              {Object.entries(pendingAction.details).map(([k, v]) => (
                <span key={k} style={{ display: 'contents' }}>
                  <span className={styles.confirmKey}>{k}:</span>
                  <span>{v}</span>
                </span>
              ))}
            </div>
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.confirmCancel}
                onClick={() => confirmMutation.mutate(false)}
                disabled={confirmMutation.isPending}
              >
                Avbryt
              </button>
              <button
                type="button"
                className={styles.confirmAccept}
                onClick={() => confirmMutation.mutate(true)}
                disabled={confirmMutation.isPending}
              >
                {confirmMutation.isPending ? 'Skickar...' : 'Bekräfta'}
              </button>
            </div>
          </div>
        )}

        <div className={styles.composer}>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder="Skriv en fråga..."
            rows={1}
            disabled={sendMutation.isPending || !!pendingAction}
          />
          <button
            type="button"
            className={styles.sendBtn}
            onClick={() => handleSend()}
            disabled={!input.trim() || sendMutation.isPending || !!pendingAction}
          >
            Skicka
          </button>
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
      title="Hjälp"
    >
      <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
        <path
          d="M5 6 L21 6 Q23 6 23 8 L23 17 Q23 19 21 19 L13 19 L8 23 L8 19 L5 19 Q3 19 3 17 L3 8 Q3 6 5 6 Z"
          stroke="currentColor"
          strokeWidth="1.6"
          fill="none"
          strokeLinejoin="round"
        />
        <circle cx="9" cy="12.5" r="1.4" fill="currentColor" />
        <circle cx="13" cy="12.5" r="1.4" fill="currentColor" />
        <circle cx="17" cy="12.5" r="1.4" fill="currentColor" />
      </svg>
    </button>
  )
}

export { SUGGESTIONS }
