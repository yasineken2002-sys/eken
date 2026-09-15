import { BullModule } from '@nestjs/bull'
import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { AiUsageModule } from '../ai/usage/ai-usage.module'
import { ContractsModule } from '../contracts/contracts.module'
import { StorageModule } from '../storage/storage.module'
import { LeasesModule } from '../leases/leases.module'
import { ImportController } from './import.controller'
import { ContractBatchController } from './contract-batch.controller'
import { ImportService } from './import.service'
import { ContractScannerService } from './contract-scanner.service'
import { ContractArchiveService } from './contract-archive.service'
import { ContractScanBatchService } from './contract-scan-batch.service'
import { ContractScanBatchQueue, CONTRACT_SCAN_BATCH_QUEUE } from './contract-scan-batch.queue'
import { ContractScanBatchWorker } from './contract-scan-batch.worker'
import { LEASE_CREATOR } from './lease-creator.token'
import { LeasesService } from '../leases/leases.service'
import { pausedUnless } from '../common/ops/automation-pause'

/**
 * DRIFTPAUS: `pausedUnless` UTELÄMNAR konsumenten ur `providers` när
 * OPS_AUTOMATION_PAUSED=true. Det är strukturellt och inte en flagga i
 * jobbkroppen: `BullExplorer.onModuleInit` anropar `queue.process(...)` för
 * varje upptäckt @Processor-provider (bull.explorer.js), så en konsument som
 * aldrig registreras kan aldrig plocka ett jobb — inte heller det första, innan
 * någon kontroll hunnit köra.
 *
 * KÖN SJÄLV REGISTRERAS SOM VANLIGT. Producenter (`*.queue.ts`) fungerar därför
 * oförändrat, och waiting/delayed-jobb blir kvar i Redis i stället för att tappas
 * eller kvitteras. Pausen stoppar KONSUMTIONEN, den tömmer ingenting.
 */
@Module({
  imports: [
    PrismaModule,
    AiUsageModule,
    ContractsModule,
    LeasesModule,
    StorageModule,
    BullModule.registerQueue({ name: CONTRACT_SCAN_BATCH_QUEUE }),
  ],
  controllers: [ImportController, ContractBatchController],
  providers: [
    ImportService,
    ContractScannerService,
    ContractArchiveService,
    ContractScanBatchService,
    ContractScanBatchQueue,
    ...pausedUnless(ContractScanBatchWorker),
    // Bind den smala LeaseCreator-token till den riktiga LeasesService.
    { provide: LEASE_CREATOR, useExisting: LeasesService },
  ],
})
export class ImportModule {}
