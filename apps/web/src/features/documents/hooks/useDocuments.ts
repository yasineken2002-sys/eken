import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchDocuments, uploadDocument, deleteDocument } from '../api/documents.api'
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
