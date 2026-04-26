import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  deactivateUser,
  fetchUsers,
  inviteUser,
  reactivateUser,
  updateUserRole,
} from '../api/users.api'
import type { AssignableRole, InviteUserInput } from '../api/users.api'

const USERS_LIST = ['users', 'list'] as const

export function useUsers() {
  return useQuery({
    queryKey: USERS_LIST,
    queryFn: fetchUsers,
  })
}

export function useInviteUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (dto: InviteUserInput) => inviteUser(dto),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: USERS_LIST })
    },
  })
}

export function useUpdateUserRole() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, role }: { id: string; role: AssignableRole }) => updateUserRole(id, role),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: USERS_LIST })
    },
  })
}

export function useDeactivateUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deactivateUser(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: USERS_LIST })
    },
  })
}

export function useReactivateUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => reactivateUser(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: USERS_LIST })
    },
  })
}
