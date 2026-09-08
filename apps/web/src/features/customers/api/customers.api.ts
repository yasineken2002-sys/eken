import type { CreateCustomerInput, UpdateCustomerInput } from '@eken/shared'
export type { CreateCustomerInput, UpdateCustomerInput } from '@eken/shared'
import { api, get, post, patch } from '@/lib/api'

export type CustomerType = 'INDIVIDUAL' | 'COMPANY'

export interface Customer {
  id: string
  organizationId: string
  type: CustomerType
  firstName: string | null
  lastName: string | null
  personalNumber: string | null
  companyName: string | null
  orgNumber: string | null
  contactPerson: string | null
  email: string | null
  phone: string | null
  street: string | null
  city: string | null
  postalCode: string | null
  country: string | null
  reference: string | null
  notes: string | null
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface CustomerWithCount extends Customer {
  _count: { invoices: number }
}

export interface CustomerFilters {
  search?: string
  type?: CustomerType
  isActive?: boolean
}

export function fetchCustomers(filters?: CustomerFilters): Promise<CustomerWithCount[]> {
  const params: Record<string, string> = {}
  if (filters?.search) params['search'] = filters.search
  if (filters?.type) params['type'] = filters.type
  if (filters?.isActive != null) params['isActive'] = String(filters.isActive)
  return get<CustomerWithCount[]>('/customers', params)
}

export function fetchCustomer(id: string): Promise<Customer> {
  return get<Customer>(`/customers/${id}`)
}

export function createCustomer(input: CreateCustomerInput): Promise<Customer> {
  return post<Customer>('/customers', input)
}

export function updateCustomer(id: string, input: UpdateCustomerInput): Promise<Customer> {
  return patch<Customer>(`/customers/${id}`, input)
}

export async function deleteCustomer(id: string): Promise<{ archived: boolean }> {
  const { data } = await api.delete<{ data: { archived: boolean } }>(`/customers/${id}`)
  return data.data
}
