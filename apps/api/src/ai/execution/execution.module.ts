import { BullModule } from '@nestjs/bull'
import { Global, Module } from '@nestjs/common'

import { CronErrorSinkModule } from '../../common/cron/cron-error-sink.module'
import { PrismaModule } from '../../common/prisma/prisma.module'
import { RedisModule } from '../../common/redis/redis.module'
import { DelegationModule } from '../delegation/delegation.module'
import { AiModule } from '../ai.module'
import { AiAgentExecutionQueue } from './execution.queue'
import { AiAgentExecutionService } from './agent-execution.service'
import { AiAgentExecutionSweepService } from './execution-sweep.service'
import { AiAgentExecutionWorker } from './execution.worker'
import { QUEUE_AI_AGENT_EXECUTION } from './execution.types'

/**
 * SKARPT LÄGE (etapp 9).
 *
 * ── DEN HÄR MODULEN IMPORTERAR VERKTYGSEXEKVERAREN, OCH DET ÄR MENINGEN ─────
 *
 * `AiExecutionDryRunModule` gör det uttryckligen INTE — dess garanti är att
 * ingen kodväg där kan nå en effekt, och den garantin bärs av att beroendet
 * saknas. Den raden ska stå kvar orörd.
 *
 * Skarpt läge är den PR:en dess docblock pekade fram emot: *"Den dag skarpt läge
 * byggs är det den PR:en som lägger till importen — och då ska raden granskas
 * för vad den är, i stället för att redan ligga där."* Importen ligger här, i en
 * egen modul, så att gränsen mellan "kan inte" och "får" går mellan två filer
 * och inte inne i en.
 *
 * ── `@Global` AV SAMMA SKÄL SOM DE TVÅ ANDRA ────────────────────────────────
 *
 * Och samma fälla: `@Global` gör modulens EGNA exporter globala, inte dess
 * beroenden. Alla fem importeras därför uttryckligen. Felet syns inte i ett enda
 * enhetsprov — de konstruerar tjänsterna för hand — utan i att API:t inte
 * startar. `AiShadowModule` och torrläget bär samma not; att den behövts tre
 * gånger säger att den är rätt.
 */
@Global()
@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_AI_AGENT_EXECUTION }),
    DelegationModule,
    AiModule,
    PrismaModule,
    RedisModule,
    CronErrorSinkModule,
  ],
  providers: [
    AiAgentExecutionService,
    AiAgentExecutionQueue,
    AiAgentExecutionWorker,
    AiAgentExecutionSweepService,
  ],
  exports: [AiAgentExecutionService, AiAgentExecutionQueue],
})
export class AiAgentExecutionModule {}
