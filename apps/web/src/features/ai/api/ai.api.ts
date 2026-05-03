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

const TOOL_LABELS: Record<string, string> = {
  get_dashboard_stats: 'Hämtar översikt',
  get_overdue_invoices: 'Hämtar förfallna fakturor',
  get_expiring_leases: 'Letar efter kontrakt som löper ut',
  get_tenants: 'Hämtar hyresgäster',
  get_invoices: 'Hämtar fakturor',
  get_properties: 'Hämtar fastigheter',
  get_units: 'Hämtar enheter',
  get_available_units: 'Letar efter lediga enheter',
  get_leases: 'Hämtar kontrakt',
  get_maintenance_tickets: 'Hämtar underhållsärenden',
  get_maintenance_plan: 'Hämtar underhållsplan',
  get_rent_notices: 'Hämtar hyresavier',
  get_inspections: 'Hämtar besiktningar',
  create_invoice: 'Förbereder ny faktura',
  create_bulk_invoices: 'Förbereder hyresfakturering',
  update_tenant: 'Uppdaterar hyresgäst',
  send_invoice_email: 'Förbereder e-post med faktura',
  send_overdue_reminders: 'Förbereder påminnelser',
  mark_invoice_paid: 'Markerar faktura som betald',
  create_lease: 'Förbereder kontrakt',
  transition_lease_status: 'Ändrar kontraktsstatus',
  create_property: 'Förbereder ny fastighet',
  create_unit: 'Förbereder ny enhet',
  export_sie4: 'Förbereder SIE4-export',
  compose_and_send_email: 'Förbereder e-postutskick',
  apply_rent_increase: 'Förbereder hyreshöjning',
  generate_lease_contract: 'Förbereder kontraktsmall',
  create_tenant_and_lease: 'Förbereder hyresgäst och kontrakt',
  generate_rent_notices: 'Förbereder hyresavier',
  create_inspection: 'Förbereder besiktning',
  // Bankavstämning + bokföring
  get_bank_transactions: 'Hämtar banktransaktioner',
  get_unmatched_transactions: 'Hämtar omatchade transaktioner',
  get_reconciliation_summary: 'Hämtar avstämningsläget',
  match_bank_transaction: 'Förbereder manuell matchning',
  import_bgmax_file: 'Förbereder BgMax-import',
  unmatch_transaction: 'Förbereder avmatchning',
  get_journal_entries: 'Hämtar verifikat',
  get_account_balance: 'Hämtar kontosaldo',
  get_vat_report: 'Genererar momsrapport',
  get_profit_loss_report: 'Genererar resultaträkning',
  get_balance_sheet: 'Genererar balansräkning',
  create_journal_entry: 'Förbereder manuellt verifikat',
  record_expense: 'Förbereder utgiftsbokning',
  close_period: 'Förbereder periodstängning',
}

export function describeTool(name: string): string {
  return TOOL_LABELS[name] ?? `Kör ${name.replace(/_/g, ' ')}`
}
