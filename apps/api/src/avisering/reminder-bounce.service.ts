import { Inject, Injectable, Logger } from '@nestjs/common'
import { NotificationType, RentCollectionStage } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'

/**
 * PORTEN MOT AVGIFTSSTRYKNINGEN — smal av två skäl, och det andra är det viktiga.
 *
 * 1. MEKANISKT: `AviseringService` importerar transitivt `storage.service.ts`
 *    och därmed `@aws-sdk/client-s3`, som är ESM och inte transformeras av jest.
 *    En enhetsspec som importerar den faller på `SyntaxError: Unexpected token
 *    'export'` innan ett enda test körts.
 *
 * 2. STRUKTURELLT: porten exponerar EN metod. Det gör det omöjligt att härifrån
 *    nå `reverseJournalEntryForInterest` — räntan kan alltså inte återföras av
 *    misstag, ens av någon som inte läst docblocket nedan. Gränsen är inte en
 *    överenskommelse utan en typ.
 */
export const REMINDER_FEE_REVERSAL = Symbol('REMINDER_FEE_REVERSAL')

export interface ReminderFeeReversal {
  reverseReminderFee(
    noticeId: string,
    orgId: string,
    reason: string,
    actorId: string | null,
  ): Promise<unknown>
}

/**
 * DEN SMALA PORTEN MOT NOTISERNA — och varför den inte är `NotificationsService`.
 *
 * Två skäl, det andra mekaniskt:
 *
 *  1. Den här filen behöver EN förmåga: skapa en notis åt organisationens
 *     användare. `NotificationsService` bär dessutom cron-jobb, månadsrapporter
 *     och PDF-generering. Att bero på hela klassen för en utfläkning vore att
 *     dra in ett halvt system för tio rader.
 *
 *  2. `NotificationsService` importerar transitivt `storage.service.ts` och
 *     därmed `@aws-sdk/client-s3`, som är ESM och INTE transformeras av jest:
 *     varje enhetsspec som importerar den faller på `SyntaxError: Unexpected
 *     token 'export'` innan ett enda test körts. En smal port gör tjänsten
 *     provbar utan att röra jest-konfigurationen globalt.
 *
 * Modulen binder porten till den riktiga tjänsten med `useExisting`, så det
 * finns fortfarande bara EN implementation.
 */
export const NOTIFICATION_FANOUT = Symbol('NOTIFICATION_FANOUT')

export interface NotificationFanout {
  createForAllOrgUsers(
    organizationId: string,
    type: NotificationType,
    title: string,
    message: string,
  ): Promise<void>
}

/**
 * EN STUDSAD PÅMINNELSE ÅTERFÖR AVGIFTEN (#654).
 *
 * Anropas av `ResendWebhookService` när `EMAIL_BOUNCED` skrivits på en avi —
 * alltså när e-postleverantören rapporterat att PÅMINNELSEN inte nådde fram.
 *
 * ── VARFÖR EN EGEN TJÄNST ───────────────────────────────────────────────────
 *
 * Policyn "vad ska hända när en påminnelse studsar" är inte samma sak som
 * "hur stryker man en avgift". Den senare är `AviseringService.reverseReminderFee`
 * och är oförändrad. Den här filen äger BESLUTET, och håller det utanför en
 * tjänst som redan har elva konstruktorberoenden.
 *
 * ── VARFÖR AVGIFTEN, MEN INTE RÄNTAN ────────────────────────────────────────
 *
 * Påminnelseavgiften ersätter ATT EN PÅMINNELSE SKICKADES. Kom den bevisligen
 * inte fram faller grunden. Dröjsmålsräntan löper av ett annat skäl: pengarna är
 * sena, och det är de oavsett om påminnelsen kom fram — betalningsskyldigheten
 * etablerades av avin, inte av påminnelsen.
 *
 * Mekaniskt vore en ränteåterföring dessutom fel: räntan fortsätter löpa, så den
 * återförda delen bokförs igen vid nästa kristalliseringspunkt. Utfallet blir en
 * såg-tand i huvudboken.
 *
 * Husets praxis säger samma sak: `reverseReminderFee` (den mänskliga "avgiften
 * var fel"-åtgärden) vänder bara avgiften. Bara `cancelNotice` — där hela
 * fordran upphör — vänder både avgift och ränta.
 *
 * ── STEGET BACKAS ALDRIG ────────────────────────────────────────────────────
 *
 * En sen studs får inte rulla tillbaka `collectionStage`. INV-B är en
 * FRAMÅTGRIND: den hindrar en avi från att gå vidare utan bevisad leverans. Att
 * av-eskalera i efterhand är ett eget och mycket större beslut.
 *
 *   NONE, REMINDED   → avgiften återförs
 *   INKASSO_READY    → INGEN återföring; ärendet lyfts till en människa
 *   avskriven        → INGEN återföring
 *
 * Vid INKASSO_READY ligger ärendet i kö för mänsklig överlämning. Att tyst ändra
 * huvudboken under ett ärende som är på väg ut skapar en skillnad mellan vad som
 * överlämnades och vad boken säger.
 *
 * ── ⚠️ LYFTET ÄR HALVSYNLIGT I DAG — OCH DET SKA STÅ HÄR ────────────────────
 *
 * Notisen når `NotificationBell` i AppLayout (syns på varje inloggad sida, med
 * olästräknare) och `NotificationsPage`. Det är en RIKTIG yta — mätt, inte
 * antagen.
 *
 * MEN den går inte att klicka sig vidare från: `notificationLinkToPath` känner
 * inte segmentet `avisering`, och inkasso-vyn är fakturabaserad
 * (`/collections/overdue-status` → `OverdueInvoice[]`) och visar inga hyresavier.
 * Operatören ser ATT något hänt, men inte beviset.
 *
 * Därför bär notisens text AVINUMRET — den måste vara självbärande. Vägen till
 * själva leveranshändelsen finns först när #648 ger avin en händelsevy.
 * **Fram till dess är detaljen osynlig. Det är ett känt tillstånd, inte ett
 * antagande om att någon ser den.**
 *
 * ── VAD DEN HÄR ÄNDRINGEN INTE LÖSER ────────────────────────────────────────
 *
 * En studsad påminnelse låser avin i `REMINDED`: 11:00-cronen blockeras av
 * INV-B (`EMAIL_BOUNCED` finns), och 10:00-cronen plockar bara upp
 * `collectionStage = NONE` — alltså kan ingen ny påminnelse skickas.
 *
 * **Det tillståndet finns REDAN, före den här ändringen.** Vi skapar det inte;
 * vi slutar ta betalt för det och gör det för första gången SYNLIGT. Vägen ur
 * det — rätta adressen och skicka om, eller nollställa steget — är ett eget
 * beslut som inte är taget. Se PR-texten.
 *
 * ── KASTAR ALDRIG ───────────────────────────────────────────────────────────
 *
 * `reverseReminderFee` har fyra spärrar som kastar `BadRequestException`; de är
 * byggda för en mänsklig HTTP-anropare. Här skulle ett kast ge webhooken 500,
 * och Resend retryar då ett event vi redan hanterat. Villkoren förprövas därför,
 * och det som ändå faller fångas och lyfts som notis.
 */
@Injectable()
export class ReminderBounceService {
  private readonly logger = new Logger(ReminderBounceService.name)

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REMINDER_FEE_REVERSAL) private readonly avisering: ReminderFeeReversal,
    @Inject(NOTIFICATION_FANOUT) private readonly notifications: NotificationFanout,
  ) {}

  async handleBouncedReminder(
    noticeId: string,
    eventId: string,
    bouncedAt: Date,
  ): Promise<'reversed' | 'flagged' | 'skipped'> {
    const notice = await this.prisma.rentNotice.findUnique({
      where: { id: noticeId },
      select: {
        id: true,
        organizationId: true,
        noticeNumber: true,
        collectionStage: true,
        reminderFeeAmount: true,
        probableLossAt: true,
        writtenOffAt: true,
      },
    })
    if (!notice) return 'skipped'

    const fee = Number(notice.reminderFeeAmount)
    const avskriven = notice.probableLossAt != null || notice.writtenOffAt != null
    const redoFörInkasso = notice.collectionStage === RentCollectionStage.INKASSO_READY
    const när = bouncedAt.toISOString()

    if (!avskriven && !redoFörInkasso && fee > 0) {
      // ── MOTVERIFIKATETS TEXT ÄR ETT VERIFIKAT, INTE EN LOGGRAD ─────────────
      //
      // Den läses av en granskare om två år och ska då bära VAD som hände, NÄR,
      // och PÅ VILKET BEVIS — utan att någon behöver frågas. Därför står
      // händelsetypen, tidpunkten OCH händelsens id i texten: det går att gå
      // från motverifikatet till raden i RentNoticeEvent och tillbaka igen.
      const skäl =
        `Påminnelsen för avi ${notice.noticeNumber} nådde aldrig mottagaren. ` +
        `E-postleverantören rapporterade en studs ${när}, loggad som EMAIL_BOUNCED ` +
        `på avin (händelse ${eventId}). Avgiften avser en påminnelse som inte kom ` +
        `fram och återförs därför.`

      try {
        await this.avisering.reverseReminderFee(notice.id, notice.organizationId, skäl, null)
        await this.notifications.createForAllOrgUsers(
          notice.organizationId,
          NotificationType.SYSTEM,
          `Påminnelsen studsade — avgiften återförd (${notice.noticeNumber})`,
          `Påminnelsen för avi ${notice.noticeNumber} kom inte fram (studs ${när}). ` +
            `Påminnelseavgiften har återförts. Kontrollera hyresgästens e-postadress: ` +
            `avin står kvar i kravtrappan men går inte vidare utan bevisad leverans, ` +
            `och någon ny påminnelse skickas inte automatiskt.`,
        )
        return 'reversed'
      } catch (err) {
        // Spärrarna i reverseReminderFee (betalning över taket, samtidig
        // ändring) är legitima nej. De ska LYFTAS, inte sväljas — och absolut
        // inte kastas vidare till webhooken.
        this.logger.warn(
          `Kunde inte återföra påminnelseavgift för avi ${notice.id} efter studs: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    await this.notifications.createForAllOrgUsers(
      notice.organizationId,
      NotificationType.SYSTEM,
      `Påminnelsen studsade — kräver granskning (${notice.noticeNumber})`,
      `Påminnelsen för avi ${notice.noticeNumber} kom inte fram (studs ${när}). ` +
        `Påminnelseavgiften återfördes INTE automatiskt` +
        (redoFörInkasso
          ? ' eftersom ärendet redan är redo för inkasso och ska hanteras av en människa.'
          : avskriven
            ? ' eftersom avin redan är avskriven.'
            : fee > 0
              ? ' — orsaken står i serverloggen.'
              : ' eftersom avin inte bär någon påminnelseavgift.') +
        ` Avin går inte vidare i kravtrappan utan bevisad leverans.`,
    )
    return 'flagged'
  }
}
