import { BullModule } from '@nestjs/bull'
import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { AiUsageModule } from '../ai/usage/ai-usage.module'
import { ContractsModule } from '../contracts/contracts.module'
import { LeasesModule } from '../leases/leases.module'
import { ImportController } from './import.controller'
import { ContractBatchController } from './contract-batch.controller'
import { ImportService } from './import.service'
import { ContractScannerService } from './contract-scanner.service'
import { ContractScanBatchService } from './contract-scan-batch.service'
import { ContractScanBatchQueue, CONTRACT_SCAN_BATCH_QUEUE } from './contract-scan-batch.queue'
import { ContractScanBatchWorker } from './contract-scan-batch.worker'
import { LEASE_CREATOR } from './lease-creator.token'
import { LeasesService } from '../leases/leases.service'

@Module({
  imports: [
    PrismaModule,
    AiUsageModule,
    ContractsModule,
    LeasesModule,
    BullModule.registerQueue({ name: CONTRACT_SCAN_BATCH_QUEUE }),
  ],
  controllers: [ImportController, ContractBatchController],
  providers: [
    ImportService,
    ContractScannerService,
    ContractScanBatchService,
    ContractScanBatchQueue,
    ContractScanBatchWorker,
    // Bind den smala LeaseCreator-token till den riktiga LeasesService.
    { provide: LEASE_CREATOR, useExisting: LeasesService },
  ],
})
export class ImportModule {}
