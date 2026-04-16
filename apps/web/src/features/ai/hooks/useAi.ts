import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchConversations,
  fetchConversation,
  sendMessage,
  confirmAction,
  deleteConversation,
} from '../api/ai.api'

export function useConversations() {
  return useQuery({
    queryKey: ['ai-conversations'],
    queryFn: fetchConversations,
    staleTime: 30_000,
  })
}

export function useConversation(id: string | null) {
  return useQuery({
    queryKey: ['ai-conversation', id],
    queryFn: () => fetchConversation(id!),
    enabled: !!id,
    staleTime: 0,
  })
}

export function useSendMessage() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ message, conversationId }: { message: string; conversationId?: string }) =>
      sendMessage(message, conversationId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['ai-conversations'] })
      if (data.conversationId) {
        queryClient.invalidateQueries({ queryKey: ['ai-conversation', data.conversationId] })
      }
    },
  })
}

export function useConfirmAction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: confirmAction,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['ai-conversations'] })
      if (data.conversationId) {
        queryClient.invalidateQueries({ queryKey: ['ai-conversation', data.conversationId] })
      }
      // Invalidate domain data so pages reflect AI-created/updated entities
      queryClient.invalidateQueries({ queryKey: ['invoices'] })
      queryClient.invalidateQueries({ queryKey: ['tenants'] })
      queryClient.invalidateQueries({ queryKey: ['leases'] })
      queryClient.invalidateQueries({ queryKey: ['properties'] })
      queryClient.invalidateQueries({ queryKey: ['units'] })
    },
  })
}

export function useDeleteConversation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: deleteConversation,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ai-conversations'] })
    },
  })
}
