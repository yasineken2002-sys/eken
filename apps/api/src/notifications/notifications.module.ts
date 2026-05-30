import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { MailModule } from '../mail/mail.module'
import { NotificationsService } from './notifications.service'
import { NotificationsController } from './notifications.controller'
import { PaymentReminderService } from './payment-reminder.service'
import { MonthlyReportService } from './monthly-report.service'
import { VerifikationsnummerModule } from '../accounting/verifikationsnummer.module'

@Module({
  imports: [PrismaModule, MailModule, VerifikationsnummerModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, PaymentReminderService, MonthlyReportService],
  exports: [NotificationsService, PaymentReminderService],
})
export class NotificationsModule {}
