import { InjectQueue } from '@nestjs/bull'
import { Injectable, Logger } from '@nestjs/common'
import type { Queue, JobOptions } from 'bull'

export const PSD2_SYNC_QUEUE = 'psd2-sync'

// Ett jobb = en org-synk-cykel (FIX4-mönstret: aldrig en in-process-loop över
// alla orgar). Per-org-isolering — org A:s döda samtycke stoppar inte B–Z.
export interface Psd2SyncJob {
  organizationId: string
}

const JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Producer för PSD2-sync-kön. En org i taget. `jobId` per org dedupar en
 * oavsiktlig dubbel-enqueue (t.ex. cron + manuell trigger samtidigt).
 */
@Injectable()
export class Psd2SyncQueue {
  private readonly logger = new Logger(Psd2SyncQueue.name)

  constructor(
    @InjectQueue(PSD2_SYNC_QUEUE)
    private readonly queue: Queue<Psd2SyncJob>,
  ) {}

  async enqueueOrgSync(organizationId: string): Promise<string> {
    const jobOptions: JobOptions = {
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { age: JOB_TTL_MS / 1000, count: 1000 },
      removeOnFail: { age: JOB_TTL_MS / 1000, count: 1000 },
      jobId: `psd2-sync-${organizationId}`,
    }
    const job = await this.queue.add({ organizationId }, jobOptions)
    this.logger.log(`Enqueued psd2-sync jobId=${job.id} org=${organizationId}`)
    return String(job.id)
  }
}
