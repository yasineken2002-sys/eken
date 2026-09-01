import { Module } from '@nestjs/common'
import { CronErrorSinkModule } from '../common/cron/cron-error-sink.module'
import { BackupService } from './backup.service'
import { BackupScheduler } from './backup.scheduler'
import { BackupFreshnessService } from './backup-freshness.service'
import { RedisModule } from '../common/redis/redis.module'

@Module({
  imports: [
    // CronErrorSinkModule (#605) — importerar bara PrismaModule, ingen cykel.
    CronErrorSinkModule,
    RedisModule,
  ],
  providers: [BackupService, BackupScheduler, BackupFreshnessService],
  exports: [BackupService, BackupFreshnessService],
})
export class BackupModule {}
