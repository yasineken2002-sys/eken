import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { AccountingModule } from '../accounting/accounting.module'
// #340: InvoiceEventsService — händelser skrivs via record(), som
// denormaliserar aktörsetiketten. InvoicesModule exporterar den.
import { InvoicesModule } from '../invoices/invoices.module'
import { ConsumptionController } from './consumption.controller'
import { ConsumptionService } from './consumption.service'

// PR 3 (bokföring): DRAFT → CONFIRMED skapar verifikat + 1510-fordran via
// AccountingService. Oberoende av leverans (PR 4). Leverans rör avi/faktura.
@Module({
  imports: [PrismaModule, AccountingModule, InvoicesModule],
  controllers: [ConsumptionController],
  providers: [ConsumptionService],
  exports: [ConsumptionService],
})
export class ConsumptionModule {}
