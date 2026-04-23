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
} from '../api/avisering.api'
import type { NoticeFilter } from '../api/avisering.api'

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
    mutationFn: ({ id, paidAmount, paidAt }: { id: string; paidAmount: number; paidAt?: string }) =>
      markAsPaid(id, paidAmount, paidAt),
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
