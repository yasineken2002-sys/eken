import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { GlobalExceptionFilter } from './common/filters/global-exception.filter'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler'
import { ScheduleModule } from '@nestjs/schedule'
import { BullModule } from '@nestjs/bull'
import { TerminusModule } from '@nestjs/terminus'
import { PrismaModule } from './common/prisma/prisma.module'
import { AuthModule } from './auth/auth.module'
import { UsersModule } from './users/users.module'
import { OrganizationsModule } from './organizations/organizations.module'
import { PropertiesModule } from './properties/properties.module'
import { UnitsModule } from './units/units.module'
import { TenantsModule } from './tenants/tenants.module'
import { LeasesModule } from './leases/leases.module'
import { InvoicesModule } from './invoices/invoices.module'
import { AccountingModule } from './accounting/accounting.module'
import { DepositsModule } from './deposits/deposits.module'
import { HealthModule } from './common/health/health.module'
import { DashboardModule } from './dashboard/dashboard.module'
import { MailModule } from './mail/mail.module'
import { NotificationsModule } from './notifications/notifications.module'
import { ReconciliationModule } from './reconciliation/reconciliation.module'
import { DocumentsModule } from './documents/documents.module'
import { ImportModule } from './import/import.module'
import { AiModule } from './ai/ai.module'
import { MaintenanceModule } from './maintenance/maintenance.module'
import { AviseringModule } from './avisering/avisering.module'
import { InspectionsModule } from './inspections/inspections.module'
import { MaintenancePlanModule } from './maintenance-plan/maintenance-plan.module'
import { ContractsModule } from './contracts/contracts.module'
import { TenantPortalModule } from './tenant-portal/tenant-portal.module'
import { NewsModule } from './news/news.module'
import { MessagesModule } from './messages/messages.module'
import { PlatformModule } from './platform/platform.module'

@Module({
  imports: [
    // Config
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),

    // Rate limiting
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: config.get<number>('THROTTLE_TTL', 60000),
            limit: config.get<number>('THROTTLE_LIMIT', 100),
          },
        ],
      }),
    }),

    // Task scheduling
    ScheduleModule.forRoot(),

    // Queue
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        redis: config.get<string>('REDIS_URL', 'redis://localhost:6379'),
      }),
    }),

    // Health checks
    TerminusModule,

    // Core
    PrismaModule,

    // Feature modules
    AuthModule,
    UsersModule,
    OrganizationsModule,
    PropertiesModule,
    UnitsModule,
    TenantsModule,
    LeasesModule,
    InvoicesModule,
    AccountingModule,
    DepositsModule,
    HealthModule,
    DashboardModule,
    MailModule,
    NotificationsModule,
    ReconciliationModule,
    DocumentsModule,
    ImportModule,
    AiModule,
    MaintenanceModule,
    AviseringModule,
    InspectionsModule,
    MaintenancePlanModule,
    ContractsModule,
    TenantPortalModule,
    NewsModule,
    MessagesModule,
    PlatformModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }, GlobalExceptionFilter],
})
export class AppModule {}
