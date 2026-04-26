import { InjectQueue } from '@nestjs/bull'
import { Injectable, Logger } from '@nestjs/common'
import type { Queue, JobOptions } from 'bull'
import {
  type EnqueueMailOptions,
  type MailJobPayload,
  type MailPriority,
  type TemplateName,
  QUEUE_HIGH,
  QUEUE_LOW,
  QUEUE_NORMAL,
} from './mail.types'

const JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Producer för mail-kön. MailService delegerar all enqueue:ing hit.
 *
 * Tre köer per prioritet — separationen ger oss möjlighet att senare
 * köra olika antal workers per kö, eller pausa låg-prio-trafik utan att
 * påverka magic-link-mail.
 */
@Injectable()
export class MailQueue {
  private readonly logger = new Logger(MailQueue.name)

  constructor(
    @InjectQueue(QUEUE_HIGH) private readonly highQueue: Queue<MailJobPayload>,
    @InjectQueue(QUEUE_NORMAL) private readonly normalQueue: Queue<MailJobPayload>,
    @InjectQueue(QUEUE_LOW) private readonly lowQueue: Queue<MailJobPayload>,
  ) {}

  async enqueue<T extends TemplateName>(opts: EnqueueMailOptions<T>): Promise<string> {
    const queue = this.queueFor(opts.priority ?? 'normal')

    const payload: MailJobPayload = {
      template: opts.template,
      props: opts.props,
      to: opts.to,
      subject: opts.subject,
      ...(opts.attachments && opts.attachments.length > 0
        ? {
            attachments: opts.attachments.map((a) => ({
              filename: a.filename,
              contentBase64: a.content.toString('base64'),
            })),
          }
        : {}),
    }

    const jobOptions: JobOptions = {
      attempts: 5,
      // Bull beräknar exponentiell delay som delay * 2^(attempt-1):
      // 1min → 2min → 4min → 8min → permanent fail. Matchar spec-andan
      // (~1min upp till ~1h) inom Bulls inbyggda backoff-stöd.
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { age: JOB_TTL_MS / 1000, count: 1000 },
      removeOnFail: { age: JOB_TTL_MS / 1000, count: 1000 },
    }

    if (opts.idempotencyKey) jobOptions.jobId = opts.idempotencyKey
    if (opts.scheduledAt) {
      const delay = opts.scheduledAt.getTime() - Date.now()
      if (delay > 0) jobOptions.delay = delay
    }

    const job = await queue.add(payload, jobOptions)
    this.logger.log(
      `Enqueued mail jobId=${job.id} template=${opts.template} to=${opts.to} priority=${opts.priority ?? 'normal'}`,
    )
    return String(job.id)
  }

  private queueFor(priority: MailPriority): Queue<MailJobPayload> {
    switch (priority) {
      case 'high':
        return this.highQueue
      case 'low':
        return this.lowQueue
      default:
        return this.normalQueue
    }
  }

  getQueues(): Queue<MailJobPayload>[] {
    return [this.highQueue, this.normalQueue, this.lowQueue]
  }
}
