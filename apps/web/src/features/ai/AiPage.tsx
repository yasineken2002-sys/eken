import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useQueryClient } from '@tanstack/react-query'
import {
  Sparkles,
  Plus,
  Trash2,
  MessageSquare,
  Bell,
  Receipt,
  AlertTriangle,
  TrendingUp,
  CheckCircle2,
  Check,
  X,
  Mic,
  MicOff,
  BarChart2,
  ArrowUp,
  ArrowRight,
  Search as SearchIcon,
  PanelLeft,
} from 'lucide-react'
import {
  useConversations,
  useConversation,
  useSendMessage,
  useConfirmAction,
  useDeleteConversation,
} from './hooks/useAi'
import { streamChat, describeTool } from './api/ai.api'
import { AnalysisModal } from './components/AnalysisModal'
import { useAuthStore } from '@/stores/auth.store'
import { cn } from '@/lib/cn'
import { formatDate } from '@eken/shared'
import type { AiMessage, PendingAction } from './api/ai.api'

// Web Speech API — not yet in all TypeScript lib definitions
interface SpeechRecognitionResult {
  readonly length: number
  readonly isFinal: boolean
  item(index: number): SpeechRecognitionAlternative
  [index: number]: SpeechRecognitionAlternative
}

interface SpeechRecognitionAlternative {
  readonly transcript: string
  readonly confidence: number
}

interface SpeechRecognitionResultList {
  readonly length: number
  item(index: number): SpeechRecognitionResult
  [index: number]: SpeechRecognitionResult
}

interface SpeechRecognitionEvent extends Event {
  readonly results: SpeechRecognitionResultList
}

interface SpeechRecognitionInstance extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  onstart: ((this: SpeechRecognitionInstance, ev: Event) => void) | null
  onresult: ((this: SpeechRecognitionInstance, ev: SpeechRecognitionEvent) => void) | null
  onend: ((this: SpeechRecognitionInstance, ev: Event) => void) | null
  onerror: ((this: SpeechRecognitionInstance, ev: Event) => void) | null
  start(): void
  stop(): void
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionInstance
}

declare global {
  interface Window {
    SpeechRecognition: SpeechRecognitionConstructor
    webkitSpeechRecognition: SpeechRecognitionConstructor
  }
}

// Quick-action prompts on the welcome screen
const QUICK_ACTIONS = [
  { icon: Bell, label: 'Skicka påminnelse till förfallna hyresgäster' },
  { icon: TrendingUp, label: 'Visa intäkter denna månad' },
  { icon: Receipt, label: 'Skapa hyresavier för juni' },
  { icon: AlertTriangle, label: 'Vilka hyresgäster har förfallna fakturor?' },
]

function LoadingDots() {
  return (
    <div className="flex items-center gap-1 py-1">
      {[0, 1, 2].map((i) => (
        <motion.div
          key={i}
          className="h-2 w-2 rounded-full"
          style={{ background: 'rgba(15,31,71,0.25)' }}
          animate={{ opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
        />
      ))}
    </div>
  )
}

function MessageBubble({ msg, userInitials }: { msg: AiMessage; userInitials: string }) {
  const isUser = msg.role === 'user'
  return (
    <div
      className={cn(
        'flex max-w-full gap-2.5',
        isUser ? 'ev-msg-user flex-row-reverse self-end' : 'ev-msg-ai',
      )}
      style={isUser ? { maxWidth: '78%' } : { maxWidth: '92%' }}
    >
      <div className={cn('ev-msg-avatar', isUser ? 'user' : 'ai')}>
        {isUser ? userInitials : <Sparkles size={14} strokeWidth={2.2} />}
      </div>
      <div className={cn('ev-bubble whitespace-pre-wrap', isUser ? 'user' : 'ai')}>
        {msg.content}
      </div>
    </div>
  )
}

interface ConfirmationCardProps {
  pendingAction: PendingAction
  onConfirm: () => void
  onCancel: () => void
  isLoading: boolean
}

function ConfirmationCard({
  pendingAction,
  onConfirm,
  onCancel,
  isLoading,
}: ConfirmationCardProps) {
  const entries = Object.entries(pendingAction.details)
  const isHighRisk = pendingAction.requiresDoubleConfirm === true
  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 4, scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      className={cn('ev-confirm-card', isHighRisk && 'danger')}
    >
      <div className="ev-confirm-icon">
        <AlertTriangle size={16} strokeWidth={2} />
      </div>
      <div className="ev-confirm-title">
        {isHighRisk ? 'Hög risk — bekräfta igen' : 'Bekräfta åtgärd'}
      </div>
      <p className="m-0 text-[13.5px] leading-[1.5]" style={{ color: 'var(--ev-color-fg-1)' }}>
        {pendingAction.confirmationMessage}
      </p>
      {entries.length > 0 && (
        <div
          className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 rounded-[10px] p-3"
          style={{ background: 'rgba(255,255,255,0.6)' }}
        >
          {entries.map(([key, value]) => (
            <div key={key} className="flex flex-col">
              <span
                className="text-[10.5px] font-semibold uppercase tracking-wider"
                style={{ color: 'var(--ev-color-fg-3)' }}
              >
                {key}
              </span>
              <span className="text-[13px] font-medium" style={{ color: 'var(--ev-color-fg-1)' }}>
                {String(value)}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-3.5 flex gap-2">
        <button
          onClick={onConfirm}
          disabled={isLoading}
          className={cn('ev-btn', isHighRisk ? 'ev-btn-danger' : 'ev-btn-primary')}
        >
          {isLoading ? (
            <LoadingDots />
          ) : (
            <>
              <CheckCircle2 size={13} strokeWidth={2.4} />
              {isHighRisk ? 'Ja, utför ändå' : 'Bekräfta'}
            </>
          )}
        </button>
        <button onClick={onCancel} disabled={isLoading} className="ev-btn ev-btn-secondary">
          <X size={13} strokeWidth={2} />
          Avbryt
        </button>
      </div>
      <p className="mb-0 mt-2.5 text-[11px]" style={{ color: 'var(--ev-color-fg-3)' }}>
        {isHighRisk
          ? 'Åtgärden kan inte enkelt ångras efter utförande'
          : 'Åtgärden utförs direkt efter bekräftelse'}
      </p>
    </motion.div>
  )
}

export function AiPage() {
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [pendingMessages, setPendingMessages] = useState<AiMessage[]>([])
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [isThinking, setIsThinking] = useState(false)
  const [streamingText, setStreamingText] = useState<string>('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [toolEvents, setToolEvents] = useState<
    Array<{ id: string; name: string; status: 'starting' | 'executing' | 'done' }>
  >([])
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [isListening, setIsListening] = useState(false)
  const [analysisOpen, setAnalysisOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const streamCleanupRef = useRef<(() => void) | null>(null)
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null)

  const user = useAuthStore((s) => s.user)
  const userInitials = user
    ? `${user.firstName[0] ?? ''}${user.lastName[0] ?? ''}`.toUpperCase()
    : 'DU'
  const firstName = user?.firstName ?? ''

  const queryClient = useQueryClient()
  const { data: conversations = [], isLoading: convLoading } = useConversations()
  const { data: conversation } = useConversation(activeConversationId)
  const sendMutation = useSendMessage()
  const confirmMutation = useConfirmAction()
  const deleteMutation = useDeleteConversation()

  const allMessages: AiMessage[] = [...(conversation?.messages ?? []), ...pendingMessages]

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [allMessages.length, isThinking, isStreaming, streamingText, pendingAction])

  useEffect(
    () => () => {
      streamCleanupRef.current?.()
    },
    [],
  )

  const startVoiceInput = () => {
    if (!('SpeechRecognition' in window) && !('webkitSpeechRecognition' in window)) {
      alert('Din webbläsare stöder inte röstinmatning')
      return
    }
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition
    const recognition = new SR()
    recognition.lang = 'sv-SE'
    recognition.continuous = false
    recognition.interimResults = true
    recognition.onstart = () => setIsListening(true)
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let transcript = ''
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results.item(i)
        transcript += result?.item(0)?.transcript ?? ''
      }
      setInput(transcript)
    }
    recognition.onend = () => {
      setIsListening(false)
      recognitionRef.current = null
    }
    recognition.onerror = () => {
      setIsListening(false)
      recognitionRef.current = null
    }
    recognition.start()
    recognitionRef.current = recognition
  }

  const stopVoiceInput = () => {
    recognitionRef.current?.stop()
    setIsListening(false)
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const ta = textareaRef.current
    if (ta) {
      ta.style.height = 'auto'
      ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`
    }
  }

  const handleSend = async (text?: string) => {
    const msg = (text ?? input).trim()
    if (!msg || isThinking || isStreaming) return

    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setPendingAction(null)

    const tempUser: AiMessage = {
      id: `tmp-user-${Date.now()}`,
      conversationId: activeConversationId ?? '',
      role: 'user',
      content: msg,
      createdAt: new Date().toISOString(),
    }
    setPendingMessages((prev) => [...prev, tempUser])

    const isActionMessage =
      activeConversationId !== null ||
      /skapa|uppdatera|skicka|markera|aktivera|avsluta|exportera|importera/i.test(msg)

    if (isActionMessage) {
      setIsThinking(true)
      try {
        const res = await sendMutation.mutateAsync({
          message: msg,
          ...(activeConversationId ? { conversationId: activeConversationId } : {}),
        })

        if (!activeConversationId) {
          setActiveConversationId(res.conversationId)
        }

        const convId = res.conversationId ?? activeConversationId ?? ''
        if (convId) {
          await queryClient.refetchQueries({ queryKey: ['ai-conversation', convId] })
        }
        setPendingMessages([])

        if (res.pendingAction) {
          setPendingAction(res.pendingAction)
        }
      } catch {
        setPendingMessages([])
      } finally {
        setIsThinking(false)
      }
    } else {
      const token = useAuthStore.getState().accessToken ?? ''
      setIsStreaming(true)
      setStreamingText('')
      setToolEvents([])

      streamCleanupRef.current = streamChat(msg, activeConversationId ?? undefined, token, {
        onDelta: (text) => setStreamingText(text),
        onToolUseStart: ({ id, name }) => {
          setToolEvents((prev) => [...prev, { id, name, status: 'starting' }])
        },
        onToolUseExecuting: ({ id }) => {
          setToolEvents((prev) =>
            prev.map((e) => (e.id === id ? { ...e, status: 'executing' } : e)),
          )
        },
        onToolResult: ({ id }) => {
          setToolEvents((prev) => prev.map((e) => (e.id === id ? { ...e, status: 'done' } : e)))
        },
        onPendingAction: (action) => {
          setIsStreaming(false)
          setStreamingText('')
          setToolEvents([])
          setActiveConversationId(action.conversationId)
          setPendingAction({
            toolName: action.toolName,
            toolInput: action.toolInput,
            confirmationMessage: action.confirmationMessage,
            details: action.details,
            ...(action.requiresDoubleConfirm ? { requiresDoubleConfirm: true } : {}),
          })
          void queryClient.invalidateQueries({ queryKey: ['ai-conversations'] })
          void queryClient
            .refetchQueries({ queryKey: ['ai-conversation', action.conversationId] })
            .then(() => {
              setPendingMessages([])
            })
        },
        onDone: (convId) => {
          setIsStreaming(false)
          setStreamingText('')
          setToolEvents([])
          setActiveConversationId(convId)
          void queryClient.invalidateQueries({ queryKey: ['ai-conversations'] })
          void queryClient.refetchQueries({ queryKey: ['ai-conversation', convId] }).then(() => {
            setPendingMessages([])
          })
        },
        onError: () => {
          setIsStreaming(false)
          setStreamingText('')
          setToolEvents([])
          setPendingMessages([])
        },
      })
    }
  }

  const handleConfirm = async () => {
    if (!pendingAction || !activeConversationId) return

    try {
      const res = await confirmMutation.mutateAsync({
        toolName: pendingAction.toolName,
        toolInput: pendingAction.toolInput,
        conversationId: activeConversationId,
        confirmed: true,
      })

      if (res.pendingAction) {
        setPendingAction(res.pendingAction)
        return
      }

      setPendingAction(null)

      if (res.reply) {
        const tempAssistant: AiMessage = {
          id: `tmp-assistant-${Date.now()}`,
          conversationId: activeConversationId,
          role: 'assistant',
          content: res.reply,
          createdAt: new Date().toISOString(),
        }
        setPendingMessages([tempAssistant])
        setTimeout(() => setPendingMessages([]), 2000)
      }

      if (res.downloadUrl) {
        window.open(res.downloadUrl, '_blank')
      }
    } catch {
      setPendingAction(null)
    }
  }

  const handleCancel = async () => {
    if (!pendingAction || !activeConversationId) {
      setPendingAction(null)
      return
    }

    try {
      await confirmMutation.mutateAsync({
        toolName: pendingAction.toolName,
        toolInput: pendingAction.toolInput,
        conversationId: activeConversationId,
        confirmed: false,
      })
    } finally {
      setPendingAction(null)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  const handleNewConversation = () => {
    streamCleanupRef.current?.()
    setActiveConversationId(null)
    setPendingMessages([])
    setPendingAction(null)
    setIsStreaming(false)
    setStreamingText('')
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const handleDelete = async (id: string) => {
    await deleteMutation.mutateAsync(id)
    if (activeConversationId === id) {
      streamCleanupRef.current?.()
      setActiveConversationId(null)
      setPendingMessages([])
      setPendingAction(null)
      setIsStreaming(false)
      setStreamingText('')
    }
    setConfirmDeleteId(null)
  }

  const isNewChat = !activeConversationId
  const hasMessages = allMessages.length > 0

  // Usage estimate — capped at 2000 for the display pill
  const usageUsed = Math.min(2000, conversations.length * 5)
  const usageRemaining = Math.max(0, 2000 - usageUsed)

  return (
    <motion.div
      key="ai"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="ev-ai-root flex h-[calc(100vh-56px)] overflow-hidden"
    >
      {/* ── History panel ── */}
      <AnimatePresence initial={false}>
        {historyOpen && (
          <motion.aside
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 260, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 36 }}
            className="flex flex-shrink-0 flex-col overflow-hidden"
            style={{
              background: 'var(--ev-color-surface)',
              borderRight: '0.5px solid var(--ev-color-border)',
            }}
          >
            <div className="flex w-[260px] flex-col" style={{ height: '100%' }}>
              <div
                className="flex items-center justify-between px-4 py-3"
                style={{ borderBottom: '0.5px solid var(--ev-color-border)' }}
              >
                <span
                  className="text-[11px] font-semibold uppercase tracking-[0.08em]"
                  style={{ color: 'var(--ev-color-fg-3)' }}
                >
                  Historik
                </span>
                <button
                  onClick={handleNewConversation}
                  className="ev-composer-icon-btn"
                  title="Ny konversation"
                  style={{ width: 28, height: 28 }}
                >
                  <Plus size={14} strokeWidth={2} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto py-2">
                {convLoading ? (
                  <div className="space-y-1 px-3">
                    {[1, 2, 3].map((i) => (
                      <div
                        key={i}
                        className="h-12 animate-pulse rounded-lg"
                        style={{ background: 'var(--ev-color-subtle)' }}
                      />
                    ))}
                  </div>
                ) : conversations.length === 0 ? (
                  <div className="flex flex-col items-center px-4 py-10 text-center">
                    <MessageSquare
                      size={20}
                      strokeWidth={1.5}
                      style={{ color: 'var(--ev-color-fg-3)' }}
                    />
                    <p className="mt-2 text-[12.5px]" style={{ color: 'var(--ev-color-fg-3)' }}>
                      Inga konversationer ännu
                    </p>
                  </div>
                ) : (
                  <div className="space-y-0.5 px-2">
                    {conversations.map((conv) => {
                      const active = activeConversationId === conv.id
                      const lastMsg = conv.messages[0]
                      return (
                        <div
                          key={conv.id}
                          className="group relative flex cursor-pointer items-start gap-2 rounded-[10px] px-3 py-2.5 transition-colors"
                          style={{
                            background: active ? 'var(--ev-color-primary-soft)' : 'transparent',
                          }}
                          onMouseEnter={(e) => {
                            if (!active)
                              (e.currentTarget as HTMLDivElement).style.background =
                                'var(--ev-color-subtle)'
                          }}
                          onMouseLeave={(e) => {
                            if (!active)
                              (e.currentTarget as HTMLDivElement).style.background = 'transparent'
                          }}
                          onClick={() => {
                            setActiveConversationId(conv.id)
                            setPendingMessages([])
                            setPendingAction(null)
                          }}
                        >
                          <div className="min-w-0 flex-1">
                            <p
                              className="truncate text-[13px] font-medium"
                              style={{
                                color: active ? 'var(--ev-color-primary)' : 'var(--ev-color-fg-1)',
                              }}
                            >
                              {conv.title}
                            </p>
                            {lastMsg && (
                              <p
                                className="mt-0.5 truncate text-[11.5px]"
                                style={{ color: 'var(--ev-color-fg-3)' }}
                              >
                                {lastMsg.content}
                              </p>
                            )}
                            <p
                              className="mt-0.5 text-[11px]"
                              style={{ color: 'var(--ev-color-fg-3)' }}
                            >
                              {formatDate(conv.updatedAt)}
                            </p>
                          </div>

                          {confirmDeleteId === conv.id ? (
                            <div
                              className="flex flex-shrink-0 items-center gap-1"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                onClick={() => void handleDelete(conv.id)}
                                className="rounded px-1.5 py-0.5 text-[11px] font-medium hover:bg-red-50"
                                style={{ color: 'var(--ev-color-danger)' }}
                              >
                                Ja
                              </button>
                              <button
                                onClick={() => setConfirmDeleteId(null)}
                                className="rounded px-1.5 py-0.5 text-[11px] font-medium"
                                style={{ color: 'var(--ev-color-fg-2)' }}
                              >
                                Nej
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                setConfirmDeleteId(conv.id)
                              }}
                              className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100"
                              style={{ color: 'var(--ev-color-fg-3)' }}
                            >
                              <Trash2 size={12} strokeWidth={1.8} />
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              <div className="p-3" style={{ borderTop: '0.5px solid var(--ev-color-border)' }}>
                <button
                  onClick={() => setAnalysisOpen(true)}
                  className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-[13px] font-medium transition-colors hover:bg-[var(--ev-color-subtle)]"
                  style={{ color: 'var(--ev-color-fg-2)' }}
                >
                  <BarChart2
                    size={14}
                    strokeWidth={1.8}
                    style={{ color: 'var(--ev-color-primary-accent)' }}
                  />
                  Analysera portfölj
                </button>
              </div>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* ── Chat column ── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Chat topbar */}
        <header
          className="flex flex-shrink-0 items-center gap-3.5 px-8 py-4"
          style={{
            borderBottom: '0.5px solid var(--ev-color-border)',
            background: 'rgba(250,250,247,0.85)',
            backdropFilter: 'blur(12px)',
          }}
        >
          <button
            onClick={() => setHistoryOpen((v) => !v)}
            className="ev-composer-icon-btn"
            title={historyOpen ? 'Dölj historik' : 'Visa historik'}
            style={{ width: 34, height: 34 }}
          >
            <PanelLeft size={16} strokeWidth={1.8} />
          </button>
          <div className="ev-ai-topbar-icon">
            <Sparkles size={20} strokeWidth={2} />
          </div>
          <div className="min-w-0">
            <div
              className="text-[17px] font-medium leading-[1.2] tracking-[-0.015em]"
              style={{ color: 'var(--ev-color-fg-1)' }}
            >
              AI-assistent
            </div>
            <div
              className="mt-[3px] flex items-center gap-1.5 text-[12px]"
              style={{ color: 'var(--ev-color-fg-2)' }}
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: 'var(--ev-color-success)' }}
              />
              <span className="tabular-nums">
                <strong style={{ color: 'var(--ev-color-fg-1)', fontWeight: 600 }}>
                  {usageRemaining.toLocaleString('sv-SE').replace(/,/g, ' ')}
                </strong>{' '}
                av <strong style={{ color: 'var(--ev-color-fg-1)', fontWeight: 600 }}>2 000</strong>{' '}
                anrop kvar denna månad
              </span>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <button
              className="ev-composer-icon-btn"
              title="Sök i historik"
              style={{ width: 34, height: 34 }}
              onClick={() => setHistoryOpen(true)}
            >
              <SearchIcon size={16} strokeWidth={1.8} />
            </button>
            <button
              className="ev-composer-icon-btn"
              title="Analysera portfölj"
              style={{ width: 34, height: 34 }}
              onClick={() => setAnalysisOpen(true)}
            >
              <BarChart2 size={16} strokeWidth={1.8} />
            </button>
          </div>
        </header>

        {/* Scroll area */}
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-[760px] flex-col gap-5 px-8 pb-4 pt-6">
            {isNewChat && !hasMessages ? (
              <div className="ev-ai-welcome">
                <div className="relative z-10">
                  <div className="ev-welcome-tag">
                    <Sparkles size={11} strokeWidth={2.2} />
                    Eveno AI
                  </div>
                  <h2 className="mb-0.5 mt-4 text-[26px] font-medium leading-[1.15] tracking-[-0.025em]">
                    Hej {firstName || 'där'}{' '}
                    <motion.span
                      style={{ display: 'inline-block', transformOrigin: '70% 70%' }}
                      animate={{ rotate: [0, 18, -10, 14, 0, 0, 0] }}
                      transition={{
                        duration: 2.4,
                        repeat: Infinity,
                        times: [0, 0.1, 0.2, 0.3, 0.4, 0.7, 1],
                      }}
                    >
                      👋
                    </motion.span>
                  </h2>
                  <div
                    className="text-[14.5px] leading-[1.5]"
                    style={{ color: 'rgba(255,255,255,0.72)' }}
                  >
                    Vad vill du göra idag?
                  </div>
                  <div className="mt-5 flex flex-col gap-2">
                    {QUICK_ACTIONS.map((a) => (
                      <button
                        key={a.label}
                        type="button"
                        onClick={() => void handleSend(a.label)}
                        className="ev-welcome-action"
                      >
                        <span className="ev-welcome-action-icon">
                          <a.icon size={14} strokeWidth={1.8} />
                        </span>
                        <span className="flex-1">{a.label}</span>
                        <span style={{ color: 'rgba(255,255,255,0.5)', flexShrink: 0 }}>
                          <ArrowRight size={13} strokeWidth={1.8} />
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <AnimatePresence initial={false}>
                {allMessages.map((msg) => (
                  <MessageBubble key={msg.id} msg={msg} userInitials={userInitials} />
                ))}
              </AnimatePresence>
            )}

            {isThinking && (
              <div className="ev-msg-ai flex max-w-[92%] gap-2.5">
                <div className="ev-msg-avatar ai">
                  <Sparkles size={14} strokeWidth={2.2} />
                </div>
                <div className="ev-bubble ai">
                  <div className="flex items-center gap-2">
                    <LoadingDots />
                    <span className="text-[12px]" style={{ color: 'var(--ev-color-fg-3)' }}>
                      Analyserar din data…
                    </span>
                  </div>
                </div>
              </div>
            )}

            {isStreaming && (
              <div className="ev-msg-ai flex max-w-[92%] gap-2.5">
                <div className="ev-msg-avatar ai">
                  <Sparkles size={14} strokeWidth={2.2} />
                </div>
                <div className="flex min-w-0 flex-col gap-2.5">
                  {toolEvents.length > 0 &&
                    toolEvents.map((evt) => (
                      <div key={evt.id} className="ev-tool-call">
                        <span className={cn('ev-tool-spark', evt.status !== 'done' && 'running')}>
                          {evt.status === 'done' ? (
                            <Check size={11} strokeWidth={2.6} />
                          ) : (
                            <Sparkles size={10} strokeWidth={2.4} />
                          )}
                        </span>
                        <span>
                          {describeTool(evt.name)}
                          {evt.status === 'done' ? '' : '…'}
                        </span>
                      </div>
                    ))}
                  {streamingText ? (
                    <div className="ev-bubble ai whitespace-pre-wrap">
                      {streamingText}
                      <span className="cursor">▋</span>
                    </div>
                  ) : toolEvents.length === 0 ? (
                    <div className="ev-bubble ai">
                      <div className="flex items-center gap-2">
                        <LoadingDots />
                        <span className="text-[12px]" style={{ color: 'var(--ev-color-fg-3)' }}>
                          Tänker…
                        </span>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            )}

            <AnimatePresence>
              {pendingAction && (
                <ConfirmationCard
                  pendingAction={pendingAction}
                  onConfirm={() => void handleConfirm()}
                  onCancel={() => void handleCancel()}
                  isLoading={confirmMutation.isPending}
                />
              )}
            </AnimatePresence>

            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Composer */}
        <div
          className="flex-shrink-0 px-8 pb-5 pt-3"
          style={{
            background: 'linear-gradient(to top, var(--ev-color-bg) 70%, rgba(250,250,247,0))',
          }}
        >
          <div className="mx-auto max-w-[760px]">
            {isListening && (
              <div
                className="mb-2 flex items-center gap-2 text-[13px]"
                style={{ color: 'var(--ev-color-danger)' }}
              >
                <span className="animate-pulse">●</span>
                Lyssnar… Tala din fråga på svenska
              </div>
            )}
            <div className="ev-composer">
              <button
                type="button"
                onClick={isListening ? stopVoiceInput : startVoiceInput}
                className={cn('ev-composer-icon-btn', isListening && 'animate-pulse')}
                title={isListening ? 'Stoppa inspelning' : 'Tala'}
              >
                {isListening ? (
                  <MicOff size={16} strokeWidth={1.8} />
                ) : (
                  <Mic size={16} strokeWidth={1.8} />
                )}
              </button>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder="Skriv en fråga eller säg ett kommando…"
                rows={1}
                className="min-w-0 flex-1 resize-none border-0 bg-transparent px-1 py-[7px] text-[14px] leading-[1.4] outline-none"
                style={{ color: 'var(--ev-color-fg-1)', maxHeight: '120px' }}
              />
              {input.length > 0 && (
                <span
                  className="px-1 text-[11px] tabular-nums"
                  style={{ color: 'var(--ev-color-fg-3)' }}
                >
                  {input.length}
                </span>
              )}
              <button
                onClick={() => void handleSend()}
                disabled={!input.trim() || isThinking || isStreaming}
                className="ev-composer-send"
                aria-label="Skicka"
              >
                <ArrowUp size={15} strokeWidth={2.4} />
              </button>
            </div>
            <p
              className="mb-0 mt-1.5 text-center text-[11px]"
              style={{ color: 'var(--ev-color-fg-3)' }}
            >
              Eveno AI kan göra misstag — granska viktiga åtgärder innan du bekräftar.
            </p>
          </div>
        </div>
      </div>

      <AnalysisModal open={analysisOpen} onClose={() => setAnalysisOpen(false)} />
    </motion.div>
  )
}
