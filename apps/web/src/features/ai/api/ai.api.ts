import { api, get, post, del } from '@/lib/api'
import { useAuthStore } from '@/stores/auth.store'

export interface AiMessage {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

export interface AiConversation {
  id: string
  organizationId: string
  userId: string
  title: string
  createdAt: string
  updatedAt: string
  messages: AiMessage[]
  _count?: { messages: number }
}

export interface PendingAction {
  toolName: string
  toolInput: Record<string, unknown>
  confirmationMessage: string
  details: Record<string, string>
  requiresDoubleConfirm?: boolean
}

export interface ChatResponse {
  conversationId: string
  reply: string
  pendingAction?: PendingAction
  downloadUrl?: string
}

/**
 * En bilaga som ligger på servern och väntar på att skickas — svaret från
 * `POST /v1/ai/attachments` (spår B1).
 *
 * `mimeType` är serverns DETEKTERADE typ (magiska byten), inte den webbläsaren
 * gissade på `File.type`. De kan skilja sig, och serverns är den sanna.
 */
export interface AiAttachment {
  id: string
  kind: 'image' | 'document'
  filename: string
  mimeType: string
  sizeBytes: number
  /** Antal sidor för PDF; null för bilder och PDF:er som inte gick att räkna. */
  pageCount: number | null
  expiresAt: string
}

/**
 * Serverns gränser, speglade här för att kunna ge svar direkt i UI:t i stället
 * för efter en uppladdning. SERVERN ÄR ALLTID AUKTORITETEN — den validerar
 * magiska byten, sidantal och totalstorlek oavsett vad som står här. Det här är
 * bara till för att slippa skicka en fil som ändå kommer avvisas.
 */
export const ATTACHMENT_LIMITS = {
  maxPerMessage: 5,
  maxImageBytes: 5 * 1024 * 1024,
  maxDocumentBytes: 20 * 1024 * 1024,
  /** Samma allowlist som serverns DETECTED_AI_CHAT_TYPES. */
  acceptedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const,
} as const

/** `accept`-attributet till filväljaren, härlett ur allowlisten ovan. */
export const ATTACHMENT_ACCEPT = ATTACHMENT_LIMITS.acceptedMimeTypes.join(',')

export async function uploadAttachment(file: File, conversationId?: string): Promise<AiAttachment> {
  const formData = new FormData()
  formData.append('file', file)
  if (conversationId) formData.append('conversationId', conversationId)

  const token = useAuthStore.getState().accessToken
  const { data } = await api.post<{ data: AiAttachment }>('/ai/attachments', formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  return data.data
}

/** Tar bort en bilaga som ännu inte skickats. Servern vägrar för skickade. */
export async function deleteAttachment(id: string): Promise<void> {
  return del(`/ai/attachments/${id}`)
}

export async function sendMessage(
  message: string,
  conversationId?: string,
  attachmentIds?: string[],
): Promise<ChatResponse> {
  return post<ChatResponse>('/ai/chat', {
    message,
    ...(conversationId ? { conversationId } : {}),
    // Utelämnas helt när inget är bifogat — text-only-vägen ska se exakt ut
    // som före spår B.
    ...(attachmentIds?.length ? { attachmentIds } : {}),
  })
}

export async function confirmAction(params: {
  toolName: string
  toolInput: Record<string, unknown>
  conversationId: string
  confirmed: boolean
}): Promise<ChatResponse> {
  return post<ChatResponse>('/ai/confirm', params)
}

export async function fetchConversations(): Promise<AiConversation[]> {
  return get<AiConversation[]>('/ai/conversations')
}

export async function fetchConversation(id: string): Promise<AiConversation> {
  return get<AiConversation>(`/ai/conversations/${id}`)
}

export async function deleteConversation(id: string): Promise<void> {
  return del(`/ai/conversations/${id}`)
}

export interface PortfolioInsight {
  category: string
  finding: string
  severity: 'info' | 'warning' | 'critical'
  action?: string
}

export interface PortfolioAnalysis {
  summary: string
  insights: PortfolioInsight[]
  recommendations: string[]
  generatedAt: string
}

export async function analyzePortfolio(type: string): Promise<PortfolioAnalysis> {
  return get<PortfolioAnalysis>(`/ai/analysis?type=${type}`)
}

export async function clearAiMemory(): Promise<void> {
  return del('/ai/memory')
}

export interface StreamChatHandlers {
  onDelta: (text: string) => void
  onDone: (conversationId: string) => void
  onError: (error: string) => void
  onToolUseStart?: (event: { id: string; name: string }) => void
  onToolUseExecuting?: (event: { id: string; name: string; input: Record<string, unknown> }) => void
  onToolResult?: (event: { id: string; name: string; result: unknown }) => void
  onPendingAction?: (action: PendingAction & { conversationId: string }) => void
}

export function streamChat(
  message: string,
  conversationId: string | undefined,
  token: string,
  handlers: StreamChatHandlers,
  attachmentIds?: string[],
): () => void {
  const controller = new AbortController()
  const params = new URLSearchParams({ message })
  if (conversationId) params.set('conversationId', conversationId)
  // BARA id:n på URL:en — bytes ligger redan på servern sedan uppladdningen.
  // Det är hela skälet till att uppladdningen är en egen endpoint: base64 får
  // inte plats i en query-param.
  if (attachmentIds?.length) params.set('attachmentIds', attachmentIds.join(','))

  let buffer = ''

  fetch(`/api/v1/ai/chat/stream?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok || !response.body) {
        handlers.onError('Kunde inte ansluta till AI-tjänsten')
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let currentEvent = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value)
        for (const line of chunk.split('\n')) {
          const trimmed = line.trim()
          if (trimmed.startsWith('event: ')) {
            currentEvent = trimmed.slice(7)
          } else if (trimmed.startsWith('data: ')) {
            try {
              const data = JSON.parse(trimmed.slice(6)) as Record<string, unknown>
              if (currentEvent === 'delta' && typeof data['text'] === 'string') {
                buffer += data['text']
                handlers.onDelta(buffer)
              } else if (
                currentEvent === 'tool_use_start' &&
                typeof data['id'] === 'string' &&
                typeof data['name'] === 'string'
              ) {
                handlers.onToolUseStart?.({ id: data['id'], name: data['name'] })
              } else if (
                currentEvent === 'tool_use_executing' &&
                typeof data['id'] === 'string' &&
                typeof data['name'] === 'string'
              ) {
                handlers.onToolUseExecuting?.({
                  id: data['id'],
                  name: data['name'],
                  input: (data['input'] as Record<string, unknown> | undefined) ?? {},
                })
              } else if (
                currentEvent === 'tool_result' &&
                typeof data['id'] === 'string' &&
                typeof data['name'] === 'string'
              ) {
                handlers.onToolResult?.({
                  id: data['id'],
                  name: data['name'],
                  result: data['result'],
                })
              } else if (
                currentEvent === 'pending_action' &&
                typeof data['conversationId'] === 'string' &&
                typeof data['toolName'] === 'string'
              ) {
                handlers.onPendingAction?.(
                  data as unknown as PendingAction & { conversationId: string },
                )
              } else if (currentEvent === 'done' && typeof data['conversationId'] === 'string') {
                handlers.onDone(data['conversationId'])
              } else if (currentEvent === 'error' && typeof data['message'] === 'string') {
                handlers.onError(data['message'])
              }
            } catch {
              // ignore malformed lines
            }
          }
        }
      }
    })
    .catch((err: unknown) => {
      if ((err as Error).name !== 'AbortError') {
        handlers.onError('Anslutningen bröts')
      }
    })

  return () => controller.abort()
}

/**
 * Verktygskatalogen hämtas från backend — frontend håller INGEN egen lista.
 *
 * Den gamla `TOOL_LABELS` här drev isär från serverns `TOOLS`: 10 verktyg
 * saknade etikett och visades som "Kör find optimization opportunities", och
 * 2 etiketter (`get_units`, `get_leases`) pekade på verktyg som tagits bort.
 * Etiketter och grupper bor nu i apps/api/src/ai/tools/ai-tools.catalog.ts,
 * vaktade av ett test som fäller bygget vid drift åt båda hållen.
 */
export type ToolGroup =
  | 'Ekonomi & avier'
  | 'Bankavstämning'
  | 'Avtal & hyresgäster'
  | 'Fastigheter & underhåll'
  | 'Dokument & juridik'

export interface ToolCatalogEntry {
  name: string
  /** Pågående form ("Skapar faktura") — statusraden medan verktyget kör. */
  label: string
  /** Imperativ form ("Skapa faktura") — verktygsmenyn i kompositören. */
  menuLabel: string
  group: ToolGroup
  /** true = kräver användarens bekräftelse innan den körs. */
  binding: boolean
}

export const fetchToolCatalog = () => get<ToolCatalogEntry[]>('/ai/tools')

/** name → etikett, för statusraden medan ett verktyg kör. */
export function toolLabelMap(catalog: ToolCatalogEntry[]): Record<string, string> {
  return Object.fromEntries(catalog.map((t) => [t.name, t.label]))
}
