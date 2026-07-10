import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchBackfillQueue, fetchBackfillPreview, confirmBackfill } from '../api/backfill.api'

export function useBackfillQueue() {
  return useQuery({
    queryKey: ['backfill', 'queue'],
    queryFn: fetchBackfillQueue,
    staleTime: 30_000,
  })
}

export function useBackfillPreview(leaseId: string | null) {
  return useQuery({
    queryKey: ['backfill', 'preview', leaseId],
    queryFn: () => fetchBackfillPreview(leaseId as string),
    enabled: !!leaseId,
    staleTime: 15_000,
  })
}

export function useConfirmBackfill() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      leaseId,
      allowBeyondWarning,
      vatDeclarationAcknowledged,
    }: {
      leaseId: string
      allowBeyondWarning: boolean
      vatDeclarationAcknowledged: boolean
    }) => confirmBackfill(leaseId, { allowBeyondWarning, vatDeclarationAcknowledged }),
    onSuccess: () => {
      // Kön krymper när ett kontrakt efterdebiterats; avilistan får nya avier.
      void qc.invalidateQueries({ queryKey: ['backfill'] })
      void qc.invalidateQueries({ queryKey: ['avisering'] })
    },
  })
}
