import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { MailModule } from '../mail/mail.module'
import { NotificationsService } from './notifications.service'
import { NotificationsController } from './notifications.controller'
import { PaymentReminderService } from './payment-reminder.service'
import { MonthlyReportService } from './monthly-report.service'
import { AccountingModule } from '../accounting/accounting.module'
import { OverdueModule } from '../overdue/overdue.module'
import { CronErrorSinkModule } from '../common/cron/cron-error-sink.module'
import { PaymentFreshnessModule } from '../payment-freshness/payment-freshness.module'

@Module({
  // AccountingModule ger PaymentReminderService den delade bookReminderFee
  // (och re-exporterar VerifikationsnummerModule). Ingen cykel: AccountingModule
  // importerar inte NotificationsModule.
  // CronErrorSinkModule (#605): de tre rapportjobben skriver sina per-org-fel
  // till ErrorLog, inte bara till containerns logg. Modulen importerar INTE
  // PlatformModule — det hade slutit en cykel via InvoicesModule (se dess
  // huvudkommentar).
  // PaymentFreshnessModule: människans "skicka påminnelser nu" måste grindas av
  // samma färskhetskrav som kravtrappans cron. En knapp som skickar krav mot
  // hyresgäster som kan ha betalat utan att avstämningen vet det är precis vad
  // grinden finns för att hindra — och att den bara gällde det automatiska
  // spåret vore en lucka i det manuella.
  imports: [
    PrismaModule,
    MailModule,
    AccountingModule,
    OverdueModule,
    CronErrorSinkModule,
    PaymentFreshnessModule,
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService, PaymentReminderService, MonthlyReportService],
  exports: [NotificationsService, PaymentReminderService],
})
export class NotificationsModule {}
