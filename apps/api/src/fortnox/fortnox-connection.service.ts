import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as crypto from 'crypto'
import { PrismaService } from '../common/prisma/prisma.service'
import { FortnoxTokenCryptoService } from './fortnox-token-crypto.service'
import { pkceChallenge } from './fortnox-providers'
import {
  FORTNOX_AUTH_PROVIDER,
  FORTNOX_LEDGER_READER,
  FortnoxAuthError,
  type FortnoxAuthProvider,
  type FortnoxLedgerReader,
  type FortnoxTokenSet,
} from './fortnox.types'

const STATE_TTL_MS = 10 * 60 * 1000
/** Förnya när mindre än så här återstår av access-token. */
const REFRESH_MARGIN_MS = 60 * 1000
/** Hur länge en förnyare äger låset innan en annan får ta över. */
const REFRESH_LEASE_MS = 30 * 1000
/** Uppskjutning efter 429 utan Retry-After, och tak för en angiven. */
const RATE_LIMIT_DEFAULT_MS = 60 * 1000
const RATE_LIMIT_MAX_MS = 15 * 60 * 1000

/**
 * De ENDA FortnoxConnection-fält som får lämna backend. Tokens, tokenVersion och
 * låset är medvetet uteslutna (samma mönster som SAFE_BANK_CONSENT_SELECT).
 */
export const SAFE_FORTNOX_CONNECTION_SELECT = {
  id: true,
  status: true,
  fortnoxDatabaseNumber: true,
  fortnoxOrgNumber: true,
  fortnoxCompanyName: true,
  exportVoucherSeries: true,
  connectedAt: true,
  disconnectedAt: true,
  lastErrorClass: true,
  lastErrorAt: true,
} as const

export class FortnoxNotConnectedError extends Error {
  constructor(
    readonly reason:
      | 'NO_CONNECTION'
      | 'AUTH_LOST'
      | 'DISCONNECTED'
      | 'REFRESH_IN_PROGRESS'
      | 'REFRESH_RATE_LIMITED',
  ) {
    super(`Fortnox: ${reason}`)
    this.name = 'FortnoxNotConnectedError'
  }
}

interface CompanyInformation {
  CompanyInformation?: {
    CompanyName?: unknown
    OrganizationNumber?: unknown
    DatabaseNumber?: unknown
  }
}

/** Normaliserar orgnr till 10 siffror för jämförelse; null om formen inte går att lita på. */
export function normalizeOrgNumber(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const digits = value.replace(/\D/g, '')
  return digits.length === 10 ? digits : digits.length === 12 ? digits.slice(2) : null
}

@Injectable()
export class FortnoxConnectionService {
  private readonly logger = new Logger(FortnoxConnectionService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: FortnoxTokenCryptoService,
    private readonly config: ConfigService,
    @Inject(FORTNOX_AUTH_PROVIDER) private readonly auth: FortnoxAuthProvider,
    @Inject(FORTNOX_LEDGER_READER) private readonly reader: FortnoxLedgerReader,
  ) {}

  get enabled(): boolean {
    return this.auth.name !== 'STUB'
  }

  private redirectUri(): string {
    return (
      this.config.get<string>('FORTNOX_CALLBACK_URL') ??
      'http://localhost:3000/v1/integrations/fortnox/callback'
    )
  }

  appReturnUrl(ok: boolean): string {
    const base =
      this.config.get<string>('FORTNOX_APP_RETURN_URL') ?? 'http://localhost:5173/settings/fortnox'
    return `${base}?fortnox=${ok ? 'ok' : 'error'}`
  }

  // ── Starta anslutning ──────────────────────────────────────────────────────
  // organizationId och användare lagras server-side bakom en slumpad engångs-state.
  async begin(organizationId: string, userId: string): Promise<{ authUrl: string }> {
    if (!this.enabled) throw new ServiceUnavailableException('Fortnox-kopplingen är inte aktiverad')
    const state = crypto.randomBytes(32).toString('hex')
    // PKCE: 64 tecken base64url (inom 43–128, endast unreserved), bunden till state.
    const codeVerifier = crypto.randomBytes(48).toString('base64url')
    await this.prisma.fortnoxOAuthState.create({
      data: {
        state,
        organizationId,
        initiatedByUserId: userId,
        codeVerifierEnc: this.crypto.encrypt(codeVerifier),
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      },
    })
    return {
      authUrl: this.auth.authorizeUrl({
        state,
        codeChallenge: pkceChallenge(codeVerifier),
        redirectUri: this.redirectUri(),
      }),
    }
  }

  // ── Callback ───────────────────────────────────────────────────────────────
  // 1. Atomisk engångs-claim av state (parallell/replayad callback får count=0).
  // 2. Org läses ur state-raden, aldrig ur query.
  // 3. Koden växlas; företaget läses med den NYA token innan något sparas.
  // 4. Fel företag (annat DatabaseNumber än tidigare anslutning, eller orgnr som
  //    inte matchar Evenos organisation) → inget sparas.
  async handleCallback(state: string, code: string): Promise<{ organizationId: string }> {
    if (!state || !code) throw new BadRequestException('Saknar state eller code')
    const claimed = await this.prisma.fortnoxOAuthState.updateMany({
      where: { state, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    })
    if (claimed.count !== 1) {
      throw new BadRequestException('Ogiltig, förbrukad eller utgången anslutningsbegäran')
    }
    const row = await this.prisma.fortnoxOAuthState.findUniqueOrThrow({ where: { state } })
    const organizationId = row.organizationId

    const tokens = await this.auth.exchangeCode({
      code,
      codeVerifier: this.crypto.decrypt(row.codeVerifierEnc),
      redirectUri: this.redirectUri(),
    })
    const info = await this.reader.get<CompanyInformation>(
      tokens.accessToken,
      '/3/companyinformation',
    )
    const ci = info.CompanyInformation ?? {}
    const databaseNumber = ci.DatabaseNumber
    if (
      typeof databaseNumber !== 'number' ||
      !Number.isInteger(databaseNumber) ||
      databaseNumber <= 0
    ) {
      await this.bestEffortRevoke(tokens)
      throw new BadRequestException('Fortnox-företagets identitet kunde inte fastställas')
    }

    const [org, existing] = await Promise.all([
      this.prisma.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { orgNumber: true },
      }),
      this.prisma.fortnoxConnection.findUnique({ where: { organizationId } }),
    ])
    const fortnoxOrg = normalizeOrgNumber(ci.OrganizationNumber)
    const evenoOrg = normalizeOrgNumber(org.orgNumber)
    const mismatch =
      (existing && existing.fortnoxDatabaseNumber !== databaseNumber) ||
      (evenoOrg !== null && fortnoxOrg !== null && evenoOrg !== fortnoxOrg)
    if (mismatch) {
      await this.bestEffortRevoke(tokens)
      if (existing) {
        await this.prisma.fortnoxConnection.update({
          where: { organizationId },
          data: { lastErrorClass: 'COMPANY_MISMATCH', lastErrorAt: new Date() },
        })
      }
      throw new ConflictException(
        'Fortnox-företaget matchar inte organisationen eller den tidigare anslutningen',
      )
    }

    const enc = {
      accessTokenEnc: this.crypto.encrypt(tokens.accessToken),
      refreshTokenEnc: this.crypto.encrypt(tokens.refreshToken),
      accessTokenExpiresAt: tokens.expiresAt,
      scope: tokens.scope ?? null,
    }
    const company = {
      fortnoxDatabaseNumber: databaseNumber,
      fortnoxOrgNumber: typeof ci.OrganizationNumber === 'string' ? ci.OrganizationNumber : null,
      fortnoxCompanyName: typeof ci.CompanyName === 'string' ? ci.CompanyName : null,
    }
    await this.prisma.fortnoxConnection.upsert({
      where: { organizationId },
      create: {
        organizationId,
        status: 'ACTIVE',
        ...company,
        ...enc,
        connectedByUserId: row.initiatedByUserId,
      },
      update: {
        status: 'ACTIVE',
        ...company,
        ...enc,
        tokenVersion: { increment: 1 },
        refreshLeaseUntil: null,
        lastErrorClass: null,
        lastErrorAt: null,
        connectedByUserId: row.initiatedByUserId,
        connectedAt: new Date(),
        disconnectedAt: null,
      },
    })
    this.logger.log(
      `[fortnox] anslutning lagrad för org ${organizationId} (företag ${databaseNumber})`,
    )
    return { organizationId }
  }

  async status(organizationId: string) {
    return this.prisma.fortnoxConnection.findUnique({
      where: { organizationId },
      select: SAFE_FORTNOX_CONNECTION_SELECT,
    })
  }

  // ── Access-token för ett anrop ──────────────────────────────────────────────
  // Förnyelse sker under CAS-lås: den som tar låset (lease + oförändrad version)
  // förnyar och höjer tokenVersion. Förlorare förnyar ALDRIG själva — de läser om
  // och får antingen den nya token eller REFRESH_IN_PROGRESS.
  async accessToken(
    organizationId: string,
    opts: {
      /**
       * P-F1: Fortnox svarade 401 på en token med denna version. Har versionen redan
       * höjts (någon annan förnyade) används den nya token; annars förnyas EN gång
       * under samma CAS-lås, oavsett återstående livstid.
       */
      afterUnauthorizedVersion?: number
    } = {},
  ): Promise<{
    token: string
    connectionId: string
    databaseNumber: number
    tokenVersion: number
  }> {
    const conn = await this.prisma.fortnoxConnection.findUnique({ where: { organizationId } })
    if (!conn) throw new FortnoxNotConnectedError('NO_CONNECTION')
    if (conn.status !== 'ACTIVE') throw new FortnoxNotConnectedError(conn.status)
    const ids = { connectionId: conn.id, databaseNumber: conn.fortnoxDatabaseNumber }
    const now = Date.now()
    const forced = opts.afterUnauthorizedVersion !== undefined
    if (forced && conn.tokenVersion !== opts.afterUnauthorizedVersion) {
      return {
        token: this.crypto.decrypt(conn.accessTokenEnc),
        ...ids,
        tokenVersion: conn.tokenVersion,
      }
    }
    if (
      !forced &&
      conn.accessTokenExpiresAt &&
      conn.accessTokenExpiresAt.getTime() - now > REFRESH_MARGIN_MS
    ) {
      return {
        token: this.crypto.decrypt(conn.accessTokenEnc),
        ...ids,
        tokenVersion: conn.tokenVersion,
      }
    }

    const lease = await this.prisma.fortnoxConnection.updateMany({
      where: {
        id: conn.id,
        status: 'ACTIVE',
        tokenVersion: conn.tokenVersion,
        OR: [{ refreshLeaseUntil: null }, { refreshLeaseUntil: { lt: new Date(now) } }],
      },
      data: { refreshLeaseUntil: new Date(now + REFRESH_LEASE_MS) },
    })
    if (lease.count !== 1) {
      const fresh = await this.prisma.fortnoxConnection.findUnique({ where: { organizationId } })
      if (fresh && fresh.status === 'ACTIVE' && fresh.tokenVersion !== conn.tokenVersion) {
        return {
          token: this.crypto.decrypt(fresh.accessTokenEnc),
          ...ids,
          tokenVersion: fresh.tokenVersion,
        }
      }
      if (fresh && fresh.status !== 'ACTIVE') throw new FortnoxNotConnectedError(fresh.status)
      if (fresh?.lastErrorClass === 'REFRESH_RATE_LIMITED') {
        throw new FortnoxNotConnectedError('REFRESH_RATE_LIMITED')
      }
      throw new FortnoxNotConnectedError('REFRESH_IN_PROGRESS')
    }

    let tokens: FortnoxTokenSet
    try {
      tokens = await this.auth.refresh(this.crypto.decrypt(conn.refreshTokenEnc ?? ''))
    } catch (err) {
      if (err instanceof FortnoxAuthError && err.kind === 'rate_limited') {
        // 429: tokens BEVARAS. Låset hålls kvar till uppskjutningens slut, så att
        // ingen annan förnyar under tiden (kontrollerad senareläggning, ingen retry).
        const delay = Math.min(
          Math.max(err.retryAfterMs ?? RATE_LIMIT_DEFAULT_MS, 1000),
          RATE_LIMIT_MAX_MS,
        )
        await this.prisma.fortnoxConnection.updateMany({
          where: { id: conn.id, tokenVersion: conn.tokenVersion },
          data: {
            refreshLeaseUntil: new Date(Date.now() + delay),
            lastErrorClass: 'REFRESH_RATE_LIMITED',
            lastErrorAt: new Date(),
          },
        })
        throw new FortnoxNotConnectedError('REFRESH_RATE_LIMITED')
      }
      if (err instanceof FortnoxAuthError && err.kind === 'not_sent') {
        await this.prisma.fortnoxConnection.updateMany({
          where: { id: conn.id, tokenVersion: conn.tokenVersion },
          data: {
            refreshLeaseUntil: null,
            lastErrorClass: 'REFRESH_NOT_SENT',
            lastErrorAt: new Date(),
          },
        })
        throw new FortnoxNotConnectedError('REFRESH_IN_PROGRESS')
      }
      // Avvisad ELLER okänt utfall: refresh-token kan vara förbrukad (rotation).
      // Ingen automatisk tokenanvändning förrän kunden ansluter igen.
      const unknown = err instanceof FortnoxAuthError && err.kind === 'unknown'
      await this.markAuthLost(organizationId, unknown ? 'REFRESH_OUTCOME_UNKNOWN' : 'AUTH_REJECTED')
      throw new FortnoxNotConnectedError('AUTH_LOST')
    }
    const saved = await this.prisma.fortnoxConnection.updateMany({
      where: { id: conn.id, status: 'ACTIVE', tokenVersion: conn.tokenVersion },
      data: {
        accessTokenEnc: this.crypto.encrypt(tokens.accessToken),
        refreshTokenEnc: this.crypto.encrypt(tokens.refreshToken),
        accessTokenExpiresAt: tokens.expiresAt,
        tokenVersion: { increment: 1 },
        refreshLeaseUntil: null,
      },
    })
    // Anslutningen kopplades från/ersattes under förnyelsen: använd inte token.
    if (saved.count !== 1) throw new FortnoxNotConnectedError('DISCONNECTED')
    return { token: tokens.accessToken, ...ids, tokenVersion: conn.tokenVersion + 1 }
  }

  /**
   * Kundens uttryckliga val av verifikatserie för export. Verifieras i det anslutna
   * Fortnox-företaget innan det sparas. Ändrar inget i Fortnox.
   */
  async setExportVoucherSeries(
    organizationId: string,
    code: unknown,
  ): Promise<{ exportVoucherSeries: string }> {
    if (typeof code !== 'string' || !/^[A-Za-z0-9]{1,8}$/.test(code)) {
      throw new BadRequestException('Ogiltig verifikatserie')
    }
    let auth: Awaited<ReturnType<FortnoxConnectionService['accessToken']>>
    try {
      auth = await this.accessToken(organizationId)
    } catch (err) {
      if (err instanceof FortnoxNotConnectedError)
        throw new ConflictException('Fortnox är inte anslutet')
      throw err
    }
    let found: unknown
    try {
      const body = await this.reader.get<{ VoucherSeries?: { Code?: unknown } }>(
        auth.token,
        `/3/voucherseries/${code}`,
      )
      found = body?.VoucherSeries?.Code
    } catch {
      found = undefined
    }
    if (found !== code) throw new BadRequestException('Verifikatserien finns inte i Fortnox')
    await this.prisma.fortnoxConnection.updateMany({
      where: { organizationId, id: auth.connectionId, status: 'ACTIVE' },
      data: { exportVoucherSeries: code },
    })
    return { exportVoucherSeries: code }
  }

  /** 401 vid läsning eller avvisad förnyelse: stoppa arbetet och nolla tokens. */
  async markAuthLost(organizationId: string, errorClass: string): Promise<void> {
    await this.prisma.fortnoxConnection.updateMany({
      where: { organizationId, status: 'ACTIVE' },
      data: {
        status: 'AUTH_LOST',
        accessTokenEnc: '',
        refreshTokenEnc: null,
        accessTokenExpiresAt: null,
        refreshLeaseUntil: null,
        lastErrorClass: errorClass,
        lastErrorAt: new Date(),
      },
    })
  }

  // ── Frånkoppling ───────────────────────────────────────────────────────────
  // Lokalt avslut sker alltid (idempotent). Återkallelse av refresh-token hos
  // Fortnox är best effort. En redan utgiven access-token återkallas INTE av
  // Fortnox (code-flow); den slutar gälla vid sin livslängd (≤1 h). Eveno
  // använder den inte efter frånkoppling eftersom den nollas här.
  // Historiska läsningar/exporter behålls; företagsidentiteten står kvar så att en
  // återanslutning till ANNAT företag kan stoppas.
  async disconnect(organizationId: string): Promise<{ disconnected: true }> {
    const conn = await this.prisma.fortnoxConnection.findUnique({ where: { organizationId } })
    if (!conn) throw new NotFoundException('Ingen Fortnox-anslutning')
    if (conn.refreshTokenEnc) {
      try {
        await this.auth.revoke(this.crypto.decrypt(conn.refreshTokenEnc))
      } catch (err) {
        this.logger.warn(
          `[fortnox] återkallelse misslyckades för org ${organizationId}: ${errorName(err)}`,
        )
      }
    }
    await this.prisma.fortnoxConnection.update({
      where: { organizationId },
      data: {
        status: 'DISCONNECTED',
        accessTokenEnc: '',
        refreshTokenEnc: null,
        accessTokenExpiresAt: null,
        refreshLeaseUntil: null,
        tokenVersion: { increment: 1 },
        disconnectedAt: new Date(),
      },
    })
    return { disconnected: true }
  }

  private async bestEffortRevoke(tokens: FortnoxTokenSet): Promise<void> {
    try {
      await this.auth.revoke(tokens.refreshToken)
    } catch (err) {
      this.logger.warn(
        `[fortnox] återkallelse efter avvisad anslutning misslyckades: ${errorName(err)}`,
      )
    }
  }
}

/** Loggar aldrig felmeddelanden från providern — de kan bära upstream-text. */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'okänt fel'
}
