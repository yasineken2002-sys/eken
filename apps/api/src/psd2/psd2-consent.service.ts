import { Injectable, Inject, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as crypto from 'crypto'
import { PrismaService } from '../common/prisma/prisma.service'
import { BankConsentCryptoService } from './bank-consent-crypto.service'
import { PSD2_PROVIDER, type BankDataProvider } from './psd2.types'

// Consent-state lever kort (SCA-redirecten ska ske direkt). 15 min räcker väl.
const STATE_TTL_MS = 15 * 60 * 1000

/**
 * Allow-list: de ENDA BankConsent-fält som får lämna backend. Tokens
 * (accessTokenEnc/refreshTokenEnc), scope och cursor är MEDVETET uteslutna och
 * når ALDRIG frontend/AI. (Mönster från tenant-portal-läcktätningen / signering.)
 */
export const SAFE_BANK_CONSENT_SELECT = {
  id: true,
  provider: true,
  status: true,
  expiresAt: true,
  lastSyncedAt: true,
  revokedAt: true,
  createdAt: true,
} as const

@Injectable()
export class Psd2ConsentService {
  private readonly logger = new Logger(Psd2ConsentService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: BankConsentCryptoService,
    private readonly config: ConfigService,
    @Inject(PSD2_PROVIDER) private readonly provider: BankDataProvider,
  ) {}

  private callbackUrl(): string {
    return (
      this.config.get<string>('PSD2_CALLBACK_URL') ??
      'http://localhost:3000/v1/reconciliation/psd2/callback'
    )
  }

  /** Frontend-URL dit callbacken redirectar tillbaka användaren efter samtycke. */
  appReturnUrl(ok: boolean): string {
    const base =
      this.config.get<string>('PSD2_APP_RETURN_URL') ??
      'http://localhost:5173/reconciliation/settings'
    return `${base}?psd2=${ok ? 'ok' : 'error'}`
  }

  // ── Starta samtycke (SCA-redirect) ────────────────────────────────────────────
  // Lagrar en engångs-`state` (CSRF-bindning) med organizationId server-side och
  // returnerar bankens authUrl. organizationId tas ALDRIG från callback-queryn.
  async beginConsent(organizationId: string, userId: string | null): Promise<{ authUrl: string }> {
    const state = crypto.randomBytes(32).toString('hex')
    await this.prisma.psd2ConsentState.create({
      data: {
        state,
        organizationId,
        provider: this.provider.name,
        ...(userId ? { initiatedByUserId: userId } : {}),
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      },
    })

    const { authUrl } = await this.provider.beginConsent({
      organizationId,
      state,
      redirectUri: this.callbackUrl(),
    })
    return { authUrl }
  }

  // ── Callback (efter bankens SCA) ──────────────────────────────────────────────
  // Validerar `state` single-use + ej utgången, hämtar organizationId HÄRIFRÅN
  // (server-lagrat), växlar koden mot tokens och lagrar dem KRYPTERADE i BankConsent.
  async handleCallback(state: string, code: string): Promise<{ organizationId: string }> {
    if (!state || !code) throw new BadRequestException('Saknar state eller code')

    // Atomisk single-use-claim: consumedAt=null + ej utgången → sätt consumedAt.
    // En parallell/replayad callback får count=0 och avvisas.
    const claimed = await this.prisma.psd2ConsentState.updateMany({
      where: { state, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    })
    if (claimed.count !== 1) {
      throw new BadRequestException('Ogiltig, förbrukad eller utgången consent-state')
    }

    const stateRow = await this.prisma.psd2ConsentState.findUniqueOrThrow({ where: { state } })
    const organizationId = stateRow.organizationId // server-lagrat, aldrig från query

    const tokens = await this.provider.exchangeCallback({ code, state })

    await this.prisma.bankConsent.upsert({
      where: {
        organizationId_provider_consentId: {
          organizationId,
          provider: this.provider.name,
          consentId: tokens.consentId,
        },
      },
      create: {
        organizationId,
        provider: this.provider.name,
        consentId: tokens.consentId,
        status: 'ACTIVE',
        accessTokenEnc: this.crypto.encrypt(tokens.accessToken),
        ...(tokens.refreshToken
          ? { refreshTokenEnc: this.crypto.encrypt(tokens.refreshToken) }
          : {}),
        ...(tokens.scope ? { scope: tokens.scope } : {}),
        ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
        ...(stateRow.initiatedByUserId ? { createdByUserId: stateRow.initiatedByUserId } : {}),
      },
      update: {
        status: 'ACTIVE',
        accessTokenEnc: this.crypto.encrypt(tokens.accessToken),
        refreshTokenEnc: tokens.refreshToken ? this.crypto.encrypt(tokens.refreshToken) : null,
        ...(tokens.scope ? { scope: tokens.scope } : {}),
        ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
        revokedAt: null,
      },
    })

    this.logger.log(
      `[psd2] samtycke lagrat för org ${organizationId} (provider ${this.provider.name})`,
    )
    return { organizationId }
  }

  // ── Läs samtycken (safe — ALDRIG tokens) ──────────────────────────────────────
  async listConsents(organizationId: string) {
    return this.prisma.bankConsent.findMany({
      where: { organizationId },
      select: SAFE_BANK_CONSENT_SELECT,
      orderBy: { createdAt: 'desc' },
    })
  }

  // ── Återkalla samtycke ────────────────────────────────────────────────────────
  async revokeConsent(organizationId: string, consentId: string, _userId: string | null) {
    const consent = await this.prisma.bankConsent.findFirst({
      where: { id: consentId, organizationId },
    })
    if (!consent) throw new NotFoundException('Samtycket hittades inte')

    if (consent.status !== 'REVOKED') {
      try {
        await this.provider.revokeConsent({
          consentId: consent.consentId,
          accessToken: this.crypto.decrypt(consent.accessTokenEnc),
        })
      } catch (err) {
        // Providern kan redan ha återkallat samtycket sitt håll — logga, men
        // markera ändå som återkallat lokalt (idempotent avslut).
        this.logger.warn(
          `[psd2] provider.revokeConsent misslyckades för ${consent.id}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    await this.prisma.bankConsent.update({
      where: { id: consent.id },
      data: { status: 'REVOKED', revokedAt: new Date() },
    })
    return { revoked: true }
  }
}
