import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { AccountingModule } from '../accounting/accounting.module'
import { ConsumptionController } from './consumption.controller'
import { ConsumptionService } from './consumption.service'

// PR 3 (bokföring): DRAFT → CONFIRMED skapar verifikat + 1510-fordran via
// AccountingService. Oberoende av leverans (PR 4). Leverans rör avi/faktura.
@Module({
  imports: [PrismaModule, AccountingModule],
  controllers: [ConsumptionController],
  providers: [ConsumptionService],
  exports: [ConsumptionService],
})
export class ConsumptionModule {}
