import { InjectQueue } from '@nestjs/bull'
import { Injectable, Logger } from '@nestjs/common'
import type { Queue, JobOptions } from 'bull'

export const CONTRACT_SCAN_BATCH_QUEUE = 'contract-scan-batch'

/**
 * Ett jobb per rad i en batch. Payloaden bär ENDAST ID:n (inga Buffrar) — den
 * råa PDF:en hämtas från DB av workern när jobbet körs, samma princip som
 * pdf-kön. En rad skannas asynkront av den härdade ContractScannerService.
 */
export interface ContractScanRowJob {
  rowId: string
  organizationId: string
}

// Bull behåller färdiga/misslyckade jobb i 7 dygn för inspektion/replay
// (samma som pdf- och lease-activation-köerna).
const JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Producer för kontraktsskannings-kön. ContractScanBatchService enqueuear en
 * rad per uppladdad PDF efter att batch-taket passerats.
 *
 * Workern är idempotent (re-läser raden, hoppar över redan terminala rader),
 * men vi sätter ändå ett `jobId` per rad så att en oavsiktlig dubbel-enqueue
 * av samma rad dedupas av Bull.
 */
@Injectable()
export class ContractScanBatchQueue {
  private readonly logger = new Logger(ContractScanBatchQueue.name)

  constructor(
    @InjectQueue(CONTRACT_SCAN_BATCH_QUEUE)
    private readonly queue: Queue<ContractScanRowJob>,
  ) {}

  async enqueueRow(payload: ContractScanRowJob): Promise<string> {
    const jobOptions: JobOptions = {
      // Vision-skanning är dyr — färre försök än PDF-rendering. Transienta
      // Anthropic-fel (429/529) retras med exponentiell backoff.
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { age: JOB_TTL_MS / 1000, count: 1000 },
      removeOnFail: { age: JOB_TTL_MS / 1000, count: 1000 },
      jobId: `scan-row-${payload.rowId}`,
    }
    const job = await this.queue.add(payload, jobOptions)
    this.logger.log(`Enqueued contract-scan row jobId=${job.id} row=${payload.rowId}`)
    return String(job.id)
  }
}
