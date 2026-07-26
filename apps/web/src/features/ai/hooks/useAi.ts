import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchConversations,
  fetchConversation,
  sendMessage,
  confirmAction,
  deleteConversation,
  fetchToolCatalog,
} from '../api/ai.api'

/**
 * Assistentens verktygskatalog. Statisk under en session — verktygen ändras
 * bara vid deploy — så den cachas hårt i stället för att hämtas per meddelande.
 */
export function useToolCatalog() {
  return useQuery({
    queryKey: ['ai-tool-catalog'],
    queryFn: fetchToolCatalog,
    staleTime: Infinity,
  })
}

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
      queryClient.invalidateQueries({ queryKey: ['tenants', 'list'] })
      queryClient.invalidateQueries({ queryKey: ['leases', 'list'] })
      queryClient.invalidateQueries({ queryKey: ['properties', 'list'] })
      queryClient.invalidateQueries({ queryKey: ['units', 'list'] })
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
