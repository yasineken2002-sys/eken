import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Webhook, WebhookVerificationError } from 'svix'
import { PrismaService } from '../common/prisma/prisma.service'
import { ResendEventSchema, type ResendEvent } from './resend-event.schema'

/**
 * Hanterar Resends leverans-/bounce-webhook.
 *
 * SÄKERHET:
 *  - Signaturen (Svix) verifieras ALLTID först. En overifierad/felsignerad
 *    request avvisas med 401 och payloaden behandlas aldrig — ingen status kan
 *    ändras utan giltig signatur.
 *  - Payloaden valideras strikt med Zod efter verifiering (data utifrån).
 *  - Korrelationen email_id → Tenant går via Tenant.lastInviteMessageId (@unique)
 *    med updateMany. Det är org-säkert: id:t pekar ut exakt en hyresgäst som bär
 *    sin egen organizationId; vi läser ALDRIG någon org-uppgift ur payloaden.
 */
@Injectable()
export class ResendWebhookService {
  private readonly logger = new Logger(ResendWebhookService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Verifierar signatur + hanterar eventet. Kastar UnauthorizedException (401)
   * vid ogiltig/saknad signatur, ServiceUnavailableException (503) om
   * webhook-hemligheten inte är konfigurerad. Returnerar tyst vid signerade men
   * okända/icke-modellerade payloads (ackas med 2xx — annars retryar Resend i
   * onödan).
   */
  async handle(
    rawBody: Buffer | undefined,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<void> {
    const secret = this.config.get<string>('RESEND_WEBHOOK_SECRET')
    if (!secret) {
      // Serverkonfigurationsfel — loggas högt internt (alert), men svaret hålls
      // generiskt så att en extern scanner inte kan skilja "saknar hemlighet"
      // från andra tillfälliga fel. 503 (inte 401) behålls MEDVETET: Resend
      // retryar bara 5xx, så event återhämtas när hemligheten väl är satt i
      // stället för att tappas. Ingenting behandlas utan en hemlighet.
      this.logger.error('RESEND_WEBHOOK_SECRET saknas — kan inte verifiera webhook')
      throw new ServiceUnavailableException('Webhooken är tillfälligt otillgänglig')
    }

    if (!rawBody || rawBody.length === 0) {
      throw new UnauthorizedException('Tom webhook-body')
    }

    // Svix kräver de tre headers Resend skickar. Fastify lowercasar headers.
    const svixHeaders = {
      'svix-id': firstHeader(headers['svix-id']),
      'svix-timestamp': firstHeader(headers['svix-timestamp']),
      'svix-signature': firstHeader(headers['svix-signature']),
    }

    let verified: unknown
    try {
      // verify() validerar HMAC + timestamp-tolerans och returnerar den
      // verifierade payloaden. Kastar vid manipulerad body eller fel signatur.
      verified = new Webhook(secret).verify(rawBody.toString('utf8'), svixHeaders)
    } catch (err) {
      if (err instanceof WebhookVerificationError) {
        this.logger.warn(`Avvisade webhook med ogiltig signatur: ${err.message}`)
        throw new UnauthorizedException('Ogiltig webhook-signatur')
      }
      throw err
    }

    const parsed = ResendEventSchema.safeParse(verified)
    if (!parsed.success) {
      // Signerad men ej modellerad form — acka (2xx) och logga, retrya inte.
      this.logger.warn(`Signerad webhook med oväntad form ignorerad: ${parsed.error.message}`)
      return
    }

    await this.process(parsed.data)
  }

  /**
   * Idempotens & ordning: Resend levererar at-least-once och kan skicka event
   * out-of-order. Det hanteras av design snarare än av dedup:
   *  - Varje hanterare sätter ETT fält till eventets värde → en exakt retry är
   *    idempotent (samma fält, samma värde).
   *  - Den HÄRLEDDA statusen (deriveStatus) beror bara på VILKA fält som är satta,
   *    inte i vilken ordning event kom: bounced/complained > delivered > invited,
   *    och aktiverad slår allt. Ordningen påverkar alltså inte vad ägaren ser.
   *  - Vid (om)skick nollställs fälten + lastInviteMessageId, så ett sent event
   *    för ett GAMMALT utskick matchar ingen tenant (no-op) och kan inte trampa
   *    en ny inbjudans status.
   */
  private async process(event: ResendEvent): Promise<void> {
    const emailId = event.data.email_id
    const at = parseEventDate(event.created_at)

    switch (event.type) {
      case 'email.delivered':
        await this.markDelivered(emailId, at)
        break
      case 'email.bounced':
        await this.markBounced(emailId, at, event.data.bounce?.message ?? null)
        break
      case 'email.complained':
        await this.markComplained(emailId, at)
        break
      default:
        this.logger.debug(`Ignorerar Resend-event type=${event.type} email_id=${emailId}`)
    }
  }

  private async markDelivered(emailId: string, at: Date): Promise<void> {
    const res = await this.prisma.tenant.updateMany({
      where: { lastInviteMessageId: emailId },
      data: { inviteDeliveredAt: at },
    })
    this.logCorrelation('delivered', emailId, res.count)
  }

  private async markBounced(emailId: string, at: Date, reason: string | null): Promise<void> {
    const res = await this.prisma.tenant.updateMany({
      where: { lastInviteMessageId: emailId },
      data: { inviteBouncedAt: at, inviteBounceReason: reason },
    })
    this.logCorrelation('bounced', emailId, res.count)
  }

  private async markComplained(emailId: string, at: Date): Promise<void> {
    const res = await this.prisma.tenant.updateMany({
      where: { lastInviteMessageId: emailId },
      data: { inviteComplainedAt: at },
    })
    this.logCorrelation('complained', emailId, res.count)
  }

  private logCorrelation(kind: string, emailId: string, count: number): void {
    if (count === 0) {
      // Ingen hyresgäst matchar — t.ex. ett icke-inbjudningsmejl eller ett event
      // för ett gammalt utskick vars id ersatts vid omskick. Förväntat, no-op.
      this.logger.debug(`Resend ${kind}: ingen tenant matchade email_id=${emailId}`)
      return
    }
    this.logger.log(`Resend ${kind}: uppdaterade ${count} tenant(s) för email_id=${emailId}`)
  }
}

function firstHeader(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? ''
  return v ?? ''
}

function parseEventDate(raw: string | undefined): Date {
  if (!raw) return new Date()
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? new Date() : d
}
