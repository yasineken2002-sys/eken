import { Module } from '@nestjs/common'
import { AccountingModule } from '../accounting/accounting.module'
import { CronErrorSinkModule } from '../common/cron/cron-error-sink.module'
import { PrismaModule } from '../common/prisma/prisma.module'
import { PaymentFreshnessModule } from '../payment-freshness/payment-freshness.module'
import {
  CUSTOMER_CREDIT_REFUND_BANK_PORT,
  UnavailableCustomerCreditRefundBankAdapter,
} from './customer-credit-refund-bank.port'
import { CustomerCreditRefundRecoveryScheduler } from './customer-credit-refund-recovery.scheduler'
import { CustomerCreditRefundService } from './customer-credit-refund.service'
import { CustomerCreditService } from './customer-credit.service'

@Module({
  imports: [PrismaModule, AccountingModule, PaymentFreshnessModule, CronErrorSinkModule],
  providers: [
    CustomerCreditService,
    CustomerCreditRefundService,
    CustomerCreditRefundRecoveryScheduler,
    // Ingen env-variabel eller aktiveringsväg kan välja en syntetisk bank i drift.
    {
      provide: CUSTOMER_CREDIT_REFUND_BANK_PORT,
      useClass: UnavailableCustomerCreditRefundBankAdapter,
    },
  ],
  exports: [CustomerCreditService, CustomerCreditRefundService],
})
export class CustomerCreditModule {}
