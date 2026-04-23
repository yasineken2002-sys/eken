import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getMessages, getMessageStats, retryMessage, sendMessage } from '../api/messages.api'
import type { SendMessagePayload } from '../api/messages.api'

export function useMessages() {
  return useQuery({ queryKey: ['messages'], queryFn: getMessages, staleTime: 30_000 })
}

export function useMessageStats() {
  return useQuery({ queryKey: ['messages', 'stats'], queryFn: getMessageStats, staleTime: 30_000 })
}

export function useSendMessage() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: SendMessagePayload) => sendMessage(payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['messages'] })
    },
  })
}

export function useRetryMessage() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => retryMessage(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['messages'] })
    },
  })
}
