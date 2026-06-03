import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { approveTermination, fetchTerminations, rejectTermination } from '../api/terminations.api'
import type { TerminationStatus } from '../api/terminations.api'

const LIST = ['terminations', 'list'] as const

export function useTerminations(filters?: { status?: TerminationStatus }) {
  return useQuery({
    queryKey: [...LIST, filters],
    queryFn: () => fetchTerminations(filters),
    staleTime: 60_000,
  })
}

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: LIST })
  // Ett godkännande säger upp leasen (terminatedAt/endDate) → leases-listan
  // kan ha ändrats.
  void qc.invalidateQueries({ queryKey: ['leases', 'list'] })
}

export function useApproveTermination() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      effectiveDate,
      terminationReason,
    }: {
      id: string
      effectiveDate?: string
      terminationReason?: string
    }) =>
      approveTermination(id, {
        ...(effectiveDate ? { effectiveDate } : {}),
        ...(terminationReason ? { terminationReason } : {}),
      }),
    onSuccess: () => invalidate(qc),
  })
}

export function useRejectTermination() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => rejectTermination(id, reason),
    onSuccess: () => invalidate(qc),
  })
}
