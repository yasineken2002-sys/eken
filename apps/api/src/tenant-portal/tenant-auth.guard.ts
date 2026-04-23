import type { CanActivate, ExecutionContext } from '@nestjs/common'
import { Injectable, UnauthorizedException } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import type { TenantAuthService } from './tenant-auth.service'
import type { PrismaService } from '../common/prisma/prisma.service'

@Injectable()
export class TenantAuthGuard implements CanActivate {
  constructor(
    private readonly tenantAuthService: TenantAuthService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest & { tenant: unknown }>()

    if (process.env.NODE_ENV !== 'production') {
      const devTenantId = request.headers['x-dev-tenant-id']
      if (devTenantId && typeof devTenantId === 'string') {
        const tenant = await this.prisma.tenant.findUnique({
          where: { id: devTenantId },
          include: { organization: true },
        })
        if (tenant) {
          request.tenant = tenant
          return true
        }
      }
    }

    const auth = request.headers.authorization
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined
    if (!token) throw new UnauthorizedException('Ingen session')
    const tenant = await this.tenantAuthService.validateSession(token)
    request.tenant = tenant
    return true
  }
}
