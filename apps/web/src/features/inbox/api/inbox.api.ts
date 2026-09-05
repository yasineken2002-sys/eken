import { get, patch } from '@/lib/api'

export type AssignmentStatus = 'AWAITING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'EXPIRED'

/** Klickbar data bakom motiveringen. Tom lista = ingen post att öppna. */
export interface InboxEvidence {
  entityType: string
  entityId: string
  label: string
}

/**
 * Ett förslag i inkorgen.
 *
 * Fälten speglar planens fem krav på vad hyresvärden ska se: `toolName` +
 * `toolInput` (vad agenten hade gjort), `reasoning` (varför), `evidence`
 * (vilken information den använde), `confidence` (hur säker), `consequence`
 * (vad som hade krävt godkännande).
 */
export interface InboxItem {
  id: string
  shadow: boolean
  toolName: string
  toolInput: Record<string, unknown>
  title: string
  reasoning: string
  consequence: string
  undoHint: string
  evidence: InboxEvidence[]
  confidence: number | null
  prediction: Record<string, unknown> | null
  outcome: Record<string, unknown> | null
  status: AssignmentStatus
  statusReason: string | null
  deadline: string
  decidedAt: string | null
  createdAt: string
}

export interface InboxPage {
  rader: InboxItem[]
  total: number
  limit: number
  offset: number
}

/** Träffgrad för ETT fält. `andel` är null när inget facit finns än. */
export interface Traffgrad {
  besvarade: number
  traffar: number
  andel: number | null
}

export interface InboxSummary {
  status: Record<AssignmentStatus, number>
  traffgrad: Record<string, Traffgrad>
}

export const fetchInbox = (params: {
  status?: AssignmentStatus
  limit?: number
  offset?: number
}) =>
  get<InboxPage>('/ai/assignments', {
    shadow: 'true',
    ...(params.status ? { status: params.status } : {}),
    ...(params.limit ? { limit: String(params.limit) } : {}),
    ...(params.offset ? { offset: String(params.offset) } : {}),
  })

export const fetchInboxSummary = () =>
  get<InboxSummary>('/ai/assignments/summary', { shadow: 'true' })

export const decideInboxItem = (params: {
  id: string
  decision: 'APPROVED' | 'REJECTED'
  reason?: string
}) =>
  patch<InboxItem>(`/ai/assignments/${params.id}/decision`, {
    decision: params.decision,
    ...(params.reason ? { reason: params.reason } : {}),
  })
