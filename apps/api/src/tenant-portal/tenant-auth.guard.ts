import type { CanActivate, ExecutionContext } from '@nestjs/common'
import { Injectable, UnauthorizedException, Logger } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { TenantAuthService } from './tenant-auth.service'
import { PrismaService } from '../common/prisma/prisma.service'

@Injectable()
export class TenantAuthGuard implements CanActivate {
  private readonly logger = new Logger(TenantAuthGuard.name)

  constructor(
    private readonly tenantAuthService: TenantAuthService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest & { tenant: unknown }>()

    // Dev-bypass: använd `X-Dev-Tenant-Id` + `X-Dev-Tenant-Secret` för att
    // imitera en hyresgäst i development. Båda krävs och miljön får INTE
    // vara production. Secret jämförs med `DEV_TENANT_BYPASS_SECRET` (env).
    // Saknas eller är fel — bypass aktiveras inte. Detta gör att en
    // misskonfigurerad staging utan secret aldrig kan släppa igenom någon
    // utan riktigt token.
    if (process.env.NODE_ENV !== 'production') {
      const expectedSecret = process.env.DEV_TENANT_BYPASS_SECRET
      const providedSecret = request.headers['x-dev-tenant-secret']
      const devTenantId = request.headers['x-dev-tenant-id']

      if (
        expectedSecret &&
        typeof providedSecret === 'string' &&
        typeof devTenantId === 'string' &&
        providedSecret === expectedSecret &&
        expectedSecret.length >= 16
      ) {
        const tenant = await this.prisma.tenant.findUnique({
          where: { id: devTenantId },
          include: { organization: true },
        })
        if (tenant) {
          this.logger.warn(`Dev tenant bypass aktiv för tenantId=${devTenantId}`)
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
