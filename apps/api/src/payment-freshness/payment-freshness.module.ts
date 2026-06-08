import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { MailModule } from '../mail/mail.module'
import { PaymentFreshnessService } from './payment-freshness.service'

/**
 * Bankavstämnings-härdning PR 4 (B). Fristående modul så att BÅDE ReconciliationModule
 * (ingest → recordPaymentDataThrough) och AviseringModule (eskalerings-crons →
 * evaluateAndAlert) kan dela tjänsten utan modulcykel. Beror bara på Prisma + Mail.
 */
@Module({
  imports: [PrismaModule, MailModule],
  providers: [PaymentFreshnessService],
  exports: [PaymentFreshnessService],
})
export class PaymentFreshnessModule {}
