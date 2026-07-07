import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { GlobalExceptionFilter } from './common/filters/global-exception.filter'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { validateEnv } from './config/env.validation'
import { ThrottlerModule } from '@nestjs/throttler'
import { UserOrIpThrottlerGuard } from './common/throttler/user-or-ip.throttler-guard'
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
import { CustomersModule } from './customers/customers.module'
import { LeasesModule } from './leases/leases.module'
import { InvoicesModule } from './invoices/invoices.module'
import { AccountingModule } from './accounting/accounting.module'
import { DepositsModule } from './deposits/deposits.module'
import { KeysModule } from './keys/keys.module'
import { ConsumptionModule } from './consumption/consumption.module'
import { MiscChargeModule } from './misc-charges/misc-charge.module'
import { RentIncreasesModule } from './rent-increases/rent-increases.module'
import { HealthModule } from './common/health/health.module'
import { DashboardModule } from './dashboard/dashboard.module'
import { MailModule } from './mail/mail.module'
import { NotificationsModule } from './notifications/notifications.module'
import { ReconciliationModule } from './reconciliation/reconciliation.module'
import { CollectionsModule } from './collections/collections.module'
import { DocumentsModule } from './documents/documents.module'
import { ImportModule } from './import/import.module'
import { AiModule } from './ai/ai.module'
import { MaintenanceModule } from './maintenance/maintenance.module'
import { AviseringModule } from './avisering/avisering.module'
import { InspectionsModule } from './inspections/inspections.module'
import { MaintenancePlanModule } from './maintenance-plan/maintenance-plan.module'
import { ContractsModule } from './contracts/contracts.module'
import { TerminationsModule } from './terminations/terminations.module'
import { TenantPortalModule } from './tenant-portal/tenant-portal.module'
import { NewsModule } from './news/news.module'
import { MessagesModule } from './messages/messages.module'
import { PlatformModule } from './platform/platform.module'
import { StorageModule } from './storage/storage.module'
import { OcrModule } from './common/ocr/ocr.module'
import { RedisModule } from './common/redis/redis.module'
import { PdfQueueModule } from './pdf-jobs/pdf-queue.module'
import { AiUsagePageModule } from './ai-usage/ai-usage.module'
import { PublicPlansModule } from './public/public-plans.module'
import { WebhooksModule } from './webhooks/webhooks.module'
import { BackupModule } from './backup/backup.module'
import { SigningModule } from './signing/signing.module'
import { Psd2Module } from './psd2/psd2.module'

@Module({
  imports: [
    // Config
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env', validate: validateEnv }),

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
    StorageModule,
    OcrModule,
    RedisModule,
    PdfQueueModule,

    // Feature modules
    AuthModule,
    UsersModule,
    OrganizationsModule,
    PropertiesModule,
    UnitsModule,
    TenantsModule,
    CustomersModule,
    LeasesModule,
    InvoicesModule,
    AccountingModule,
    DepositsModule,
    KeysModule,
    ConsumptionModule,
    MiscChargeModule,
    RentIncreasesModule,
    HealthModule,
    DashboardModule,
    MailModule,
    NotificationsModule,
    ReconciliationModule,
    CollectionsModule,
    DocumentsModule,
    ImportModule,
    AiModule,
    MaintenanceModule,
    AviseringModule,
    InspectionsModule,
    MaintenancePlanModule,
    ContractsModule,
    TerminationsModule,
    TenantPortalModule,
    NewsModule,
    MessagesModule,
    PlatformModule,
    AiUsagePageModule,
    PublicPlansModule,
    WebhooksModule,
    BackupModule,
    SigningModule,
    Psd2Module,
  ],
  providers: [{ provide: APP_GUARD, useClass: UserOrIpThrottlerGuard }, GlobalExceptionFilter],
})
export class AppModule {}
