import { get, post, del } from '@/lib/api'

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

export async function sendMessage(message: string, conversationId?: string): Promise<ChatResponse> {
  return post<ChatResponse>('/ai/chat', { message, ...(conversationId ? { conversationId } : {}) })
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

export function streamChat(
  message: string,
  conversationId: string | undefined,
  token: string,
  onDelta: (text: string) => void,
  onDone: (conversationId: string) => void,
  onError: (error: string) => void,
): () => void {
  const controller = new AbortController()
  const params = new URLSearchParams({ message })
  if (conversationId) params.set('conversationId', conversationId)

  let buffer = ''

  fetch(`/api/v1/ai/chat/stream?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok || !response.body) {
        onError('Kunde inte ansluta till AI-tjänsten')
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
              const data = JSON.parse(trimmed.slice(6)) as {
                text?: string
                conversationId?: string
                message?: string
              }
              if (currentEvent === 'delta' && data.text !== undefined) {
                buffer += data.text
                onDelta(buffer)
              } else if (currentEvent === 'done' && data.conversationId) {
                onDone(data.conversationId)
              } else if (currentEvent === 'error' && data.message) {
                onError(data.message)
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
        onError('Anslutningen bröts')
      }
    })

  return () => controller.abort()
}
