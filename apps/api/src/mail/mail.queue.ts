import { InjectQueue } from '@nestjs/bull'
import { Injectable, Logger } from '@nestjs/common'
import type { Queue, JobOptions } from 'bull'
import { PrismaService } from '../common/prisma/prisma.service'
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
 *
 * ── STRYPVENTILEN ───────────────────────────────────────────────────────────
 *
 * Här sitter den PRIMÄRA grinden mot `Organization.transactionalEmailsDisabled`.
 * Den ligger hos producenten och inte hos workern därför att ett suppressat
 * mejl då aldrig ens blir ett Bull-jobb: inga retries, ingen FailedEmail-rad,
 * inget brus. Workern har en andra kontroll för jobb som redan låg i kön när
 * flaggan sattes.
 */
@Injectable()
export class MailQueue {
  private readonly logger = new Logger(MailQueue.name)

  constructor(
    @InjectQueue(QUEUE_HIGH) private readonly highQueue: Queue<MailJobPayload>,
    @InjectQueue(QUEUE_NORMAL) private readonly normalQueue: Queue<MailJobPayload>,
    @InjectQueue(QUEUE_LOW) private readonly lowQueue: Queue<MailJobPayload>,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Köar ett mejl — om organisationens strypventil är öppen.
   *
   * RETURVÄRDET: Bull-jobId vid köat mejl, TOM STRÄNG när ventilen är stängd.
   * Den tomma strängen är vald framför ett kast och framför `null`:
   *   • Ett KAST hade gjort en medveten konfiguration till ett fel — cron-jobb
   *     hade räknat upp sina felräknare och `enqueueSafely` larmat till Sentry
   *     varje gång ventilen gjorde exakt det den ska.
   *   • `string | null` hade rippat in i `enqueueSafely`, som är typad
   *     `() => Promise<string>` och delas med kontraktsskanning och PDF-kön.
   * Anropare som sparar id:t vaktar redan på falsy (rent-reminder.service.ts:775).
   *
   * ÄRLIG BIVERKNING, och den ska sägas högt: anropare som markerar sitt
   * dokument som skickat efter ett lyckat anrop gör det även när mejlet
   * suppressats — en avi kan alltså stå som SENT utan att någon fått den. Det
   * är avsiktligt (ventilen är till för demo-, test- och internkonton där just
   * det är önskvärt), men det är också varför varje suppression loggas som
   * WARN med org och mall: en flagga som satts av misstag ska gå att se i
   * loggen, inte bara i dess tystnad.
   */
  async enqueue<T extends TemplateName>(opts: EnqueueMailOptions<T>): Promise<string> {
    if (await this.isSuppressed(opts.organizationId, opts.template, opts.to)) return ''

    const queue = this.queueFor(opts.priority ?? 'normal')

    const payload: MailJobPayload = {
      template: opts.template,
      props: opts.props,
      to: opts.to,
      organizationId: opts.organizationId,
      subject: opts.subject,
      ...(opts.attachments && opts.attachments.length > 0
        ? {
            attachments: opts.attachments.map((a) => ({
              filename: a.filename,
              contentBase64: a.content.toString('base64'),
            })),
          }
        : {}),
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      ...(opts.correlation ? { correlation: opts.correlation } : {}),
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

  /**
   * Sant om organisationens strypventil är stängd — eller om organisationen
   * inte går att slå upp.
   *
   * OKÄND ORG FÄLLER (fail-closed). Ett org-id som inte finns betyder att vi
   * inte KAN avgöra om ventilen är öppen, och den säkra riktningen är att inte
   * skicka: inget legitimt mejl bär ett org-id som saknas i databasen. En
   * DB-blipp kastar däremot vidare i stället för att tyst suppressa — ett
   * infrastrukturfel ska se ut som ett fel, inte som en konfiguration.
   */
  private async isSuppressed(
    organizationId: string,
    template: TemplateName,
    to: string,
  ): Promise<boolean> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { transactionalEmailsDisabled: true },
    })

    if (!org) {
      this.logger.error(
        `[MAIL] Suppresserar mejl template=${template} to=${to}: organisationen ${organizationId} finns inte. ` +
          'Ett okänt org-id går inte att grinda mot — se MailQueue.isSuppressed.',
      )
      return true
    }

    if (org.transactionalEmailsDisabled) {
      this.logger.warn(
        `[MAIL] Suppresserat template=${template} to=${to} org=${organizationId}: ` +
          'transactionalEmailsDisabled är satt. Inget jobb köades.',
      )
      return true
    }

    return false
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
