import { Module } from '@nestjs/common'
import { CronErrorSinkModule } from '../common/cron/cron-error-sink.module'
import { ReadingReviewFollowUpController } from './reading-review-follow-up.controller'
import { ReadingReviewFollowUpService } from './reading-review-follow-up.service'
import { PrismaModule } from '../common/prisma/prisma.module'
import { AccountingModule } from '../accounting/accounting.module'
// #340: InvoiceEventsService — händelser skrivs via record(), som
// denormaliserar aktörsetiketten. InvoicesModule exporterar den.
import { InvoicesModule } from '../invoices/invoices.module'
import { ReadingReviewController } from './reading-review.controller'
import { ReadingReviewService } from './reading-review.service'
import { ConsumptionController } from './consumption.controller'
import { ConsumptionService } from './consumption.service'

// PR 3 (bokföring): DRAFT → CONFIRMED skapar verifikat + 1510-fordran via
// AccountingService. Oberoende av leverans (PR 4). Leverans rör avi/faktura.
@Module({
  imports: [PrismaModule, AccountingModule, InvoicesModule, CronErrorSinkModule],
  controllers: [ConsumptionController, ReadingReviewController, ReadingReviewFollowUpController],
  providers: [ConsumptionService, ReadingReviewService, ReadingReviewFollowUpService],
  exports: [ConsumptionService],
})
export class ConsumptionModule {}
