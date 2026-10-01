import { FortnoxTransport } from './provider/fortnox-transport'
import { FortnoxTransportError } from './provider/fortnox-transport.types'
import { FortnoxReadError, type FortnoxLedgerReader } from './fortnox.types'

/**
 * Läsport ovanpå den granskade transporten (provider/, TRANSPORT v2).
 *
 * Endast GET. `rateLimitKey` är stabil klient- + företagsidentitet, aldrig token.
 * Felen översätts utan token, URL eller svarstext:
 *   401 → auth (anslutningen stoppas), 403 → forbidden (scope/licens),
 *   429/5xx/nät/tidsgräns → transient, ogiltigt svar/övriga 4xx → invalid.
 *
 * INTE inkopplad i DI i denna version: modulens factory har ingen skarp väg
 * (se fortnox-providers.ts). Adaptern finns för att kedjan ska vara provad.
 */
export class TransportLedgerReader implements FortnoxLedgerReader {
  constructor(
    private readonly transport: Pick<FortnoxTransport, 'request'>,
    private readonly rateLimitKey: string,
  ) {}

  async get<T>(
    accessToken: string,
    path: string,
    query?: Readonly<Record<string, string | number>>,
  ): Promise<T> {
    try {
      const res = await this.transport.request<T>({
        accessToken,
        rateLimitKey: this.rateLimitKey,
        method: 'GET',
        path,
        ...(query ? { query } : {}),
      })
      return res.data
    } catch (err) {
      throw toReadError(err)
    }
  }
}

export function toReadError(err: unknown): FortnoxReadError {
  if (err instanceof FortnoxTransportError) {
    if (err.status === 401) return new FortnoxReadError('auth', 401)
    if (err.status === 403) return new FortnoxReadError('forbidden', 403)
    if (err.code === 'INVALID_RESPONSE' || err.code === 'INVALID_REQUEST') {
      return new FortnoxReadError('invalid', err.status)
    }
    if (
      err.code === 'HTTP_ERROR' &&
      err.status !== undefined &&
      err.status < 500 &&
      err.status !== 429
    ) {
      return new FortnoxReadError('invalid', err.status)
    }
    return new FortnoxReadError('transient', err.status)
  }
  return new FortnoxReadError('transient')
}
