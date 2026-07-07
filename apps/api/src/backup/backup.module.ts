import { Module } from '@nestjs/common'
import { BackupService } from './backup.service'
import { BackupScheduler } from './backup.scheduler'

@Module({
  providers: [BackupService, BackupScheduler],
  exports: [BackupService],
})
export class BackupModule {}
