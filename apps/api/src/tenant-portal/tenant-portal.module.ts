import { Module, forwardRef } from '@nestjs/common'
import { MaintenanceModule } from '../maintenance/maintenance.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { PrismaModule } from '../common/prisma/prisma.module'
import { ContractsModule } from '../contracts/contracts.module'
import { StorageModule } from '../storage/storage.module'
import { TenantAuthService } from './tenant-auth.service'
import { TenantAuthGuard } from './tenant-auth.guard'
import { TenantPortalService } from './tenant-portal.service'
import {
  TenantAuthController,
  TenantPortalController,
  TenantPortalAdminController,
} from './tenant-portal.controller'

@Module({
  imports: [
    MaintenanceModule,
    NotificationsModule,
    PrismaModule,
    StorageModule,
    forwardRef(() => ContractsModule),
  ],
  controllers: [TenantAuthController, TenantPortalController, TenantPortalAdminController],
  providers: [TenantAuthService, TenantAuthGuard, TenantPortalService],
  exports: [TenantAuthService, TenantAuthGuard],
})
export class TenantPortalModule {}
