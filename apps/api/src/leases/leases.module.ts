import { BullModule } from '@nestjs/bull'
import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { DepositsModule } from '../deposits/deposits.module'
import { RentIncreasesModule } from '../rent-increases/rent-increases.module'
import { TenantPortalModule } from '../tenant-portal/tenant-portal.module'
import { ContractsModule } from '../contracts/contracts.module'
import { AviseringModule } from '../avisering/avisering.module'
import { LeasesController } from './leases.controller'
import { LeasesService } from './leases.service'
import { LeaseActivationQueue, LEASE_ACTIVATION_QUEUE } from './lease-activation.queue'
import { LeaseActivationWorker } from './lease-activation.worker'
import { RedisModule } from '../common/redis/redis.module'
import { CronErrorSinkModule } from '../common/cron/cron-error-sink.module'

@Module({
  imports: [
    RedisModule,
    PrismaModule,
    NotificationsModule,
    DepositsModule,
    RentIncreasesModule,
    TenantPortalModule,
    ContractsModule,
    AviseringModule,
    BullModule.registerQueue({ name: LEASE_ACTIVATION_QUEUE }),
    CronErrorSinkModule,
  ],
  controllers: [LeasesController],
  providers: [LeasesService, LeaseActivationQueue, LeaseActivationWorker],
  exports: [LeasesService],
})
export class LeasesModule {}
