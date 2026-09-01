import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { MailModule } from '../mail/mail.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { AiUsageController } from './ai-usage.controller'
import { AiUsagePageService } from './ai-usage.service'
import { AiUsageNotifierService } from './ai-usage-notifier.service'
import { RedisModule } from '../common/redis/redis.module'
import { CronErrorSinkModule } from '../common/cron/cron-error-sink.module'

/**
 * Endpoints + cron för admin-frontendens "Plan & AI-användning"-sida.
 * Separat från ai/usage-modulen som loggar varje anrop, för att hålla
 * den interna loggningen frikopplad från användarvänd API-yta.
 */
@Module({
  imports: [RedisModule, PrismaModule, MailModule, NotificationsModule, CronErrorSinkModule],
  controllers: [AiUsageController],
  providers: [AiUsagePageService, AiUsageNotifierService],
  exports: [AiUsagePageService],
})
export class AiUsagePageModule {}
