import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchProperties,
  fetchProperty,
  createProperty,
  updateProperty,
  deleteProperty,
} from '../api/properties.api'
import type { CreatePropertyInput } from '@eken/shared'

// Disjunkta query-nycklar – list-mutationer får inte invalidera detail-queries.
const PROPERTIES_LIST = ['properties', 'list'] as const
const PROPERTY_DETAIL = (id: string) => ['property', 'detail', id] as const

export function useProperties() {
  return useQuery({
    queryKey: PROPERTIES_LIST,
    queryFn: fetchProperties,
  })
}

export function useProperty(id: string | null) {
  return useQuery({
    queryKey: id ? PROPERTY_DETAIL(id) : ['property', 'detail', '__disabled__'],
    queryFn: () => fetchProperty(id!),
    enabled: !!id,
  })
}

function invalidateProperties(qc: ReturnType<typeof useQueryClient>, deletedId?: string) {
  void qc.invalidateQueries({ queryKey: PROPERTIES_LIST })
  if (deletedId) qc.removeQueries({ queryKey: PROPERTY_DETAIL(deletedId) })
}

export function useCreateProperty() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (dto: CreatePropertyInput) => createProperty(dto),
    onSuccess: () => invalidateProperties(queryClient),
  })
}

export function useUpdateProperty() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...dto }: { id: string } & Partial<CreatePropertyInput>) =>
      updateProperty(id, dto),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: PROPERTIES_LIST })
      void queryClient.invalidateQueries({ queryKey: PROPERTY_DETAIL(variables.id) })
    },
  })
}

export function useDeleteProperty() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteProperty(id),
    onSuccess: (_data, id) => invalidateProperties(queryClient, id),
  })
}
