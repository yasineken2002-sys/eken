import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { AiUsageModule } from '../ai/usage/ai-usage.module'
import { ContractsModule } from '../contracts/contracts.module'
import { ImportController } from './import.controller'
import { ImportService } from './import.service'
import { ContractScannerService } from './contract-scanner.service'

@Module({
  imports: [PrismaModule, AiUsageModule, ContractsModule],
  controllers: [ImportController],
  providers: [ImportService, ContractScannerService],
})
export class ImportModule {}
