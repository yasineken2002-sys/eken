import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { MailModule } from '../mail/mail.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { AiUsageController } from './ai-usage.controller'
import { AiUsagePageService } from './ai-usage.service'
import { AiUsageNotifierService } from './ai-usage-notifier.service'

/**
 * Endpoints + cron för admin-frontendens "Plan & AI-användning"-sida.
 * Separat från ai/usage-modulen som loggar varje anrop, för att hålla
 * den interna loggningen frikopplad från användarvänd API-yta.
 */
@Module({
  imports: [PrismaModule, MailModule, NotificationsModule],
  controllers: [AiUsageController],
  providers: [AiUsagePageService, AiUsageNotifierService],
  exports: [AiUsagePageService],
})
export class AiUsagePageModule {}
