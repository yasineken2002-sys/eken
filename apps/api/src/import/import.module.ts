import { BullModule } from '@nestjs/bull'
import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { AiUsageModule } from '../ai/usage/ai-usage.module'
import { ContractsModule } from '../contracts/contracts.module'
import { ImportController } from './import.controller'
import { ContractBatchController } from './contract-batch.controller'
import { ImportService } from './import.service'
import { ContractScannerService } from './contract-scanner.service'
import { ContractScanBatchService } from './contract-scan-batch.service'
import { ContractScanBatchQueue, CONTRACT_SCAN_BATCH_QUEUE } from './contract-scan-batch.queue'
import { ContractScanBatchWorker } from './contract-scan-batch.worker'

@Module({
  imports: [
    PrismaModule,
    AiUsageModule,
    ContractsModule,
    BullModule.registerQueue({ name: CONTRACT_SCAN_BATCH_QUEUE }),
  ],
  controllers: [ImportController, ContractBatchController],
  providers: [
    ImportService,
    ContractScannerService,
    ContractScanBatchService,
    ContractScanBatchQueue,
    ContractScanBatchWorker,
  ],
})
export class ImportModule {}
