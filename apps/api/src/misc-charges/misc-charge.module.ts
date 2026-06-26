import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { AccountingModule } from '../accounting/accounting.module'
import { MiscChargeController } from './misc-charge.controller'
import { MiscChargeService } from './misc-charge.service'

// Spår A PR 3: DRAFT → CONFIRMED (verifikat via AccountingService) → CANCELLED
// (motverifikat). Leverans/attach (ATTACHED, RentNoticeLine) är PR 4.
@Module({
  imports: [PrismaModule, AccountingModule],
  controllers: [MiscChargeController],
  providers: [MiscChargeService],
  exports: [MiscChargeService],
})
export class MiscChargeModule {}
