import { OnQueueFailed, Process, Processor } from '@nestjs/bull'
import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Job } from 'bull'
import { Resend } from 'resend'
import { isCreditPaidInformation, readPreparedNoticeMail } from '../avisering/notice-dispatch'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { AUTOMATISKA_KUNDEFFEKTER_ORG_STATUSES } from '../common/org/automation-org-statuses'
import { DEFAULT_MAIL_FROM } from './mail.types'
import { RentNoticeEventsService } from '../avisering/rent-notice-events.service'
import { PrismaService } from '../common/prisma/prisma.service'
import { claimLegacyNoticeDispatch } from './legacy-notice-dispatch'
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

const DEFAULT_FROM = DEFAULT_MAIL_FROM
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
    // #648-följd. SIST i listan: nya beroenden läggs till på slutet så
    // befintliga positionsanrop inte tyst byter betydelse.
    private readonly rentNoticeEvents: RentNoticeEventsService,
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
      if (correlation?.kind === 'rent-notice' && correlation.sendId) {
        const pending = await this.prisma.rentNoticeSend.findFirst({
          where: {
            id: correlation.sendId,
            rentNoticeId: correlation.rentNoticeId,
            rentNotice: { organizationId: job.data.organizationId },
          },
          select: { dispatchStartedAt: true, acceptedAt: true },
        })
        if (pending?.dispatchStartedAt && !pending.acceptedAt)
          throw new Error(
            'Mejl har stängts av efter påbörjat utskick. Okänt leveransutfall behöver kontrolleras.',
          )
      }

      this.logger.warn(
        `[${job.queue.name}] SUPPRESSERAT jobId=${job.id} template=${template} to=${to} ` +
          `org=${job.data.organizationId}: transactionalEmailsDisabled var satt när jobbet plockades. ` +
          'Jobbet kastas, inget skickas.',
      )
      return
    }

    if (correlation?.kind === 'rent-notice' && correlation.sendId) {
      await this.processPreparedNotice(job, correlation.sendId, correlation.rentNoticeId)
      return
    }

    // F-047-2: AVINS GILTIGHET VID KONSUMTION. Ett avimejl som köades medan avin fortfarande var
    // skickbar kan plockas efter att avin betalats eller annullerats. Då skickas det inte: hyresgästen ska
    // inte få en betalningsuppmaning för en reglerad eller makulerad fordran. Saknas avin (annan
    // organisation eller borttagen) skickas inget heller — samma fail-closed-riktning som ventilen ovan.
    // Gränsen: ett mejl som Resend redan tagit emot kan inte återkallas.
    // O-050-5 (TESTKUND-051): gäller även påminnelsen (`rent-notice-reminder`) — samma avi, samma org-bundna läsning.
    if (correlation?.kind === 'rent-notice' || correlation?.kind === 'rent-notice-reminder') {
      const avi = await this.prisma.rentNotice.findFirst({
        where: { id: correlation.rentNoticeId, organizationId: job.data.organizationId },
        select: {
          status: true,
          sends: { where: { dispatchKey: { not: null } }, select: { id: true } },
        },
      })
      if (correlation.kind === 'rent-notice' && (avi?.sends?.length ?? 0) > 0) return
      if (!avi || avi.status === 'PAID' || avi.status === 'CANCELLED' || avi.status === 'OPENING') {
        this.logger.warn(
          `[${job.queue.name}] AVIMEJL SKICKAS INTE jobId=${job.id} avi=${correlation.rentNoticeId} ` +
            `org=${job.data.organizationId}: avin har status ${avi?.status ?? 'saknas'} när jobbet plockades.`,
        )
        return
      }
    }

    this.logger.log(
      `[${job.queue.name}] attempt=${attempt} jobId=${job.id} template=${template} to=${to}`,
    )

    const { html, text } = await this.renderer.render(
      template as TemplateName,
      props as TemplatePropsMap[TemplateName],
    )

    if (correlation?.kind === 'rent-notice') {
      const claimed = await claimLegacyNoticeDispatch(
        this.prisma,
        job.data.organizationId,
        correlation.rentNoticeId,
        to,
        String(job.id),
      )
      if (!claimed) return
    }

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
      await this.persistResendId(correlation, resendId, job.data.organizationId)
    }
  }

  private async processPreparedNotice(
    job: Job<MailJobPayload>,
    sendId: string,
    noticeId: string,
  ): Promise<void> {
    const organizationId = job.data.organizationId
    const prepared = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "RentNotice" WHERE id = ${noticeId} AND "organizationId" = ${organizationId} FOR UPDATE`
      const send = await tx.rentNoticeSend.findFirst({
        where: { id: sendId, rentNoticeId: noticeId, rentNotice: { organizationId } },
        include: {
          rentNotice: {
            select: {
              status: true,
              tenant: { select: { anonymizedAt: true } },
              organization: { select: { status: true, transactionalEmailsDisabled: true } },
            },
          },
        },
      })
      if (!send) throw new Error('Avins utskicksreservation saknas')
      if (send.acceptedAt) return null
      const mail = readPreparedNoticeMail(send, organizationId)
      if (
        send.rentNotice.tenant.anonymizedAt ||
        send.rentNotice.organization.transactionalEmailsDisabled ||
        !AUTOMATISKA_KUNDEFFEKTER_ORG_STATUSES.some(
          (status) => status === send.rentNotice.organization.status,
        )
      ) {
        if (send.dispatchStartedAt)
          throw new Error(
            'Hyresgästen eller organisationen har spärrats efter påbörjat utskick. Okänt leveransutfall behöver kontrolleras.',
          )
        return null
      }
      const status = send.rentNotice.status
      if (
        status === 'CANCELLED' ||
        status === 'OPENING' ||
        (status === 'PAID' && !isCreditPaidInformation(send))
      ) {
        if (send.dispatchStartedAt)
          throw new Error(
            'Avin har ändrats efter påbörjat utskick. Okänt leveransutfall behöver kontrolleras utan nytt betalningsmejl.',
          )
        return null
      }
      const now = new Date(Date.now())
      // Resend behåller idempotensnycklar i 24h. En timmes marginal:
      // okänt utfall utanför fönstret får inte bli ett blint dubbelutskick.
      // https://resend.com/docs/dashboard/emails/idempotency-keys
      if (
        send.dispatchStartedAt &&
        now.getTime() - send.dispatchStartedAt.getTime() >= 23 * 60 * 60 * 1000
      ) {
        throw new Error(
          'Utskickets leveransutfall är okänt efter omförsöksfönstret och behöver kontrolleras',
        )
      }
      await tx.rentNoticeSend.updateMany({
        where: { id: sendId, rentNotice: { organizationId }, dispatchStartedAt: null },
        data: { dispatchStartedAt: now },
      })
      return mail
    }, PRISMA_DEFAULT_TX_LIMITS)
    if (!prepared) return

    // Inga databaslås hålls under leverantörsanropet. Allt, även avsändare,
    // färdig HTML och PDF-byte, kommer ur samma oföränderliga underlag.
    const result = await this.resend.emails.send(
      {
        from: prepared.from,
        to: prepared.to,
        subject: prepared.subject,
        html: prepared.html,
        text: prepared.text,
        attachments: prepared.attachments.map((a) => ({
          filename: a.filename,
          content: Buffer.from(a.contentBase64, 'base64'),
        })),
      },
      { idempotencyKey: prepared.idempotencyKey },
    )
    if (result.error) throw new Error(`Resend rejected mail: ${result.error.message}`)
    const resendId = result.data?.id
    if (!resendId) throw new Error('Mejlleverantören saknar leveransidentifierare')

    await this.persistResendId(
      { kind: 'rent-notice', rentNoticeId: noticeId, sendId },
      resendId,
      organizationId,
    )
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

  private async persistResendId(
    correlation: MailCorrelation,
    resendId: string,
    organizationId: string,
  ): Promise<void> {
    if (correlation.kind === 'rent-notice' && correlation.sendId) {
      const sendId = correlation.sendId
      const noticeId = correlation.rentNoticeId
      // Ack-fel måste bubbla: omförsöket använder samma leverantörsnyckel och
      // återhämtar kvittot. Ett redan sparat kvitto gör senare retry till no-op.
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "RentNotice" WHERE id = ${noticeId} AND "organizationId" = ${organizationId} FOR UPDATE`
        const send = await tx.rentNoticeSend.findFirst({
          where: { id: sendId, rentNoticeId: noticeId, rentNotice: { organizationId } },
        })
        if (!send) throw new Error('Avins utskicksreservation saknas vid kvittering')
        if (send.acceptedAt) {
          if (send.messageId !== resendId)
            throw new Error('Mejlleverantören gav två olika kvitton för samma utskick')
          return
        }
        await tx.rentNoticeSend.updateMany({
          where: { id: sendId, rentNotice: { organizationId }, acceptedAt: null },
          data: { messageId: resendId, acceptedAt: new Date() },
        })
        await tx.rentNotice.updateMany({
          where: { id: noticeId, organizationId, sentAt: null },
          data: {
            sentAt: new Date(),
            sentTo: readPreparedNoticeMail(send, organizationId).to,
            noticeMessageId: resendId,
            sendError: null,
          },
        })
        await tx.rentNotice.updateMany({
          where: { id: noticeId, organizationId, status: { in: ['PENDING', 'FAILED', 'OVERDUE'] } },
          data: { status: 'SENT' },
        })
      }, PRISMA_DEFAULT_TX_LIMITS)
      return
    }
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
          // ORG-SCOPAD som påminnelsevägen nedan. Två former för samma sak blir
          // en glidning: den ena skulle förr eller senare "förenklas" till den
          // andra, och då är det den oscopade som blir mönstret.
          await this.prisma.rentNotice.updateMany({
            where: { id: correlation.rentNoticeId, organizationId },
            data: { noticeMessageId: resendId },
          })
          break
        case 'rent-notice-reminder':
          // ── TVÅ SKRIVNINGAR, TVÅ ENHETER ────────────────────────────────
          //
          // `RentNoticeSend.messageId` är den som webhooken korrelerar på, och
          // den bär rätt enhet: ETT utskick, ETT message-id. Avins
          // `reminderMessageId` skrivs kvar därför att den visar SENASTE
          // utskickets id i gränssnittet och är webhookens reservväg för jobb
          // som köades innan `sendId` fanns.
          //
          // Ordningen spelar roll: utskicksraden först. Faller den andra
          // skrivningen har korrelationen ändå landat där utfallet ska hamna.
          if (correlation.sendId) {
            // ORG-SCOPAD, och det syns på plats. `sendId` kommer ur jobbets egen
            // payload och är inte klientindata — men en skrivning på ett id vars
            // ägarskap inte prövas i samma funktion går inte att granska där den
            // står. `updateMany` i stället för `update`: en icke-träff blir noll
            // rader i stället för ett kast, och ett kast här hade utlöst en
            // onödig Bull-retry på ett mejl som redan är skickat.
            await this.prisma.rentNoticeSend.updateMany({
              where: { id: correlation.sendId, rentNotice: { organizationId } },
              data: { messageId: resendId },
            })
          }
          await this.prisma.rentNotice.updateMany({
            where: { id: correlation.rentNoticeId, organizationId },
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

    // ── OCH SAMMA FEL I AVINS EGEN LOGG ─────────────────────────────────────
    //
    // `FailedEmail` fick sin koppling till avin i #651 och den fylls — men INGEN
    // läser tabellen (mätt: noll läsare i src/, noll rader i prod). Det är den
    // operativa raden: jobId, payload, antal försök, för den som felsöker kön.
    //
    // Domänraden saknades. `SEND_FAILED` skrivs bara vid SYNKRONA fel — när
    // hyresgästen saknar e-post, eller när köandet självt kastar. Ett Bull-jobb
    // som gör slut på sina försök lämnade därför inget spår alls på avin, och
    // ett ärende som stod stilla i REMINDED gick inte att förklara i den vy som
    // finns för just det (#648).
    //
    // Ingen grind ändras: INV-B läser SENT, EMAIL_DELIVERED och EMAIL_BOUNCED —
    // inte SEND_FAILED. Raden är upplysning, inte beslut.
    if (rentNoticeId) await this.recordSendFailed(rentNoticeId, String(job.id), err.message)
  }

  /**
   * Skriver `SEND_FAILED` på avin — EN GÅNG per jobb.
   *
   * `RentNoticeEvent` är append-only: en dubblett går inte att städa bort. Bulls
   * `failed`-händelse för sista försöket avfyras normalt en gång, men "normalt"
   * är inte "alltid", så uppslaget på jobId står här.
   *
   * KONTROLLEN ÄR INTE ATOMISK, och det är ett medvetet val. Två samtidiga
   * skrivningar för SAMMA jobId kan båda passera. Alternativet vore ett unikt
   * index till på en append-only-tabell för en rad som ingen grind läser —
   * kostnaden är en dubblerad upplysning, inte ett felaktigt beslut.
   */
  private async recordSendFailed(
    rentNoticeId: string,
    jobId: string,
    reason: string,
  ): Promise<void> {
    try {
      const redan = await this.prisma.rentNoticeEvent.findFirst({
        where: {
          rentNoticeId,
          type: 'SEND_FAILED',
          payload: { path: ['jobId'], equals: jobId },
        },
        select: { id: true },
      })
      if (redan) return
      await this.rentNoticeEvents.record(rentNoticeId, 'SEND_FAILED', 'SYSTEM', null, {
        jobId,
        reason,
        // Skiljer den här raden från de synkrona SEND_FAILED-raderna, som
        // skrivs innan brevet ens nått kön.
        steg: 'utskicket gav upp efter alla försök',
      })
    } catch (err) {
      // Loggens skrivning får aldrig bli anledningen till att kön fallerar.
      this.logger.error(
        `Kunde inte skriva SEND_FAILED på avi ${rentNoticeId} (jobId=${jobId}): ${(err as Error).message}`,
      )
    }
  }
}

@Injectable()
@Processor(QUEUE_HIGH)
export class MailWorkerHigh extends MailWorkerBase {
  constructor(
    renderer: MailRenderer,
    prisma: PrismaService,
    config: ConfigService,
    rentNoticeEvents: RentNoticeEventsService,
  ) {
    super(renderer, prisma, config, rentNoticeEvents)
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
  constructor(
    renderer: MailRenderer,
    prisma: PrismaService,
    config: ConfigService,
    rentNoticeEvents: RentNoticeEventsService,
  ) {
    super(renderer, prisma, config, rentNoticeEvents)
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
  constructor(
    renderer: MailRenderer,
    prisma: PrismaService,
    config: ConfigService,
    rentNoticeEvents: RentNoticeEventsService,
  ) {
    super(renderer, prisma, config, rentNoticeEvents)
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
