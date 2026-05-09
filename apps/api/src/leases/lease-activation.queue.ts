import { InjectQueue } from '@nestjs/bull'
import { Injectable, Logger } from '@nestjs/common'
import type { Queue, JobOptions } from 'bull'

export const LEASE_ACTIVATION_QUEUE = 'lease-activation'

/**
 * Bull-jobben för lease-aktivering. Tre jobbtyper i samma kö så de delar
 * worker, retry-policy och visualisering. Idempotency-nycklar (`jobId`) gör
 * att samma logiska aktivering inte enqueueas dubbelt.
 */
export type LeaseActivationJob =
  | {
      type: 'generate-contract-pdf'
      leaseId: string
      organizationId: string
      // Mänsklig användare som triggade aktiveringen, om en sådan finns.
      // Sätts till null när jobbet enqueueas av cron, system-fix eller
      // andra autonoma flöden — i de fallen sparas Document utan
      // uploadedBy och worker-loggen markerar 'system'.
      actorUserId: string | null
    }
  | {
      type: 'send-welcome-mail'
      tenantId: string
    }
  | {
      type: 'create-initial-notices'
      leaseId: string
      organizationId: string
    }

const JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Producer för lease-activation-kön. Används från LeasesService när status
 * flippas till ACTIVE — istället för fire-and-forget får vi automatisk retry
 * (1m → 2m → 4m → 8m → 16m → permanent fail) om Puppeteer kraschar eller
 * mejlleverantören är nere.
 */
@Injectable()
export class LeaseActivationQueue {
  private readonly logger = new Logger(LeaseActivationQueue.name)

  constructor(
    @InjectQueue(LEASE_ACTIVATION_QUEUE)
    private readonly queue: Queue<LeaseActivationJob>,
  ) {}

  async enqueueGenerateContract(payload: {
    leaseId: string
    organizationId: string
    actorUserId: string | null
  }): Promise<string> {
    const jobOptions: JobOptions = {
      attempts: 5,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { age: JOB_TTL_MS / 1000, count: 1000 },
      removeOnFail: { age: JOB_TTL_MS / 1000, count: 1000 },
      // jobId dedupar dubbla enqueues (t.ex. dubbelklick på "aktivera").
      jobId: `gen-pdf-${payload.leaseId}`,
    }
    const job = await this.queue.add({ type: 'generate-contract-pdf', ...payload }, jobOptions)
    this.logger.log(`Enqueued generate-contract-pdf jobId=${job.id} lease=${payload.leaseId}`)
    return String(job.id)
  }

  async enqueueWelcomeMail(payload: { tenantId: string }): Promise<string> {
    const jobOptions: JobOptions = {
      attempts: 5,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { age: JOB_TTL_MS / 1000, count: 1000 },
      removeOnFail: { age: JOB_TTL_MS / 1000, count: 1000 },
      jobId: `welcome-${payload.tenantId}`,
    }
    const job = await this.queue.add({ type: 'send-welcome-mail', ...payload }, jobOptions)
    this.logger.log(`Enqueued send-welcome-mail jobId=${job.id} tenant=${payload.tenantId}`)
    return String(job.id)
  }

  async enqueueInitialNotices(payload: {
    leaseId: string
    organizationId: string
  }): Promise<string> {
    const jobOptions: JobOptions = {
      attempts: 5,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { age: JOB_TTL_MS / 1000, count: 1000 },
      removeOnFail: { age: JOB_TTL_MS / 1000, count: 1000 },
      // Idempotency-nyckel: en lease får bara ett initial-notices-jobb. Om
      // admin re-aktiverar eller dubbelklickar dedupar Bull.
      jobId: `initial-notices-${payload.leaseId}`,
    }
    const job = await this.queue.add({ type: 'create-initial-notices', ...payload }, jobOptions)
    this.logger.log(`Enqueued create-initial-notices jobId=${job.id} lease=${payload.leaseId}`)
    return String(job.id)
  }
}
