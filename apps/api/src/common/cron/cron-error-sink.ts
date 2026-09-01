import { Injectable, Logger } from '@nestjs/common'
import { PlatformErrorsService } from '../../platform/errors/platform-errors.service'

/**
 * VARAKTIG SÄNKA FÖR CRON-FEL (#605).
 *
 * ── VAD SOM SAKNADES ────────────────────────────────────────────────────────
 *
 * Mätt mot `befee7b`, per metodkropp och med `*Unsafe`-delegaten följd:
 *
 *     25 @Cron-jobb
 *      0  skriver till ErrorLog
 *     12  har någon varaktig rapportväg (Sentry direkt, runCronSafely,
 *         forEachOrgSafely)
 *     13  har ENDAST den lokala loggen
 *
 * Den lokala loggen överlever inte containern. Under 30 dagar skedde 204 merges
 * till main, alltså minst lika många containerbyten — ett cron-fel från förra
 * veckan finns ingenstans att fråga efter.
 *
 * Det gör en tom ErrorLog tvetydig på samma sätt som #586 gjorde, fast av ett
 * annat skäl: där kunde skrivningen tappas, här sker den aldrig.
 *
 * ── VARFÖR SKRIVNINGEN INVÄNTAS ─────────────────────────────────────────────
 *
 * Samma läxa som #586. Ett cron-jobb kan mycket väl vara mitt i en körning när
 * containern får SIGTERM — det är själva formen på en deploy under drift. En
 * flytande promise är då borta, och eftersom `logInternalError` fångar sitt eget
 * fel blir förlusten tyst.
 *
 * Taket finns av motsatt skäl: en trasig databas får inte hänga cron-körningen.
 * Löper det ut blir utfallet en HÖGLJUDD rad i den lokala loggen — vilket är
 * sämre än ErrorLog men oändligt mycket bättre än tystnad.
 */
const ERROR_LOG_WRITE_TIMEOUT_MS = 2_000

/** Vad som får skickas med utöver felet självt. */
export interface CronFailureContext {
  /** Organisationen felet gäller, när felet är per-org och inte per-körning. */
  organizationId?: string
  /** Fritt fält för cronets egen taxonomi (t.ex. { steg: 'mejlutskick' }). */
  detail?: Record<string, unknown>
}

@Injectable()
export class CronErrorSink {
  private readonly logger = new Logger(CronErrorSink.name)

  constructor(private readonly errors: PlatformErrorsService) {}

  /**
   * Gör ett cron-fel varaktigt synligt.
   *
   * Skriver till ErrorLog och VÄNTAR IN skrivningen (med tak). Anroparen behöver
   * inte fånga något: metoden kastar aldrig — ett fel här får aldrig bli
   * anledningen till att cronet fallerar.
   */
  async report(cronName: string, err: unknown, context: CronFailureContext = {}): Promise<void> {
    const message = `[cron:${cronName}] ${err instanceof Error ? err.message : String(err)}`
    const stack = err instanceof Error ? err.stack : undefined

    const write = this.errors.logInternalError({
      severity: 'CRITICAL',
      source: 'API',
      message,
      ...(stack ? { stack } : {}),
      context: {
        cron: cronName,
        ...(context.detail ?? {}),
      },
      ...(context.organizationId ? { organizationId: context.organizationId } : {}),
    })

    let timer: NodeJS.Timeout | undefined
    const timedOut = Symbol('cron-errorlog-timeout')
    try {
      const utfall = await Promise.race([
        write.then(() => undefined),
        new Promise<typeof timedOut>((resolve) => {
          timer = setTimeout(() => resolve(timedOut), ERROR_LOG_WRITE_TIMEOUT_MS)
          timer.unref?.()
        }),
      ])
      if (utfall === timedOut) {
        this.logger.error(
          `[cron:${cronName}] ErrorLog-skrivningen slutfördes inte inom ` +
            `${ERROR_LOG_WRITE_TIMEOUT_MS} ms — felet kan saknas i ErrorLog.`,
        )
      }
    } catch (sinkErr) {
      // Ska inte kunna hända (logInternalError fångar sitt eget fel), men en
      // sänka som kastar vore värre än ingen sänka alls.
      this.logger.error(
        `[cron:${cronName}] felsänkan kastade oväntat`,
        sinkErr instanceof Error ? sinkErr.stack : String(sinkErr),
      )
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
