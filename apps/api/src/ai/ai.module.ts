import { Module } from '@nestjs/common'
import { AiAssistantController } from './ai-assistant.controller'
import { AiAssistantService } from './ai-assistant.service'
import { DataContextService } from './data-context.service'
import { ToolExecutorService } from './tools/tool-executor.service'
import { MemoryService } from './memory.service'
import { PortfolioAnalysisService } from './portfolio-analysis.service'
import { TenantAiController } from './tenant-ai.controller'
import { TenantAiService } from './tenant-ai.service'
import { TenantToolExecutorService } from './tools/tenant-tool-executor.service'
import { AiUsageModule } from './usage/ai-usage.module'
import { AiAuditService } from './audit/ai-audit.service'
import { PrismaModule } from '../common/prisma/prisma.module'
import { InvoicesModule } from '../invoices/invoices.module'
import { TenantsModule } from '../tenants/tenants.module'
import { LeasesModule } from '../leases/leases.module'
import { PropertiesModule } from '../properties/properties.module'
import { UnitsModule } from '../units/units.module'
import { AccountingModule } from '../accounting/accounting.module'
import { MailModule } from '../mail/mail.module'
import { MaintenanceModule } from '../maintenance/maintenance.module'
import { AviseringModule } from '../avisering/avisering.module'
import { InspectionsModule } from '../inspections/inspections.module'
import { MaintenancePlanModule } from '../maintenance-plan/maintenance-plan.module'
import { ReconciliationModule } from '../reconciliation/reconciliation.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { CollectionsModule } from '../collections/collections.module'
import { TenantPortalModule } from '../tenant-portal/tenant-portal.module'

@Module({
  imports: [
    PrismaModule,
    AiUsageModule,
    InvoicesModule,
    TenantsModule,
    LeasesModule,
    PropertiesModule,
    UnitsModule,
    AccountingModule,
    MailModule,
    MaintenanceModule,
    AviseringModule,
    InspectionsModule,
    MaintenancePlanModule,
    ReconciliationModule,
    NotificationsModule,
    CollectionsModule,
    TenantPortalModule,
  ],
  controllers: [AiAssistantController, TenantAiController],
  providers: [
    AiAssistantService,
    DataContextService,
    ToolExecutorService,
    MemoryService,
    PortfolioAnalysisService,
    AiAuditService,
    TenantAiService,
    TenantToolExecutorService,
  ],
  exports: [AiAssistantService, AiAuditService],
})
export class AiModule {}
