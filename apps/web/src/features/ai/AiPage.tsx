import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useQueryClient } from '@tanstack/react-query'
import {
  Sparkles,
  Send,
  Plus,
  Trash2,
  MessageSquare,
  Building2,
  FileText,
  AlertTriangle,
  TrendingUp,
  Users,
  CheckCircle2,
  X,
  Mic,
  MicOff,
  BarChart2,
} from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { Button } from '@/components/ui/Button'
import {
  useConversations,
  useConversation,
  useSendMessage,
  useConfirmAction,
  useDeleteConversation,
} from './hooks/useAi'
import { streamChat } from './api/ai.api'
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

const SUGGESTIONS = [
  {
    icon: AlertTriangle,
    label: 'Vilka hyresgäster har förfallna fakturor?',
    color: '#DC2626',
    bg: '#FEF2F2',
  },
  { icon: FileText, label: 'Skapa hyresfakturor för maj 2026', color: '#059669', bg: '#ECFDF5' },
  { icon: TrendingUp, label: 'Visa intäkter för Q1 2026', color: '#2563EB', bg: '#EFF6FF' },
  {
    icon: AlertTriangle,
    label: 'Skicka påminnelser till förfallna fakturor',
    color: '#D97706',
    bg: '#FFFBEB',
  },
  { icon: Building2, label: 'Hur många lediga enheter finns?', color: '#7C3AED', bg: '#F5F3FF' },
  { icon: Users, label: 'Exportera bokföring för 2026', color: '#6B7280', bg: '#F9FAFB' },
]

function LoadingDots() {
  return (
    <div className="flex items-center gap-1 py-1">
      {[0, 1, 2].map((i) => (
        <motion.div
          key={i}
          className="h-2 w-2 rounded-full bg-gray-300"
          animate={{ opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
        />
      ))}
    </div>
  )
}

function MessageBubble({ msg }: { msg: AiMessage }) {
  const isUser = msg.role === 'user'
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}
    >
      {!isUser && (
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-gray-100 bg-white shadow-sm">
          <Sparkles size={14} strokeWidth={1.8} className="text-blue-500" />
        </div>
      )}
      <div
        className={`max-w-[70%] rounded-2xl px-4 py-2.5 ${
          isUser
            ? 'rounded-tr-sm bg-[#1A7C45] text-white'
            : 'rounded-tl-sm border border-gray-100 bg-white text-gray-800'
        }`}
      >
        <p
          className={`whitespace-pre-wrap text-[13.5px] leading-relaxed ${
            isUser ? 'text-white' : 'text-gray-800'
          }`}
        >
          {msg.content}
        </p>
      </div>
    </motion.div>
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
      className="mx-auto max-w-3xl px-6 pb-4"
    >
      <div
        className={cn(
          'overflow-hidden rounded-2xl border border-l-4 border-gray-100 bg-white shadow-sm',
          isHighRisk ? 'border-l-red-600' : 'border-l-green-600',
        )}
      >
        <div className="px-5 pb-5 pt-4">
          {/* Header */}
          <div className="mb-3 flex items-center gap-2">
            <div
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-lg',
                isHighRisk ? 'bg-red-50' : 'bg-amber-50',
              )}
            >
              <AlertTriangle
                size={14}
                strokeWidth={1.8}
                className={isHighRisk ? 'text-red-600' : 'text-amber-600'}
              />
            </div>
            <span className="text-[13.5px] font-semibold text-gray-900">
              {isHighRisk ? 'Hög risk — bekräfta igen' : 'Bekräfta åtgärd'}
            </span>
          </div>

          {/* High risk extra warning */}
          {isHighRisk && (
            <div className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2">
              <p className="text-[12.5px] font-medium text-red-700">
                OBS: Denna åtgärd påverkar flera poster eller ett högt belopp. Kontrollera
                detaljerna nedan noggrant innan du bekräftar.
              </p>
            </div>
          )}

          {/* Confirmation message */}
          <p className="mb-4 text-[14px] font-medium text-gray-800">
            {pendingAction.confirmationMessage}
          </p>

          {/* Details grid */}
          {entries.length > 0 && (
            <div className="mb-5 grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-xl bg-gray-50 p-3">
              {entries.map(([key, value]) => (
                <div key={key} className="flex flex-col">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                    {key}
                  </span>
                  <span className="text-[13px] font-medium text-gray-700">{value}</span>
                </div>
              ))}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2">
            <button
              onClick={onCancel}
              disabled={isLoading}
              className="flex h-9 items-center gap-1.5 rounded-lg border border-[#E5E7EB] bg-white px-4 text-[13.5px] font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
            >
              <X size={13} strokeWidth={2} />
              Avbryt
            </button>
            <button
              onClick={onConfirm}
              disabled={isLoading}
              className={cn(
                'flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg px-4 text-[13.5px] font-medium text-white transition-colors active:scale-[0.97] disabled:opacity-50',
                isHighRisk ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700',
              )}
            >
              {isLoading ? (
                <LoadingDots />
              ) : (
                <>
                  <CheckCircle2 size={14} strokeWidth={2} />
                  {isHighRisk ? 'Ja, jag är säker — utför ändå' : 'Bekräfta och utför'}
                </>
              )}
            </button>
          </div>

          <p className="mt-2.5 text-center text-[11px] text-gray-400">
            {isHighRisk
              ? 'Åtgärden kan inte enkelt ångras efter utförande'
              : 'Åtgärden utförs direkt efter bekräftelse'}
          </p>
        </div>
      </div>
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
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [isListening, setIsListening] = useState(false)
  const [analysisOpen, setAnalysisOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const streamCleanupRef = useRef<(() => void) | null>(null)
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null)

  const queryClient = useQueryClient()
  const { data: conversations = [], isLoading: convLoading } = useConversations()
  const { data: conversation } = useConversation(activeConversationId)
  const sendMutation = useSendMessage()
  const confirmMutation = useConfirmAction()
  const deleteMutation = useDeleteConversation()

  // Merge DB messages with pending
  const allMessages: AiMessage[] = [...(conversation?.messages ?? []), ...pendingMessages]

  // Scroll to bottom when messages, streaming, or pending action changes
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [allMessages.length, isThinking, isStreaming, streamingText, pendingAction])

  // Cleanup SSE stream on unmount
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

  // Auto-resize textarea
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

    // Route to non-streaming (tool-capable) path when:
    // - Message contains an action keyword, OR
    // - We're in an existing conversation (follow-up replies must reach Claude tools)
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

        // Wait for conversation refetch before clearing pending messages to avoid flash
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
      // Read/question queries — use streaming
      const token = useAuthStore.getState().accessToken ?? ''
      setIsStreaming(true)
      setStreamingText('')

      streamCleanupRef.current = streamChat(
        msg,
        activeConversationId ?? undefined,
        token,
        (text) => setStreamingText(text),
        (convId) => {
          setIsStreaming(false)
          setStreamingText('')
          setActiveConversationId(convId)
          void queryClient.invalidateQueries({ queryKey: ['ai-conversations'] })
          // Refetch conversation first, then clear pending to avoid message flash
          void queryClient.refetchQueries({ queryKey: ['ai-conversation', convId] }).then(() => {
            setPendingMessages([])
          })
        },
        (_error) => {
          setIsStreaming(false)
          setStreamingText('')
          setPendingMessages([])
        },
      )
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

      // Double-confirm: server returned a new pendingAction (high-risk second check)
      if (res.pendingAction) {
        setPendingAction(res.pendingAction)
        return
      }

      setPendingAction(null)

      // Add result as assistant message to pending until refetch
      if (res.reply) {
        const tempAssistant: AiMessage = {
          id: `tmp-assistant-${Date.now()}`,
          conversationId: activeConversationId,
          role: 'assistant',
          content: res.reply,
          createdAt: new Date().toISOString(),
        }
        setPendingMessages([tempAssistant])
        setTimeout(() => setPendingMessages([]), 2000) // let query refresh
      }

      // Handle SIE4 download
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

  return (
    <PageWrapper id="ai">
      <div className="flex h-[calc(100vh-52px)] overflow-hidden">
        {/* ── Left Sidebar ── */}
        <div className="flex w-[280px] flex-shrink-0 flex-col border-r border-gray-100 bg-white">
          {/* Header */}
          <div className="border-b border-gray-100 px-4 py-3">
            <div className="mb-3 flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-50">
                <Sparkles size={14} strokeWidth={1.8} className="text-blue-600" />
              </div>
              <span className="text-[14px] font-semibold text-gray-900">Eveno AI</span>
            </div>
            <Button variant="primary" size="sm" className="w-full" onClick={handleNewConversation}>
              <Plus size={13} strokeWidth={2} />
              Ny konversation
            </Button>
          </div>

          {/* Conversation list */}
          <div className="flex-1 overflow-y-auto py-2">
            {convLoading ? (
              <div className="space-y-1 px-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-12 animate-pulse rounded-lg bg-gray-100" />
                ))}
              </div>
            ) : conversations.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
                <MessageSquare size={20} strokeWidth={1.5} className="mb-2 text-gray-200" />
                <p className="text-[12.5px] text-gray-400">Inga konversationer ännu</p>
              </div>
            ) : (
              <div className="space-y-0.5 px-2">
                {conversations.map((conv) => {
                  const active = activeConversationId === conv.id
                  const lastMsg = conv.messages[0]
                  return (
                    <div
                      key={conv.id}
                      className={`group relative flex cursor-pointer items-start gap-2 rounded-lg px-3 py-2.5 transition-colors ${
                        active ? 'bg-blue-50' : 'hover:bg-gray-50'
                      }`}
                      onClick={() => {
                        setActiveConversationId(conv.id)
                        setPendingMessages([])
                        setPendingAction(null)
                      }}
                    >
                      <div className="min-w-0 flex-1">
                        <p
                          className={`truncate text-[13px] font-medium ${
                            active ? 'text-blue-700' : 'text-gray-800'
                          }`}
                        >
                          {conv.title}
                        </p>
                        {lastMsg && (
                          <p className="mt-0.5 truncate text-[11.5px] text-gray-400">
                            {lastMsg.content}
                          </p>
                        )}
                        <p className="mt-0.5 text-[11px] text-gray-300">
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
                            className="rounded px-1.5 py-0.5 text-[11px] font-medium text-red-600 hover:bg-red-50"
                          >
                            Ja
                          </button>
                          <button
                            onClick={() => setConfirmDeleteId(null)}
                            className="rounded px-1.5 py-0.5 text-[11px] font-medium text-gray-500 hover:bg-gray-100"
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
                          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-gray-300 opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
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

          {/* Analysis button */}
          <div className="border-t border-gray-100 p-3">
            <button
              onClick={() => setAnalysisOpen(true)}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] font-medium text-gray-600 transition-colors hover:bg-gray-50"
            >
              <BarChart2 size={14} strokeWidth={1.8} className="text-purple-500" />
              Analysera portfölj
            </button>
          </div>
        </div>

        {/* ── Chat Area ── */}
        <div className="flex min-w-0 flex-1 flex-col bg-[#F7F8FA]">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto">
            {isNewChat && !hasMessages ? (
              /* Welcome state */
              <div className="flex h-full flex-col items-center justify-center px-8 py-12">
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.3 }}
                  className="flex h-16 w-16 items-center justify-center rounded-2xl border border-gray-100 bg-white shadow-md"
                >
                  <Sparkles size={28} strokeWidth={1.5} className="text-blue-500" />
                </motion.div>
                <motion.h2
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 }}
                  className="mt-4 text-[20px] font-semibold text-gray-900"
                >
                  Hej! Jag är Eveno AI
                </motion.h2>
                <motion.p
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.15 }}
                  className="mt-2 max-w-sm text-center text-[13.5px] text-gray-500"
                >
                  Jag kan analysera din fastighetsportfölj, skapa fakturor, hantera hyresgäster och
                  ge dig konkreta råd — allt baserat på aktuell data.
                </motion.p>

                {/* Suggestion chips */}
                <motion.div
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                  className="mt-8 grid w-full max-w-lg grid-cols-2 gap-2"
                >
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s.label}
                      onClick={() => void handleSend(s.label)}
                      className="flex items-center gap-2.5 rounded-xl border border-gray-100 bg-white px-4 py-3 text-left transition-all hover:border-blue-200 hover:shadow-sm active:scale-[0.98]"
                    >
                      <div
                        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg"
                        style={{ background: s.bg }}
                      >
                        <s.icon size={14} strokeWidth={1.8} style={{ color: s.color }} />
                      </div>
                      <span className="text-[12.5px] font-medium text-gray-700">{s.label}</span>
                    </button>
                  ))}
                </motion.div>
              </div>
            ) : (
              <div className="mx-auto max-w-3xl space-y-5 px-6 py-6">
                <AnimatePresence initial={false}>
                  {allMessages.map((msg) => (
                    <MessageBubble key={msg.id} msg={msg} />
                  ))}
                </AnimatePresence>

                {isThinking && (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex gap-3"
                  >
                    <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-gray-100 bg-white shadow-sm">
                      <Sparkles size={14} strokeWidth={1.8} className="text-blue-500" />
                    </div>
                    <div className="rounded-2xl rounded-tl-sm border border-gray-100 bg-white px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <LoadingDots />
                        <span className="text-[12px] text-gray-400">Analyserar din data...</span>
                      </div>
                    </div>
                  </motion.div>
                )}

                {isStreaming && (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex gap-3"
                  >
                    <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-gray-100 bg-white shadow-sm">
                      <Sparkles
                        size={14}
                        strokeWidth={1.8}
                        className="animate-pulse text-blue-500"
                      />
                    </div>
                    <div className="max-w-[70%] rounded-2xl rounded-tl-sm border border-gray-100 bg-white px-4 py-2.5">
                      {streamingText ? (
                        <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-gray-800">
                          {streamingText}
                          <span className="cursor">▋</span>
                        </p>
                      ) : (
                        <div className="flex items-center gap-2">
                          <LoadingDots />
                          <span className="text-[12px] text-gray-400">Tänker...</span>
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}

                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {/* Confirmation card — shown above input */}
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

          {/* Input area */}
          <div className="border-t border-gray-100 bg-white px-6 py-4">
            <div className="mx-auto max-w-3xl">
              {isListening && (
                <div className="mb-2 flex items-center gap-2 text-[13px] text-red-500">
                  <span className="animate-pulse">●</span>
                  Lyssnar... Tala din fråga på svenska
                </div>
              )}
              <div className="flex items-end gap-3 rounded-2xl border border-[#E5E7EB] bg-white px-4 py-3 transition-all focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  placeholder="Skriv ett meddelande... (Enter för att skicka)"
                  rows={1}
                  className="flex-1 resize-none bg-transparent text-[13.5px] text-gray-800 placeholder-gray-400 outline-none"
                  style={{ maxHeight: '120px' }}
                />
                <div className="flex flex-shrink-0 items-center gap-2">
                  {input.length > 0 && (
                    <span className="text-[11px] text-gray-300">{input.length}</span>
                  )}
                  <button
                    type="button"
                    onClick={isListening ? stopVoiceInput : startVoiceInput}
                    className={cn(
                      'rounded-lg p-2 transition-all',
                      isListening
                        ? 'animate-pulse bg-red-100 text-red-600'
                        : 'text-gray-400 hover:text-gray-600',
                    )}
                    title={isListening ? 'Stoppa inspelning' : 'Tala'}
                  >
                    {isListening ? <MicOff size={18} /> : <Mic size={18} />}
                  </button>
                  <button
                    onClick={() => void handleSend()}
                    disabled={!input.trim() || isThinking || isStreaming}
                    className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white transition-colors hover:bg-blue-700 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Send size={14} strokeWidth={2} />
                  </button>
                </div>
              </div>
              <p className="mt-2 text-center text-[11px] text-gray-300">
                Eveno AI kan utföra åtgärder — åtgärder kräver alltid din bekräftelse.
              </p>
            </div>
          </div>
        </div>
      </div>

      <AnalysisModal open={analysisOpen} onClose={() => setAnalysisOpen(false)} />
    </PageWrapper>
  )
}
