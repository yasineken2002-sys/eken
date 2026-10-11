import { FortnoxTransportError } from './fortnox-transport.types'
import type { FortnoxTransportRequest } from './fortnox-transport.types'

const ORIGIN = 'https://api.fortnox.se'
const globalQuery = [
  'page',
  'limit',
  'offset',
  'lastmodified',
  'financialyear',
  'financialyeardate',
]
const listQueries: Record<string, readonly string[]> = {
  companyinformation: [],
  financialyears: [...globalQuery, 'date', 'Date'],
  accounts: [...globalQuery, 'sortby', 'sortorder', 'sru'],
  costcenters: globalQuery,
  projects: [...globalQuery, 'description', 'projectleader'],
  voucherseries: globalQuery,
  vouchers: [...globalQuery, 'costcenter', 'fromdate', 'todate', 'voucherseries'],
  supplierinvoices: [
    ...globalQuery,
    'tofinalpaydate',
    'fromfinalpaydate',
    'filter',
    'suppliernumber',
    'suppliername',
    'ocr',
    'invoicenumber',
    'serialnumber',
    'costcenter',
    'project',
    'ourreference',
    'yourreference',
    'fromdate',
    'todate',
  ],
}

export function prepareFortnoxRequest(
  input: FortnoxTransportRequest,
  allowVoucherWrites: boolean,
): {
  url: string
  body: string | undefined
  method: 'GET' | 'POST'
  accessToken: string
  rateLimitKey: string
  signal: AbortSignal | undefined
} {
  let rejection: 'INVALID_REQUEST' | 'WRITE_DISABLED' = 'INVALID_REQUEST'
  try {
    // Read every caller property once BEFORE any nested getter, query iteration or toJSON.
    // Only this private plain snapshot is subsequently validated and used for dispatch.
    const request = {
      method: input.method,
      path: input.path,
      accessToken: input.accessToken,
      rateLimitKey: input.rateLimitKey,
      signal: input.signal,
      query: input.query,
      body: input.body,
    }
    if (request.signal !== undefined) {
      // Native getter performs the brand check without executing caller shadow getters.
      Reflect.get(AbortSignal.prototype, 'aborted', request.signal)
    }
    const invalid = () => new FortnoxTransportError('INVALID_REQUEST', 'not_sent', 0)
    if (
      !request ||
      typeof request.path !== 'string' ||
      typeof request.accessToken !== 'string' ||
      !/^[A-Za-z0-9._~+/-]+=*$/.test(request.accessToken) ||
      typeof request.rateLimitKey !== 'string' ||
      !request.rateLimitKey.trim() ||
      request.rateLimitKey.length > 256 ||
      /[\x00-\x1f\x7f]/.test(request.rateLimitKey)
    )
      throw invalid()
    // Match raw input before URL normalization; no encoded slashes/dots, absolute URLs or fragments.
    if (!/^\/3\/[a-z]+(?:\/[A-Za-z0-9_-]+){0,2}$/.test(request.path)) throw invalid()
    let allowedQuery: readonly string[]
    if (request.method === 'POST') {
      if (request.path !== '/3/vouchers') throw invalid()
      if (!allowVoucherWrites) {
        rejection = 'WRITE_DISABLED'
        throw invalid()
      }
      if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body))
        throw invalid()
      allowedQuery = ['financialyear']
    } else if (request.method === 'GET') {
      if (request.body !== undefined) throw invalid()
      const list = /^\/3\/([a-z]+)$/.exec(request.path)?.[1]
      if (list && Object.hasOwn(listQueries, list)) {
        allowedQuery = listQueries[list]!
      } else if (
        /^\/3\/(?:accounts|financialyears|projects|supplierinvoices)\/\d+$/.test(request.path) ||
        /^\/3\/(?:costcenters|voucherseries)\/[A-Za-z0-9_-]+$/.test(request.path) ||
        /^\/3\/vouchers\/[A-Za-z0-9_-]+\/\d+$/.test(request.path) ||
        /^\/3\/vouchers\/sublist(?:\/[A-Za-z0-9_-]+)?$/.test(request.path)
      ) {
        allowedQuery = request.path.includes('/sublist')
          ? listQueries.vouchers!
          : ['financialyear', 'financialyeardate']
      } else throw invalid()
    } else throw invalid()

    const url = new URL(request.path, ORIGIN)
    if (
      request.query !== undefined &&
      (!request.query || typeof request.query !== 'object' || Array.isArray(request.query))
    )
      throw invalid()
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (
        !allowedQuery.includes(key) ||
        !['string', 'number', 'boolean'].includes(typeof value) ||
        (typeof value === 'number' && !Number.isFinite(value)) ||
        String(value).length > 1024 ||
        /[\x00-\x1f\x7f]/.test(String(value))
      )
        throw invalid()
      if (['page', 'limit', 'offset', 'financialyear'].includes(key)) {
        if (
          !/^\d+$/.test(String(value)) ||
          !Number.isSafeInteger(Number(value)) ||
          Number(value) < (key === 'offset' ? 0 : 1) ||
          (key === 'limit' && Number(value) > 500)
        )
          throw invalid()
      }
      url.searchParams.set(key, String(value))
    }
    if (url.origin !== ORIGIN || url.pathname !== request.path) throw invalid()
    let body: string | undefined
    try {
      body = request.method === 'POST' ? JSON.stringify(request.body) : undefined
    } catch {
      throw invalid()
    }
    if (request.method === 'POST' && body === undefined) throw invalid()
    return {
      url: url.toString(),
      body,
      method: request.method,
      accessToken: request.accessToken,
      rateLimitKey: request.rateLimitKey,
      signal: request.signal,
    }
  } catch {
    // No upstream getter/toJSON exception, including a forged transport error, can escape.
    throw new FortnoxTransportError(rejection, 'not_sent', 0)
  }
}
