import { useState } from 'react'
import { motion } from 'framer-motion'
import { UserPlus, ShieldCheck, Mail, Clock, Power, RotateCw, Lock } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { useAuthStore } from '@/stores/auth.store'
import { useUsers, useUpdateUserRole, useDeactivateUser, useReactivateUser } from './hooks/useUsers'
import { InviteUserModal } from './components/InviteUserModal'
import type { OrgUser, AssignableRole } from './api/users.api'
import { formatDate } from '@eken/shared'
import type { UserRole } from '@eken/shared'

const ROLE_LABELS: Record<UserRole, string> = {
  OWNER: 'Ägare',
  ADMIN: 'Administratör',
  MANAGER: 'Förvaltare',
  ACCOUNTANT: 'Ekonomi',
  VIEWER: 'Läsbehörighet',
}

const ASSIGNABLE_ROLES: { value: AssignableRole; label: string }[] = [
  { value: 'ADMIN', label: 'Administratör' },
  { value: 'MANAGER', label: 'Förvaltare' },
  { value: 'ACCOUNTANT', label: 'Ekonomi' },
  { value: 'VIEWER', label: 'Läsbehörighet' },
]

const container = { hidden: {}, show: { transition: { staggerChildren: 0.04 } } }
const item = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
}

export function UsersPanel() {
  const { data: users = [], isLoading } = useUsers()
  const [inviteOpen, setInviteOpen] = useState(false)
  const currentUser = useAuthStore((s) => s.user)
  const isOwner = currentUser?.role === 'OWNER'
  const canInvite = isOwner || currentUser?.role === 'ADMIN'

  return (
    <section className="rounded-2xl border border-gray-100 bg-white p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-[14px] font-semibold text-gray-800">Användare</h2>
          <p className="mt-0.5 text-[12px] text-gray-500">
            Hantera vem som har åtkomst till organisationen
          </p>
        </div>
        {canInvite && (
          <Button variant="primary" size="sm" onClick={() => setInviteOpen(true)}>
            <UserPlus size={14} strokeWidth={1.8} className="mr-1.5" />
            Bjud in
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-xl bg-gray-50" />
          ))}
        </div>
      ) : users.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="Inga användare ännu"
          description="Bjud in din första användare för att komma igång."
        />
      ) : (
        <motion.ul
          variants={container}
          initial="hidden"
          animate="show"
          className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-[#EAEDF0]"
        >
          {users.map((u) => (
            <motion.li key={u.id} variants={item}>
              <UserRow user={u} isOwner={isOwner} isSelf={u.id === currentUser?.id} />
            </motion.li>
          ))}
        </motion.ul>
      )}

      <InviteUserModal open={inviteOpen} onClose={() => setInviteOpen(false)} />
    </section>
  )
}

interface UserRowProps {
  user: OrgUser
  isOwner: boolean
  isSelf: boolean
}

function UserRow({ user, isOwner, isSelf }: UserRowProps) {
  const updateRole = useUpdateUserRole()
  const deactivate = useDeactivateUser()
  const reactivate = useReactivateUser()

  const fullName = `${user.firstName} ${user.lastName}`.trim() || user.email
  const isTargetOwner = user.role === 'OWNER'
  const canEditRole = isOwner && !isSelf && !isTargetOwner
  const canToggleActive = isOwner && !isSelf && !isTargetOwner
  const initials = `${user.firstName[0] ?? ''}${user.lastName[0] ?? ''}`.toUpperCase() || '?'

  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-gray-50/60">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-50 text-[12.5px] font-semibold text-blue-700">
          {initials}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-[13.5px] font-medium text-gray-900">{fullName}</p>
            {isSelf && (
              <span className="rounded-md bg-gray-100 px-1.5 py-0.5 text-[10.5px] font-medium text-gray-600">
                Du
              </span>
            )}
            {!user.isActive && <Badge variant="default">Inaktiv</Badge>}
            {user.mustChangePassword && user.isActive && (
              <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-700">
                <Lock size={10} strokeWidth={2} />
                Inväntar aktivering
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-3 text-[12px] text-gray-500">
            <span className="flex items-center gap-1">
              <Mail size={11} strokeWidth={1.8} className="text-gray-400" />
              {user.email}
            </span>
            <span className="flex items-center gap-1">
              <Clock size={11} strokeWidth={1.8} className="text-gray-400" />
              {user.lastLoginAt ? `Inloggad ${formatDate(user.lastLoginAt)}` : 'Aldrig inloggad'}
            </span>
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {canEditRole ? (
          <select
            value={user.role}
            disabled={updateRole.isPending}
            onChange={(e) =>
              updateRole.mutate({ id: user.id, role: e.target.value as AssignableRole })
            }
            className="h-8 rounded-lg border border-[#DDDFE4] bg-white px-2.5 text-[12.5px] font-medium text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/15"
          >
            {ASSIGNABLE_ROLES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        ) : (
          <Badge variant="info">{ROLE_LABELS[user.role]}</Badge>
        )}

        {canToggleActive &&
          (user.isActive ? (
            <button
              type="button"
              onClick={() => deactivate.mutate(user.id)}
              disabled={deactivate.isPending}
              title="Inaktivera användaren"
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#DDDFE4] text-gray-400 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
            >
              <Power size={13} strokeWidth={1.8} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => reactivate.mutate(user.id)}
              disabled={reactivate.isPending}
              title="Återaktivera användaren"
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#DDDFE4] text-gray-400 transition-colors hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-600 disabled:opacity-50"
            >
              <RotateCw size={13} strokeWidth={1.8} />
            </button>
          ))}
      </div>
    </div>
  )
}
