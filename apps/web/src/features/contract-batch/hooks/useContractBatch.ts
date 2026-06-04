import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  createContractBatch,
  getContractBatch,
  confirmContractRow,
  confirmSafeRows,
  skipContractRow,
  cancelContractBatch,
  type ConfirmRowBody,
} from '../api/contractBatch.api'

const KEY = 'contract-batch'

export function useContractBatch(id: string | undefined) {
  return useQuery({
    queryKey: [KEY, 'detail', id],
    queryFn: () => getContractBatch(id as string),
    enabled: !!id,
    // Polla medan skanningen pågår så granskningsvyn fylls på allteftersom.
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status === 'PENDING' || status === 'SCANNING' ? 2000 : false
    },
  })
}

export function useCreateContractBatch() {
  return useMutation({
    mutationFn: (files: File[]) => createContractBatch(files),
    onError: (err: unknown) => toast.error(errorMessage(err, 'Kunde inte skapa batchen.')),
  })
}

export function useConfirmRow(batchId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ rowId, body }: { rowId: string; body: ConfirmRowBody }) =>
      confirmContractRow(batchId, rowId, body),
    onSuccess: (res) => {
      toast.success(res.alreadyCommitted ? 'Raden var redan godkänd.' : 'Avtal skapat (utkast).')
      void qc.invalidateQueries({ queryKey: [KEY, 'detail', batchId] })
      void qc.invalidateQueries({ queryKey: ['leases'] })
    },
    onError: (err: unknown) => toast.error(errorMessage(err, 'Kunde inte skapa avtalet.')),
  })
}

export function useConfirmSafe(batchId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => confirmSafeRows(batchId),
    onSuccess: (res) => {
      const failed = res.failed.length
      if (failed === 0) toast.success(`${res.committed.length} avtal skapade.`)
      else
        toast.warning(
          `${res.committed.length} avtal skapade, ${failed} rad(er) misslyckades — granska dem.`,
        )
      void qc.invalidateQueries({ queryKey: [KEY, 'detail', batchId] })
      void qc.invalidateQueries({ queryKey: ['leases'] })
    },
    onError: (err: unknown) => toast.error(errorMessage(err, 'Kunde inte godkänna raderna.')),
  })
}

export function useSkipRow(batchId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (rowId: string) => skipContractRow(batchId, rowId),
    onSuccess: () => {
      toast.success('Raden hoppades över.')
      void qc.invalidateQueries({ queryKey: [KEY, 'detail', batchId] })
    },
    onError: (err: unknown) => toast.error(errorMessage(err, 'Kunde inte hoppa över raden.')),
  })
}

export function useCancelBatch(batchId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => cancelContractBatch(batchId),
    onSuccess: () => {
      toast.success('Batchen avbröts.')
      void qc.invalidateQueries({ queryKey: [KEY, 'detail', batchId] })
    },
    onError: (err: unknown) => toast.error(errorMessage(err, 'Kunde inte avbryta batchen.')),
  })
}

function errorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null) {
    const maybe = err as { response?: { data?: { error?: { message?: string } } } }
    const msg = maybe.response?.data?.error?.message
    if (typeof msg === 'string' && msg.length > 0) return msg
  }
  return fallback
}
