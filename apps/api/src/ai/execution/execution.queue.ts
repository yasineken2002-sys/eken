import { InjectQueue } from '@nestjs/bull'
import { Injectable, Logger } from '@nestjs/common'

import { QUEUE_AI_AGENT_EXECUTION, type AiAgentExecutionJobPayload } from './execution.types'

import type { Queue, JobOptions } from 'bull'

/** Bull behåller färdiga/misslyckade jobb i 7 dygn. Samma som de två andra köerna. */
const JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * EGEN KÖ, INTE EN GREN I TORRLÄGETS.
 *
 * Torrlägets jobb läser databasen och är ofarligt; det här jobbet SKRIVER i
 * kundens data. Delade de kö hade en enda backoff-kurva fått gälla för båda, och
 * ett omförsök av en dom hade sett likadant ut som ett omförsök av en effekt.
 *
 * ── ETT FÖRSÖK, INTE TRE ────────────────────────────────────────────────────
 *
 * Torrlägets kö gör tre försök, därför att en misslyckad läsning kan lyckas
 * nästa gång och ingenting har hänt under tiden. Här är det motsatt: ett jobb
 * som kastade kan mycket väl ha hunnit orsaka en HALV effekt, och ett automatiskt
 * omförsök är då en andra körning av något ingen vet utfallet av.
 *
 * Anspråket (`executionStartedAt`) skulle visserligen avvisa den — men att luta
 * sig mot det vore att låta köns inställning bero på en kolumn i en annan fil.
 * Ett försök, och sveparpasset plockar upp det som blev kvar och som fortfarande
 * saknar terminalstatus.
 */
@Injectable()
export class AiAgentExecutionQueue {
  private readonly logger = new Logger(AiAgentExecutionQueue.name)

  constructor(
    @InjectQueue(QUEUE_AI_AGENT_EXECUTION)
    private readonly queue: Queue<AiAgentExecutionJobPayload>,
  ) {}

  async enqueue(payload: AiAgentExecutionJobPayload): Promise<string> {
    const jobOptions: JobOptions = {
      attempts: 1,
      removeOnComplete: { age: JOB_TTL_MS / 1000, count: 1000 },
      removeOnFail: { age: JOB_TTL_MS / 1000, count: 1000 },
      // HÄRLETT JOB-ID, samma skäl som i de två andra köerna: sveparpasset och
      // en direktköning kan mötas för samma rad.
      jobId: `exec-assignment-${payload.assignmentId}`,
    }
    const job = await this.queue.add(payload, jobOptions)
    this.logger.log(
      `Enqueued ai-agent-execution jobId=${job.id} assignment=${payload.assignmentId}`,
    )
    return String(job.id)
  }
}
