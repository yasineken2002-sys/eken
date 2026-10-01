/**
 * Fortnox A — portar och delade typer.
 *
 * Ägarbeslut 2026-10-01: Eveno sköter avier, betalningar och kravflöde; Fortnox
 * är huvudbok. Den här katalogen har två riktningar:
 *
 *  - ÅTERLÄSNING (shadow): Fortnox huvudbok läses med GET och sammanställs till
 *    ett separat, källmärkt underlag. Det ersätter INTE Evenos rapporter.
 *  - EXPORT: Evenos verifikat förhandskontrolleras och köas. Sändning är
 *    avstängd tills Fortnox idempotens/återfinnande är belagt (se export-tjänsten).
 *
 * Inget här bär token till logg, JSON-svar, URL eller AI-kontext. Tokens finns
 * bara i minnet under ett anrop och krypterat i FortnoxConnection.
 *
 * `provider/` (transport mot api.fortnox.se) ägs av en separat leverans. Den
 * här filen definierar bara den smala läsport som återläsningen konsumerar.
 */

export const FORTNOX_AUTH_PROVIDER = Symbol('FORTNOX_AUTH_PROVIDER')
export const FORTNOX_LEDGER_READER = Symbol('FORTNOX_LEDGER_READER')

/** Tokens i klartext — lever endast i minnet mellan provider och kryptering. */
export interface FortnoxTokenSet {
  accessToken: string
  refreshToken: string
  expiresAt: Date
  scope?: string
}

export interface FortnoxAuthProvider {
  readonly name: 'STUB' | 'MOCK' | 'REAL'
  /**
   * Webbläsarens redirect till Fortnox samtyckessida. Bär state och PKCE S256-challenge,
   * aldrig token. (PKCE S256 är dokumenterat av Fortnox; `plain` används aldrig.)
   */
  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string
  exchangeCode(input: {
    code: string
    codeVerifier: string
    redirectUri: string
  }): Promise<FortnoxTokenSet>
  refresh(refreshToken: string): Promise<FortnoxTokenSet>
  revoke(refreshToken: string): Promise<void>
}

/**
 * Fel från auth-providern:
 *  - `rejected`: Fortnox avvisade (ogiltig/återkallad refresh-token) → AUTH_LOST.
 *  - `not_sent`: begäran nådde aldrig Fortnox → bara låset släpps.
 *  - `unknown`: begäran kan ha behandlats (timeout efter sändning). Förnyelse
 *    ROTERAR refresh-token, så den gamla kan vara förbrukad → automatisk
 *    tokenanvändning låses tills återanslutning (AUTH_LOST, REFRESH_OUTCOME_UNKNOWN).
 *  - `rate_limited`: HTTP 429. Bevisar INTE ogiltig token → tokens bevaras och nästa
 *    försök skjuts upp (REFRESH_RATE_LIMITED). Ingen automatisk omförsök i samma
 *    operation. Fortnox faktiska 429-semantik vid förnyelse är oprövad.
 */
export class FortnoxAuthError extends Error {
  /** Sätts BARA när leverantören angett en väntetid; ingen påhittad standard. */
  declare readonly retryAfterMs?: number

  constructor(
    readonly kind: 'rejected' | 'not_sent' | 'unknown' | 'rate_limited',
    retryAfterMs?: number,
  ) {
    super(`Fortnox auth: ${kind}`)
    this.name = 'FortnoxAuthError'
    if (retryAfterMs !== undefined)
      Object.defineProperty(this, 'retryAfterMs', { value: retryAfterMs, enumerable: true })
  }
}

/** Endast GET. Sökvägen är relativ (`/3/...`); URL:er accepteras aldrig. */
export interface FortnoxLedgerReader {
  get<T>(
    accessToken: string,
    path: string,
    query?: Readonly<Record<string, string | number>>,
  ): Promise<T>
}

/**
 * Läsfel utan token, URL eller svarskropp. `auth` (401) stoppar anslutningen,
 * `forbidden` (403, scope/licens saknas) och `transient` (nät/429/5xx/timeout)
 * ger en ofullständig läsning, `invalid` = svaret höll inte schemat.
 */
export class FortnoxReadError extends Error {
  constructor(
    readonly kind: 'auth' | 'forbidden' | 'transient' | 'invalid',
    readonly status?: number,
  ) {
    super(`Fortnox read: ${kind}${status ? ` (${status})` : ''}`)
    this.name = 'FortnoxReadError'
  }
}

// ── Fortnox-resurser (fält ur schemasnapshot d39f8c31…, endast de som används) ──

export interface FortnoxMetaInformation {
  '@CurrentPage'?: unknown
  '@TotalPages'?: unknown
  '@TotalResources'?: unknown
}

export interface FortnoxVoucherRow {
  Account?: unknown
  Debit?: unknown
  Credit?: unknown
  CostCenter?: unknown
  Project?: unknown
  Removed?: unknown
  Description?: unknown
}

export interface FortnoxVoucher {
  Year?: unknown
  VoucherSeries?: unknown
  VoucherNumber?: unknown
  TransactionDate?: unknown
  Description?: unknown
  CostCenter?: unknown
  Project?: unknown
  ReferenceType?: unknown
  ReferenceNumber?: unknown
  VoucherRows?: unknown
}

export const FORTNOX_READ_STATUSES = [
  'COMPLETE',
  'COMPLETE_WITH_UNCERTAINTY',
  'PARTIAL',
  'FAILED',
  'AUTH_LOST',
  'WRONG_COMPANY',
] as const
