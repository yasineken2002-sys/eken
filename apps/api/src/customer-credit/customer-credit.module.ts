import { Module } from '@nestjs/common'
import { AccountingModule } from '../accounting/accounting.module'
import { PrismaModule } from '../common/prisma/prisma.module'
import { PaymentFreshnessModule } from '../payment-freshness/payment-freshness.module'
import { CustomerCreditService } from './customer-credit.service'

@Module({
  imports: [PrismaModule, AccountingModule, PaymentFreshnessModule],
  providers: [CustomerCreditService],
  exports: [CustomerCreditService],
})
export class CustomerCreditModule {}
