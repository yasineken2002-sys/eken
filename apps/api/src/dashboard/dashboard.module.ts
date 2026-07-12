import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { AccountingModule } from '../accounting/accounting.module'
import { DashboardController } from './dashboard.controller'
import { DashboardService } from './dashboard.service'

@Module({
  // AccountingModule → "Totala intäkter" läses ur huvudboken (Σ 3xxx) via
  // AccountingService.getRevenueTotal, inte ur Invoice/RentNotice.
  imports: [PrismaModule, AccountingModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
