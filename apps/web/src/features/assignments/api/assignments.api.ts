import { get, patch } from '@/lib/api'

export type AssignmentStatus = 'AWAITING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'EXPIRED'

/** Klickbar data bakom motiveringen. Tom lista = ingen post att öppna. */
export interface AssignmentEvidence {
  entityType: string
  entityId: string
  label: string
}

export interface Assignment {
  id: string
  toolName: string
  title: string
  reasoning: string
  consequence: string
  undoHint: string
  evidence: AssignmentEvidence[]
  status: AssignmentStatus
  statusReason: string | null
  deadline: string
  decidedAt: string | null
  createdAt: string
}

/**
 * Uppdragen för `/uppdrag`.
 *
 * ── SVARET ÄR SIDINDELAT SEDAN INKORGEN (etapp 6) ───────────────────────────
 *
 * Endpointen returnerade förut en naken array och bär nu `{ rader, total, limit,
 * offset }`. Sidan här läser bara raderna — men `total` finns, och den dagen
 * `/uppdrag` växer förbi en sida är det talet som ska visas i stället för att
 * listan tyst klipps. Skillnaden är utskriven därför att en trunkering utan tal
 * är exakt den tystnad kodbasen inte accepterar.
 */
export interface AssignmentPage {
  rader: Assignment[]
  total: number
  limit: number
  offset: number
}

export const fetchAssignments = async (status?: AssignmentStatus): Promise<Assignment[]> => {
  const sida = await get<AssignmentPage>('/ai/assignments', status ? { status } : undefined)
  return sida.rader
}

export const decideAssignment = (params: {
  id: string
  decision: 'APPROVED' | 'REJECTED'
  reason?: string
}) =>
  patch<Assignment>(`/ai/assignments/${params.id}/decision`, {
    decision: params.decision,
    ...(params.reason ? { reason: params.reason } : {}),
  })
