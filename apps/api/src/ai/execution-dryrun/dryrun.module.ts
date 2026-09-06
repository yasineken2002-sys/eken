import { BullModule } from '@nestjs/bull'
import { Global, Module } from '@nestjs/common'

import { DelegationModule } from '../delegation/delegation.module'
import { AiExecutionDryRunQueue } from './dryrun.queue'
import { AiExecutionDryRunSweepService } from './dryrun-sweep.service'
import { AiExecutionDryRunWorker } from './dryrun.worker'
import { AiExecutionDryRunService } from './execution-dryrun.service'
import { QUEUE_AI_EXECUTION_DRYRUN } from './dryrun.types'

/**
 * TORRLÄGET (etapp 8, PR 1).
 *
 * ── MODULEN IMPORTERAR INTE VERKTYGSEXEKVERAREN, OCH DET ÄR SPÄRREN ────────
 *
 * `AiToolsModule`/`ToolExecutorService` står medvetet inte i `imports`. Det är
 * inte en glömska att fylla i senare: så länge beroendet saknas kan ingen kodväg
 * här nå en effekt, oavsett vad någon skriver i en tjänst. Samma konstruktion
 * som `Psd2Module`, som aldrig får importera `AccountingModule`.
 *
 * Den dag skarpt läge byggs är det den PR:en som lägger till importen — och då
 * ska raden granskas för vad den är, i stället för att redan ligga där.
 *
 * ── `@Global` AV SAMMA SKÄL SOM SKUGGKÖN ──────────────────────────────────
 *
 * Skuggproducenten ska kunna köa en dom utan att `AiShadowModule` importerar
 * torrläget. Riktningen spelar roll: producenten får inte bli beroende av
 * bedömningen — ett förslag ska skrivas även när domen inte går att köa, och
 * `enqueueSafely` ser till att den inte kan kasta.
 *
 * Notera vad `@Global` INTE gör: den gör modulens EGNA exporter globala, inte
 * dess beroenden. Modulen måste importera `DelegationModule` som alla andra.
 */
@Global()
@Module({
  imports: [BullModule.registerQueue({ name: QUEUE_AI_EXECUTION_DRYRUN }), DelegationModule],
  providers: [
    AiExecutionDryRunService,
    AiExecutionDryRunQueue,
    AiExecutionDryRunWorker,
    AiExecutionDryRunSweepService,
  ],
  exports: [AiExecutionDryRunService, AiExecutionDryRunQueue],
})
export class AiExecutionDryRunModule {}
