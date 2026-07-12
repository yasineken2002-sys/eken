import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { OverdueDebtService } from './overdue-debt.service'

/**
 * En sanningskälla för "Försenat belopp" (T4/#47). Beroende enbart av Prisma →
 * kan importeras av valfri konsument (DashboardModule, NotificationsModule) utan
 * cirkelrisk.
 */
@Module({
  imports: [PrismaModule],
  providers: [OverdueDebtService],
  exports: [OverdueDebtService],
})
export class OverdueModule {}
