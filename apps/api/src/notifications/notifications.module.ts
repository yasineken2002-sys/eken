import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { MailModule } from '../mail/mail.module'
import { NotificationsService } from './notifications.service'
import { NotificationsController } from './notifications.controller'
import { PaymentReminderService } from './payment-reminder.service'

@Module({
  imports: [PrismaModule, MailModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, PaymentReminderService],
  exports: [NotificationsService, PaymentReminderService],
})
export class NotificationsModule {}
