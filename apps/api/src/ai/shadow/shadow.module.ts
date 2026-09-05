import { BullModule } from '@nestjs/bull'
import { Global, Module } from '@nestjs/common'

import { CronErrorSinkModule } from '../../common/cron/cron-error-sink.module'
import { PrismaModule } from '../../common/prisma/prisma.module'
import { RedisModule } from '../../common/redis/redis.module'
import { HistoryModule } from '../../history/history.module'
import { AiUsageModule } from '../usage/ai-usage.module'
import { MaintenanceShadowService } from './maintenance-shadow.service'
import { ShadowOutcomeService } from './shadow-outcome.service'
import { AiShadowQueue } from './shadow.queue'
import { AiShadowSweepService } from './shadow-sweep.service'
import { AiShadowWorker } from './shadow.worker'
import { QUEUE_AI_SHADOW } from './shadow.types'

/**
 * SKUGGLÄGET (etapp 6).
 *
 * `@Global` av samma skäl som `PdfQueueModule`: `MaintenanceService` ska kunna
 * injicera kön utan att `MaintenanceModule` importerar AI-lagret. Den riktningen
 * spelar roll — maintenance får inte bli beroende av AI:n, bara AI:n av
 * maintenance.
 *
 * ── MODULEN IMPORTERAR INTE ToolExecutorService, OCH DET ÄR STRUKTURELLT ─────
 *
 * Skuggläget UTFÖR ingenting. Det är inte en flagga som kan flippas utan en
 * frånvarande kodväg: ingen fil under `ai/shadow/` importerar exekveraren, och
 * modulen ger den inte heller. `shadow-no-execution.db.spec.ts` mäter samma sak
 * åt andra hållet — noll `AiToolExecution` före och efter en körning.
 */
@Global()
@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_AI_SHADOW }),
    HistoryModule,
    AiUsageModule,
    // ── DE TRE SVEPET BEHÖVER, OCH VARFÖR DE STÅR HÄR ─────────────────────
    // `PrismaModule` (frågorna), `RedisModule` (LockService) och
    // `CronErrorSinkModule` (den varaktiga felsänkan). Att `@Global()` gör
    // MODULENS EGNA exporter globala betyder inte att den ärver andras — en
    // global modul måste importera sina beroenden som alla andra.
    //
    // Felet syntes inte i ett enda enhetsprov: de konstruerar tjänsterna för
    // hand. Det var E2E som fällde det, med "Nest can't resolve dependencies",
    // alltså ett API som inte ens STARTAR. Värt att minnas nästa gång någon
    // undrar vad E2E-jobbet är värt.
    PrismaModule,
    RedisModule,
    CronErrorSinkModule,
  ],
  providers: [
    AiShadowQueue,
    AiShadowWorker,
    MaintenanceShadowService,
    AiShadowSweepService,
    ShadowOutcomeService,
  ],
  exports: [AiShadowQueue, MaintenanceShadowService, ShadowOutcomeService],
})
export class AiShadowModule {}
