import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  acceptRentIncrease,
  createRentIncrease,
  fetchRentIncrease,
  fetchRentIncreases,
  rejectRentIncrease,
  sendRentIncreaseNotice,
  withdrawRentIncrease,
} from '../api/rent-increases.api'
import type { CreateRentIncreaseInput } from '../api/rent-increases.api'
import type { RentIncreaseStatus } from '@eken/shared'

const LIST = ['rent-increases', 'list'] as const
const DETAIL = (id: string) => ['rent-increase', 'detail', id] as const

export function useRentIncreases(filters?: { status?: RentIncreaseStatus; leaseId?: string }) {
  return useQuery({
    queryKey: [...LIST, filters],
    queryFn: () => fetchRentIncreases(filters),
    staleTime: 60_000,
  })
}

export function useRentIncrease(id: string | null) {
  return useQuery({
    queryKey: id ? DETAIL(id) : ['rent-increase', 'detail', '__disabled__'],
    queryFn: () => fetchRentIncrease(id!),
    enabled: !!id,
  })
}

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: LIST })
  // Lease.monthlyRent kan ha förändrats av cron — invalidate leases-listan.
  void qc.invalidateQueries({ queryKey: ['leases', 'list'] })
}

export function useCreateRentIncrease() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (dto: CreateRentIncreaseInput) => createRentIncrease(dto),
    onSuccess: () => invalidate(qc),
  })
}

export function useSendRentIncreaseNotice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => sendRentIncreaseNotice(id),
    onSuccess: () => invalidate(qc),
  })
}

export function useAcceptRentIncrease() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => acceptRentIncrease(id),
    onSuccess: () => invalidate(qc),
  })
}

export function useRejectRentIncrease() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, rejectionReason }: { id: string; rejectionReason: string }) =>
      rejectRentIncrease(id, rejectionReason),
    onSuccess: () => invalidate(qc),
  })
}

export function useWithdrawRentIncrease() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => withdrawRentIncrease(id),
    onSuccess: () => invalidate(qc),
  })
}
