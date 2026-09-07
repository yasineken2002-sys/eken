import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AssignContractorInput,
  CancelWorkOrderInput,
  CreateContractorInput,
  SendWorkOrderInput,
  UpdateContractorInput,
} from '@eken/shared'

import {
  assignContractor,
  cancelWorkOrder,
  createContractor,
  sendWorkOrder,
  deleteContractor,
  fetchContractor,
  fetchContractors,
  updateContractor,
  type ContractorFilters,
} from '../api/contractors.api'

// Disjunkta nycklar så list-invalidering inte träffar detalj-queries.
const CONTRACTORS_LIST = (f?: ContractorFilters) => ['contractors', 'list', f ?? {}] as const
const CONTRACTOR_DETAIL = (id: string) => ['contractor', 'detail', id] as const

export const contractorQueryKeys = {
  list: CONTRACTORS_LIST,
  detail: CONTRACTOR_DETAIL,
  allLists: () => ['contractors', 'list'] as const,
}

export function useContractors(filters?: ContractorFilters) {
  return useQuery({
    queryKey: CONTRACTORS_LIST(filters),
    queryFn: () => fetchContractors(filters),
  })
}

export function useContractor(id: string | null) {
  return useQuery({
    queryKey: id ? CONTRACTOR_DETAIL(id) : ['contractor', 'detail', '__disabled__'],
    queryFn: () => fetchContractor(id!),
    enabled: !!id,
  })
}

export function useCreateContractor() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateContractorInput) => createContractor(input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: contractorQueryKeys.allLists() }),
  })
}

export function useUpdateContractor() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateContractorInput }) =>
      updateContractor(id, input),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: contractorQueryKeys.allLists() })
      void qc.invalidateQueries({ queryKey: contractorQueryKeys.detail(v.id) })
    },
  })
}

export function useDeleteContractor() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteContractor(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: contractorQueryKeys.allLists() }),
  })
}

/**
 * Tilldelning invaliderar ÄRENDET, inte hantverkarlistan — registret ändras
 * inte av att någon får ett ärende. Disjunkta nycklar gör den skillnaden
 * möjlig att uttrycka.
 */
export function useAssignContractor() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ ticketId, input }: { ticketId: string; input: AssignContractorInput }) =>
      assignContractor(ticketId, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['maintenance'] })
      void qc.invalidateQueries({ queryKey: ['maintenance-ticket'] })
    },
  })
}

// ─── Arbetsorder (PR 2) ──────────────────────────────────────────────────────

export function useSendWorkOrder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ ticketId, input }: { ticketId: string; input: SendWorkOrderInput }) =>
      sendWorkOrder(ticketId, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['maintenance'] })
      void qc.invalidateQueries({ queryKey: ['maintenance-ticket'] })
    },
  })
}

export function useCancelWorkOrder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: CancelWorkOrderInput }) =>
      cancelWorkOrder(id, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['maintenance'] })
      void qc.invalidateQueries({ queryKey: ['maintenance-ticket'] })
    },
  })
}
