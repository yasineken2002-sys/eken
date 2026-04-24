import { createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import type { PlatformJwtPayload } from '../platform-token.types'

export const CurrentPlatformUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): PlatformJwtPayload => {
    const request = ctx.switchToHttp().getRequest<FastifyRequest & { user: PlatformJwtPayload }>()
    return request.user
  },
)
