import { InjectQueue } from '@nestjs/bull'
import { Injectable, Logger } from '@nestjs/common'

import { QUEUE_AI_PAYMENT_SHADOW, type AiPaymentShadowJobPayload } from './payment-shadow.types'

import type { Queue, JobOptions } from 'bull'

/** Bull behåller färdiga/misslyckade jobb i 7 dygn för inspektion. */
const JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000

@Injectable()
export class AiPaymentShadowQueue {
  private readonly logger = new Logger(AiPaymentShadowQueue.name)

  constructor(
    @InjectQueue(QUEUE_AI_PAYMENT_SHADOW) private readonly queue: Queue<AiPaymentShadowJobPayload>,
  ) {}

  /**
   * `jobId` är HÄRLETT ur bankraden — samma konstruktion som `AiShadowQueue`.
   *
   * Kön är snabbvägen och sveparcronen är skyddsnätet; de kan mötas för samma
   * rad. Ett härlett jobId gör att Bull själv avvisar det andra jobbet så länge
   * det första ligger kvar, och det som ändå slinker igenom stoppas av det
   * partiella unika indexet i databasen. Två spärrar, i den ordningen, eftersom
   * bara den andra håller när Redis gallrat jobbet.
   */
  async enqueue(payload: AiPaymentShadowJobPayload): Promise<string> {
    const jobOptions: JobOptions = {
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { age: JOB_TTL_MS / 1000, count: 1000 },
      removeOnFail: { age: JOB_TTL_MS / 1000, count: 1000 },
      jobId: `shadow-tx-${payload.bankTransactionId}`,
    }
    const job = await this.queue.add(payload, jobOptions)
    this.logger.log(`Enqueued ai-payment-shadow jobId=${job.id} tx=${payload.bankTransactionId}`)
    return String(job.id)
  }
}
