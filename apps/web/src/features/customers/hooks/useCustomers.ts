import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchCustomers,
  fetchCustomer,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  type CustomerFilters,
  type CreateCustomerInput,
  type UpdateCustomerInput,
} from '../api/customers.api'

// Disjunkta query-nycklar så list-invalidering inte träffar detalj-queries.
const CUSTOMERS_LIST = (filters?: CustomerFilters) => ['customers', 'list', filters ?? {}] as const
const CUSTOMER_DETAIL = (id: string) => ['customer', 'detail', id] as const

export const customerQueryKeys = {
  list: CUSTOMERS_LIST,
  detail: CUSTOMER_DETAIL,
  allLists: () => ['customers', 'list'] as const,
}

export function useCustomers(filters?: CustomerFilters) {
  return useQuery({
    queryKey: CUSTOMERS_LIST(filters),
    queryFn: () => fetchCustomers(filters),
  })
}

export function useCustomer(id: string | null) {
  return useQuery({
    queryKey: id ? CUSTOMER_DETAIL(id) : ['customer', 'detail', '__disabled__'],
    queryFn: () => fetchCustomer(id!),
    enabled: !!id,
  })
}

export function useCreateCustomer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (dto: CreateCustomerInput) => createCustomer(dto),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: customerQueryKeys.allLists() })
    },
  })
}

export function useUpdateCustomer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...dto }: { id: string } & UpdateCustomerInput) => updateCustomer(id, dto),
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({ queryKey: customerQueryKeys.allLists() })
      void qc.invalidateQueries({ queryKey: CUSTOMER_DETAIL(variables.id) })
    },
  })
}

export function useDeleteCustomer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteCustomer(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: customerQueryKeys.allLists() })
    },
  })
}
