import { Injectable, Logger } from '@nestjs/common'
import * as Sentry from '@sentry/nestjs'
import { BackupService, parseBackupKeyDate } from './backup.service'
import { CronErrorSink } from '../common/cron/cron-error-sink'

/**
 * BACKUPENS FÄRSKHET — larmar på ÅLDER, inte på fel.
 *
 * Problemet den löser är mätt, inte tänkt: backupen var avstängd i 45 dagar utan
 * att någon märkte det. `runBackup` larmar när en körning MISSLYCKAS, men en
 * backup som aldrig körs kan aldrig misslyckas — frånvaron gav ingen signal alls,
 * och tystnad såg exakt ut som framgång.
 *
 * Larmet utgår därför från ålder på den senaste LYCKADE backupen, och är lika
 * högljutt när svaret är "det finns ingen".
 *
 * ── FORMEN ÄR LÅNAD FRÅN PaymentFreshnessService ────────────────────────────
 *
 * Samma problem, samma form: ett `evaluate()` som är rent och returnerar ett
 * strukturerat utfall (flagga, ålder i hela dygn, tröskel), och ett `check()`
 * som larmar och sammanfattar i loggen (PaymentFreshness kallar sitt
 * `evaluateAndAlert` — samma roll, annat namn). Dygnsgranulariteten
 * och `wholeDaysBetween`-regeln är medvetet identiska, så att de två grindarna
 * inte kan glida isär i vad "en dag gammal" betyder.
 *
 * TVÅ AVVIKELSER, båda avsiktliga:
 *
 * 1. **Mottagaren är driften, inte kunden.** PaymentFreshness mejlar
 *    organisationens OWNER/ADMIN, eftersom det är hyresvärden som ska ladda upp
 *    en bankfil. En utebliven databasbackup är däremot INGENTING en kund kan
 *    åtgärda — dumpen omfattar alla organisationer, och åtgärden ligger i
 *    Railway och Cloudflare. Att mejla kunder om det vore att läcka ett
 *    driftsfel till fel mottagare. Larmet går till Sentry och serverloggen.
 * 2. **Ingen persisterad idempotensmarkör.** PaymentFreshness har
 *    `paymentDataStaleAlertedAt` i databasen. Det kräver en migration, och en
 *    migration är utanför den här ändringens ram. Markören är därför
 *    processlokal (se `senastLarmadSignatur`): den dämpar upprepning inom en
 *    körande process, och Sentry deduperar på fingerprint. En omstart ger ett
 *    larm till — vilket är fel håll att fela på, och alltså rätt håll.
 *
 * INGA PERSONUPPGIFTER, INGA HEMLIGHETER, INGA BELOPP i larmtexten. Antal,
 * tidsstämplar och variabelnamn räcker för att åtgärda felet.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * TRÖSKELN: en missad natt tolereras, inte två.
 *
 * Jobbet kör 03:00 varje dygn. Med hela dygn räknat är gårdagens backup
 * `ageDays = 1` och släpps igenom — det är marginalen för EN utebliven körning
 * (deploy, omstart, en långsam natt). `ageDays = 2` betyder att två nätter
 * passerat utan en enda dump, och då är det inte längre brus.
 */
export const BACKUP_MAX_AGE_DAYS = 1

/** Hela kalenderdygn mellan två tidpunkter. Samma regel som PaymentFreshness. */
function wholeDaysBetween(from: Date, to: Date): number {
  const fromDay = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())
  const toDay = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate())
  return Math.max(0, Math.floor((toDay - fromDay) / MS_PER_DAY))
}

/**
 * Utfallets art. `fresh` och `not-production` larmar inte; de tre övriga gör det.
 * De tre är AVSIKTLIGT skilda: åtgärden är olika för var och en, och ett larm som
 * inte säger vilken av dem det är tvingar mottagaren att själv gå och titta.
 */
export type BackupFreshnessKind = 'disabled' | 'never' | 'stale' | 'fresh' | 'not-production'

export interface BackupFreshnessVerdict {
  alarm: boolean
  kind: BackupFreshnessKind
  /** Senaste lyckade backupens tidpunkt, `null` när ingen finns. */
  latestBackupAt: Date | null
  /** Hela dygn sedan senaste backup. `Infinity` när ingen finns. */
  ageDays: number
  thresholdDays: number
  /** Antal backup-objekt i lagringen. Ett ANTAL, aldrig innehåll. */
  backupCount: number
  /** Varför backupen inte kör, när den inte gör det. */
  blockReason: string | null
}

export interface BackupFreshnessInput {
  isProduction: boolean
  productionBlockReason: string | null
  /** Nycklarna i lagringen. Bara nycklar — inga storlekar, inget innehåll. */
  keys: string[]
  now: Date
  thresholdDays?: number
}

/**
 * REN UTVÄRDERING — ingen R2, ingen Sentry, ingen klocka utifrån.
 *
 * Ordningen är inte godtycklig: en AVSTÄNGD backup ska rapporteras som avstängd
 * även om lagringen råkar innehålla gamla dumpar. Det motsatta — att rapportera
 * "för gammal" om något som är avstängt — hade skickat mottagaren att leta efter
 * ett fel i jobbet i stället för i konfigurationen.
 */
export function evaluateBackupFreshness(input: BackupFreshnessInput): BackupFreshnessVerdict {
  const thresholdDays = input.thresholdDays ?? BACKUP_MAX_AGE_DAYS
  const datum = input.keys
    .map(parseBackupKeyDate)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())
  const latestBackupAt = datum[0] ?? null
  const backupCount = datum.length

  const bas = { latestBackupAt, backupCount, thresholdDays, blockReason: null } as const

  // Utanför produktion är avstängd backup det NORMALA (dev/test) — inget larm.
  if (!input.isProduction) {
    return { ...bas, alarm: false, kind: 'not-production', ageDays: Infinity }
  }

  // (c) Avstängd eller blockerad i produktion. Fallet som orsakade de 45 dagarna.
  if (input.productionBlockReason) {
    return {
      ...bas,
      alarm: true,
      kind: 'disabled',
      ageDays: latestBackupAt ? wholeDaysBetween(latestBackupAt, input.now) : Infinity,
      blockReason: input.productionBlockReason,
    }
  }

  // (b) Ingen lyckad backup över huvud taget.
  if (!latestBackupAt) {
    return { ...bas, alarm: true, kind: 'never', ageDays: Infinity }
  }

  // (a) För gammal.
  const ageDays = wholeDaysBetween(latestBackupAt, input.now)
  if (ageDays > thresholdDays) {
    return { ...bas, alarm: true, kind: 'stale', ageDays }
  }

  // (d) Färsk — tyst.
  return { ...bas, alarm: false, kind: 'fresh', ageDays }
}

/** Larmtexten. Antal och tidsstämplar — aldrig innehåll, värden eller belopp. */
export function backupFreshnessMessage(v: BackupFreshnessVerdict): string {
  const svans =
    ' En utebliven backup ger ingen egen signal: ett jobb som aldrig körs kan aldrig' +
    ' misslyckas, så frånvaron måste larmas på ålder. Åtgärda i Railway/Cloudflare' +
    ' och verifiera att en dump landar nästa natt.'

  if (v.kind === 'disabled') {
    const senast = v.latestBackupAt
      ? `Senaste dump i lagringen: ${v.latestBackupAt.toISOString()} (${v.backupCount} st totalt).`
      : 'Det finns dessutom ingen dump alls i lagringen.'
    return (
      `[backup-freshness] LARM: databasbackupen kör INTE i produktion — ${v.blockReason}. ` +
      `${senast}${svans}`
    )
  }

  if (v.kind === 'never') {
    return (
      '[backup-freshness] LARM: det finns INGEN databasbackup alls. Jobbet är påslaget ' +
      'och inte blockerat, men lagringen innehåller 0 dumpar — ingen körning har ' +
      `alltså någonsin lyckats.${svans}`
    )
  }

  if (v.kind === 'stale') {
    return (
      `[backup-freshness] LARM: senaste databasbackup är ${v.ageDays} dygn gammal ` +
      `(${v.latestBackupAt?.toISOString()}), gränsen är ${v.thresholdDays} dygn. ` +
      `Lagringen innehåller ${v.backupCount} dumpar.${svans}`
    )
  }

  // Icke-larmande utfall får också en text — den används i loggen, inte i larmet.
  return v.kind === 'fresh'
    ? `[backup-freshness] OK: senaste backup ${v.latestBackupAt?.toISOString()} ` +
        `(${v.ageDays} dygn, ${v.backupCount} dumpar i lagringen).`
    : '[backup-freshness] Utanför produktion — färskheten bevakas inte.'
}

@Injectable()
export class BackupFreshnessService {
  private readonly logger = new Logger(BackupFreshnessService.name)

  /**
   * Processlokal dämpning: samma larm om och om igen samma dygn ger ingen ny
   * information. Se avvikelse 2 i filens docblock — en persisterad markör hade
   * krävt en migration.
   */
  private senastLarmadSignatur: string | null = null

  constructor(
    private readonly backup: BackupService,
    /**
     * #605 — VARAKTIG FELSÄNKA. `BackupScheduler.dailyFreshnessCheck` sväljer
     * med flit; rapporteringen sker här, och bara här.
     */
    private readonly cronErrors: CronErrorSink,
  ) {}

  /** Läser lagringen och utvärderar. Kastar aldrig — se `check()`. */
  async evaluate(now: Date = new Date()): Promise<BackupFreshnessVerdict> {
    // Är backupen blockerad går vi ALDRIG till R2: konfigurationen kan vara
    // ofullständig, och ett anslutningsfel hade maskerat det verkliga skälet.
    if (!this.backup.isProduction || this.backup.productionBlockReason) {
      return evaluateBackupFreshness({
        isProduction: this.backup.isProduction,
        productionBlockReason: this.backup.productionBlockReason,
        keys: [],
        now,
      })
    }

    const objekt = await this.backup.listBackups()
    return evaluateBackupFreshness({
      isProduction: this.backup.isProduction,
      productionBlockReason: null,
      keys: objekt.map((o) => o.key),
      now,
    })
  }

  /**
   * Dygnets kontroll: utvärdera, larma vid behov, logga alltid.
   *
   * Att den loggar ÄVEN i det tysta fallet är med flit. En vakt som bara syns
   * när den fäller går inte att skilja från en vakt som slutat köra — och det
   * är exakt den defekten hela den här tjänsten finns för att åtgärda.
   */
  async check(now: Date = new Date()): Promise<BackupFreshnessVerdict> {
    let verdict: BackupFreshnessVerdict
    try {
      verdict = await this.evaluate(now)
    } catch (err) {
      // Kan vi inte ens läsa lagringen vet vi inte om backupen finns. Det är ett
      // larm i sig, inte ett tyst hopp över.
      const meddelande =
        '[backup-freshness] LARM: kunde inte läsa backup-lagringen, så färskheten ' +
        'går inte att avgöra. Behandlas som ett larm — okänt läge är inte samma sak ' +
        'som ett friskt läge.'
      this.logger.error(`${meddelande} (${err instanceof Error ? err.message : String(err)})`)
      Sentry.captureMessage(meddelande, 'error')
      await this.cronErrors.report('backup-freshness', new Error(meddelande), {
        detail: { steg: 'läsa-lagringen' },
      })
      throw err
    }

    const text = backupFreshnessMessage(verdict)

    if (!verdict.alarm) {
      this.logger.log(text)
      return verdict
    }

    this.logger.error(text)

    // En signatur per art och dygn — samma läge larmar en gång per dygn, inte
    // en gång per körning.
    const signatur = `${verdict.kind}:${now.toISOString().slice(0, 10)}`
    if (this.senastLarmadSignatur !== signatur) {
      this.senastLarmadSignatur = signatur
      Sentry.captureMessage(text, 'error')
      // Innanför dämpningen med flit: samma larm en gång per dygn, inte en gång
      // per körning. En felkanal som upprepar sig slutar läsas.
      await this.cronErrors.report('backup-freshness', new Error(text), {
        detail: { steg: 'färskhetslarm', art: verdict.kind },
      })
    }

    return verdict
  }
}
