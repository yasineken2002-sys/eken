import { Module } from '@nestjs/common'
import { BackupService } from './backup.service'
import { BackupScheduler } from './backup.scheduler'
import { BackupFreshnessService } from './backup-freshness.service'

@Module({
  providers: [BackupService, BackupScheduler, BackupFreshnessService],
  exports: [BackupService, BackupFreshnessService],
})
export class BackupModule {}
