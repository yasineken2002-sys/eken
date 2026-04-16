import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { AccountingModule } from '../accounting/accounting.module'
import { InvoicesController } from './invoices.controller'
import { InvoicesService } from './invoices.service'
import { InvoiceEventsService } from './invoice-events.service'
import { TrackingController } from './tracking.controller'
import { PdfService } from './pdf.service'

@Module({
  imports: [PrismaModule, AccountingModule],
  controllers: [InvoicesController, TrackingController],
  providers: [InvoicesService, InvoiceEventsService, PdfService],
  exports: [InvoicesService, InvoiceEventsService, PdfService],
})
export class InvoicesModule {}
