import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { BackupService } from './backup.service'

@Injectable()
export class BackupScheduler {
  private readonly logger = new Logger(BackupScheduler.name)

  constructor(private readonly backup: BackupService) {}

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
}
