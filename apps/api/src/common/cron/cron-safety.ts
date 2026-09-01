import { Logger } from '@nestjs/common'
import * as Sentry from '@sentry/nestjs'
import type { CronErrorSink } from './cron-error-sink'

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
 * Sentry-mönstret speglar backup.service.ts: ett SKRUBBAT syntetiskt fel till
 * Sentry (bredare läsarkrets). Org-id (UUID, säker korrelationsnyckel) taggas
 * för filtrering.
 *
 * ── TRE MOTTAGARE, INTE TVÅ — OCH DEN TREDJE FÅR DET RÅA FELET (#612) ───────
 *
 * Den här texten sa tidigare att full detalj gick till den LOKALA LOGGEN ENBART.
 * Det stämde när den skrevs och slutade stämma med #605, utan att någon ändrade
 * meningen. Så här ser delningen faktiskt ut:
 *
 *   lokal logg   RÅA `err.message` + `err.stack`   försvinner med containern
 *   Sentry       skrubbat syntetiskt fel + taggar  bred läsarkrets
 *   ErrorLog     RÅA `err`  ← via options.sink     VARAKTIG, läses av admin
 *
 * DET ÄR ETT MEDVETET BESLUT, taget i #612. Skrubba INTE sänkvägen för att få
 * texten att stämma med sin gamla lydelse: förlusten av detalj var hela
 * defekten i #605. En rad som bara säger "Prisma-fel i morning-insights" är
 * nästan lika tvetydig som den tystnad #605 byggde bort, och då hade båda
 * ärendena varit förgäves.
 *
 * Priset — att den varaktiga tabellen bär den fritext som avsiktligt hölls
 * utanför Sentry — betalas på andra sätt, och de ligger utanför den här filen:
 *
 *   • FRIST. `ErrorLog` är ett driftverktyg, inte ett revisionsspår, och gallras
 *     (30 dagar löst / 180 olöst). Se `platform/errors/error-log-retention.ts`.
 *   • RADERING PÅ BEGÄRAN. `anonymize-tenant.ts` tar bort rader som bär en
 *     hyresgästs UUID — en fritextkolumn går inte att maskera, bara radera.
 *   • ÅTKOMST. Skrivvägen är stängd (#612 PR A). LÄSNINGEN är ännu inte
 *     graderad: varje plattformsanvändare ser varje rad, eftersom `PlatformUser`
 *     inte har något rollfält. Öppen punkt, med villkoret utskrivet i ärendet —
 *     ska lösas innan någon utanför de två grundarna får admin-inlogg.
 *
 * Den som läser den här filen ska alltså veta att `options.sink` skriver mer än
 * Sentry gör, och varför det är rätt.
 */

/** Ett per-item-fel som forEachOrgSafely isolerade och rapporterade. */
export interface CronItemFailure<T> {
  item: T
  error: unknown
}

/**
 * Sentry-larmnivå. Default (utelämnad) = Sentrys standard (error). Höj till
 * 'fatal' för MÅNADS-cadence-cron där ett fel = hela månadens körning uteblir
 * och nästa försök dröjer ~30 dagar (t.ex. avisering-generate-monthly).
 */
export type CronAlarmLevel = 'fatal' | 'error' | 'warning'

export interface RunCronSafelyOptions {
  /** Cronets egen logger (bevarar klasskontext); default: intern CronSafety-logger. */
  logger?: Logger
  /** Sentry-larmnivå (default: Sentrys standard). Höj till 'fatal' för månads-cron. */
  level?: CronAlarmLevel
  /**
   * VARAKTIG SÄNKA (#605). Utan den lever felet bara i Sentry och i den lokala
   * loggen — och loggen överlever inte containern.
   *
   * Den är valfri i TYPEN men inte i praktiken: `check-cron-error-sink.mjs`
   * kräver att varje @Cron-jobb når sänkan, eller står kvitterat med ett skäl.
   * Att den är valfri här är enbart för att de tretton okonverterade jobben ska
   * fortsätta kompilera medan skulden betas av.
   */
  sink?: CronErrorSink
}

export interface ForEachOrgSafelyOptions<T> {
  /** Cronets egen logger (bevarar klasskontext); default: intern CronSafety-logger. */
  logger?: Logger
  /** Varaktig sänka (#605) — se RunCronSafelyOptions.sink. */
  sink?: CronErrorSink
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
    // Full detalj (kan innehålla query/infra/PII) till den lokala loggen — och,
    // via `options.sink` längre ned, till ErrorLog. INTE till Sentry. Se
    // docblocket överst för varför sänkan medvetet får det råa felet.
    logger.error(
      `[cron:${cronName}] MISSLYCKADES: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err.stack : undefined,
    )
    // Sentry får ett skrubbat meddelande + cron-tagg (bredare läsarkrets än
    // de med DB-/infra-access). Speglar backup.service.ts. Månads-cron höjer
    // nivån till 'fatal' via options.level (ett fel = månadens körning uteblir).
    Sentry.captureException(new Error(`Cron ${cronName} misslyckades (se serverlogg för detalj)`), {
      tags: { cron: cronName },
      ...(options.level ? { level: options.level } : {}),
    })
    // VARAKTIG SÄNKA (#605). Inväntas — ett cron-jobb kan mycket väl vara mitt i
    // en körning när containern får SIGTERM, och en flytande skrivning är då
    // borta. `report` kastar aldrig.
    await options.sink?.report(cronName, err)
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
      // Per-org-felet är den FARLIGA formen: loopen fortsätter, cronet
      // rapporterar "n lyckade, m misslyckade" och körningen ser lyckad ut.
      // Utan en varaktig sänka finns det m:et ingenstans i morgon.
      await options.sink?.report(cronName, error, {
        ...(orgId ? { organizationId: orgId } : {}),
      })
    }
  }

  return failures
}
