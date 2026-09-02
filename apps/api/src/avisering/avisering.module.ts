import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { MailModule } from '../mail/mail.module'
import { InvoicesModule } from '../invoices/invoices.module'
import { OcrModule } from '../common/ocr/ocr.module'
import { StorageModule } from '../storage/storage.module'
import { AccountingModule } from '../accounting/accounting.module'
import { ConsumptionModule } from '../consumption/consumption.module'
import { MiscChargeModule } from '../misc-charges/misc-charge.module'
import { PaymentFreshnessModule } from '../payment-freshness/payment-freshness.module'
import { DepositsModule } from '../deposits/deposits.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { AviseringController } from './avisering.controller'
import { AviseringService } from './avisering.service'
import { NotificationsService } from '../notifications/notifications.service'
import {
  NOTIFICATION_FANOUT,
  REMINDER_FEE_REVERSAL,
  ReminderBounceService,
} from './reminder-bounce.service'
import { AviseringScheduler } from './avisering.scheduler'
import { RentReminderService } from './rent-reminder.service'
import { RentNoticeEventsService } from './rent-notice-events.service'
import { RentInterestService } from './rent-interest.service'
import { RentBadDebtService } from './rent-bad-debt.service'
import { RentDebtService } from './rent-debt.service'
import { RentBackfillService } from './rent-backfill.service'
import { RentNoticeCreditService } from './rent-notice-credit.service'
import { CronErrorSinkModule } from '../common/cron/cron-error-sink.module'

@Module({
  imports: [
    PrismaModule,
    MailModule,
    InvoicesModule,
    OcrModule,
    StorageModule,
    AccountingModule,
    ConsumptionModule,
    MiscChargeModule,
    PaymentFreshnessModule,
    DepositsModule,
    NotificationsModule,
    CronErrorSinkModule,
  ],
  controllers: [AviseringController],
  providers: [
    ReminderBounceService,
    // Porten binds till den riktiga tjänsten — en implementation, smal yta.
    { provide: NOTIFICATION_FANOUT, useExisting: NotificationsService },
    { provide: REMINDER_FEE_REVERSAL, useExisting: AviseringService },
    AviseringService,
    AviseringScheduler,
    RentReminderService,
    RentNoticeEventsService,
    RentInterestService,
    RentBadDebtService,
    RentDebtService,
    RentBackfillService,
    RentNoticeCreditService,
  ],
  // RentReminderService exporteras så PdfWorker (kind 'avisering-reminder') kan
  // resolva den via ModuleRef. RentInterestService exporteras för PR 4
  // (inkasso-ready kristalliserar räntan en sista gång). RentDebtService
  // (bankavstämnings-härdning) exponeras för CollectionsModule (export-grind, PR 2)
  // och konsumeras internt av RentReminderService + RentBadDebtService (PR 3a, INV-A).
  // Tillåtna outstanding()-läsare vaktas statiskt av rent-debt-money-neutrality.spec.ts.
  exports: [
    AviseringService,
    ReminderBounceService,
    RentNoticeEventsService,
    RentReminderService,
    RentInterestService,
    RentDebtService,
    RentBackfillService,
  ],
})
export class AviseringModule {}
