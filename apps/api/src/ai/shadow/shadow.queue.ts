import { InjectQueue } from '@nestjs/bull'
import { Injectable, Logger } from '@nestjs/common'

import { QUEUE_AI_SHADOW, type AiShadowJobPayload } from './shadow.types'

import type { Queue, JobOptions } from 'bull'

/** Bull behåller färdiga/misslyckade jobb i 7 dygn för inspektion. */
const JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000

@Injectable()
export class AiShadowQueue {
  private readonly logger = new Logger(AiShadowQueue.name)

  constructor(@InjectQueue(QUEUE_AI_SHADOW) private readonly queue: Queue<AiShadowJobPayload>) {}

  /**
   * `jobId` är HÄRLETT ur ärendet, och det är inte en optimering.
   *
   * Kön är snabbvägen och sveparcronen är skyddsnätet; de kan mötas för samma
   * ärende. Ett härlett jobId gör att Bull själv avvisar det andra jobbet så
   * länge det första ligger kvar — och det som ändå slinker igenom stoppas av
   * det partiella unika indexet i databasen. Två spärrar, i den ordningen,
   * eftersom bara den andra håller när Redis gallrat jobbet.
   */
  async enqueue(payload: AiShadowJobPayload): Promise<string> {
    const jobOptions: JobOptions = {
      // TRE FÖRSÖK, inte fem. Ett skuggförslag är inte kritiskt, och en
      // modellkörning som fallerar tre gånger fallerar sannolikt av ett skäl
      // fler försök inte löser. Sveparcronen tar det som blir kvar.
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { age: JOB_TTL_MS / 1000, count: 1000 },
      removeOnFail: { age: JOB_TTL_MS / 1000, count: 1000 },
      jobId: `shadow-ticket-${payload.ticketId}`,
    }
    const job = await this.queue.add(payload, jobOptions)
    this.logger.log(`Enqueued ai-shadow jobId=${job.id} ticket=${payload.ticketId}`)
    return String(job.id)
  }
}
