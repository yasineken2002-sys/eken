import { Module } from '@nestjs/common'
import { MaintenanceModule } from '../maintenance/maintenance.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { PrismaModule } from '../common/prisma/prisma.module'
import { TenantAuthService } from './tenant-auth.service'
import { TenantAuthGuard } from './tenant-auth.guard'
import { TenantPortalService } from './tenant-portal.service'
import { TenantAuthController } from './tenant-portal.controller'
import { TenantPortalController } from './tenant-portal.controller'

@Module({
  imports: [MaintenanceModule, NotificationsModule, PrismaModule],
  controllers: [TenantAuthController, TenantPortalController],
  providers: [TenantAuthService, TenantAuthGuard, TenantPortalService],
  exports: [TenantAuthService],
})
export class TenantPortalModule {}
