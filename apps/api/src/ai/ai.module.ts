import { Module } from '@nestjs/common'
import { AiAssistantController } from './ai-assistant.controller'
import { AiAssistantService } from './ai-assistant.service'
import { DataContextService } from './data-context.service'
import { ToolExecutorService } from './tools/tool-executor.service'
import { MemoryService } from './memory.service'
import { PortfolioAnalysisService } from './portfolio-analysis.service'
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
  ],
  controllers: [AiAssistantController],
  providers: [
    AiAssistantService,
    DataContextService,
    ToolExecutorService,
    MemoryService,
    PortfolioAnalysisService,
    AiAuditService,
  ],
  exports: [AiAssistantService, AiAuditService],
})
export class AiModule {}
