import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { decideAssignment, fetchAssignments } from '../api/assignments.api'
import type { AssignmentStatus } from '../api/assignments.api'

// Disjunkta nycklar per filter — annars skriver en filtrerad lista över den
// ofiltrerade i cachen.
const LIST = ['assignments', 'list'] as const

export function useAssignments(status?: AssignmentStatus) {
  return useQuery({
    queryKey: [...LIST, status ?? 'alla'],
    queryFn: () => fetchAssignments(status),
    staleTime: 30_000,
  })
}

export function useDecideAssignment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: decideAssignment,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LIST })
      // Kallelsen ligger i notisklockan. Beslutar man här ska räknaren följa med.
      void qc.invalidateQueries({ queryKey: ['notifications'] })
    },
  })
}
