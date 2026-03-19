import type { ExceptionFilter, ArgumentsHost } from '@nestjs/common'
import { Catch, HttpException, HttpStatus } from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const reply = ctx.getResponse<FastifyReply>()
    const request = ctx.getRequest<FastifyRequest>()

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR

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
          // class-validator errors
          details = { validation: r['message'] as string[] }
          message = 'Valideringsfel'
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
