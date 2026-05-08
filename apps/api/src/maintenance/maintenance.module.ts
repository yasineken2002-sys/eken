import { Module, forwardRef } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { StorageModule } from '../storage/storage.module'
import { MaintenanceController } from './maintenance.controller'
import { MaintenanceService } from './maintenance.service'

@Module({
  imports: [PrismaModule, StorageModule, forwardRef(() => NotificationsModule)],
  controllers: [MaintenanceController],
  providers: [MaintenanceService],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
