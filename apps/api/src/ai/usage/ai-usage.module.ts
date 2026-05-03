import { Module } from '@nestjs/common'
import { PrismaModule } from '../../common/prisma/prisma.module'
import { AiUsageService } from './ai-usage.service'
import { AiQuotaService } from './ai-quota.service'

/**
 * Liten modul som exporterar bara usage/quota-services. Importeras av
 * Import- och Inspections-modulerna som behöver logga AI-anrop utan att
 * dra in hela AiModule (vilket skulle skapa cirkulära beroenden).
 */
@Module({
  imports: [PrismaModule],
  providers: [AiUsageService, AiQuotaService],
  exports: [AiUsageService, AiQuotaService],
})
export class AiUsageModule {}
