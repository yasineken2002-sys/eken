import { Module } from '@nestjs/common'
import { MaintenancePlanController } from './maintenance-plan.controller'
import { MaintenancePlanService } from './maintenance-plan.service'
import { PrismaModule } from '../common/prisma/prisma.module'

@Module({
  imports: [PrismaModule],
  controllers: [MaintenancePlanController],
  providers: [MaintenancePlanService],
  exports: [MaintenancePlanService],
})
export class MaintenancePlanModule {}
