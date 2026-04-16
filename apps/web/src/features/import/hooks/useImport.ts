import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getImportJobs, previewImport, executeImport, scanContract } from '../api/import.api'

export function useImportJobs() {
  return useQuery({
    queryKey: ['import', 'jobs'],
    queryFn: () => getImportJobs(),
    staleTime: 30_000,
  })
}

export function usePreviewImport() {
  return useMutation({
    mutationFn: ({ file, type }: { file: File; type: string }) => previewImport(file, type),
  })
}

export function useExecuteImport() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ file, type }: { file: File; type: string }) => executeImport(file, type),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['import', 'jobs'] })
      void queryClient.invalidateQueries({ queryKey: ['properties'] })
      void queryClient.invalidateQueries({ queryKey: ['units'] })
      void queryClient.invalidateQueries({ queryKey: ['tenants'] })
      void queryClient.invalidateQueries({ queryKey: ['leases'] })
    },
  })
}

export function useScanContract() {
  return useMutation({
    mutationFn: (file: File) => scanContract(file),
  })
}
