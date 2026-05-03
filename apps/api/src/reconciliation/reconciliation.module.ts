import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { InvoicesModule } from '../invoices/invoices.module'
import { AccountingModule } from '../accounting/accounting.module'
import { ReconciliationController } from './reconciliation.controller'
import { ReconciliationService } from './reconciliation.service'

@Module({
  imports: [PrismaModule, InvoicesModule, AccountingModule],
  controllers: [ReconciliationController],
  providers: [ReconciliationService],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
