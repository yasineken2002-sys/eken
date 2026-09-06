import { InjectQueue } from '@nestjs/bull'
import { Injectable, Logger } from '@nestjs/common'

import { QUEUE_AI_EXECUTION_DRYRUN, type AiExecutionDryRunJobPayload } from './dryrun.types'

import type { Queue, JobOptions } from 'bull'

/** Bull behåller färdiga/misslyckade jobb i 7 dygn för inspektion. Samma som skuggkön. */
const JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * EGEN KÖ, INTE EN GREN I SKUGGKÖN.
 *
 * De två gör olika saker och kostar olika mycket: skuggkörningen anropar
 * modellen (dyrt, kvotat, kan fallera på leverantören), domen läser databasen
 * (billigt, deterministiskt). Delade de kö hade en modellstörning stoppat även
 * bedömningen av förslag som redan finns — och en enda backoff-kurva hade fått
 * gälla två helt olika sorters fel.
 */
@Injectable()
export class AiExecutionDryRunQueue {
  private readonly logger = new Logger(AiExecutionDryRunQueue.name)

  constructor(
    @InjectQueue(QUEUE_AI_EXECUTION_DRYRUN)
    private readonly queue: Queue<AiExecutionDryRunJobPayload>,
  ) {}

  /**
   * `jobId` är HÄRLETT ur uppdraget, av samma skäl som i skuggkön: kön är
   * snabbvägen och sveparcronen skyddsnätet, och de kan mötas för samma rad.
   * Bull avvisar då det andra jobbet så länge det första ligger kvar, och det
   * som ändå slinker igenom stoppas av att tjänsten inte bedömer om en rad som
   * redan har en dom.
   */
  async enqueue(payload: AiExecutionDryRunJobPayload): Promise<string> {
    const jobOptions: JobOptions = {
      // TRE FÖRSÖK. Domen är en databasläsning; fallerar den tre gånger är det
      // inte något fler försök löser. Sveparcronen tar det som blir kvar.
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { age: JOB_TTL_MS / 1000, count: 1000 },
      removeOnFail: { age: JOB_TTL_MS / 1000, count: 1000 },
      jobId: `dryrun-assignment-${payload.assignmentId}`,
    }
    const job = await this.queue.add(payload, jobOptions)
    this.logger.log(
      `Enqueued ai-execution-dryrun jobId=${job.id} assignment=${payload.assignmentId}`,
    )
    return String(job.id)
  }
}
