import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchProperties,
  fetchProperty,
  createProperty,
  updateProperty,
  deleteProperty,
} from '../api/properties.api'
import type { CreatePropertyInput } from '@eken/shared'

export function useProperties() {
  return useQuery({
    queryKey: ['properties'],
    queryFn: fetchProperties,
  })
}

export function useProperty(id: string | null) {
  return useQuery({
    queryKey: ['properties', id],
    queryFn: () => fetchProperty(id!),
    enabled: !!id,
  })
}

export function useCreateProperty() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (dto: CreatePropertyInput) => createProperty(dto),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['properties'] })
    },
  })
}

export function useUpdateProperty() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...dto }: { id: string } & Partial<CreatePropertyInput>) =>
      updateProperty(id, dto),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['properties'] })
    },
  })
}

export function useDeleteProperty() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteProperty(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['properties'] })
    },
  })
}
