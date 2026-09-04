import { Module, forwardRef } from '@nestjs/common'
import { CronErrorSinkModule } from '../common/cron/cron-error-sink.module'
import { MaintenanceModule } from '../maintenance/maintenance.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { PrismaModule } from '../common/prisma/prisma.module'
import { ContractsModule } from '../contracts/contracts.module'
import { BankidModule } from '../bankid/bankid.module'
import { TenantBankIdService } from './tenant-bankid.service'
import { StorageModule } from '../storage/storage.module'
import { InvoicesModule } from '../invoices/invoices.module'
import { AviseringModule } from '../avisering/avisering.module'
import { TenantAuthService } from './tenant-auth.service'
import { TenantAuthGuard } from './tenant-auth.guard'
import { TenantPortalService } from './tenant-portal.service'
import { TenantInvitationsService } from './tenant-invitations.service'
import {
  TenantAuthController,
  TenantPortalController,
  TenantPortalAdminController,
} from './tenant-portal.controller'

@Module({
  imports: [
    // CronErrorSinkModule (#605 batch 2) — importerar bara PrismaModule, ingen cykel.
    CronErrorSinkModule,
    MaintenanceModule,
    NotificationsModule,
    PrismaModule,
    StorageModule,
    InvoicesModule,
    AviseringModule,
    forwardRef(() => ContractsModule),
    // BankidModule exporterar BANKID_PROVIDER. Ingen cykel: den importerar
    // AuthModule, som inte känner till portalen. Providern DELAS med web-flödet
    // med flit — en skarp adapter ska vara EN klient mot brokern, inte två.
    BankidModule,
  ],
  controllers: [TenantAuthController, TenantPortalController, TenantPortalAdminController],
  providers: [
    TenantAuthService,
    TenantAuthGuard,
    TenantPortalService,
    TenantInvitationsService,
    TenantBankIdService,
  ],
  exports: [TenantAuthService, TenantAuthGuard],
})
export class TenantPortalModule {}
