import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { InvoicesModule } from '../invoices/invoices.module'
import { ReconciliationController } from './reconciliation.controller'
import { ReconciliationService } from './reconciliation.service'

@Module({
  imports: [PrismaModule, InvoicesModule],
  controllers: [ReconciliationController],
  providers: [ReconciliationService],
})
export class ReconciliationModule {}
