import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { InvoicesModule } from '../invoices/invoices.module'
import { AccountingModule } from '../accounting/accounting.module'
import { AiUsageModule } from '../ai/usage/ai-usage.module'
import { ReconciliationController } from './reconciliation.controller'
import { ReconciliationService } from './reconciliation.service'
import { PdfStatementParserService } from './pdf-statement-parser.service'
import { BankStatementImportService } from './bank-statement-import.service'

@Module({
  imports: [PrismaModule, InvoicesModule, AccountingModule, AiUsageModule],
  controllers: [ReconciliationController],
  providers: [ReconciliationService, PdfStatementParserService, BankStatementImportService],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
