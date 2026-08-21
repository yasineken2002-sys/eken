import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { BackupService } from './backup.service'
import { BackupFreshnessService } from './backup-freshness.service'

@Injectable()
export class BackupScheduler {
  private readonly logger = new Logger(BackupScheduler.name)

  constructor(
    private readonly backup: BackupService,
    private readonly freshness: BackupFreshnessService,
  ) {}

  // Daglig databasbackup 03:00. Kör bara om BACKUP_ENABLED=true + R2/DB-config finns
  // (annars no-op i dev/test). pg_dump → R2 (geografiskt separerat från Railway) →
  // gallra >retention. Fel larmas via Sentry i BackupService.runBackup.
  @Cron('0 3 * * *')
  async dailyBackup(): Promise<void> {
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
  @Cron('0 9 * * *')
  async dailyFreshnessCheck(): Promise<void> {
    try {
      await this.freshness.check()
    } catch {
      // Redan loggat + larmat i check(). Svälj så cron-loopen överlever.
    }
  }
}
