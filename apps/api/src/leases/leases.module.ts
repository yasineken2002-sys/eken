import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { DepositsModule } from '../deposits/deposits.module'
import { RentIncreasesModule } from '../rent-increases/rent-increases.module'
import { LeasesController } from './leases.controller'
import { LeasesService } from './leases.service'

@Module({
  imports: [PrismaModule, NotificationsModule, DepositsModule, RentIncreasesModule],
  controllers: [LeasesController],
  providers: [LeasesService],
  exports: [LeasesService],
})
export class LeasesModule {}
