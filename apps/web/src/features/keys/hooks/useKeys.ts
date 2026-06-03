import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchKeys, issueKeys, returnKey, updateKey } from '../api/keys.api'
import type { IssueKeysInput, ReturnKeyInput, UpdateKeyInput } from '../api/keys.api'
import type { KeyStatus } from '@eken/shared'

const KEYS_LIST = ['keys', 'list'] as const

export function useKeys(filters?: { leaseId?: string; unitId?: string; status?: KeyStatus }) {
  return useQuery({
    queryKey: [...KEYS_LIST, filters],
    queryFn: () => fetchKeys(filters),
    staleTime: 60_000,
  })
}

function invalidateKeys(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: KEYS_LIST })
}

export function useIssueKeys() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (dto: IssueKeysInput) => issueKeys(dto),
    onSuccess: () => invalidateKeys(qc),
  })
}

export function useReturnKey() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...dto }: { id: string } & ReturnKeyInput) => returnKey(id, dto),
    onSuccess: () => invalidateKeys(qc),
  })
}

export function useUpdateKey() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...dto }: { id: string } & UpdateKeyInput) => updateKey(id, dto),
    onSuccess: () => invalidateKeys(qc),
  })
}
