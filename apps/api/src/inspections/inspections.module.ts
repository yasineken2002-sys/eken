import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { PrismaModule } from '../common/prisma/prisma.module'
import { InvoicesModule } from '../invoices/invoices.module'
import { AiUsageModule } from '../ai/usage/ai-usage.module'
import { InspectionsController } from './inspections.controller'
import { InspectionsService } from './inspections.service'
import { InspectionAnalyzerService } from './inspection-analyzer.service'
import { InspectionImageIntegrityService } from './inspection-image-integrity.service'

@Module({
  imports: [ConfigModule, PrismaModule, InvoicesModule, AiUsageModule],
  controllers: [InspectionsController],
  providers: [InspectionsService, InspectionAnalyzerService, InspectionImageIntegrityService],
  // Bildkontrollen exporteras därför att hyresgästportalen ställer SAMMA fråga
  // om SAMMA bilaga. Två kopior av jämförelsen hade varit två tillfällen att
  // svara olika om exakt det som ska gå att lita på.
  exports: [InspectionsService, InspectionImageIntegrityService],
})
export class InspectionsModule {}
