import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { PrismaModule } from '../common/prisma/prisma.module'
import { InvoicesModule } from '../invoices/invoices.module'
import { AiUsageModule } from '../ai/usage/ai-usage.module'
import { InspectionsController } from './inspections.controller'
import { InspectionsService } from './inspections.service'
import { InspectionAnalyzerService } from './inspection-analyzer.service'

@Module({
  imports: [ConfigModule, PrismaModule, InvoicesModule, AiUsageModule],
  controllers: [InspectionsController],
  providers: [InspectionsService, InspectionAnalyzerService],
  exports: [InspectionsService],
})
export class InspectionsModule {}
