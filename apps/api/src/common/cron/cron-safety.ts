import { Logger } from '@nestjs/common'
import * as Sentry from '@sentry/nestjs'

/**
 * T5 Fas B1a — delade cron-säkerhetshjälpare (resiliens/observability).
 *
 * Bakgrund (kartläggningens Tier 1-fynd): ~15+ av 23 @Cron saknar app-nivå
 * try/catch runt sin FÖRSTA query och saknar Sentry. @nestjs/schedule fångar
 * kastet i en TYST logger.error → en transient DB-blipp på första findMany
 * avbryter hela dagens körning för ALLA orgar utan att någon larmas. Bara
 * backup.scheduler har Sentry idag.
 *
 * Dessa hjälpare RAPPORTERAR felet (Sentry FÖRE swallow) — de gör aldrig fel
 * tystare än idag, tvärtom. De äger BARA felisolering + rapportering; de bygger
 * ingen utfallssummary och skickar ingen org-notis (det äger varje cron själv).
 *
 * Sentry-mönstret speglar backup.service.ts: FULL detalj till den lokala loggen
 * (kan innehålla infra/PII), ett SKRUBBAT syntetiskt fel till Sentry (bredare
 * läsarkrets). Org-id (UUID, säker korrelationsnyckel) taggas för filtrering.
 */

/** Ett per-item-fel som forEachOrgSafely isolerade och rapporterade. */
export interface CronItemFailure<T> {
  item: T
  error: unknown
}

export interface RunCronSafelyOptions {
  /** Cronets egen logger (bevarar klasskontext); default: intern CronSafety-logger. */
  logger?: Logger
}

export interface ForEachOrgSafelyOptions<T> {
  /** Cronets egen logger (bevarar klasskontext); default: intern CronSafety-logger. */
  logger?: Logger
  /**
   * Härleder org-id för Sentry-korrelation + lokal logg. UUID är en säker
   * korrelationsnyckel (ej PII). Utelämnad → felet taggas utan org.
   */
  orgIdOf?: (item: T) => string | undefined
}

const defaultLogger = new Logger('CronSafety')

/**
 * Kör HELA cron-kroppen inom ett app-nivå try/catch. Vid fel (t.ex. en transient
 * DB-blipp på första query): logga full detalj lokalt, larma via Sentry med ett
 * skrubbat meddelande, och SVÄLJ sedan (kastar inte vidare) så @nestjs/schedule
 * inte dubbelloggar. Larmet ersätter dagens tysta död.
 *
 * @returns fn:s returvärde, eller undefined om kroppen kastade.
 */
export async function runCronSafely<T>(
  cronName: string,
  fn: () => Promise<T>,
  options: RunCronSafelyOptions = {},
): Promise<T | undefined> {
  const logger = options.logger ?? defaultLogger
  try {
    return await fn()
  } catch (err) {
    // Full detalj (kan innehålla query/infra) ENBART i den lokala loggen.
    logger.error(
      `[cron:${cronName}] MISSLYCKADES: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err.stack : undefined,
    )
    // Sentry får ett skrubbat meddelande + cron-tagg (bredare läsarkrets än
    // de med DB-/infra-access). Speglar backup.service.ts.
    Sentry.captureException(new Error(`Cron ${cronName} misslyckades (se serverlogg för detalj)`), {
      tags: { cron: cronName },
    })
    return undefined
  }
}

/**
 * Kör perItemFn per item med per-item try/catch: ett fel på item N isolerar item
 * N och avbryter INTE item N+1. Varje fel loggas (full detalj lokalt) och larmas
 * via Sentry med org-kontext, sedan fortsätter loopen.
 *
 * Hjälparen äger BARA isoleringen. Den bygger ingen summary och skickar ingen
 * notis — den returnerar enbart fel-listan så att varje cron behåller sin egen
 * utfallstaxonomi och (utanför denna wrapper) sin egen org-notis. perItemFn ska
 * själv hantera sina FÖRVÄNTADE domänutfall; bara oväntade kast når hit.
 *
 * @returns en fel-lista {item, error}[] (tom om allt lyckades). Inget annat.
 */
export async function forEachOrgSafely<T>(
  cronName: string,
  items: readonly T[],
  perItemFn: (item: T) => Promise<void>,
  options: ForEachOrgSafelyOptions<T> = {},
): Promise<Array<CronItemFailure<T>>> {
  const logger = options.logger ?? defaultLogger
  const failures: Array<CronItemFailure<T>> = []

  for (const item of items) {
    try {
      await perItemFn(item)
    } catch (error) {
      const orgId = options.orgIdOf?.(item)
      failures.push({ item, error })
      logger.error(
        `[cron:${cronName}] item misslyckades${orgId ? ` (org ${orgId})` : ''}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
      )
      Sentry.captureException(
        new Error(
          `Cron ${cronName} misslyckades för org ${orgId ?? '(okänd)'} (se serverlogg för detalj)`,
        ),
        { tags: { cron: cronName, org: orgId } },
      )
    }
  }

  return failures
}
