import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchInviteStatus,
  inviteTenants,
  resendInvites,
  type TenantInviteStatus,
} from '../api/invitations.api'

const INVITE_STATUS = (status?: TenantInviteStatus) =>
  ['tenant-invitations', 'status', status ?? 'all'] as const

export function useInviteStatus(status?: TenantInviteStatus) {
  return useQuery({
    queryKey: INVITE_STATUS(status),
    queryFn: () => fetchInviteStatus(status ? { status, pageSize: 200 } : { pageSize: 200 }),
  })
}

export function useInviteTenants() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: inviteTenants,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tenant-invitations'] })
      void qc.invalidateQueries({ queryKey: ['tenants', 'list'] })
    },
  })
}

export function useResendInvites() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: resendInvites,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tenant-invitations'] })
    },
  })
}
