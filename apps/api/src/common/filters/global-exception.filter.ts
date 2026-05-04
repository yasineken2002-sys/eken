import type { ExceptionFilter, ArgumentsHost } from '@nestjs/common'
import { Catch, HttpException, HttpStatus, Injectable } from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { PlatformErrorsService } from '../../platform/errors/platform-errors.service'

interface AuthedRequest extends FastifyRequest {
  user?: { sub?: string; organizationId?: string }
}

@Catch()
@Injectable()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(private readonly errorsService: PlatformErrorsService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const reply = ctx.getResponse<FastifyReply>()
    const request = ctx.getRequest<AuthedRequest>()

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR

    if (status >= 500) {
      const message = exception instanceof Error ? exception.message : String(exception)
      const stack = exception instanceof Error ? exception.stack : undefined

      console.error('[GlobalExceptionFilter] Unhandled exception:', exception)

      void this.errorsService.logInternalError({
        severity: 'CRITICAL',
        source: 'API',
        message,
        ...(stack ? { stack } : {}),
        context: {
          path: request.url,
          method: request.method,
          userId: request.user?.sub ?? null,
          ip: request.ip,
        },
        ...(request.user?.organizationId ? { organizationId: request.user.organizationId } : {}),
      })
    }

    let message = 'Internal server error'
    let details: Record<string, string[]> | undefined

    if (exception instanceof HttpException) {
      const response = exception.getResponse()
      if (typeof response === 'string') {
        message = response
      } else if (typeof response === 'object' && response !== null) {
        const r = response as Record<string, unknown>
        message = (r['message'] as string) ?? message
        if (Array.isArray(r['message'])) {
          const messages = r['message'] as string[]
          details = { validation: messages }
          // Visa det första (eller alla) faktiska felmeddelandena. Tidigare
          // ersattes detta med ett generiskt "Valideringsfel" vilket gjorde
          // det omöjligt för UI:t att visa vilket krav som inte uppfylls.
          message = messages.length === 1 ? messages[0]! : messages.join('. ')
        }
      }
    }

    void reply.status(status).send({
      success: false,
      error: {
        code: HttpStatus[status] ?? 'UNKNOWN_ERROR',
        message,
        ...(details ? { details } : {}),
        path: request.url,
        timestamp: new Date().toISOString(),
      },
    })
  }
}
