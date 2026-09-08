import { Module } from '@nestjs/common'
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
  imports: [PrismaModule, AccountingModule, InvoicesModule],
  controllers: [ConsumptionController, ReadingReviewController],
  providers: [ConsumptionService, ReadingReviewService],
  exports: [ConsumptionService],
})
export class ConsumptionModule {}
