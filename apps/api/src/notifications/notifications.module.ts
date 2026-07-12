import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { MailModule } from '../mail/mail.module'
import { NotificationsService } from './notifications.service'
import { NotificationsController } from './notifications.controller'
import { PaymentReminderService } from './payment-reminder.service'
import { MonthlyReportService } from './monthly-report.service'
import { AccountingModule } from '../accounting/accounting.module'
import { OverdueModule } from '../overdue/overdue.module'

@Module({
  // AccountingModule ger PaymentReminderService den delade bookReminderFee
  // (och re-exporterar VerifikationsnummerModule). Ingen cykel: AccountingModule
  // importerar inte NotificationsModule.
  imports: [PrismaModule, MailModule, AccountingModule, OverdueModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, PaymentReminderService, MonthlyReportService],
  exports: [NotificationsService, PaymentReminderService],
})
export class NotificationsModule {}
