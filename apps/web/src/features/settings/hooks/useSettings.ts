import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getOrganization, updateOrganization, uploadLogo } from '../api/settings.api'

export function useOrganization() {
  return useQuery({ queryKey: ['organization'], queryFn: getOrganization })
}

export function useUpdateOrganization() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: updateOrganization,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['organization'] }),
  })
}

export function useUploadLogo() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: uploadLogo,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['organization'] }),
  })
}
