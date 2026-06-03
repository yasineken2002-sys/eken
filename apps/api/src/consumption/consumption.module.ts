import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { ConsumptionController } from './consumption.controller'
import { ConsumptionService } from './consumption.service'

// PR 2 (intake): avläsningar in → DRAFT-charges ut. Inget verifikat, ingen
// 1510-fordran (PR 3), inget på avi/faktura (PR 4) — därför inget
// AccountingModule-beroende ännu. vatRateForRent importeras som ren funktion.
@Module({
  imports: [PrismaModule],
  controllers: [ConsumptionController],
  providers: [ConsumptionService],
  exports: [ConsumptionService],
})
export class ConsumptionModule {}
