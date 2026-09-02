import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Prisma, RentNoticeEventType } from '@prisma/client'
import { Webhook, WebhookVerificationError } from 'svix'
import { PrismaService } from '../common/prisma/prisma.service'
import { ResendEventSchema, type ResendEvent } from './resend-event.schema'
import { resolveActorType } from '../common/ai-origin/ai-origin.context'

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
 *  - Matchar ingen inbjudan kan email_id i stället vara en hyresavi-PÅMINNELSE.
 *    Den korreleras via RentNotice.reminderMessageId (@unique, inkasso PR 4b₀) och
 *    leveransutfallet skrivs APPEND-ONLY till RentNoticeEvent (EMAIL_DELIVERED/
 *    EMAIL_BOUNCED). Samma org-säkerhet: @unique → exakt en avi, som bär sin egen
 *    organizationId; ingen org-uppgift läses ur payloaden, ingen cross-tenant-skrivning.
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
        await this.markBounced(emailId, at, event.data.bounce ?? null)
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
    if (res.count > 0) {
      this.logCorrelation('delivered', emailId, res.count)
      return
    }
    // Ingen inbjudan matchade — kan vara en hyresavi-påminnelse (inkasso PR 4b₀).
    const matched = await this.recordNoticeDeliveryEvent(emailId, 'DELIVERED', {
      deliveredAt: at.toISOString(),
    })
    if (!matched) this.logCorrelation('delivered', emailId, 0)
  }

  private async markBounced(
    emailId: string,
    at: Date,
    bounce: ResendEvent['data']['bounce'] | null,
  ): Promise<void> {
    const res = await this.prisma.tenant.updateMany({
      where: { lastInviteMessageId: emailId },
      data: { inviteBouncedAt: at, inviteBounceReason: bounce?.message ?? null },
    })
    if (res.count > 0) {
      this.logCorrelation('bounced', emailId, res.count)
      return
    }
    // Hyresavi-påminnelse: lagra STRUKTURERAD bounce-kategori (type/subType),
    // ALDRIG den fria bounce-texten. Fritexten kan innehålla mottagarens e-post
    // (PII) och hamnar annars i en append-only logg som inte kan rensas
    // (security-auditor LOW / GDPR lagringsminimering).
    const matched = await this.recordNoticeDeliveryEvent(emailId, 'BOUNCED', {
      bouncedAt: at.toISOString(),
      ...(bounce?.type ? { bounceType: bounce.type } : {}),
      ...(bounce?.subType ? { bounceSubType: bounce.subType } : {}),
    })
    if (!matched) this.logCorrelation('bounced', emailId, 0)
  }

  private async markComplained(emailId: string, at: Date): Promise<void> {
    const res = await this.prisma.tenant.updateMany({
      where: { lastInviteMessageId: emailId },
      data: { inviteComplainedAt: at },
    })
    this.logCorrelation('complained', emailId, res.count)
  }

  /**
   * Korrelerar ett Resend-event mot en hyresavi och loggar leveransutfallet
   * APPEND-ONLY i RentNoticeEvent. Returnerar true om en avi matchade.
   *
   * ── TVÅ NYCKLAR, TVÅ BETYDELSER (#651) ─────────────────────────────────────
   *
   * `reminderMessageId` pekar ut PÅMINNELSEN, `noticeMessageId` AVIN. Vilket av
   * fälten som träffade avgör händelsetypen, och den skillnaden är inte
   * kosmetisk: INV-B-grinden läser EMAIL_DELIVERED som beviset att det
   * lagstadgade KRAVET nått gäldenären. Skrev avins leverans samma typ hade den
   * tyst uppfyllt grinden med fel bevis.
   *
   * Org-säkert: båda fälten är @unique, så ett email_id pekar ut HÖGST en avi,
   * som bär sin egen organizationId — vi läser aldrig org ur payloaden och kan
   * aldrig skriva till fel organisations logg.
   *
   * Idempotent under Resends at-least-once-leverans: om utfallet redan loggats
   * skapas ingen dubblett (append-only-loggen får aldrig skrivas över). Det
   * DB-enforce:as dessutom av det partiella unika indexet
   * `RentNoticeEvent_delivery_idempotency_key`, som omfattar alla fyra typerna.
   */
  private async recordNoticeDeliveryEvent(
    emailId: string,
    utfall: 'DELIVERED' | 'BOUNCED',
    payload: Prisma.InputJsonObject,
  ): Promise<boolean> {
    // ── UTSKICKET FÖRST (#656) ──────────────────────────────────────────────
    //
    // `RentNoticeSend.messageId` bär rätt enhet: ETT utskick, ETT message-id.
    // Träffar den vet vi både vilken avi och VILKET UTSKICK utfallet gäller, och
    // ett sent svar för ett tidigare utskick landar på sitt eget utskick i
    // stället för att tappas.
    const utskick = await this.prisma.rentNoticeSend.findUnique({
      where: { messageId: emailId },
      select: { id: true, rentNoticeId: true, kind: true },
    })

    // RESERVVÄGEN är den gamla frågan, och den behövs: jobb som köades innan
    // `sendId` fanns bär ingen utskicksrad. De får `sendId = ''`, samma sentinel
    // som raderna från före kolumnen — alltså exakt den gamla semantiken, en av
    // varje typ per avi.
    const notice = utskick
      ? { id: utskick.rentNoticeId, reminderMessageId: null as string | null }
      : await this.prisma.rentNotice.findFirst({
          where: { OR: [{ reminderMessageId: emailId }, { noticeMessageId: emailId }] },
          select: { id: true, reminderMessageId: true },
        })
    if (!notice) return false

    const sendId = utskick?.id ?? ''

    // VILKET fält som träffade avgör typen. `reminderMessageId` först: träffar
    // den är det påminnelsen, annars avin. Båda är @unique, så det finns ingen
    // tvetydighet att lösa upp. Kom vi via utskicksraden säger dess `kind` samma
    // sak, direkt.
    const gällerPåminnelsen = utskick
      ? utskick.kind === 'REMINDER'
      : notice.reminderMessageId === emailId
    const type: RentNoticeEventType = gällerPåminnelsen
      ? utfall === 'DELIVERED'
        ? 'EMAIL_DELIVERED'
        : 'EMAIL_BOUNCED'
      : utfall === 'DELIVERED'
        ? 'NOTICE_EMAIL_DELIVERED'
        : 'NOTICE_EMAIL_BOUNCED'

    // Snabbväg + rena loggar: hoppa över om utfallet redan loggats FÖR DET HÄR
    // UTSKICKET. Utan `sendId` i frågan hade en omsändnings utfall setts som
    // "redan loggat" av det förra utskickets rad — vilket är precis det
    // enhetsfel indexet nu spärrar (#656).
    const existing = await this.prisma.rentNoticeEvent.findFirst({
      where: { rentNoticeId: notice.id, type, sendId },
      select: { id: true },
    })
    if (existing) {
      this.logger.debug(`Resend ${type}: redan loggat för avi ${notice.id} (idempotent)`)
      return true
    }

    try {
      await this.prisma.rentNoticeEvent.create({
        data: {
          rentNoticeId: notice.id,
          type,
          sendId,
          actorType: resolveActorType('WEBHOOK'),
          actorLabel: 'E-postleverantör',
          payload,
        },
      })
      this.logger.log(`Resend ${type}: loggade leverans-event för hyresavi ${notice.id}`)
    } catch (err) {
      // Det partiella unika indexet (rentNoticeId, type) på leveranstyperna
      // DB-enforce:ar idempotensen: en samtidig dubblett som passerade findFirst-
      // kontrollen ger P2002. Behandla som no-op — det vinnande anropet har redan
      // skrivit utfallet (append-only-loggen får aldrig dubbletter).
      if ((err as { code?: string } | null)?.code === 'P2002') {
        this.logger.debug(
          `Resend ${type}: samtidig dubblett för avi ${notice.id} (P2002, idempotent)`,
        )
        return true
      }
      throw err
    }
    return true
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
