import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { get, post, patch, del } from '@/lib/api'
import type { Invoice, InvoiceEvent, InvoiceStatus, CreateInvoiceInput } from '@eken/shared'
import { sendInvoiceEmail, createBulkInvoices } from '../api/invoices.api'
import type { BulkInvoiceInput } from '../api/invoices.api'

// ─── Queries ─────────────────────────────────────────────────────────────────

export function useInvoices(filters?: { status?: InvoiceStatus; tenantId?: string }) {
  return useQuery({
    queryKey: ['invoices', filters],
    queryFn: () => get<Invoice[]>('/invoices', filters as Record<string, unknown> | undefined),
  })
}

export function useInvoice(id: string) {
  return useQuery({
    queryKey: ['invoice', id],
    queryFn: () => get<Invoice>(`/invoices/${id}`),
    enabled: !!id,
  })
}

export function useInvoiceEvents(id: string) {
  return useQuery({
    queryKey: ['invoice-events', id],
    queryFn: () => get<InvoiceEvent[]>(`/invoices/${id}/events`),
    enabled: !!id,
  })
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export function useCreateInvoice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: CreateInvoiceInput) => post<Invoice>('/invoices', data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['invoices'] })
    },
  })
}

export function useUpdateInvoice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...data }: Partial<CreateInvoiceInput> & { id: string }) =>
      patch<Invoice>(`/invoices/${id}`, data),
    onSuccess: (_, { id }) => {
      void qc.invalidateQueries({ queryKey: ['invoices'] })
      void qc.invalidateQueries({ queryKey: ['invoice', id] })
    },
  })
}

export function useDeleteInvoice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => del(`/invoices/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['invoices'] })
    },
  })
}

export function useSendInvoiceEmail() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: sendInvoiceEmail,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['invoices'] })
    },
  })
}

export function useTransitionStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      status,
      payload,
    }: {
      id: string
      status: InvoiceStatus
      payload?: Record<string, unknown>
    }) => patch<Invoice>(`/invoices/${id}/status`, { status, ...(payload ? { payload } : {}) }),
    onSuccess: (_, { id }) => {
      void qc.invalidateQueries({ queryKey: ['invoices'] })
      void qc.invalidateQueries({ queryKey: ['invoice', id] })
      void qc.invalidateQueries({ queryKey: ['invoice-events', id] })
    },
  })
}

export function useCreateBulkInvoices() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: BulkInvoiceInput) => createBulkInvoices(data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['invoices'] })
    },
  })
}
