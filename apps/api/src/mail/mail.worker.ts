import { OnQueueFailed, Process, Processor } from '@nestjs/bull'
import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Job } from 'bull'
import { Resend } from 'resend'
import { PrismaService } from '../common/prisma/prisma.service'
import { MailRenderer } from './mail.renderer'
import {
  type MailJobPayload,
  type TemplateName,
  type TemplatePropsMap,
  QUEUE_HIGH,
  QUEUE_LOW,
  QUEUE_NORMAL,
} from './mail.types'

const DEFAULT_FROM = 'Eken Fastigheter <onboarding@resend.dev>'
const CONCURRENCY = 5

@Injectable()
abstract class MailWorkerBase {
  protected readonly logger = new Logger(this.constructor.name)
  protected readonly resend: Resend
  protected readonly from: string

  constructor(
    private readonly renderer: MailRenderer,
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const apiKey = config.get<string>('RESEND_API_KEY')
    if (!apiKey) {
      this.logger.warn('RESEND_API_KEY saknas — mailutskick kommer misslyckas')
    }
    this.resend = new Resend(apiKey ?? 'missing-key')
    this.from = config.get<string>('MAIL_FROM') ?? DEFAULT_FROM

    if (config.get<string>('NODE_ENV') === 'production' && this.from.includes('resend.dev')) {
      this.logger.error(
        '[MAIL] WARNING: Sending from Resend sandbox domain in production. Set MAIL_FROM to a verified domain.',
      )
    }
  }

  protected async processJob(job: Job<MailJobPayload>): Promise<void> {
    const start = Date.now()
    const { template, props, to, subject, attachments } = job.data
    const attempt = job.attemptsMade + 1

    this.logger.log(
      `[${job.queue.name}] attempt=${attempt} jobId=${job.id} template=${template} to=${to}`,
    )

    const { html, text } = await this.renderer.render(
      template as TemplateName,
      props as TemplatePropsMap[TemplateName],
    )

    const result = await this.resend.emails.send({
      from: this.from,
      to,
      subject,
      html,
      text,
      ...(attachments && attachments.length > 0
        ? {
            attachments: attachments.map((a) => ({
              filename: a.filename,
              content: Buffer.from(a.contentBase64, 'base64'),
            })),
          }
        : {}),
    })

    if (result.error) {
      // Kasta så Bull triggar retry/DLQ
      throw new Error(`Resend rejected mail: ${result.error.message}`)
    }

    const duration = Date.now() - start
    this.logger.log(
      `[${job.queue.name}] sent jobId=${job.id} template=${template} to=${to} duration=${duration}ms resendId=${result.data?.id ?? 'unknown'}`,
    )
  }

  /**
   * Anropas av Bull vid varje failed attempt. Bull schemalägger retry
   * automatiskt baserat på job.opts.backoff (exponential delay 1m → 8m).
   * Här loggar vi bara — och vid sista försöket sparar vi i FailedEmail
   * så jobbet kan inspekteras och replayas.
   */
  protected async handleFailed(job: Job<MailJobPayload>, err: Error): Promise<void> {
    const attempt = job.attemptsMade
    const maxAttempts = job.opts.attempts ?? 1
    const isPermanent = attempt >= maxAttempts

    this.logger.warn(
      `[${job.queue.name}] failed jobId=${job.id} template=${job.data.template} to=${job.data.to} attempt=${attempt}/${maxAttempts} permanent=${isPermanent} error=${err.message}`,
    )

    if (!isPermanent) return

    try {
      await this.prisma.failedEmail.create({
        data: {
          jobId: String(job.id),
          template: job.data.template,
          to: job.data.to,
          subject: job.data.subject,
          payload: job.data as object,
          error: err.message,
          attempts: attempt,
        },
      })
    } catch (dbErr) {
      this.logger.error(
        `Failed to write FailedEmail row for jobId=${job.id}: ${(dbErr as Error).message}`,
      )
    }
  }
}

@Injectable()
@Processor(QUEUE_HIGH)
export class MailWorkerHigh extends MailWorkerBase {
  constructor(renderer: MailRenderer, prisma: PrismaService, config: ConfigService) {
    super(renderer, prisma, config)
  }

  @Process({ concurrency: CONCURRENCY })
  async handle(job: Job<MailJobPayload>): Promise<void> {
    await this.processJob(job)
  }

  @OnQueueFailed()
  async onFailed(job: Job<MailJobPayload>, err: Error): Promise<void> {
    await this.handleFailed(job, err)
  }
}

@Injectable()
@Processor(QUEUE_NORMAL)
export class MailWorkerNormal extends MailWorkerBase {
  constructor(renderer: MailRenderer, prisma: PrismaService, config: ConfigService) {
    super(renderer, prisma, config)
  }

  @Process({ concurrency: CONCURRENCY })
  async handle(job: Job<MailJobPayload>): Promise<void> {
    await this.processJob(job)
  }

  @OnQueueFailed()
  async onFailed(job: Job<MailJobPayload>, err: Error): Promise<void> {
    await this.handleFailed(job, err)
  }
}

@Injectable()
@Processor(QUEUE_LOW)
export class MailWorkerLow extends MailWorkerBase {
  constructor(renderer: MailRenderer, prisma: PrismaService, config: ConfigService) {
    super(renderer, prisma, config)
  }

  @Process({ concurrency: CONCURRENCY })
  async handle(job: Job<MailJobPayload>): Promise<void> {
    await this.processJob(job)
  }

  @OnQueueFailed()
  async onFailed(job: Job<MailJobPayload>, err: Error): Promise<void> {
    await this.handleFailed(job, err)
  }
}
