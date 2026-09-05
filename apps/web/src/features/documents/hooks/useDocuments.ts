import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchDocuments,
  uploadDocument,
  deleteDocument,
  sendDocumentToTenant,
} from '../api/documents.api'
import type { UploadDocumentInput } from '../api/documents.api'

export function useDocuments(filters?: {
  propertyId?: string
  unitId?: string
  leaseId?: string
  tenantId?: string
  category?: string
}) {
  return useQuery({
    queryKey: ['documents', filters],
    queryFn: () => fetchDocuments(filters),
    staleTime: 60_000,
  })
}

export function useUploadDocument() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: UploadDocumentInput) => uploadDocument(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['documents'] })
    },
  })
}

export function useDeleteDocument() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteDocument(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['documents'] })
    },
  })
}

/**
 * Skicka ett dokument till en hyresgästs portal.
 *
 * INVALIDERAR INTE dokumentlistan i den här vyn: leveransen skapar ett NYTT
 * dokument kopplat till hyresgästen (`deliverToTenant` laddar upp en egen kopia
 * med en mottagarhärledd lagringsnyckel), och det syns i hyresgästens portal —
 * inte nödvändigtvis i den lista man står i. En invalidering hade sett rimlig ut
 * och inte gjort något användaren kan se.
 */
export function useSendDocumentToTenant() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      documentId,
      tenantId,
      notify,
    }: {
      documentId: string
      tenantId: string
      notify: boolean
    }) => sendDocumentToTenant(documentId, tenantId, notify),
    onSuccess: () => {
      // Hyresgästens dokumentlista kan vara öppen i en annan vy.
      void queryClient.invalidateQueries({ queryKey: ['documents'] })
    },
  })
}
