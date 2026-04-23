import { createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import type { Tenant } from '@prisma/client'

export const CurrentTenant = createParamDecorator(
  (
    _data: unknown,
    ctx: ExecutionContext,
  ): Tenant & { organization: { id: string; name: string } } => {
    const request = ctx
      .switchToHttp()
      .getRequest<
        FastifyRequest & { tenant: Tenant & { organization: { id: string; name: string } } }
      >()
    return request.tenant
  },
)
