import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Cron } from '@nestjs/schedule'
import type { TokenPair } from '@eken/shared'

import { PrismaService } from '../common/prisma/prisma.service'
import { SigningCryptoService } from '../signing/signing-crypto.service'
import { AuthService } from '../auth/auth.service'
import { CronErrorSink } from '../common/cron/cron-error-sink'
import { runCronSafely } from '../common/cron/cron-safety'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { BANKID_PROVIDER, type BankIdProvider, type BankIdStartResult } from './bankid.types'
import { signChooseToken, verifyChooseToken } from './bankid-choose-token'

/** 'BANKID' — se `UserBankIdIdentity.provider` i schema.prisma. */
const PROVIDER = 'BANKID'

/**
 * BankID:s standardmodell ger en order tre minuter innan den går ut. Vi lägger
 * på en minut så att en order som PROVIDERN fortfarande anser levande inte kan
 * vara borta hos oss — annars svarar vi "utgången" om något providern skulle
 * fullborda, och användaren ser ett fel efter att ha signerat.
 */
export const ORDER_TTL_MS = 4 * 60 * 1000

export type BankIdCollectResponse =
  | { status: 'pending'; hintCode?: string }
  | { status: 'failed'; reason: string }
  | { status: 'complete' }

export type BankIdLoginResponse =
  | { status: 'pending'; hintCode?: string }
  | { status: 'failed'; reason: string }
  | { status: 'complete'; tokens: TokenPair }
  | {
      status: 'choose'
      chooseToken: string
      accounts: Array<{ userId: string; organizationName: string; role: string }>
    }

/**
 * BankID-inloggning och -anslutning för operatörer (`apps/web`).
 *
 * ── PERSONNUMRET LEVER BARA I MINNET ──────────────────────────────────────
 *
 * `completionData.personalNumber` kommer rått från providern och blindindexeras
 * på FÖRSTA raden efter att det tagits emot. Klartexten når aldrig en logg, ett
 * felmeddelande, ett Sentry-event eller en databaskolumn — det som lagras är
 * `subjectHash` (HMAC) och `subjectEnc` (AES-GCM-envelope). Kravet står också
 * vid `BankIdCompletionData` i `bankid.types.ts`, och ett prov i
 * `bankid-auth.pii.spec.ts` fäller om klartexten läcker till loggen.
 *
 * ── ORDERN ÄR AUKTORITETEN, INTE HANDTAGET ────────────────────────────────
 *
 * Varje start skriver en `BankIdOrder`. Den är single-use (`consumedAt` sätts
 * atomiskt) och kortlivad. Vid ENROLL bär den dessutom `userId`, och collect
 * kräver att den inloggade användaren ÄR den användaren — se `enrollCollect`.
 */
@Injectable()
export class BankIdAuthService {
  private readonly logger = new Logger(BankIdAuthService.name)

  constructor(
    @Inject(BANKID_PROVIDER) private readonly provider: BankIdProvider,
    private readonly prisma: PrismaService,
    private readonly crypto: SigningCryptoService,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
    private readonly cronErrors: CronErrorSink,
  ) {}

  // ── Anslutning (inloggad användare kopplar sitt BankID) ───────────────────

  async enrollStart(userId: string, endUserIp: string, now: Date): Promise<BankIdStartResult> {
    const res = await this.provider.start({ endUserIp })
    await this.prisma.bankIdOrder.create({
      data: {
        orderRef: res.orderRef,
        purpose: 'ENROLL',
        // BINDNINGEN. Utan den kan A starta en order och låta B fullborda den i
        // sin webbläsare — och B:s personnummer hade knutits till A:s konto.
        userId,
        expiresAt: new Date(now.getTime() + ORDER_TTL_MS),
      },
    })
    return res
  }

  async enrollCollect(userId: string, orderRef: string, now: Date): Promise<BankIdCollectResponse> {
    const order = await this.loadLiveOrder(orderRef, 'ENROLL', now)

    // CSRF-SPÄRREN. Ordern är bunden till det konto som STARTADE den, och bara
    // den inloggade användaren själv får fullborda den. En annan användares
    // collect på samma orderRef nekas — även om hen råkat få tag i handtaget.
    if (order.userId !== userId) {
      throw new ForbiddenException('Ordern hör till en annan användare')
    }

    const res = await this.provider.collect(orderRef)
    if (res.status === 'pending')
      return { status: 'pending', ...(res.hintCode ? { hintCode: res.hintCode } : {}) }
    if (res.status === 'failed') {
      await this.consume(orderRef, now)
      return { status: 'failed', reason: res.reason }
    }

    // FÖRSTA RADEN efter mottagandet. Efter de här två uttrycken finns
    // personnumret inte längre i någon variabel vi bär vidare.
    const subjectHash = this.crypto.blindIndex(res.completionData.personalNumber)
    const subjectEnc = this.crypto.encrypt(res.completionData.personalNumber)

    // PRISMA_DEFAULT_TX_LIMITS, uttryckligen: transaktionen gör två skrivningar
    // mot indexerade nycklar och har ingen väntan i sig — den behöver inte
    // pengavägarnas längre fönster. Gränsen står ändå skriven, så nästa läsare
    // ser att den är VALD och inte ärvd (#488).
    await this.prisma.$transaction(async (tx) => {
      // Idempotent: samma person + samma konto en gång. Ett andra försök är
      // inte ett fel — användaren tryckte två gånger.
      await tx.userBankIdIdentity.upsert({
        where: {
          provider_subjectHash_userId: { provider: PROVIDER, subjectHash, userId },
        },
        create: { provider: PROVIDER, subjectHash, subjectEnc, userId, verifiedAt: now },
        // Bara verifieringstidpunkten uppdateras. `subjectEnc` skrivs INTE om:
        // envelopen är redan rätt, och en omskrivning hade bytt IV utan skäl.
        update: { verifiedAt: now },
      })
      await tx.bankIdOrder.updateMany({
        where: { orderRef, consumedAt: null },
        data: { consumedAt: now },
      })
    }, PRISMA_DEFAULT_TX_LIMITS)

    this.logger.log(`[bankid] identitet ansluten till konto ${userId}`)
    return { status: 'complete' }
  }

  // ── Inloggning ────────────────────────────────────────────────────────────

  async loginStart(endUserIp: string, now: Date): Promise<BankIdStartResult> {
    const res = await this.provider.start({ endUserIp })
    await this.prisma.bankIdOrder.create({
      data: {
        orderRef: res.orderRef,
        purpose: 'LOGIN',
        // Ingen userId: en inloggning har per definition ingen användare än.
        expiresAt: new Date(now.getTime() + ORDER_TTL_MS),
      },
    })
    return res
  }

  async loginCollect(orderRef: string, now: Date): Promise<BankIdLoginResponse> {
    await this.loadLiveOrder(orderRef, 'LOGIN', now)

    const res = await this.provider.collect(orderRef)
    if (res.status === 'pending')
      return { status: 'pending', ...(res.hintCode ? { hintCode: res.hintCode } : {}) }
    if (res.status === 'failed') {
      await this.consume(orderRef, now)
      return { status: 'failed', reason: res.reason }
    }

    const subjectHash = this.crypto.blindIndex(res.completionData.personalNumber)
    const konton = await this.accountsFor(subjectHash)

    if (konton.length === 0) {
      // INGET SOM AVSLÖJAR OM PERSONNUMRET FINNS. Samma svar som ett misslyckat
      // BankID, samma svar som ett okänt konto — den som identifierat sig får
      // veta att inloggningen inte gick, inte varför. Samma hållning som
      // `forgot-password` redan har.
      //
      // Ordern förbrukas ändå: en order som identifierat någon får inte kunna
      // spelas om medan ett konto skapas.
      await this.consume(orderRef, now)
      throw new UnauthorizedException('Inloggningen kunde inte slutföras')
    }

    if (konton.length === 1) {
      const konto = konton[0] as (typeof konton)[number]
      await this.consume(orderRef, now)
      return { status: 'complete', tokens: await this.auth.issueTokensForUser(konto.userId) }
    }

    // FLERA KONTON. Ordern förbrukas INTE här — den är auktoriteten för valet,
    // och `chooseToken` ensam räcker inte (se bankid-choose-token.ts, punkt 4).
    return {
      status: 'choose',
      chooseToken: signChooseToken(
        { orderRef, subjectHash },
        this.config.getOrThrow<string>('JWT_SECRET'),
        now,
      ),
      accounts: konton,
    }
  }

  async loginChoose(chooseToken: string, userId: string, now: Date): Promise<TokenPair> {
    const payload = verifyChooseToken(
      chooseToken,
      this.config.getOrThrow<string>('JWT_SECRET'),
      now,
    )
    if (!payload) throw new UnauthorizedException('Valet kunde inte verifieras')

    // Ordern är auktoriteten. En replay av en giltig token mot en förbrukad
    // order avvisas här, oavsett signatur.
    await this.loadLiveOrder(payload.orderRef, 'LOGIN', now)

    // Kontot MÅSTE höra till den identifierade personen. Utan den här raden
    // hade en giltig token kunnat användas för att logga in på vilket konto som
    // helst — token säger "vi vet vem du är", inte "du får vara vem du vill".
    const konton = await this.accountsFor(payload.subjectHash)
    if (!konton.some((k) => k.userId === userId)) {
      throw new ForbiddenException('Kontot hör inte till den identifierade personen')
    }

    await this.consume(payload.orderRef, now)
    return this.auth.issueTokensForUser(userId)
  }

  // ── Hjälpare ──────────────────────────────────────────────────────────────

  private async accountsFor(
    subjectHash: string,
  ): Promise<Array<{ userId: string; organizationName: string; role: string }>> {
    const rader = await this.prisma.userBankIdIdentity.findMany({
      where: { provider: PROVIDER, subjectHash },
      select: {
        userId: true,
        user: { select: { role: true, isActive: true, organization: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    })
    return (
      rader
        // En inaktiverad användare är inte ett konto att logga in på, och ska inte
        // heller synas i kontolistan — den hade avslöjat att kontot finns.
        .filter((r) => r.user.isActive)
        .map((r) => ({
          userId: r.userId,
          organizationName: r.user.organization.name,
          role: r.user.role,
        }))
    )
  }

  /**
   * Hämtar en order som fortfarande FÅR användas: rätt syfte, inte förbrukad,
   * inte utgången.
   *
   * Samma `NotFoundException` för alla tre fallen, och för en order som inte
   * finns. Att skilja dem åt hade låtit någon räkna ut vilka orderRef som
   * existerar.
   */
  private async loadLiveOrder(
    orderRef: string,
    purpose: 'ENROLL' | 'LOGIN',
    now: Date,
  ): Promise<{ userId: string | null }> {
    const order = await this.prisma.bankIdOrder.findUnique({
      where: { orderRef },
      select: { purpose: true, userId: true, consumedAt: true, expiresAt: true },
    })
    if (!order || order.purpose !== purpose || order.consumedAt != null || order.expiresAt <= now) {
      throw new NotFoundException('Ordern finns inte eller är inte längre giltig')
    }
    return { userId: order.userId }
  }

  /**
   * Förbrukar ordern. `updateMany` med `consumedAt: null` i villkoret gör det
   * atomiskt: två samtidiga collect på samma order ger `count 1` och `count 0`,
   * och den som fick 0 har förlorat kapplöpningen.
   */
  private async consume(orderRef: string, now: Date): Promise<void> {
    const res = await this.prisma.bankIdOrder.updateMany({
      where: { orderRef, consumedAt: null },
      data: { consumedAt: now },
    })
    if (res.count === 0) {
      throw new ConflictException('Ordern är redan förbrukad')
    }
  }

  // ── Städning ──────────────────────────────────────────────────────────────
  // ── KLASSIFICERING: B — SKYDDAT AV INVARIANT ─────────────────────────
  // BankIdOrder deleteMany på utgångna rader — idempotent radering, en andra
  // körning träffar noll rader. Samma form och samma skäl som
  // psd2-consent-state-cleanup.
  //
  // Bevakas av check-cron-classification.mjs: ett @Cron utan klassificering
  // fäller CI, och ett B utan namngiven invariant likaså.
  @Cron('15 3 * * *')
  async cleanupExpiredOrders(): Promise<void> {
    await runCronSafely('bankid-order-cleanup', () => this.cleanupExpiredOrdersUnsafe(), {
      logger: this.logger,
      sink: this.cronErrors,
    })
  }

  private async cleanupExpiredOrdersUnsafe(): Promise<void> {
    const res = await this.prisma.bankIdOrder.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    })
    if (res.count > 0) {
      this.logger.log(`[bankid] städade ${res.count} utgångna ordrar`)
    }
  }
}
