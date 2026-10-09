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
  /**
   * OBSERVERAT [O], ingen specifikation: exakt H3H4-REAL-002 svar-0112 (sha bdf57baa…), 400 med
   * ErrorInformation { error: 1, message: «Värdet innehåller ej tillåtna tecken. (<Description>)»,
   * code: 2000359 }, oavsett innehåll. Inget skapas.
   */
  | 'observerad_2000359_h3h4_real_002'

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
  /** Prov: ändra svaret på GET /3/vouchers/sublist (t.ex. ofullständig sidinformation). */
  listTamper: ((body: Record<string, unknown>, query: Record<string, string>) => unknown) | null =
    null
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
      const body = await this.ledger.get<Record<string, unknown>>(token, url.pathname, q)
      if (this.listTamper && url.pathname === '/3/vouchers/sublist')
        return json(this.listTamper(body, query))
      return json(body)
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
    if (fault === 'observerad_2000359_h3h4_real_002') {
      const d = (JSON.parse(String(init?.body)) as { Voucher?: { Description?: unknown } }).Voucher
      return json(
        {
          ErrorInformation: {
            error: 1,
            message: `Värdet innehåller ej tillåtna tecken. (${String(d?.Description)})`,
            code: 2000359,
          },
        },
        400,
      )
    }
    if (this.beforeWrite) await this.beforeWrite()
    const year = Number(query.financialyear)
    const v = (JSON.parse(String(init?.body)) as { Voucher: Record<string, unknown> }).Voucher
    // MÄTT mot Fortnox 2026-10-03T01:20:44Z (testföretag 1868238, execute-001, svar-0069
    // sha256 3f7e5ec11437dd55…): Voucher.Year i
    // POST-kroppen avvisas 400 / 2000321 "Fältet Year är endast läsbart." — trots att
    // OpenAPI anger fältet som obligatoriskt. Ytan får inte maskera ett skrivskyddat fält.
    if (Object.hasOwn(v ?? {}, 'Year'))
      return json(
        {
          ErrorInformation: { error: 1, message: 'Fältet Year är endast läsbart.', code: 2000321 },
        },
        400,
      )
    // [K] KÄLLA, inte observation — TESTKUND-016: Fortnox «Formats & Encoding», avsnitt Valid characters (hämtad 2026-10-09, kvitto
    // CLAUDE1/bevis/016-prov/kalla, regex sha b18d69cb…). Text utanför listan avvisas med det verkliga
    // formatet (H3H4-REAL-002 svar-0112: 400 / 2000359). Listan återges ordagrant; i u-läge skalas bara
    // de ogiltiga escapes \! \@ \’ av (samma tecken). U+2014 ingår inte; kolon, &, é, U+2013 ingår.
    const giltig =
      /^[\p{L}’\\\u{0308}\u{030a}a-zåäöéáœæøüA-ZÅÄÖÉÁÜŒÆØ0-9 –:.`´’,;^¤#%§£$€¢¥©™°&/()=+\-*_!?²³®½@\u{00a0}\n\r]*$/u
    const ogiltig = (text: unknown) => typeof text === 'string' && !giltig.test(text)
    const avvisa = (varde: string) =>
      json(
        {
          ErrorInformation: {
            error: 1,
            message: `Värdet innehåller ej tillåtna tecken. (${varde})`,
            code: 2000359,
          },
        },
        400,
      )
    if (ogiltig(v.Description)) return avvisa(String(v.Description))
    for (const r of (v.VoucherRows as Array<Record<string, unknown>> | undefined) ?? [])
      if (ogiltig(r.TransactionInformation)) return avvisa(String(r.TransactionInformation))
    if (ogiltig(v.Comments)) return avvisa(String(v.Comments))
    const series = String(v.VoucherSeries)
    const number =
      Math.max(
        0,
        ...this.ledger.vouchers
          .filter((x) => x.VoucherSeries === series && x.Year === year)
          .map((x) => Number(x.VoucherNumber)),
      ) + 1
    // Radform MÄTT live (execute-002, svar-0070-GET-vouchers_A_1, sha256 bfc70f…, 1868238) och
    // i guidens svarsexempel: radens Description är KONTOTS benämning, TransactionInformation är
    // radtexten och '' när ingen text skickats, och både Debit och Credit finns (0 på motsidan).
    const created: FortnoxVoucher = {
      Year: year,
      VoucherSeries: series,
      VoucherNumber: number,
      TransactionDate: v.TransactionDate,
      Description: v.Description,
      // Verkliga svar (H3H4-REAL-002 A9–A11, sublist i E2-B-REAL-001) bär Comments.
      Comments: typeof v.Comments === 'string' ? v.Comments : null,
      VoucherRows: (v.VoucherRows as Array<Record<string, unknown>>).map((r) => {
        const { Description: _ignorerad, ...rest } = structuredClone(r)
        void _ignorerad
        const konto = this.ledger.accounts.find((a) => a.Number === r.Account)
        return {
          ...rest,
          Debit: rest.Debit ?? 0,
          Credit: rest.Credit ?? 0,
          TransactionInformation: rest.TransactionInformation ?? '',
          Description: konto?.Description ?? '',
        }
      }),
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
