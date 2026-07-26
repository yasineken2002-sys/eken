import { useState, useRef, useEffect } from 'react'
import { AnimatePresence } from 'framer-motion'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { AnalysisModal } from './components/AnalysisModal'
import { Composer } from './components/Composer'
import { ConfirmationCard } from './components/ConfirmationCard'
import { ConversationSidebar } from './components/ConversationSidebar'
import { MessageList } from './components/MessageList'
import { WelcomeState } from './components/WelcomeState'
import {
  useConversations,
  useConversation,
  useSendMessage,
  useConfirmAction,
  useDeleteConversation,
} from './hooks/useAi'
import { useVoiceInput } from './hooks/useVoiceInput'
import { streamChat } from './api/ai.api'
import { useAuthStore } from '@/stores/auth.store'
import type { ToolEvent } from './components/MessageList'
import type { AiMessage, PendingAction } from './api/ai.api'

/**
 * AI-assistenten (operatör). Sidan äger tillstånd, sändningsflödet och layouten;
 * presentationen ligger i `components/`. Två vägar in till assistenten:
 *
 *  • ÅTGÄRDSVÄGEN (icke-strömmande `POST /ai/chat`) — används när meddelandet
 *    ser ut att vilja göra något, eller när vi redan är i en konversation, för
 *    att följdsvar ska nå Claudes verktyg.
 *  • LÄSVÄGEN (SSE `GET /ai/chat/stream`) — frågor, med verktygsspår och
 *    bekräftelseflöde.
 */
export function AiPage() {
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [pendingMessages, setPendingMessages] = useState<AiMessage[]>([])
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [isThinking, setIsThinking] = useState(false)
  const [streamingText, setStreamingText] = useState<string>('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([])
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [analysisOpen, setAnalysisOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const streamCleanupRef = useRef<(() => void) | null>(null)

  const voice = useVoiceInput(setInput)

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

  const resetTextareaHeight = () => {
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const handleSend = async (text?: string) => {
    const msg = (text ?? input).trim()
    if (!msg || isThinking || isStreaming) return

    setInput('')
    resetTextareaHeight()
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
        // Samma tysta fel-svälj som strömvägen hade: action-anropet (icke-
        // strömmande /ai/chat) rensade state men gav ingen återkoppling vid
        // AI-fel. Visa samma läsbara toast. isThinking släcks i finally.
        setPendingMessages([])
        toast.error('AI-assistenten kunde inte svara just nu. Försök igen om en stund.')
      } finally {
        setIsThinking(false)
      }
    } else {
      // Read/question queries — use streaming (med tool-stöd och bekräftelseflöde)
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
        onError: (_error) => {
          // Släck BÅDA spinner-tillstånden (isStreaming för strömvägen,
          // isThinking som defensiv säkerhet) + rensa strömnings-state. Utan
          // detta snurrade "tänker"-indikatorn för evigt vid AI-fel. Visa ett
          // läsbart fel via appens toast — aldrig den råa tekniska orsaken
          // (_error kan innehålla t.ex. "credit balance too low").
          setIsStreaming(false)
          setIsThinking(false)
          setStreamingText('')
          setToolEvents([])
          setPendingMessages([])
          toast.error('AI-assistenten kunde inte svara just nu. Försök igen om en stund.')
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

  const handleNewConversation = () => {
    streamCleanupRef.current?.()
    setActiveConversationId(null)
    setPendingMessages([])
    setPendingAction(null)
    setIsStreaming(false)
    setStreamingText('')
    setInput('')
    resetTextareaHeight()
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

  const handleSelectConversation = (id: string) => {
    setActiveConversationId(id)
    setPendingMessages([])
    setPendingAction(null)
  }

  const isNewChat = !activeConversationId
  const hasMessages = allMessages.length > 0

  return (
    <PageWrapper id="ai">
      <div className="flex h-[calc(100vh-52px)] overflow-hidden">
        {/* ── Left Sidebar ── */}
        <ConversationSidebar
          conversations={conversations}
          isLoading={convLoading}
          activeConversationId={activeConversationId}
          confirmDeleteId={confirmDeleteId}
          onSelect={handleSelectConversation}
          onNewConversation={handleNewConversation}
          onRequestDelete={setConfirmDeleteId}
          onConfirmDelete={(id) => void handleDelete(id)}
          onOpenAnalysis={() => setAnalysisOpen(true)}
        />

        {/* ── Chat Area ── */}
        <div className="bg-canvas flex min-w-0 flex-1 flex-col">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto">
            {isNewChat && !hasMessages ? (
              <WelcomeState onSuggestion={(label) => void handleSend(label)} />
            ) : (
              <MessageList
                messages={allMessages}
                isThinking={isThinking}
                isStreaming={isStreaming}
                streamingText={streamingText}
                toolEvents={toolEvents}
                endRef={messagesEndRef}
              />
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
          <Composer
            value={input}
            onChange={setInput}
            onSubmit={() => void handleSend()}
            disabled={isThinking || isStreaming}
            isListening={voice.isListening}
            onStartVoice={voice.start}
            onStopVoice={voice.stop}
            textareaRef={textareaRef}
          />
        </div>
      </div>

      <AnalysisModal open={analysisOpen} onClose={() => setAnalysisOpen(false)} />
    </PageWrapper>
  )
}
