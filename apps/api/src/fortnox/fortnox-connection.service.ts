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
import { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
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
/** Scopes som MÅSTE vara beviljade för att anslutningen ska bli ACTIVE (C-F05). */
export const FORTNOX_REQUIRED_SCOPES = [
  'companyinformation',
  'bookkeeping',
  'costcenter',
  'project',
] as const
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
  exportOmitDimensionsAt: true,
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
    const current = await this.prisma.fortnoxConnection.findUnique({
      where: { organizationId },
      select: { generation: true },
    })
    await this.prisma.fortnoxOAuthState.create({
      data: {
        state,
        organizationId,
        initiatedByUserId: userId,
        // C-F03: callbacken får bara skriva om anslutningen fortfarande har denna generation.
        expectedGeneration: current?.generation ?? null,
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

    const refuse = async (message: string, errorClass: string): Promise<never> => {
      await this.bestEffortRevoke(tokens)
      await this.prisma.fortnoxConnection.updateMany({
        where: { organizationId },
        data: { lastErrorClass: errorClass, lastErrorAt: new Date() },
      })
      throw new ConflictException(message)
    }

    // C-F05: alla nödvändiga scopes måste vara FAKTISKT beviljade (tokensvaret).
    const granted = new Set((tokens.scope ?? '').split(/\s+/).filter(Boolean))
    const missingScopes = FORTNOX_REQUIRED_SCOPES.filter((s) => !granted.has(s))
    if (missingScopes.length) {
      await refuse(
        `Fortnox beviljade inte nödvändig behörighet (${missingScopes.join(', ')})`,
        'SCOPE_MISSING',
      )
    }

    // C-F04: är Evenos orgnr känt måste Fortnox ange ett giltigt, lika orgnr.
    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { orgNumber: true },
    })
    const fortnoxOrg = normalizeOrgNumber(ci.OrganizationNumber)
    const evenoOrg = normalizeOrgNumber(org.orgNumber)
    if (evenoOrg !== null && fortnoxOrg !== evenoOrg) {
      await refuse(
        'Fortnox-företagets organisationsnummer matchar inte organisationen',
        'COMPANY_MISMATCH',
      )
    }

    const enc = {
      accessTokenEnc: this.crypto.encrypt(tokens.accessToken),
      refreshTokenEnc: this.crypto.encrypt(tokens.refreshToken),
      accessTokenExpiresAt: tokens.expiresAt,
      scope: tokens.scope ?? null,
    }
    const company = {
      fortnoxOrgNumber: typeof ci.OrganizationNumber === 'string' ? ci.OrganizationNumber : null,
      fortnoxCompanyName: typeof ci.CompanyName === 'string' ? ci.CompanyName : null,
    }
    const activate = {
      status: 'ACTIVE' as const,
      ...company,
      ...enc,
      tokenVersion: { increment: 1 },
      refreshLeaseUntil: null,
      refreshAttemptId: null,
      lastErrorClass: null,
      lastErrorAt: null,
      connectedByUserId: row.initiatedByUserId,
      connectedAt: new Date(),
      disconnectedAt: null,
    }

    // C-F03: lagring är ATOMISK och bunden till generation + företag.
    //  - fanns en anslutning när state skapades: CAS på (generation, DatabaseNumber);
    //    frånkoppling däremellan (generation höjd) eller annat företag → avvisas.
    //  - fanns ingen: skapa; samtidig förstagångscallback ger unikhetskrock → läs den
    //    vinnande raden och acceptera BARA samma företag via samma CAS.
    let stored = false
    if (row.expectedGeneration === null) {
      try {
        await this.prisma.fortnoxConnection.create({
          data: {
            organizationId,
            status: 'ACTIVE',
            fortnoxDatabaseNumber: databaseNumber,
            ...company,
            ...enc,
            connectedByUserId: row.initiatedByUserId,
          },
        })
        stored = true
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'))
          throw err
      }
    }
    if (!stored) {
      const existing = await this.prisma.fortnoxConnection.findUnique({ where: { organizationId } })
      if (!existing) await refuse('Anslutningsbegäran är inaktuell; försök igen', 'STALE_CONNECT')
      if (existing!.fortnoxDatabaseNumber !== databaseNumber) {
        await refuse('Fortnox-företaget matchar inte den tidigare anslutningen', 'COMPANY_MISMATCH')
      }
      // D01: en förstagångsinloggning (ingen anslutning när state skapades) får bara
      // ansluta sig till generation 0 — aldrig adoptera en senare generation som
      // uppstått genom frånkoppling under tiden.
      if (row.expectedGeneration === null && existing!.generation !== 0) {
        await refuse('Anslutningen ändrades under inloggningen; försök igen', 'STALE_CONNECT')
      }
      const generation = row.expectedGeneration ?? 0
      const res = await this.prisma.fortnoxConnection.updateMany({
        where: { organizationId, generation, fortnoxDatabaseNumber: databaseNumber },
        data: activate,
      })
      if (res.count !== 1)
        await refuse('Anslutningen ändrades under inloggningen; försök igen', 'STALE_CONNECT')
    }
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

    // C-F01: ett försök registreras BESTÄNDIGT innan anropet. Låset kan bara tas om
    // inget oavslutat försök finns och ett eventuellt uppskjutningsfönster passerat.
    const attemptId = crypto.randomUUID()
    const lease = await this.prisma.fortnoxConnection.updateMany({
      where: {
        id: conn.id,
        status: 'ACTIVE',
        tokenVersion: conn.tokenVersion,
        refreshAttemptId: null,
        OR: [{ refreshLeaseUntil: null }, { refreshLeaseUntil: { lt: new Date(now) } }],
      },
      data: { refreshLeaseUntil: new Date(now + REFRESH_LEASE_MS), refreshAttemptId: attemptId },
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
      // Ett tidigare försök har gått ut utan registrerat utfall (krasch eller sparfel
      // efter att Fortnox kan ha roterat token). Den gamla refresh-token får INTE
      // återanvändas → beständigt stopp tills återanslutning.
      if (
        fresh?.refreshAttemptId &&
        fresh.refreshLeaseUntil &&
        fresh.refreshLeaseUntil.getTime() < now
      ) {
        await this.markAuthLost(organizationId, 'REFRESH_OUTCOME_UNKNOWN', {
          connectionId: fresh.id,
          tokenVersion: fresh.tokenVersion,
          refreshAttemptId: fresh.refreshAttemptId,
        })
        throw new FortnoxNotConnectedError('AUTH_LOST')
      }
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
        // 429: tokens BEVARAS; försöket avslutas som SÄKERT (inget skickat som roterat).
        // Låset hålls till uppskjutningens slut (kontrollerad senareläggning, ingen retry).
        const delay = Math.min(
          Math.max(err.retryAfterMs ?? RATE_LIMIT_DEFAULT_MS, 1000),
          RATE_LIMIT_MAX_MS,
        )
        await this.prisma.fortnoxConnection.updateMany({
          where: {
            organizationId,
            id: conn.id,
            tokenVersion: conn.tokenVersion,
            refreshAttemptId: attemptId,
          },
          data: {
            refreshAttemptId: null,
            refreshLeaseUntil: new Date(Date.now() + delay),
            lastErrorClass: 'REFRESH_RATE_LIMITED',
            lastErrorAt: new Date(),
          },
        })
        throw new FortnoxNotConnectedError('REFRESH_RATE_LIMITED')
      }
      if (err instanceof FortnoxAuthError && err.kind === 'not_sent') {
        await this.prisma.fortnoxConnection.updateMany({
          where: {
            organizationId,
            id: conn.id,
            tokenVersion: conn.tokenVersion,
            refreshAttemptId: attemptId,
          },
          data: {
            refreshAttemptId: null,
            refreshLeaseUntil: null,
            lastErrorClass: 'REFRESH_NOT_SENT',
            lastErrorAt: new Date(),
          },
        })
        throw new FortnoxNotConnectedError('REFRESH_IN_PROGRESS')
      }
      // Avvisad ELLER okänt utfall: refresh-token kan vara förbrukad (rotation).
      // C-F02: stoppet gäller BARA den anslutning/version/det försök som ägde anropet.
      const unknown = err instanceof FortnoxAuthError && err.kind === 'unknown'
      await this.markAuthLost(
        organizationId,
        unknown ? 'REFRESH_OUTCOME_UNKNOWN' : 'AUTH_REJECTED',
        {
          connectionId: conn.id,
          tokenVersion: conn.tokenVersion,
          refreshAttemptId: attemptId,
        },
      )
      throw new FortnoxNotConnectedError('AUTH_LOST')
    }
    const saved = await this.prisma.fortnoxConnection.updateMany({
      where: {
        organizationId,
        id: conn.id,
        tokenVersion: conn.tokenVersion,
        refreshAttemptId: attemptId,
        status: 'ACTIVE',
      },
      data: {
        accessTokenEnc: this.crypto.encrypt(tokens.accessToken),
        refreshTokenEnc: this.crypto.encrypt(tokens.refreshToken),
        accessTokenExpiresAt: tokens.expiresAt,
        tokenVersion: { increment: 1 },
        refreshLeaseUntil: null,
        refreshAttemptId: null,
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

  /**
   * E2: kundens uttryckliga beslut (OWNER/ADMIN) att exportera UTAN kostnadsställe
   * och projekt. Sparas med vem och när; utan beslut blockerar förhandskontrollen.
   */
  async setExportOmitDimensions(organizationId: string, userId: string, omit: unknown) {
    if (omit !== true && omit !== false) throw new BadRequestException('Ogiltigt dimensionsbeslut')
    const res = await this.prisma.fortnoxConnection.updateMany({
      where: { organizationId, status: 'ACTIVE' },
      data: omit
        ? { exportOmitDimensionsAt: new Date(), exportOmitDimensionsBy: userId }
        : { exportOmitDimensionsAt: null, exportOmitDimensionsBy: null },
    })
    if (res.count !== 1) throw new ConflictException('Fortnox är inte anslutet')
    return { omitDimensions: omit }
  }

  /**
   * 401 som består efter förnyelse, avvisad eller okänd förnyelse: stoppa arbetet och
   * nolla tokens. C-F02: bunden till den anslutning och tokenversion (och i
   * förekommande fall det försök) som observerade felet — ett gammalt svar kan
   * aldrig stoppa en NYARE anslutning.
   */
  async markAuthLost(
    organizationId: string,
    errorClass: string,
    expect: { connectionId: string; tokenVersion: number; refreshAttemptId?: string },
  ): Promise<void> {
    await this.prisma.fortnoxConnection.updateMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        id: expect.connectionId,
        tokenVersion: expect.tokenVersion,
        ...(expect.refreshAttemptId ? { refreshAttemptId: expect.refreshAttemptId } : {}),
      },
      data: {
        status: 'AUTH_LOST',
        accessTokenEnc: '',
        refreshTokenEnc: null,
        accessTokenExpiresAt: null,
        refreshLeaseUntil: null,
        refreshAttemptId: null,
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
    // C-F03: frånkoppling och invalidering av väntande inloggningar i EN transaktion;
    // generationen höjs så att en pågående callback inte kan återaktivera.
    await this.prisma.$transaction(async (tx) => {
      await tx.fortnoxConnection.update({
        where: { organizationId },
        data: {
          status: 'DISCONNECTED',
          accessTokenEnc: '',
          refreshTokenEnc: null,
          accessTokenExpiresAt: null,
          refreshLeaseUntil: null,
          refreshAttemptId: null,
          tokenVersion: { increment: 1 },
          generation: { increment: 1 },
          disconnectedAt: new Date(),
        },
      })
      await tx.fortnoxOAuthState.updateMany({
        where: { organizationId, consumedAt: null },
        data: { consumedAt: new Date() },
      })
    }, PRISMA_DEFAULT_TX_LIMITS)
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
