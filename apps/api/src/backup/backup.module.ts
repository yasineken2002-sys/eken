import { Module } from '@nestjs/common'
import { BackupService } from './backup.service'
import { BackupScheduler } from './backup.scheduler'
import { BackupFreshnessService } from './backup-freshness.service'
import { RedisModule } from '../common/redis/redis.module'

@Module({
  imports: [RedisModule],
  providers: [BackupService, BackupScheduler, BackupFreshnessService],
  exports: [BackupService, BackupFreshnessService],
})
export class BackupModule {}
