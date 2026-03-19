import type { CanActivate, ExecutionContext } from '@nestjs/common'
import { Injectable, ForbiddenException } from '@nestjs/common'
import type { Reflector } from '@nestjs/core'
import type { UserRole } from '@eken/shared'
import type { FastifyRequest } from 'fastify'
import type { JwtPayload } from '@eken/shared'

export const ROLES_KEY = 'roles'

const ROLE_HIERARCHY: Record<UserRole, number> = {
  OWNER: 5,
  ADMIN: 4,
  MANAGER: 3,
  ACCOUNTANT: 2,
  VIEWER: 1,
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (!requiredRoles?.length) return true

    const request = context.switchToHttp().getRequest<FastifyRequest & { user: JwtPayload }>()
    const user = request.user

    const userLevel = ROLE_HIERARCHY[user.role] ?? 0
    const hasRole = requiredRoles.some((r) => userLevel >= ROLE_HIERARCHY[r])

    if (!hasRole) throw new ForbiddenException('Otillräckliga rättigheter')
    return true
  }
}
