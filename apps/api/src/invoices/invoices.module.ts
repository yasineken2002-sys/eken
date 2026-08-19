import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { AccountingModule } from '../accounting/accounting.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { InvoicesController } from './invoices.controller'
import { InvoicesService } from './invoices.service'
import { InvoiceEventsService } from './invoice-events.service'
import { TrackingController } from './tracking.controller'
import { PdfService } from './pdf.service'
import { CreditNoteService } from './credit-note.service'

@Module({
  imports: [PrismaModule, AccountingModule, NotificationsModule],
  controllers: [InvoicesController, TrackingController],
  providers: [InvoicesService, InvoiceEventsService, PdfService, CreditNoteService],
  exports: [InvoicesService, InvoiceEventsService, PdfService, CreditNoteService],
})
export class InvoicesModule {}
