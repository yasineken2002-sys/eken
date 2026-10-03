import { FortnoxReadError, type FortnoxVoucher } from './fortnox.types'
import type { MockFortnoxLedgerReader } from './fortnox-providers'
import type { FortnoxRateLimiter } from './provider/fortnox-transport.types'

/**
 * ENDAST PROV. Syntetisk Fortnox-HTTP-yta som `fetch`, så att den skarpa
 * transporten, läsaren och skrivaren provas med riktiga Request/Response-objekt.
 * Data ligger i en MockFortnoxLedgerReader (samma huvudbok för läsning och
 * skrivning). Ingen nätverkstrafik.
 */
export type FakeFortnoxFault =
  | 'drop_response_after_write'
  | 'status_500_after_write'
  | 'status_400'
  | 'status_429'
  | 'network_error_before_write'
  | 'wrong_year_after_write'
  | 'no_number_after_write'

export const noopRateLimiter: FortnoxRateLimiter = {
  acquire: async () => undefined,
  defer: () => undefined,
}

export class FakeFortnoxApi {
  /** POST-anrop som nådde ytan (oavsett utfall). */
  posts = 0
  /** Poster som faktiskt skapats i huvudboken. */
  writes = 0
  requests: Array<{ method: string; path: string; query: Record<string, string> }> = []
  faults: FakeFortnoxFault[] = []
  /** n-te GET /3/companyinformation (1-baserat) svarar med detta DatabaseNumber. */
  companyOverride = new Map<number, number>()
  /** n-te GET /3/companyinformation svarar med denna HTTP-status. */
  companyStatus = new Map<number, number>()
  companyCalls = 0
  /** Körs precis innan en POST skapar posten (barriär för prov). */
  beforeWrite: (() => Promise<void>) | null = null
  /** Körs när en POST når ytan, före utfall (prov: kontrollera anspråket i DB). */
  onPost: ((body: unknown) => Promise<void>) | null = null

  constructor(readonly ledger: MockFortnoxLedgerReader) {}

  readonly fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    if (url.origin !== 'https://api.fortnox.se') throw new TypeError('fake: fel origin')
    if (init?.redirect !== 'error') throw new TypeError('fake: omdirigering måste vara error')
    const method = String(init?.method ?? 'GET')
    const query = Object.fromEntries(url.searchParams.entries())
    this.requests.push({ method, path: url.pathname, query })
    const auth = new Headers(init?.headers).get('authorization') ?? ''
    const token = auth.replace(/^Bearer /, '')
    if (method === 'POST') return this.post(url, query, init)
    if (url.pathname === '/3/companyinformation') {
      this.companyCalls += 1
      const status = this.companyStatus.get(this.companyCalls)
      if (status) return json({ ErrorInformation: { message: 'x' } }, status)
      const override = this.companyOverride.get(this.companyCalls)
      if (override !== undefined) {
        return json({
          CompanyInformation: { ...this.ledger.company, DatabaseNumber: override },
        })
      }
    }
    try {
      const q: Record<string, string | number> = {}
      for (const [k, v] of Object.entries(query)) q[k] = /^\d+$/.test(v) ? Number(v) : v
      return json(await this.ledger.get(token, url.pathname, q))
    } catch (err) {
      if (err instanceof FortnoxReadError)
        return json({ ErrorInformation: { message: 'x' } }, err.status ?? 404)
      throw err
    }
  }

  private async post(url: URL, query: Record<string, string>, init?: RequestInit) {
    this.posts += 1
    if (this.onPost) await this.onPost(JSON.parse(String(init?.body)))
    if (url.pathname !== '/3/vouchers') return json({ ErrorInformation: {} }, 404)
    const fault = this.faults.shift()
    if (fault === 'network_error_before_write') throw new TypeError('fetch failed')
    if (fault === 'status_400') return json({ ErrorInformation: { message: 'x' } }, 400)
    if (fault === 'status_429') return json({ ErrorInformation: { message: 'x' } }, 429)
    if (this.beforeWrite) await this.beforeWrite()
    const year = Number(query.financialyear)
    const v = (JSON.parse(String(init?.body)) as { Voucher: Record<string, unknown> }).Voucher
    const series = String(v.VoucherSeries)
    const number =
      Math.max(
        0,
        ...this.ledger.vouchers
          .filter((x) => x.VoucherSeries === series && x.Year === year)
          .map((x) => Number(x.VoucherNumber)),
      ) + 1
    const created: FortnoxVoucher = {
      Year: year,
      VoucherSeries: series,
      VoucherNumber: number,
      TransactionDate: v.TransactionDate,
      Description: v.Description,
      VoucherRows: structuredClone(v.VoucherRows),
    }
    this.ledger.vouchers.push(created)
    this.writes += 1
    if (fault === 'drop_response_after_write') throw new TypeError('fetch failed')
    if (fault === 'status_500_after_write') return json({ ErrorInformation: {} }, 500)
    if (fault === 'wrong_year_after_write')
      return json({ Voucher: { ...created, Year: year + 1 } }, 201)
    if (fault === 'no_number_after_write')
      return json({ Voucher: { ...created, VoucherNumber: undefined } }, 201)
    return json({ Voucher: structuredClone(created) }, 201)
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
