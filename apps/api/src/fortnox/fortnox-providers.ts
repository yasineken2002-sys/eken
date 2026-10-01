import { ServiceUnavailableException } from '@nestjs/common'
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
 *   på + FORTNOX_PROVIDER=mock utanför production     → Mock (dev/E2E, syntetisk)
 *   på i övrigt                                       → kastar: skarp adapter är
 *                                                       inte inkopplad i denna version
 *
 * Den skarpa vägen är en AVSIKTLIG spärr, inte en glömd gren: verklig anslutning
 * kräver bekräftat testföretag, utvecklarlicens och godkänd hemlighetshantering.
 */
export type FortnoxMode = 'STUB' | 'MOCK'

export function fortnoxMode(config: ConfigService, crypto: FortnoxTokenCryptoService): FortnoxMode {
  if (config.get<string>('FORTNOX_ENABLED') !== 'true') return 'STUB'
  if (!crypto.configured) {
    throw new Error(
      '[fortnox] FORTNOX_ENABLED=true men FORTNOX_TOKEN_KEY saknas/ogiltig — fail-fast.',
    )
  }
  const wantsMock = config.get<string>('FORTNOX_PROVIDER') === 'mock'
  if (wantsMock && config.get<string>('NODE_ENV') !== 'production') return 'MOCK'
  throw new Error(
    '[fortnox] skarp Fortnox-adapter är inte inkopplad (kräver verifierat testföretag och åtkomst). ' +
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
  failRefresh: null | 'rejected' | 'transient' = null
  expiresInMs = 3600_000
  now: () => number = () => Date.now()

  authorizeUrl(input: { state: string; redirectUri: string }): string {
    const code = `mock-code-${input.state.slice(0, 8)}`
    this.issuedCodes.add(code)
    const q = new URLSearchParams({ state: input.state, redirect_uri: input.redirectUri })
    return `https://mock.fortnox.invalid/oauth-v1/auth?${q.toString()}`
  }

  private tokens(): FortnoxTokenSet {
    this.n += 1
    return {
      accessToken: `mock-access-${this.n}`,
      refreshToken: `mock-refresh-${this.n}`,
      expiresAt: new Date(this.now() + this.expiresInMs),
      scope: 'companyinformation bookkeeping costcenter',
    }
  }

  async exchangeCode(input: { code: string }): Promise<FortnoxTokenSet> {
    this.calls.exchange += 1
    if (!this.issuedCodes.delete(input.code)) throw new FortnoxAuthError('rejected')
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
