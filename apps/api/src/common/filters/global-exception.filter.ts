import type { ExceptionFilter, ArgumentsHost } from '@nestjs/common'
import { Catch, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common'
import * as Sentry from '@sentry/nestjs'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { PlatformErrorsService } from '../../platform/errors/platform-errors.service'

interface AuthedRequest extends FastifyRequest {
  user?: { sub?: string; organizationId?: string }
}

/**
 * Hur länge felregistreringen får hålla upp 5xx-svaret innan vi ger upp på den.
 *
 * Talet är en avvägning, inte en gissning. Att INTE vänta alls var defekten
 * (#586): en flytande promise som processens nedstängning kan hinna före.
 * Att vänta obegränsat vore den motsatta defekten — en trasig databas skulle
 * hänga varje felsvar, och `logInternalError` finns just för att felregistrering
 * aldrig ska blockera anroparen.
 *
 * 2 000 ms är rikligt för en enda INSERT och kort nog att inte märkas på en väg
 * som redan är ett serverfel. Löper den ut är utfallet en HÖGLJUDD förlust
 * (se nedan), inte en tyst.
 */
const ERROR_LOG_WRITE_TIMEOUT_MS = 2_000

@Catch()
@Injectable()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name)

  constructor(private readonly errorsService: PlatformErrorsService) {}

  /**
   * ── #586: SKRIVNINGEN INVÄNTAS ─────────────────────────────────────────────
   *
   * Raden var `void this.errorsService.logInternalError({...})`. Promisen
   * flöt fritt: `catch` returnerade, svaret gick ut, och skrivningen låg kvar i
   * mikrotask-kön. Går processen ner däremellan är felet borta — och eftersom
   * `logInternalError` fångar sitt EGET fel och loggar det, blir förlusten tyst.
   *
   * Det gör en tom ErrorLog tvetydig på exakt det sätt resten av kodbasen
   * bekämpar: den betyder antingen "inget fel inträffade" eller "felet hann inte
   * skrivas", och de två går inte att skilja åt i efterhand.
   *
   * NEDSTÄNGNINGEN ÄR DET SKARPA FALLET. Nest stänger HTTP-servern FÖRE
   * shutdown-hookarna, så en request som redan accepterats får köra klart — men
   * bara om den fortfarande PÅGÅR. Med ett `void` är skrivningen inte en del av
   * requesten längre, och `PrismaService.onModuleDestroy` ($disconnect) kan
   * hinna före. Att i stället vänta in den gör skrivningen till en del av
   * requesten, och då skyddas den av dräneringen som redan finns.
   *
   * En dränering i `onApplicationShutdown` hade INTE fungerat: Nest kör
   * `onModuleDestroy` först, alltså kopplar Prisma ner innan hooken nås.
   *
   * `catch` är därför `async`. Nest tillåter det (`ExceptionFilter.catch`
   * returnerar `any`), och svaret skickas efter väntan — vilket är hela poängen:
   * requesten räknas som pågående tills felet är skrivet.
   */
  async catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const reply = ctx.getResponse<FastifyReply>()
    const request = ctx.getRequest<AuthedRequest>()

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR

    if (status >= 500) {
      const message = exception instanceof Error ? exception.message : String(exception)
      const stack = exception instanceof Error ? exception.stack : undefined

      console.error('[GlobalExceptionFilter] Unhandled exception:', exception)

      // Skicka till Sentry med kontext så incident-utredningen kan börja
      // direkt på rätt request, user och org. 4xx-fel (validering, behörighet)
      // hamnar inte här eftersom HttpException-status är < 500.
      Sentry.withScope((scope) => {
        scope.setTag('path', request.url)
        scope.setTag('method', request.method)
        if (request.user?.organizationId) {
          scope.setTag('organizationId', request.user.organizationId)
        }
        if (request.user?.sub) {
          scope.setUser({ id: request.user.sub })
        }
        Sentry.captureException(exception)
      })

      await this.awaitErrorLogWrite(
        this.errorsService.logInternalError({
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
        }),
      )
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

  /**
   * Vänta in felregistreringen — men med tak, och gör ett överskridande
   * HÖGLJUTT.
   *
   * Poängen med #586 är inte att skrivningen alltid ska lyckas. Det är att en
   * MISSLYCKAD skrivning aldrig ska vara oskiljbar från "inget fel inträffade".
   * Därför loggas timeouten med det ursprungliga felets identitet, så raden går
   * att korrelera mot Sentry-eventet som redan skickats ovan.
   *
   * `logInternalError` kastar aldrig (den fångar internt), så `catch` här fångar
   * bara det oväntade.
   */
  private async awaitErrorLogWrite(write: Promise<unknown>): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    const timedOut = Symbol('errorlog-timeout')
    try {
      const utfall = await Promise.race([
        write.then(() => undefined),
        new Promise<typeof timedOut>((resolve) => {
          timer = setTimeout(() => resolve(timedOut), ERROR_LOG_WRITE_TIMEOUT_MS)
          // Håll inte processen vid liv för den här timern.
          timer.unref?.()
        }),
      ])
      if (utfall === timedOut) {
        this.logger.error(
          `ErrorLog-skrivningen slutfördes inte inom ${ERROR_LOG_WRITE_TIMEOUT_MS} ms — ` +
            'felet kan saknas i ErrorLog. Se Sentry-eventet för samma request.',
        )
      }
    } catch (err) {
      // Ska inte kunna hända: logInternalError fångar sitt eget fel.
      this.logger.error(
        'ErrorLog-skrivningen kastade oväntat',
        err instanceof Error ? err.stack : String(err),
      )
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
