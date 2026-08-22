import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { BackupService } from './backup.service'
import { BackupFreshnessService } from './backup-freshness.service'
import { CRON_LOCK_TTL_SEC } from '../common/redis/cron-lock'
import { LockService } from '../common/redis/lock.service'

@Injectable()
export class BackupScheduler {
  private readonly logger = new Logger(BackupScheduler.name)

  constructor(
    private readonly backup: BackupService,
    private readonly freshness: BackupFreshnessService,
    // Cron-lås (klass A). Sist i listan: nya beroenden läggs till på slutet
    // så befintliga positionsanrop inte tyst byter betydelse.
    private readonly locks: LockService,
  ) {}

  // Daglig databasbackup 03:00. Kör bara om BACKUP_ENABLED=true + R2/DB-config finns
  // (annars no-op i dev/test). pg_dump → R2 (geografiskt separerat från Railway) →
  // gallra >retention. Fel larmas via Sentry i BackupService.runBackup.
  @Cron('0 3 * * *')
  async dailyBackup(): Promise<void> {
    // ── LÅST (klass A) ────────────────────────────────────────────────────
    //
    // `backupKey` innehåller SEKUNDER, så två körningar ger två pg_dump mot
    // prod-databasen, två R2-objekt och en felaktig gallringsräknare. Backupen
    // är på väg att sättas i drift — att låsa den innan den slås på är
    // billigare än att upptäcka det efteråt.
    //
    // Låset skyddar mot SAMTIDIGHET — två repliker som kör jobbet samtidigt.
    // Prod kör i dag en instans (`numReplicas: null`), så det är FÖREBYGGANDE:
    // skyddet är en deployinställning, inte en kodinvariant, och aktiveras den
    // dag tjänsten skalas upp utan att någon rör koden.
    const result = await this.locks.runIfUnlocked(
      'cron:daily-backup',
      () => this.dailyBackupUnsafe(),
      { ttlSec: CRON_LOCK_TTL_SEC },
    )
    if (!result.ran) {
      // Ett tyst överhopp är oskiljbart från "cronen kördes aldrig". Säg det —
      // och säg hur gammalt låset var, så ett normalt överhopp går att skilja
      // från ett hängt lås som stängt av jobbet.
      this.logger.log(
        `[cron:daily-backup] Kördes redan av en annan replik — hoppar över. ` +
          `Låset hållet i ${result.heldForSec ?? '?'} s av ${CRON_LOCK_TTL_SEC} s.`,
      )
    }
  }

  private async dailyBackupUnsafe(): Promise<void> {
    if (!this.backup.enabled) return
    try {
      await this.backup.runBackup()
    } catch {
      // Redan loggat + Sentry-rapporterat i runBackup — svälj här så cron-loopen
      // inte kraschar. Nästa körning försöker igen.
    }
  }

  /**
   * FÄRSKHETSKONTROLLEN — 09:00, sex timmar efter nattjobbet.
   *
   * Körs OAVSETT om backupen är påslagen. Det är hela poängen: en avstängd
   * backup har inga misslyckanden att larma om, och det var precis därför den
   * kunde vara avstängd i 45 dagar utan att någon märkte det.
   *
   * Tidpunkten ligger efter 03:00 med marginal, så en långsam eller omstartad
   * natt hinner bli klar innan åldern mäts.
   */
  // ── KLASSIFICERING: B — SKYDDAT AV INVARIANT ─────────────────────────
  // BackupFreshnessService har INGEN prisma-injektion alls (verifierat: noll
  // träffar i filen) — check() listar R2 och larmar via Sentry/logger. Ren
  // läsning kan inte ge dubbelt utfall.
  //
  // Bevakas av check-cron-classification.mjs: ett @Cron utan klassificering
  // fäller CI, och ett B utan namngiven invariant likaså.
  @Cron('0 9 * * *')
  async dailyFreshnessCheck(): Promise<void> {
    try {
      await this.freshness.check()
    } catch {
      // Redan loggat + larmat i check(). Svälj så cron-loopen överlever.
    }
  }
}
