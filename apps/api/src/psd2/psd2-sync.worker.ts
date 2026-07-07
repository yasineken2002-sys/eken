import { Process, Processor } from '@nestjs/bull'
import { Injectable, Logger } from '@nestjs/common'
import type { Job } from 'bull'
import { Psd2SyncService } from './psd2-sync.service'
import { PSD2_SYNC_QUEUE, type Psd2SyncJob } from './psd2-sync.queue'

// En org i taget räcker — synken är I/O-bunden (bank-API) och per-org isolerad.
const CONCURRENCY = 2

/**
 * Worker för PSD2-sync-kön. Ett jobb = en org-synk-cykel. All logik ligger i den
 * flagg-agnostiska Psd2SyncService; workern är bara transporten. När PSD2_ENABLED
 * är av väljer DI-factoryn Stub-providern → syncOrganization kastar 503 om ett
 * jobb ändå skulle köras (inget jobb enqueueas i inaktivt läge).
 */
@Injectable()
@Processor(PSD2_SYNC_QUEUE)
export class Psd2SyncWorker {
  private readonly logger = new Logger(Psd2SyncWorker.name)

  constructor(private readonly sync: Psd2SyncService) {}

  @Process({ concurrency: CONCURRENCY })
  async handle(job: Job<Psd2SyncJob>): Promise<void> {
    const { organizationId } = job.data
    const attempt = job.attemptsMade + 1
    this.logger.log(`[psd2-sync] attempt=${attempt} jobId=${job.id} org=${organizationId}`)
    await this.sync.syncOrganization(organizationId)
  }
}
