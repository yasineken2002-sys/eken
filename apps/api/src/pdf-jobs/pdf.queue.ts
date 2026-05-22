import { InjectQueue } from '@nestjs/bull'
import { Injectable, Logger } from '@nestjs/common'
import type { Queue, JobOptions } from 'bull'
import { type PdfJobPayload, QUEUE_PDF } from './pdf.types'

// Bull behåller färdiga/misslyckade jobb i 7 dygn för inspektion/replay.
const JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Producer för PDF-kön. Send/bulk-flöden delegerar all enqueue:ing hit.
 *
 * Workern (PdfWorker) är idempotent — varje jobbtyp re-läser sin entitet och
 * hoppar över redan utfört arbete — så vi sätter medvetet inget statiskt
 * jobId: en användare ska kunna trigga om ett misslyckat utskick.
 */
@Injectable()
export class PdfQueue {
  private readonly logger = new Logger(PdfQueue.name)

  constructor(@InjectQueue(QUEUE_PDF) private readonly queue: Queue<PdfJobPayload>) {}

  async enqueue(payload: PdfJobPayload): Promise<string> {
    const jobOptions: JobOptions = {
      attempts: 5,
      // Exponentiell backoff: 1m → 2m → 4m → 8m → permanent fail. Samma
      // mönster som mail-kön (mail.queue.ts).
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { age: JOB_TTL_MS / 1000, count: 1000 },
      removeOnFail: { age: JOB_TTL_MS / 1000, count: 1000 },
    }

    const job = await this.queue.add(payload, jobOptions)
    this.logger.log(`Enqueued pdf job id=${job.id} kind=${payload.kind}`)
    return String(job.id)
  }
}
