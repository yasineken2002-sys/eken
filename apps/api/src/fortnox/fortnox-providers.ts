import { ServiceUnavailableException } from '@nestjs/common'
import { createHash } from 'crypto'
import { ConfigService } from '@nestjs/config'
import { FortnoxTokenCryptoService } from './fortnox-token-crypto.service'
import {
  FortnoxAuthError,
  FortnoxReadError,
  type FortnoxAuthProvider,
  type FortnoxLedgerReader,
  type FortnoxTokenSet,
  type FortnoxVoucher,
} from './fortnox.types'

/**
 * Val av provider. Fyra utfall, samma form som PSD2/BankID:
 *
 *   FORTNOX_ENABLED != 'true'                         → Stub (503 på varje väg)
 *   på, men FORTNOX_TOKEN_KEY saknas/ogiltig          → kastar (fail-fast vid boot)
 *   på + FORTNOX_PROVIDER=mock och NODE_ENV=test      → Mock (prov, syntetisk)
 *   på + FORTNOX_PROVIDER=real + klient-id/hemlighet/https-callback → REAL
 *   på i övrigt (inkl. real med saknad konfiguration) → kastar vid boot
 *
 * Den skarpa vägen är byggd men AVSTÄNGD tills den uttryckligen konfigureras.
 * Verklig anslutning kräver bekräftat testföretag, utvecklarlicens och godkänd
 * hemlighetshantering — inget av det är gjort i denna leverans (NOT_RUN).
 */
export type FortnoxMode = 'STUB' | 'MOCK' | 'REAL'

/** Uppgifter för den skarpa vägen. Läses bara när REAL uttryckligen är vald. */
export interface FortnoxRealConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
}

export function fortnoxRealConfig(config: ConfigService): FortnoxRealConfig {
  const clientId = config.get<string>('FORTNOX_CLIENT_ID') ?? ''
  const clientSecret = config.get<string>('FORTNOX_CLIENT_SECRET') ?? ''
  const redirectUri = config.get<string>('FORTNOX_CALLBACK_URL') ?? ''
  let https = false
  try {
    https = new URL(redirectUri).protocol === 'https:'
  } catch {
    https = false
  }
  // Felmeddelandet namnger saknade NYCKLAR, aldrig värden.
  const missing = [
    !clientId && 'FORTNOX_CLIENT_ID',
    !clientSecret && 'FORTNOX_CLIENT_SECRET',
    !https && 'FORTNOX_CALLBACK_URL (https)',
  ].filter(Boolean)
  if (missing.length) {
    throw new Error(`[fortnox] FORTNOX_PROVIDER=real men saknar ${missing.join(', ')} — fail-fast.`)
  }
  return { clientId, clientSecret, redirectUri }
}

export function fortnoxMode(config: ConfigService, crypto: FortnoxTokenCryptoService): FortnoxMode {
  if (config.get<string>('FORTNOX_ENABLED') !== 'true') return 'STUB'
  if (!crypto.configured) {
    throw new Error(
      '[fortnox] FORTNOX_ENABLED=true men FORTNOX_TOKEN_KEY saknas/ogiltig — fail-fast.',
    )
  }
  // Mock bara vid NODE_ENV=test + uttryckligt val. Aldrig av NODE_ENV=development
  // eller saknad konfiguration: en falsk anslutning får inte uppstå i en
  // produktionslik miljö (SAMORDNING-04).
  const provider = config.get<string>('FORTNOX_PROVIDER')
  if (provider === 'mock' && config.get<string>('NODE_ENV') === 'test') return 'MOCK'
  // Skarp väg ENDAST vid uttryckligt FORTNOX_PROVIDER=real och komplett konfiguration.
  // Aldrig default: påslaget utan uttryckligt val stoppar vid boot.
  if (provider === 'real') {
    fortnoxRealConfig(config)
    return 'REAL'
  }
  throw new Error(
    '[fortnox] FORTNOX_ENABLED=true kräver uttryckligt FORTNOX_PROVIDER=real (eller mock i test). ' +
      'Sätt FORTNOX_ENABLED=false.',
  )
}

const DISABLED = 'Fortnox-kopplingen är inte aktiverad'

export class StubFortnoxAuthProvider implements FortnoxAuthProvider {
  readonly name = 'STUB' as const
  authorizeUrl(): string {
    throw new ServiceUnavailableException(DISABLED)
  }
  exchangeCode(): Promise<FortnoxTokenSet> {
    throw new ServiceUnavailableException(DISABLED)
  }
  refresh(): Promise<FortnoxTokenSet> {
    throw new ServiceUnavailableException(DISABLED)
  }
  revoke(): Promise<void> {
    throw new ServiceUnavailableException(DISABLED)
  }
}

export class StubFortnoxLedgerReader implements FortnoxLedgerReader {
  get<T>(): Promise<T> {
    throw new ServiceUnavailableException(DISABLED)
  }
}

/**
 * Syntetisk auth för dev/E2E och prov. Koden är engångs; tokens är löpnummer
 * utan värde utanför processen. `failRefresh` styr provens felutfall.
 */
export class MockFortnoxAuthProvider implements FortnoxAuthProvider {
  readonly name = 'MOCK' as const
  private n = 0
  readonly issuedCodes = new Set<string>()
  readonly calls = { exchange: 0, refresh: 0, revoke: 0 }
  failRefresh: null | 'rejected' | 'not_sent' | 'unknown' | 'rate_limited' = null
  /** challenge per utfärdad kod — exchange kräver matchande verifier (S256). */
  private readonly challenges = new Map<string, string>()
  expiresInMs = 3600_000
  /** Beviljade scopes i tokensvaret (prov kan snäva in). */
  scope = 'companyinformation bookkeeping costcenter project'
  now: () => number = () => Date.now()

  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string {
    const code = `mock-code-${input.state.slice(0, 8)}`
    this.issuedCodes.add(code)
    this.challenges.set(code, input.codeChallenge)
    const q = new URLSearchParams({
      state: input.state,
      redirect_uri: input.redirectUri,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    })
    return `https://mock.fortnox.invalid/oauth-v1/auth?${q.toString()}`
  }

  private tokens(): FortnoxTokenSet {
    this.n += 1
    return {
      accessToken: `mock-access-${this.n}`,
      refreshToken: `mock-refresh-${this.n}`,
      expiresAt: new Date(this.now() + this.expiresInMs),
      scope: this.scope,
    }
  }

  async exchangeCode(input: { code: string; codeVerifier: string }): Promise<FortnoxTokenSet> {
    this.calls.exchange += 1
    const challenge = this.challenges.get(input.code)
    if (!this.issuedCodes.delete(input.code)) throw new FortnoxAuthError('rejected')
    if (challenge !== pkceChallenge(input.codeVerifier)) throw new FortnoxAuthError('rejected')
    return this.tokens()
  }

  async refresh(refreshToken: string): Promise<FortnoxTokenSet> {
    this.calls.refresh += 1
    if (this.failRefresh) throw new FortnoxAuthError(this.failRefresh)
    if (!refreshToken.startsWith('mock-refresh-')) throw new FortnoxAuthError('rejected')
    return this.tokens()
  }

  async revoke(): Promise<void> {
    this.calls.revoke += 1
  }
}

/**
 * Syntetisk huvudbok (Fortnox-formade svar) för dev/E2E. Sidstorlek och sidparametrar
 * är ANTAGANDEN (H1); verklig semantik är oprövad tills sandbox finns.
 */
export class MockFortnoxLedgerReader implements FortnoxLedgerReader {
  company = {
    CompanyName: 'Syntetiskt Testbolag AB',
    OrganizationNumber: '556000-0001',
    DatabaseNumber: 900001,
  }
  costCenters: string[] = ['HUSA', 'HUSB']
  financialYears = [{ Id: 1, FromDate: '2026-01-01', ToDate: '2026-12-31' }]
  accounts: Array<{ Number: number; Active: boolean; Description?: string }> = [
    { Number: 2440, Active: true, Description: 'Leverantörsskulder' },
    { Number: 5170, Active: true, Description: 'Reparation och underhåll av fastighet' },
  ]
  projects: Array<{ ProjectNumber: string; Description: string }> = []
  voucherSeries: string[] = ['A', 'L']
  vouchers: FortnoxVoucher[] = []
  pageSize = 2
  /** Prov: kasta på anrop nr N (1-baserat). */
  failOnCall: { n: number; error: FortnoxReadError } | null = null
  /** Prov: körs före anrop nr N. */
  hooks = new Map<number, () => void>()
  calls: string[] = []
  validTokens: ((t: string) => boolean) | null = null

  async get<T>(
    accessToken: string,
    path: string,
    query?: Readonly<Record<string, string | number>>,
  ): Promise<T> {
    this.calls.push(path)
    const n = this.calls.length
    this.hooks.get(n)?.()
    if (this.failOnCall?.n === n) throw this.failOnCall.error
    if (this.validTokens && !this.validTokens(accessToken)) throw new FortnoxReadError('auth', 401)
    const page = Number(query?.page ?? 1)
    if (path === '/3/companyinformation') return { CompanyInformation: { ...this.company } } as T
    if (path === '/3/costcenters') {
      return this.paged(
        this.costCenters.map((Code) => ({ Code, Active: true })),
        'CostCenters',
        page,
      ) as T
    }
    if (path === '/3/vouchers/sublist') return this.paged(this.vouchers, 'Vouchers', page) as T
    // Katalogvägar (lista/detalj) — syntetiska, samma sidantagande (H1).
    if (path === '/3/financialyears')
      return this.paged(this.financialYears, 'FinancialYears', page) as T
    if (path === '/3/accounts') return this.paged(this.accounts, 'Accounts', page) as T
    if (path === '/3/projects') return this.paged(this.projects, 'Projects', page) as T
    const ccd = /^\/3\/costcenters\/([A-Za-z0-9_-]+)$/.exec(path)
    if (ccd) {
      if (!this.costCenters.includes(ccd[1] ?? '')) throw new FortnoxReadError('invalid', 404)
      return { CostCenter: { Code: ccd[1], Active: true } } as T
    }
    const vsd = /^\/3\/voucherseries\/([A-Za-z0-9_-]+)$/.exec(path)
    if (vsd) {
      if (!this.voucherSeries.includes(vsd[1] ?? '')) throw new FortnoxReadError('invalid', 404)
      return {
        VoucherSeries: { Code: vsd[1], Description: 'Serie', Year: query?.financialyear },
      } as T
    }
    const prd = /^\/3\/projects\/(\d+)$/.exec(path)
    if (prd) {
      const p = this.projects.find((x) => x.ProjectNumber === prd[1])
      if (!p) throw new FortnoxReadError('invalid', 404)
      return { Project: { ...p } } as T
    }
    const fy = /^\/3\/financialyears\/(\d+)$/.exec(path)
    if (fy) {
      const y = this.financialYears.find((x) => x.Id === Number(fy[1]))
      if (!y) throw new FortnoxReadError('invalid', 404)
      return { FinancialYear: { ...y } } as T
    }
    const acc = /^\/3\/accounts\/(\d+)$/.exec(path)
    if (acc) {
      const a = this.accounts.find((x) => x.Number === Number(acc[1]))
      if (!a) throw new FortnoxReadError('invalid', 404)
      return { Account: { ...a, Year: query?.financialyear } } as T
    }
    const m = /^\/3\/vouchers\/([A-Za-z0-9]+)\/(\d+)$/.exec(path)
    if (m) {
      const v = this.vouchers.find(
        (x) => x.VoucherSeries === m[1] && x.VoucherNumber === Number(m[2]),
      )
      if (!v) throw new FortnoxReadError('invalid', 404)
      return { Voucher: structuredClone(v) } as T
    }
    throw new FortnoxReadError('invalid', 404)
  }

  private paged(items: unknown[], key: string, page: number) {
    const totalPages = Math.max(1, Math.ceil(items.length / this.pageSize))
    return {
      MetaInformation: {
        '@CurrentPage': page,
        '@TotalPages': totalPages,
        '@TotalResources': items.length,
      },
      [key]: structuredClone(items.slice((page - 1) * this.pageSize, page * this.pageSize)),
    }
  }
}

/** RFC 7636 S256: base64url(SHA-256(verifier)) utan utfyllnad. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}
