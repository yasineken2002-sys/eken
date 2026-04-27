import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { AccountingModule } from '../accounting/accounting.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { DepositsController } from './deposits.controller'
import { DepositsService } from './deposits.service'

@Module({
  imports: [PrismaModule, AccountingModule, NotificationsModule],
  controllers: [DepositsController],
  providers: [DepositsService],
  exports: [DepositsService],
})
export class DepositsModule {}
