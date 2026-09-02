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

export const fetchAssignments = (status?: AssignmentStatus) =>
  get<Assignment[]>('/ai/assignments', status ? { status } : undefined)

export const decideAssignment = (params: {
  id: string
  decision: 'APPROVED' | 'REJECTED'
  reason?: string
}) =>
  patch<Assignment>(`/ai/assignments/${params.id}/decision`, {
    decision: params.decision,
    ...(params.reason ? { reason: params.reason } : {}),
  })
