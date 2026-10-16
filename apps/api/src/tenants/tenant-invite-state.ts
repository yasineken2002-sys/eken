import type { Prisma } from '@prisma/client'

// Gäller mottagaren och den aktuella inbjudan. inviteCount bevaras som historik.
export const CLEARED_TENANT_INVITE_STATE = {
  invitedAt: null,
  inviteDeliveredAt: null,
  inviteBouncedAt: null,
  inviteBounceReason: null,
  inviteComplainedAt: null,
  lastInviteMessageId: null,
} satisfies Prisma.TenantUpdateManyMutationInput
