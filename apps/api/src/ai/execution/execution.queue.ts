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
 * ── TRE FÖRSÖK, OCH ANSPRÅKET ÄR DET SOM SKYDDAR ────────────────────────────
 *
 * Här stod först `attempts: 1`, med motiveringen att ett omförsök vore en andra
 * körning av något ingen vet utfallet av, och att det vore fel att luta sig mot
 * anspråket i en annan fil.
 *
 * `check-graceful-shutdown` R3 fällde det, och hade rätt av ett skäl som gjorde
 * hela resonemanget ogiltigt: **`maxStalledCount` är GLOBAL** för alla köer
 * (`app.module.ts`) och står på 3. Ett jobb som STALLAR — workern dog, låset
 * gick ut — återlevereras alltså upp till tre gånger oavsett vad `attempts`
 * säger. `attempts: 1` gav mig ingen extra säkerhet; den gav mig en ILLUSION av
 * den, och gjorde dessutom stall-budgeten större än felbudgeten.
 *
 * Det som faktiskt hindrar en andra effekt är anspråket
 * (`AiAssignment.executionStartedAt`, ett villkorat `updateMany`) — och det
 * MÅSTE vara så, eftersom den globala inställningen redan kan återleverera.
 * Talet följer därför minimum, och skyddet står där det hör hemma.
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
      // FÖLJER MINIMUM — se docblocket. Talet är bundet till den globala
      // `maxStalledCount`, inte fritt valt.
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
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
