import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchTickets,
  fetchStats,
  fetchTicket,
  createTicket,
  updateTicket,
  addComment,
  deleteTicket,
} from '../api/maintenance.api'
import type { TicketFilters, CreateTicketInput, UpdateTicketInput } from '../api/maintenance.api'

export function useTickets(filters?: TicketFilters) {
  return useQuery({
    queryKey: ['maintenance', filters],
    queryFn: () => fetchTickets(filters),
    staleTime: 60_000,
  })
}

export function useTicket(id: string | null) {
  return useQuery({
    queryKey: ['maintenance', id],
    queryFn: () => fetchTicket(id!),
    enabled: !!id,
    staleTime: 60_000,
  })
}

export function useMaintenanceStats() {
  return useQuery({
    queryKey: ['maintenance', 'stats'],
    queryFn: fetchStats,
    staleTime: 60_000,
  })
}

export function useCreateTicket() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (dto: CreateTicketInput) => createTicket(dto),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['maintenance'] })
    },
  })
}

export function useUpdateTicket() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, dto }: { id: string; dto: UpdateTicketInput }) => updateTicket(id, dto),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['maintenance'] })
    },
  })
}

export function useAddComment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      content,
      isInternal,
    }: {
      id: string
      content: string
      isInternal: boolean
    }) => addComment(id, content, isInternal),
    onSuccess: (_data, { id }) => {
      void qc.invalidateQueries({ queryKey: ['maintenance', id] })
      void qc.invalidateQueries({ queryKey: ['maintenance'] })
    },
  })
}

export function useDeleteTicket() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteTicket(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['maintenance'] })
    },
  })
}
