import { OnQueueFailed, Process, Processor } from '@nestjs/bull'
import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Job } from 'bull'
import { Resend } from 'resend'
import { PrismaService } from '../common/prisma/prisma.service'
import { MailRenderer } from './mail.renderer'
import {
  type MailCorrelation,
  type MailJobPayload,
  type TemplateName,
  type TemplatePropsMap,
  QUEUE_HIGH,
  QUEUE_LOW,
  QUEUE_NORMAL,
} from './mail.types'

const DEFAULT_FROM = 'Eveno Fastigheter <noreply@eveno.se>'
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
    const explicitFrom = config.get<string>('MAIL_FROM')
    this.from = explicitFrom ?? DEFAULT_FROM

    const isProduction = config.get<string>('NODE_ENV') === 'production'
    if (isProduction && this.from.includes('resend.dev')) {
      this.logger.error(
        '[MAIL] WARNING: Sending from Resend sandbox domain in production. Set MAIL_FROM to a verified domain.',
      )
    }
    if (isProduction && !explicitFrom) {
      this.logger.error(
        `[MAIL] WARNING: MAIL_FROM is not set in production — falling back to default "${DEFAULT_FROM}". Set MAIL_FROM explicitly.`,
      )
    }
  }

  protected async processJob(job: Job<MailJobPayload>): Promise<void> {
    const start = Date.now()
    const { template, props, to, subject, attachments, idempotencyKey, correlation } = job.data
    const attempt = job.attemptsMade + 1

    // Strypventilens SISTAHANDSSKYDD. Den primära grinden sitter hos producenten
    // (MailQueue.enqueue) och hindrar jobbet från att skapas alls — den här
    // fångar de två fall producenten omöjligt kan fånga: jobb som redan låg i
    // kön när flaggan sattes, och jobb som köats med `scheduledAt` långt fram.
    // Vi returnerar utan att kasta: ett kast hade gett fem Bull-retries och en
    // FailedEmail-rad för något som är en konfiguration, inte ett fel.
    if (await this.isSuppressed(job.data.organizationId)) {
      this.logger.warn(
        `[${job.queue.name}] SUPPRESSERAT jobId=${job.id} template=${template} to=${to} ` +
          `org=${job.data.organizationId}: transactionalEmailsDisabled var satt när jobbet plockades. ` +
          'Jobbet kastas, inget skickas.',
      )
      return
    }

    this.logger.log(
      `[${job.queue.name}] attempt=${attempt} jobId=${job.id} template=${template} to=${to}`,
    )

    const { html, text } = await this.renderer.render(
      template as TemplateName,
      props as TemplatePropsMap[TemplateName],
    )

    // Idempotency-Key skickas till Resend så att retries (efter worker-stall,
    // container-restart, transient timeout efter att Resend accepterat mejlet)
    // inte ger ett andra utskick till samma mottagare. Resend dedupar i 24h.
    const result = await this.resend.emails.send(
      {
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
      },
      idempotencyKey ? { idempotencyKey } : undefined,
    )

    if (result.error) {
      // Kasta så Bull triggar retry/DLQ
      throw new Error(`Resend rejected mail: ${result.error.message}`)
    }

    const resendId = result.data?.id
    const duration = Date.now() - start
    this.logger.log(
      `[${job.queue.name}] sent jobId=${job.id} template=${template} to=${to} duration=${duration}ms resendId=${resendId ?? 'unknown'}`,
    )

    // Korrelera Resend-id:t med rätt domänobjekt så webhooken (PR 2) kan koppla
    // leverans-/bounce-event tillbaka. Görs EFTER lyckat utskick — id:t finns
    // inte vid enqueue. Ett fel här är icke-fatalt: mejlet ÄR skickat, så vi
    // kastar inte (det skulle trigga en onödig Bull-retry). Resultatet blir
    // bara att statusen fastnar på "skickad" tills nästa utskick.
    if (correlation && resendId) {
      await this.persistResendId(correlation, resendId)
    }
  }

  /**
   * Läser strypventilen igen, vid konsumtion. Okänd org fäller — samma
   * fail-closed-riktning som producenten (MailQueue.isSuppressed): kan vi inte
   * bevisa att ventilen är öppen skickar vi inte.
   */
  private async isSuppressed(organizationId: string): Promise<boolean> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { transactionalEmailsDisabled: true },
    })
    return !org || org.transactionalEmailsDisabled
  }

  private async persistResendId(correlation: MailCorrelation, resendId: string): Promise<void> {
    try {
      switch (correlation.kind) {
        case 'tenant-invite':
          await this.prisma.tenant.update({
            where: { id: correlation.tenantId },
            data: { lastInviteMessageId: resendId },
          })
          break
        // #651: BÅDA avi-fälten skrivs HÄR, och bara här. Anropsställena hade
        // tidigare skrivit `reminderMessageId` själva, med returvärdet från
        // `MailQueue.enqueue` — som är Bulls jobId, inte Resends email_id.
        // Webhooken frågar på email_id, så korrelationen kunde aldrig träffa.
        case 'rent-notice':
          await this.prisma.rentNotice.update({
            where: { id: correlation.rentNoticeId },
            data: { noticeMessageId: resendId },
          })
          break
        case 'rent-notice-reminder':
          await this.prisma.rentNotice.update({
            where: { id: correlation.rentNoticeId },
            data: { reminderMessageId: resendId },
          })
          break
      }
    } catch (err) {
      this.logger.error(
        `Failed to persist resendId=${resendId} for correlation=${JSON.stringify(
          correlation,
        )}: ${(err as Error).message}`,
      )
    }
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

    // #651: KOPPLA FELET TILL AVIN. Utan den här lämnade ett slutgiltigt
    // misslyckat påminnelseutskick en rad vars enda spår var jobId, template,
    // to, subject, payload och error — ingen av dem en främmande nyckel. Ett
    // ärende som stod stilla i REMINDED gick alltså inte att förklara.
    //
    // Källan är jobbets egen `correlation`, alltså SAMMA fält som
    // `persistResendId` läser vid framgång: framgångs- och felvägen pekar ut
    // samma objekt, och kan inte glida isär.
    const korrelation = job.data.correlation
    const rentNoticeId =
      korrelation &&
      (korrelation.kind === 'rent-notice' || korrelation.kind === 'rent-notice-reminder')
        ? korrelation.rentNoticeId
        : null

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
          ...(rentNoticeId ? { rentNoticeId } : {}),
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
