import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { GlobalExceptionFilter } from './common/filters/global-exception.filter'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { validateEnv } from './config/env.validation'
import { PersonalNumberModule } from './common/crypto/personal-number.module'
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
import { HistoryModule } from './history/history.module'
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

    // Personnummer-kryptering (AES-256-GCM + HMAC-blind-index). @Global — skrivs
    // och läses i tenants, customers, leases, import, contracts, collections och
    // tenant-portal.
    PersonalNumberModule,

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

    // Task scheduling.
    //
    // Cron registreras BARA där jobben ska köras: i produktion, eller när en
    // utvecklare uttryckligen sätter CRON_ENABLED=true. En utvecklares
    // codespace ska aldrig fan-outa schemalagda jobb över alla organisationer.
    //
    // Bakgrund (2026-07-27): weekly-summary-cronen gör ett AI-anrop per org och
    // itererar ALLA orgar. Dev-databasen har 224 testorgar, så varje söndag
    // 18:00 — om dev-servern råkade vara igång — brändes ~17 kr i Anthropic-
    // krediter på sammanfattningar till skräpkonton. Eftersom dev och prod
    // delade API-nyckel drabbade det samma saldo som produktionen.
    //
    // Grinden gäller alla 23 @Cron-jobb, inte bara AI-jobben: backup, kravtrappa,
    // påminnelser och plattformsfakturering ska heller aldrig utlösas från en
    // utvecklingsmiljö mot delade externa resurser (R2, Resend, Anthropic).
    ...(process.env['NODE_ENV'] === 'production' || process.env['CRON_ENABLED'] === 'true'
      ? [ScheduleModule.forRoot()]
      : []),

    // Queue
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        redis: config.get<string>('REDIS_URL', 'redis://localhost:6379'),
        // ── STALL-BUDGETEN ────────────────────────────────────────────────
        //
        // `maxStalledCount` stod tidigare inte här alls, vilket betydde bulls
        // default 1 — och det talet är inte en oskyldig default.
        //
        // Ett jobb "stallar" när workern som höll det försvinner utan att
        // släppa låset: en deploy, en OOM, en krasch. Bull upptäcker det via
        // lockDuration 30 s + stalledInterval 30 s (alltså upp till ~60 s),
        // räknar upp jobbets `stalledCounter` och kör om det FRÅN BÖRJAN.
        //
        // Överstiger räknaren det här talet gör bull något annat: jobbet
        // flyttas rakt till `failed` med "job stalled more than allowable
        // limit" (moveStalledJobsToWait-7.lua:79-114). Den vägen FÖRBIGÅR
        // `attempts` och `backoff` helt — ingen retry, ingen backoff. Vår
        // `attempts: 5` på PDF-kön skyddar alltså inte mot ett avbrott.
        //
        // OCH — det som gör default 1 farlig — `stalledCounter` NOLLSTÄLLS
        // ALDRIG. `HINCRBY` är dess enda förekomst i hela biblioteket. Talet
        // är en LIVSTIDSBUDGET PER JOBB, inte per körning: ett jobb som en
        // deploy avbröt i mars bär räknaren kvar i juni, och nästa avbrott —
        // hur långt senare som helst — dödar det permanent.
        //
        // ── AVVÄGNINGEN, SOM MÅSTE STÅ HÄR OCH INTE BARA I EN PR-TEXT ─────
        //
        // `maxStalledCount` finns för att skydda mot ett jobb som DÖDAR SIN
        // WORKER — en payload som får processen att gå OOM och som annars
        // kraschloopar hela kön. Höjer vi talet får ett sådant jobb fler
        // chanser att göra det. Det är en verklig kostnad, inte en formalitet.
        //
        // Vi accepterar den av två belagda skäl:
        //
        //  1. Jobben är idempotenta. `claimRowForScan` returnerar null för en
        //     rad som redan är terminal, `RentNotice` har @@unique på
        //     (leaseId, year, month, type), och mejlen bär Resends
        //     Idempotency-Key. En omkörning gör inte om arbetet en andra gång.
        //  2. Den vanligaste stall-orsaken hos oss är bevisligen DEPLOY, inte
        //     krasch: 7–19 deployer per aktiv dag, och fram tills den här
        //     commiten dog processen på 26 ms utan att pausa köhämtningen.
        //
        // Slutar något av de två gälla är avvägningen fel och talet ska ned.
        //
        // ── VARFÖR 3 ──────────────────────────────────────────────────────
        //
        // `settings` här är global för alla sju köer, men producenterna har
        // olika `attempts` (3 för contract-scan och psd2-sync, 5 för mail,
        // pdf och lease-activation). Talet är därför MINIMUM av dem: då kan
        // ingen kös stall-budget överstiga dess felbudget.
        // check-graceful-shutdown.mjs härleder minimum UR KODEN och fäller om
        // de glider isär — sänks ett `attempts` till 2 blir CI röd här.
        settings: { maxStalledCount: 3 },
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
    HistoryModule,
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
