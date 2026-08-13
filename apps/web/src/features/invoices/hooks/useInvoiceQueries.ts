import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { get, post, patch, del } from '@/lib/api'
import type { Invoice, InvoiceEvent, InvoiceStatus, CreateInvoiceInput } from '@eken/shared'
import { sendInvoiceEmail, registerInvoicePayment } from '../api/invoices.api'
import type { RegisterPaymentInput } from '../api/invoices.api'

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * #325 — listsvaret bär ALLTID `outstanding` (restskulden). TYPEN ÄR SPÄRREN:
 * genom att kräva fältet kan en yta som läser listan inte tyst falla tillbaka
 * på `total` och råka visa ursprungsbeloppet som skuld på en delbetald faktura.
 *
 * #349 — DETALJSVARET BÄR DET NU OCKSÅ. Betalningsmodalen kan öppnas från
 * listan men också via deep-link från notifikationer, där raden kommer från
 * `useInvoice(id)`. Saknades fältet där var alternativet en `?? total`-fallback,
 * alltså bruttot tillbaka i ett beloppspåstående — precis det #325 stängde.
 * Samma typ används därför för båda svaren.
 */
export type InvoiceWithOutstanding = Invoice & { outstanding: number }

/** Bakåtkompatibelt namn — listan och detaljen har samma form sedan #349. */
export type InvoiceListItem = InvoiceWithOutstanding

export function useInvoices(filters?: { status?: InvoiceStatus; tenantId?: string }) {
  return useQuery({
    queryKey: ['invoices', filters],
    queryFn: () =>
      get<InvoiceListItem[]>('/invoices', filters as Record<string, unknown> | undefined),
  })
}

export function useInvoice(id: string) {
  return useQuery({
    queryKey: ['invoice', id],
    queryFn: () => get<InvoiceWithOutstanding>(`/invoices/${id}`),
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

export function useRegisterPayment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...dto }: { id: string } & RegisterPaymentInput) =>
      registerInvoicePayment(id, dto),
    onSuccess: (_, { id }) => {
      void qc.invalidateQueries({ queryKey: ['invoices'] })
      void qc.invalidateQueries({ queryKey: ['invoice', id] })
      void qc.invalidateQueries({ queryKey: ['invoice-events', id] })
    },
  })
}
