import { SetMetadata } from '@nestjs/common'
import type { UserRole } from '@eken/shared'
import { ROLES_KEY } from '../guards/roles.guard'

export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles)
