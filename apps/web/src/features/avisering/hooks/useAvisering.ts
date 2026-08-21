import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchNotices,
  fetchStats,
  generateNotices,
  sendNotices,
  sendAllNotices,
  markAsPaid,
  cancelNotice,
  downloadNoticePdf,
  getRentNoticeCreditPreview,
  createRentNoticeCredit,
} from '../api/avisering.api'
import type { NoticeFilter, PaymentMethod, CreateRentNoticeCreditInput } from '../api/avisering.api'

export function useNotices(filters?: NoticeFilter) {
  return useQuery({
    queryKey: ['avisering', filters],
    queryFn: () => fetchNotices(filters),
    staleTime: 30_000,
  })
}

export function useNoticeStats(month: number, year: number) {
  return useQuery({
    queryKey: ['avisering', 'stats', month, year],
    queryFn: () => fetchStats(month, year),
    staleTime: 30_000,
  })
}

export function useGenerateNotices() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ month, year }: { month: number; year: number }) => generateNotices(month, year),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['avisering'] }),
  })
}

export function useSendNotices() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (noticeIds: string[]) => sendNotices(noticeIds),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['avisering'] }),
  })
}

export function useSendAllNotices() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ month, year }: { month: number; year: number }) => sendAllNotices(month, year),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['avisering'] }),
  })
}

export function useMarkAsPaid() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      paidAmount,
      paymentMethod,
      paidAt,
    }: {
      id: string
      paidAmount: number
      paymentMethod: PaymentMethod
      paidAt?: string
    }) => markAsPaid(id, paidAmount, paymentMethod, paidAt),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['avisering'] }),
  })
}

export function useCancelNotice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => cancelNotice(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['avisering'] }),
  })
}

export function useDownloadPdf() {
  return useMutation({
    mutationFn: ({ id, noticeNumber }: { id: string; noticeNumber: string }) =>
      downloadNoticePdf(id, noticeNumber),
  })
}

// ─── #518 — kreditering (nedsättning) av hyresavi ────────────────────────────

/**
 * Underlaget för både avi-detaljen och krediteringsmodalen.
 *
 * `amount` gör att svaret bär en PROJEKTION av den tänkta krediteringen. Nyckeln
 * innehåller därför beloppet: två olika belopp är två olika svar, och en delad
 * cachenyckel hade visat operatören utfallet av någon annans siffra.
 *
 * Nyckeln är dessutom DISJUNKT från listnyckeln `['avisering', …]`. En gemensam
 * prefix hade gjort att `invalidateQueries(['avisering'])` slog ut previewen och
 * tvärtom — och en preview som hämtas om mitt i ett formulär skriver över
 * operatörens inmatade belopp.
 */
export function useRentNoticeCreditPreview(
  id: string | undefined,
  enabled: boolean,
  amount?: number,
) {
  return useQuery({
    queryKey: ['rent-notice-credit-preview', id, amount ?? null],
    queryFn: () => getRentNoticeCreditPreview(id!, amount),
    enabled: !!id && enabled,
    // Underlaget bär ett tak som en samtidig kreditering kan ha flyttat.
    staleTime: 0,
  })
}

export function useCreateRentNoticeCredit() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...dto }: { id: string } & CreateRentNoticeCreditInput) =>
      createRentNoticeCredit(id, dto),
    onSuccess: () => {
      // Krediteringen ändrar restskulden i listan OCH taket i previewen. Utan
      // det andra anropet föreslår modalen nästa gång ett belopp som redan är
      // krediterat, och operatören möts av ett fel för sitt eget förslag.
      void qc.invalidateQueries({ queryKey: ['avisering'] })
      void qc.invalidateQueries({ queryKey: ['rent-notice-credit-preview'] })
    },
  })
}
