import { Module, forwardRef } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { InvoicesModule } from '../invoices/invoices.module'
import { AccountingModule } from '../accounting/accounting.module'
import { AiUsageModule } from '../ai/usage/ai-usage.module'
import { PaymentFreshnessModule } from '../payment-freshness/payment-freshness.module'
import { AviseringModule } from '../avisering/avisering.module'
import { ReconciliationController } from './reconciliation.controller'
import { ReconciliationService } from './reconciliation.service'
import { PdfStatementParserService } from './pdf-statement-parser.service'
import { BankStatementImportService } from './bank-statement-import.service'
import { BankImportAttemptService } from './bank-import-attempt.service'

@Module({
  imports: [
    PrismaModule,
    InvoicesModule,
    AccountingModule,
    AiUsageModule,
    PaymentFreshnessModule,
    // #326 C — RentNoticeEventsService denormaliserar aktörsetiketten.
    forwardRef(() => AviseringModule),
  ],
  controllers: [ReconciliationController],
  providers: [
    ReconciliationService,
    PdfStatementParserService,
    BankStatementImportService,
    // #F034b — filnivåns idempotens. Provider i den här modulen och inte global:
    // den ÄGS av bankimporten, och en global tjänst hade inbjudit andra vägar
    // att ta arrenden på ett avtryck vars innebörd är definierad här.
    BankImportAttemptService,
  ],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
