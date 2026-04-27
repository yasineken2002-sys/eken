import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createDeposit,
  fetchDeposit,
  fetchDeposits,
  markDepositPaid,
  refundDeposit,
} from '../api/deposits.api'
import type { CreateDepositInput, RefundDepositInput } from '../api/deposits.api'
import type { DepositStatus } from '@eken/shared'

const DEPOSITS_LIST = ['deposits', 'list'] as const
const DEPOSIT_DETAIL = (id: string) => ['deposit', 'detail', id] as const

export function useDeposits(filters?: { status?: DepositStatus; leaseId?: string }) {
  return useQuery({
    queryKey: [...DEPOSITS_LIST, filters],
    queryFn: () => fetchDeposits(filters),
    staleTime: 60_000,
  })
}

export function useDeposit(id: string | null) {
  return useQuery({
    queryKey: id ? DEPOSIT_DETAIL(id) : ['deposit', 'detail', '__disabled__'],
    queryFn: () => fetchDeposit(id!),
    enabled: !!id,
  })
}

function invalidateDeposits(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: DEPOSITS_LIST })
  // En deposition kan ändra fakturastatus + lease-detalj.
  void qc.invalidateQueries({ queryKey: ['invoices'] })
  void qc.invalidateQueries({ queryKey: ['leases', 'list'] })
}

export function useCreateDeposit() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (dto: CreateDepositInput) => createDeposit(dto),
    onSuccess: () => invalidateDeposits(qc),
  })
}

export function useMarkDepositPaid() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => markDepositPaid(id),
    onSuccess: (_, id) => {
      invalidateDeposits(qc)
      void qc.invalidateQueries({ queryKey: ['deposit', 'detail', id] })
    },
  })
}

export function useRefundDeposit() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...dto }: { id: string } & RefundDepositInput) => refundDeposit(id, dto),
    onSuccess: (_, vars) => {
      invalidateDeposits(qc)
      void qc.invalidateQueries({ queryKey: ['deposit', 'detail', vars.id] })
    },
  })
}
