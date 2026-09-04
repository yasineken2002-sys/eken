import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { PrismaService } from '../common/prisma/prisma.service'
import { PersonalNumberService } from '../common/crypto/personal-number.service'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import {
  BANKID_PROVIDER,
  type BankIdProvider,
  type BankIdStartResult,
} from '../bankid/bankid.types'
import {
  CHOOSE_KONTEXT_PORTAL,
  signChooseToken,
  verifyChooseToken,
} from '../bankid/bankid-choose-token'
import { TenantAuthService } from './tenant-auth.service'
import type { TenantBankIdCandidate, TenantBankIdCollectResult } from './tenant-bankid.types'

/** 'BANKID' — se `TenantBankIdIdentity.provider` i schema.prisma. */
const PROVIDER = 'BANKID'

/**
 * Syftet på `BankIdOrder`-raden. EGET värde, skilt från web-flödets 'LOGIN'.
 *
 * Tabellen delas med web (#745 PR 2) därför att en pågående BankID-order är
 * samma sak i båda världarna — ett kortlivat, engångs-, serverlagrat handtag.
 * Syftet håller dem isär: `loadLiveOrder` kräver exakt match, så en order som
 * startats i portalen kan inte fullbordas som en web-inloggning eller tvärtom.
 */
const PURPOSE = 'TENANT_LOGIN'

/** Samma fönster som web-flödet: BankID:s standardordertid plus en minut. */
const ORDER_TTL_MS = 4 * 60 * 1000

/**
 * BankID-inloggning för HYRESGÄSTER (`apps/portal`).
 *
 * ── INGEN ANSLUTNING, OCH DET ÄR SKILLNADEN MOT WEB ────────────────────────
 *
 * Webbflödet har två steg: en inloggad användare KOPPLAR sitt BankID, och först
 * därefter kan hen logga in med det. Skälet är att ett `User`-konto skapas av
 * en e-postadress och ett lösenord — systemet vet inte vem människan bakom är,
 * så någon måste bevisa kopplingen en gång.
 *
 * En hyresgäst är motsatsen: hyresvärden HAR redan registrerat personnumret,
 * eftersom det står i hyresavtalet. Kopplingen mellan människa och hyresförhållande
 * är alltså redan gjord, av den part som har rätt att göra den. Ett
 * anslutningssteg hade bara låtit hyresgästen bekräfta något hyresvärden redan
 * påstått — och hade dessutom krävt en inloggning för att kunna logga in.
 *
 * Uppslaget sker därför direkt mot `Tenant.personalNumberHash`.
 * `TenantBankIdIdentity` SKRIVS vid den lyckade inloggningen som ett kvitto på
 * att beviset finns; den är inte matchningsnyckeln. Se schema.prisma.
 *
 * ── PERSONNUMRET LEVER BARA I MINNET ──────────────────────────────────────
 *
 * `completionData.personalNumber` blindindexeras på första raden efter att det
 * tagits emot. Klartexten når aldrig en logg, ett felmeddelande eller en kolumn.
 */
@Injectable()
export class TenantBankIdService {
  private readonly logger = new Logger(TenantBankIdService.name)

  constructor(
    @Inject(BANKID_PROVIDER) private readonly provider: BankIdProvider,
    private readonly prisma: PrismaService,
    private readonly personalNumbers: PersonalNumberService,
    private readonly auth: TenantAuthService,
    private readonly config: ConfigService,
  ) {}

  async start(endUserIp: string, now: Date): Promise<BankIdStartResult> {
    const res = await this.provider.start({ endUserIp })
    await this.prisma.bankIdOrder.create({
      data: {
        orderRef: res.orderRef,
        purpose: PURPOSE,
        // Ingen userId och ingen tenantId: vid inloggning är det okänt vem det
        // är förrän ordern fullbordats. Bindningen sker i uppslaget, inte här.
        expiresAt: new Date(now.getTime() + ORDER_TTL_MS),
      },
    })
    return res
  }

  async collect(orderRef: string, now: Date): Promise<TenantBankIdCollectResult> {
    await this.loadLiveOrder(orderRef, now)

    const res = await this.provider.collect(orderRef)
    if (res.status === 'pending') {
      return { status: 'pending', ...(res.hintCode ? { hintCode: res.hintCode } : {}) }
    }
    if (res.status === 'failed') {
      await this.consume(orderRef, now)
      return { status: 'failed', reason: res.reason }
    }

    // FÖRSTA RADEN EFTER MOTTAGANDET. Efter det här uttrycket bär vi bara hashar.
    const personnummer = res.completionData.personalNumber
    const hashar = this.personalNumbers.indexCandidates(personnummer)
    const kandidater = await this.kandidaterFor(hashar)

    if (kandidater.length === 0) {
      // AVSLÖJAR INGENTING. Samma svar som ett misslyckat BankID: den som
      // identifierat sig får veta att inloggningen inte gick, inte varför.
      // Ordern förbrukas ändå — en order som identifierat någon får inte kunna
      // spelas om medan en hyresgäst läggs upp.
      await this.consume(orderRef, now)
      throw new UnauthorizedException('Inloggningen kunde inte slutföras')
    }

    if (kandidater.length === 1) {
      const kandidat = kandidater[0] as TenantBankIdCandidate
      await this.consume(orderRef, now)
      const skydd = this.personalNumbers.protect(personnummer)
      return this.skrivKvittoOchSession(
        kandidat.tenantId,
        hashar[0] as string,
        skydd.personalNumberEnc as string,
        now,
      )
    }

    // FLERA HYRESVÄRDAR. Ordern förbrukas INTE här — den är auktoriteten för
    // valet, och `chooseToken` ensam räcker inte.
    //
    // Envelopen läggs på ORDERN, inte i token: klartexten finns bara här, och
    // identitetskvittot ska kunna skrivas även för den som har två hyresvärdar.
    // Se kolumnens docblock i schema.prisma för varför de två alternativen är
    // sämre.
    await this.prisma.bankIdOrder.update({
      where: { orderRef },
      data: { subjectEnc: this.personalNumbers.protect(personnummer).personalNumberEnc as string },
    })

    return {
      status: 'choose',
      chooseToken: signChooseToken(
        {
          orderRef,
          // Blindindexet i sin EXAKTA form (BankID:s tolvsiffriga). Kvittot
          // skrivs på den, och listan nedan avgränsar vilket hyresförhållande
          // valet får peka på.
          subjectHash: hashar[0] as string,
          // FRUSEN KANDIDATLISTA. Valet kan inte flyttas till en hyresgästrad som
          // inte matchade — se `choose`.
          tenantIds: kandidater.map((k) => k.tenantId),
        },
        this.config.getOrThrow<string>('JWT_SECRET'),
        now,
        CHOOSE_KONTEXT_PORTAL,
      ),
      candidates: kandidater,
    }
  }

  /**
   * Väljer hyresvärd när personen är hyresgäst hos flera.
   *
   * ── DEN OMVÄNDA RIKTNINGEN ────────────────────────────────────────────────
   *
   * Kan en hyresgäst i organisation A välja en hyresgästrad i organisation B som
   * INTE matchade? Nej, och spärren är listan i token: `tenantIds` signerades vid
   * identifieringen och är exakt de rader personnumret träffade. Ett id utanför
   * den listan avvisas oavsett hur giltig signaturen är, och listan kan inte
   * ändras utan att signaturen faller.
   *
   * Det är starkare än att härleda om mängden vid valet: en hyresgästrad som
   * någon lägger upp MELLAN identifiering och val hade då kunnat dyka upp i
   * mängden. Valet ska vara avgränsat till det användaren faktiskt såg.
   */
  async choose(
    chooseToken: string,
    tenantId: string,
    now: Date,
  ): Promise<TenantBankIdCollectResult> {
    const payload = verifyChooseToken(
      chooseToken,
      this.config.getOrThrow<string>('JWT_SECRET'),
      now,
      CHOOSE_KONTEXT_PORTAL,
    )
    if (!payload) throw new UnauthorizedException('Valet kunde inte verifieras')
    if (!payload.tenantIds?.includes(tenantId)) {
      throw new UnauthorizedException('Valet kunde inte verifieras')
    }

    // Ordern är auktoriteten. En replay av en giltig token mot en förbrukad
    // order avvisas här, oavsett signatur.
    await this.loadLiveOrder(payload.orderRef, now)

    // Envelopen kommer från ORDERN, som bar den från identifieringen. Läses före
    // förbrukningen, som nollställer fältet.
    const order = await this.prisma.bankIdOrder.findUnique({
      where: { orderRef: payload.orderRef },
      select: { subjectEnc: true },
    })
    await this.consume(payload.orderRef, now)

    return this.skrivKvittoOchSession(tenantId, payload.subjectHash, order?.subjectEnc ?? null, now)
  }

  // ── Hjälpare ──────────────────────────────────────────────────────────────

  /**
   * Hyresgästrader som personnumret matchar, i HELA databasen.
   *
   * `in` över båda blindindexformerna — se `PersonalNumberService.indexCandidates`
   * för varför ett index inte räcker. Uppslaget går på
   * `Tenant_personalNumberHash_idx`; utan det globala indexet hade varje
   * inloggning blivit en seq scan över samtliga hyresgäster.
   *
   * `select` och inte `include`: raden får aldrig bära credential-kolumnerna ut
   * ur servicen (B1), och `tenant-credential-read.spec.ts` fäller en läsning här
   * som saknar det.
   */
  private async kandidaterFor(hashar: string[]): Promise<TenantBankIdCandidate[]> {
    const rader = await this.prisma.tenant.findMany({
      where: {
        personalNumberHash: { in: hashar },
        // En avidentifierad hyresgäst är inte någon att logga in som. Raden
        // finns kvar av bokföringsskäl (GDPR art. 17 → avidentifiering, inte
        // radering) men den representerar ingen levande relation.
        anonymizedAt: null,
      },
      select: {
        id: true,
        organization: { select: { name: true } },
        leases: {
          where: { status: 'ACTIVE' },
          orderBy: { startDate: 'desc' },
          take: 1,
          select: { unit: { select: { name: true, property: { select: { street: true } } } } },
        },
      },
      orderBy: { createdAt: 'asc' },
    })

    return rader.map((r) => {
      const enhet = r.leases[0]?.unit
      const adress = enhet ? [enhet.property.street, enhet.name].filter(Boolean).join(', ') : null
      return {
        tenantId: r.id,
        organizationName: r.organization.name,
        address: adress || null,
      }
    })
  }

  /**
   * Skriver identitetskvittot och skapar sessionen.
   *
   * `subjectEnc` kommer antingen direkt från identifieringen (en träff) eller
   * från orderraden (efter ett val). Är den null — vilket bara kan hända om
   * ordern hunnit förbrukas mellan de två anropen — skrivs INGET kvitto, och det
   * är rätt: en rad utan envelope hade varit ett halvt bevis, och sessionen
   * hänger inte på kvittot.
   */
  private async skrivKvittoOchSession(
    tenantId: string,
    subjectHash: string,
    subjectEnc: string | null,
    now: Date,
  ): Promise<TenantBankIdCollectResult> {
    if (subjectEnc) {
      // PRISMA_DEFAULT_TX_LIMITS, uttryckligen: en skrivning mot en indexerad
      // nyckel, ingen väntan. Gränsen står skriven så nästa läsare ser att den
      // är VALD och inte ärvd (#488).
      await this.prisma.$transaction(async (tx) => {
        await tx.tenantBankIdIdentity.upsert({
          where: {
            provider_subjectHash_tenantId: { provider: PROVIDER, subjectHash, tenantId },
          },
          create: { provider: PROVIDER, subjectHash, subjectEnc, tenantId, verifiedAt: now },
          // Bara tidpunkten. `subjectEnc` skrivs INTE om: envelopen är redan
          // rätt, och en omskrivning hade bytt IV utan skäl.
          update: { verifiedAt: now },
        })
      }, PRISMA_DEFAULT_TX_LIMITS)
    }

    const session = await this.auth.createSessionForTenant(tenantId)
    this.logger.log(`[bankid] hyresgästsession skapad för ${tenantId}`)
    return {
      status: 'complete',
      sessionToken: session.sessionToken,
      expiresAt: session.expiresAt.toISOString(),
      tenant: {
        id: session.tenant.id,
        firstName: session.tenant.firstName,
        lastName: session.tenant.lastName,
        companyName: session.tenant.companyName,
        email: session.tenant.email,
      },
    }
  }

  /**
   * Order som fortfarande FÅR användas: rätt syfte, inte förbrukad, inte utgången.
   * Samma `NotFoundException` för alla fyra fallen — att skilja dem åt hade låtit
   * någon räkna ut vilka orderRef som existerar.
   */
  private async loadLiveOrder(orderRef: string, now: Date): Promise<void> {
    const order = await this.prisma.bankIdOrder.findUnique({
      where: { orderRef },
      select: { purpose: true, consumedAt: true, expiresAt: true },
    })
    if (!order || order.purpose !== PURPOSE || order.consumedAt != null || order.expiresAt <= now) {
      throw new NotFoundException('Ordern finns inte eller är inte längre giltig')
    }
  }

  /**
   * Förbrukar ordern atomiskt. Två samtidiga collect ger `count 1` och `count 0`;
   * den som fick 0 har förlorat kapplöpningen.
   */
  private async consume(orderRef: string, now: Date): Promise<void> {
    const res = await this.prisma.bankIdOrder.updateMany({
      where: { orderRef, consumedAt: null },
      // Envelopen nollställs i SAMMA sats som förbrukningen. Den behövs inte
      // efter att ordern är använd, och en personuppgift som ligger kvar "tills
      // städjobbet kommer" är en personuppgift som ligger kvar.
      data: { consumedAt: now, subjectEnc: null },
    })
    if (res.count === 0) throw new ConflictException('Ordern är redan förbrukad')
  }
}
