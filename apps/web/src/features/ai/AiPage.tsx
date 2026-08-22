import { useState, useRef, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { AnalysisModal } from './components/AnalysisModal'
import { Composer } from './components/Composer'
import { ConfirmationCard } from './components/ConfirmationCard'
import { ConversationSidebar } from './components/ConversationSidebar'
import { MessageList } from './components/MessageList'
import { SuggestionChips, WelcomeGreeting } from './components/WelcomeState'
import {
  useConversations,
  useConversation,
  useSendMessage,
  useConfirmAction,
  useDeleteConversation,
  useToolCatalog,
} from './hooks/useAi'
import { useVoiceInput } from './hooks/useVoiceInput'
import { useAttachments } from './hooks/useAttachments'
import { streamChat, toolLabelMap } from './api/ai.api'
import { useAuthStore } from '@/stores/auth.store'
import type { ToolEvent } from './components/MessageList'
import type { AiMessage, PendingAction, ToolCatalogEntry } from './api/ai.api'

/** Rad under texten i det temporära user-meddelandet medan svaret hämtas. */
function attachmentNote(count: number): string {
  return `_(${count} ${count === 1 ? 'bilaga' : 'bilagor'} bifogad${count === 1 ? '' : 'e'})_`
}

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
  /** Turtaket nåddes — svaret är ofullständigt. Nollställs vid varje ny tur. */
  const [iterationCapped, setIterationCapped] = useState<{
    toolRounds: number
    maxToolRounds: number
  } | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [analysisOpen, setAnalysisOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const streamCleanupRef = useRef<(() => void) | null>(null)

  const voice = useVoiceInput(setInput)

  // Bilagorna (B4). Hooken äger uppladdning, förhandsvisning och städning;
  // sidan frågar bara efter `readyIds` när meddelandet skickas.
  const attach = useAttachments()

  const queryClient = useQueryClient()
  const { data: conversations = [], isLoading: convLoading } = useConversations()
  const { data: conversation } = useConversation(activeConversationId)
  const sendMutation = useSendMessage()
  const confirmMutation = useConfirmAction()
  const deleteMutation = useDeleteConversation()
  const { data: toolCatalog } = useToolCatalog()

  // Etiketter för verktygsspåret. Kommer från backends katalog — frontend har
  // ingen egen lista (den drev isär förr).
  const toolLabels = toolCatalog ? toolLabelMap(toolCatalog) : {}

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
    // Blockerad av en pågående uppladdning eller ett felkort — hade vi skickat
    // nu gått meddelandet iväg utan sin bilaga. Skäl visas i kompositören.
    if (attach.blockingReason) return

    // Läs id:na FÖRE nollställningen: `attach.clear()` nedan tömmer brickan,
    // och de här id:na är det enda sättet servern hittar bilagorna.
    const attachmentIds = attach.readyIds

    setInput('')
    resetTextareaHeight()
    setPendingAction(null)
    // Brickan töms direkt vid sändning. Bilagorna blir konsumerade på servern,
    // och ett kort som ligger kvar hade avvisats med "redan skickade" nästa
    // gång — bättre att UI:t speglar att de nu hör till meddelandet.
    attach.clear()

    const tempUser: AiMessage = {
      id: `tmp-user-${Date.now()}`,
      conversationId: activeConversationId ?? '',
      role: 'user',
      // Bilagorna visas som en rad under texten tills konversationen hämtats
      // om — annars ser det ut som att de försvann i det ögonblick man skickade.
      content: attachmentIds.length > 0 ? `${msg}\n\n${attachmentNote(attachmentIds.length)}` : msg,
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
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
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
      setIterationCapped(null)

      streamCleanupRef.current = streamChat(
        msg,
        activeConversationId ?? undefined,
        token,
        {
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
          onIterationCap: ({ toolRounds, maxToolRounds }) => {
            // Markeringen står redan i den strömmade texten (kommer som en
            // `delta`). Den här flaggan gör att den ÄVEN syns som en varning i
            // gränssnittet — ett avbrutet arbete ska inte gå att läsa förbi som
            // brödtext. Loggas dessutom så det syns i en supportsession.
            setIterationCapped({ toolRounds, maxToolRounds })
            console.warn(
              `[ai] turtaket nåddes: ${toolRounds}/${maxToolRounds} verktygsomgångar — svaret är ofullständigt`,
            )
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
        },
        // Bara id:n går på URL:en — bytes ligger redan på servern.
        attachmentIds.length > 0 ? attachmentIds : undefined,
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

  const handleNewConversation = () => {
    streamCleanupRef.current?.()
    // Bilagor som laddats upp men aldrig skickats hör till det övergivna
    // meddelandet. Tas bort här; TTL-cronen städar dem annars inom ett dygn.
    attach.attachments.forEach((a) => attach.remove(a.localId))
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

  // Tomt läge: ingen vald konversation OCH inget på väg in. Styr både
  // kompositörens variant och om hälsning/chips visas.
  const isEmpty = !activeConversationId && allMessages.length === 0

  /**
   * Val i verktygsmenyn. Till skillnad från snabbstart-chipsen (som skickar
   * direkt) STARTAR det här ingenting: prompten skrivs i rutan och användaren
   * får skriva klart och skicka själv. Menyn listar även bindande verktyg, och
   * ett bindande verktyg får aldrig vara ett klick från exekvering.
   *
   * Startprompten härleds ur `menuLabel` — katalogen är enda sanningskällan,
   * frontend har ingen egen promptlista.
   */
  const handleSelectTool = (entry: ToolCatalogEntry) => {
    const seed = `${entry.menuLabel} `
    setInput(seed)
    // Efter renderingen: fokus i rutan med markören sist, så användaren kan
    // skriva vidare direkt ("Skapa faktura |").
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(seed.length, seed.length)
    })
  }

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

        {/* ── Chat Area ──
            Kompositören ligger på SAMMA plats i trädet i båda lägena och monteras
            aldrig om — den byter bara variant. Skulle den flyttas mellan två
            grenar hade React monterat om textarean och användaren tappat fokus
            i samma ögonblick som konversationen startar. Ytorna över och under
            den styr i stället var den hamnar: i tomt läge klämmer de in den mitt
            på sidan, i konversationsläge fyller meddelandena ytan ovanför och
            kompositören hamnar i botten. `layout` gör förflyttningen till en
            glidning i stället för ett hopp. */}
        <div className="bg-canvas flex min-w-0 flex-1 flex-col">
          {isEmpty ? (
            <div className="flex flex-1 flex-col items-center justify-end px-8 pb-7">
              <WelcomeGreeting />
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto">
              <MessageList
                messages={allMessages}
                isThinking={isThinking}
                isStreaming={isStreaming}
                streamingText={streamingText}
                toolEvents={toolEvents}
                toolLabels={toolLabels}
                iterationCapped={iterationCapped}
                endRef={messagesEndRef}
              />
            </div>
          )}

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

          <motion.div layout transition={{ type: 'spring', stiffness: 320, damping: 34 }}>
            <Composer
              value={input}
              onChange={setInput}
              onSubmit={() => void handleSend()}
              disabled={isThinking || isStreaming}
              isListening={voice.isListening}
              onStartVoice={voice.start}
              onStopVoice={voice.stop}
              variant={isEmpty ? 'hero' : 'docked'}
              toolCatalog={toolCatalog}
              onSelectTool={handleSelectTool}
              attachments={attach.attachments}
              onAddFiles={(files) => attach.addFiles(files, activeConversationId ?? undefined)}
              onRemoveAttachment={attach.remove}
              attachmentBlockingReason={attach.blockingReason}
              textareaRef={textareaRef}
            />
          </motion.div>

          {isEmpty && (
            <div className="flex flex-1 flex-col items-center justify-start px-8 pt-5">
              <SuggestionChips onSelect={(prompt) => void handleSend(prompt)} />
            </div>
          )}
        </div>
      </div>

      <AnalysisModal open={analysisOpen} onClose={() => setAnalysisOpen(false)} />
    </PageWrapper>
  )
}
