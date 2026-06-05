import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { MailModule } from '../mail/mail.module'
import { InvoicesModule } from '../invoices/invoices.module'
import { OcrModule } from '../common/ocr/ocr.module'
import { StorageModule } from '../storage/storage.module'
import { AccountingModule } from '../accounting/accounting.module'
import { ConsumptionModule } from '../consumption/consumption.module'
import { AviseringController } from './avisering.controller'
import { AviseringService } from './avisering.service'
import { AviseringScheduler } from './avisering.scheduler'
import { RentReminderService } from './rent-reminder.service'
import { RentNoticeEventsService } from './rent-notice-events.service'

@Module({
  imports: [
    PrismaModule,
    MailModule,
    InvoicesModule,
    OcrModule,
    StorageModule,
    AccountingModule,
    ConsumptionModule,
  ],
  controllers: [AviseringController],
  providers: [AviseringService, AviseringScheduler, RentReminderService, RentNoticeEventsService],
  // RentReminderService exporteras så PdfWorker (kind 'avisering-reminder') kan
  // resolva den via ModuleRef, precis som AviseringService.
  exports: [AviseringService, RentReminderService],
})
export class AviseringModule {}
