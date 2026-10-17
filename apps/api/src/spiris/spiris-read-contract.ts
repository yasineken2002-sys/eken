/** Inert Spiris GET descriptions and projections of already decoded JSON.
 * No transport, credentials, environment, provider activation or Fortnox mapping.
 * Source: saved official openapi/v2.json, SHA256 below. Pagination syntax/max
 * comes from the separately recorded official pagination-copy guide.
 * This validates USED fields, not every field of the upstream resource.
 *
 * Eveno usability rules, stronger than upstream required/minimum declarations:
 * nonblank CompanyIdentifier; year Id/StartDate/EndDate present; positive
 * requested page/PageSize, at most 1000 items, matching page/year, nonnegative
 * totals; a nonempty page cannot be beyond TotalNumberOfPages.
 * Date-time subset: real calendar, year 0001..9999, explicit offset,
 * seconds 00..59 (leap seconds are not supported). Strings remain unchanged.
 * None of these checks verifies company ownership, a complete collection,
 * snapshot consistency, accounting-method meaning or production readiness.
 */
import { types } from 'node:util'

export const SPIRIS_SPEC_SHA256 = '556f1937a3007bcae1149fe9564d9eff26be55a3392db8ec27b9fceaeb0da379'

export type SpirisReadErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_HTTP_STATUS'
  | 'HTTP_ERROR'
  | 'INVALID_RESPONSE'
  | 'YEAR_MISMATCH'

export class SpirisReadContractError extends Error {
  constructor(
    readonly code: SpirisReadErrorCode,
    readonly httpStatus: number | null,
  ) {
    super(`Spiris read contract: ${code}`)
    this.name = 'SpirisReadContractError'
  }
}

export type SpirisPageRequest = Readonly<{ page: number; pageSize: number }>
export type SpirisPageQuery = Readonly<{ $page: number; $pagesize: number }>
export type SpirisCompanySettingsGet = Readonly<{
  provider: 'SPIRIS'
  method: 'GET'
  operation: 'companysettings'
  path: '/companysettings'
}>
export type SpirisFiscalYearsGet = Readonly<{
  provider: 'SPIRIS'
  method: 'GET'
  operation: 'fiscalyears'
  path: '/fiscalyears'
  query: SpirisPageQuery
}>
export type SpirisAccountsGet = Readonly<{
  provider: 'SPIRIS'
  method: 'GET'
  operation: 'accounts-year'
  path: `/accounts/${string}`
  query: SpirisPageQuery
}>
export type SpirisGetDescriptor =
  | SpirisCompanySettingsGet
  | SpirisFiscalYearsGet
  | SpirisAccountsGet

/** Current authenticated company, NOT a company-selection list or verified binding. */
export type SpirisCompanySettings = Readonly<{
  CompanyIdentifier: string
  Name: string
  CountryCode: string
  CorporateIdentityNumber?: string | null
  CurrencyCode?: string | null
  CompanyStatus?: number
}>
export type SpirisFiscalYear = Readonly<{
  Id: string
  StartDate: string
  EndDate: string
  IsLockedForAccounting?: boolean
  BookkeepingMethod?: 0 | 1 | 2
}>
export type SpirisAccount = Readonly<{
  FiscalYearId: string
  Number: string
  Name: string
  IsActive: boolean
  IsBlockedForManualBooking?: boolean
}>
export type SpirisPageMetadata = Readonly<{
  CurrentPage: number
  PageSize: number
  TotalNumberOfPages: number
  TotalNumberOfResults: number
  ServerTimeUtc: string
}>
export type SpirisPage<T> = Readonly<{ Data: readonly T[]; Meta: SpirisPageMetadata }>

type ObjectValue = Record<string, unknown>
type Fault = Readonly<{ code: SpirisReadErrorCode; httpStatus: number | null }>
const REQUEST: Fault = { code: 'INVALID_REQUEST', httpStatus: null }
const RESPONSE: Fault = { code: 'INVALID_RESPONSE', httpStatus: 200 }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const DEFAULT_PAGE: SpirisPageRequest = Object.freeze({ page: 1, pageSize: 100 })

function fail(fault: Fault): never {
  throw new SpirisReadContractError(fault.code, fault.httpStatus)
}
function object(value: unknown, fault: Fault): ObjectValue {
  if (types.isProxy(value) || value === null || typeof value !== 'object' || Array.isArray(value))
    return fail(fault)
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return fail(fault)
  return value as ObjectValue
}
function field(value: ObjectValue | readonly unknown[], key: string, fault: Fault): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor) return undefined
  if (!Object.hasOwn(descriptor, 'value')) return fail(fault)
  return descriptor.value
}
function has(value: ObjectValue, key: string): boolean {
  return Object.hasOwn(value, key)
}
function text(value: unknown, fault: Fault, minimum = 0, maximum = Infinity): string {
  if (typeof value !== 'string') return fail(fault)
  // OpenAPI maxLength counts Unicode characters, not UTF-16 code units.
  let length = 0
  const characters = value[Symbol.iterator]()
  while (!characters.next().done) {
    length++
    if (length > maximum) return fail(fault)
  }
  if (length < minimum) return fail(fault)
  return value
}
function nullableText(value: unknown): string | null {
  return value === null ? null : text(value, RESPONSE)
}
function int32(value: unknown, fault: Fault, minimum = -2_147_483_648): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > 2_147_483_647
  )
    return fail(fault)
  return value
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') return fail(RESPONSE)
  return value
}
function bookkeepingMethod(value: unknown): 0 | 1 | 2 {
  if (value !== 0 && value !== 1 && value !== 2) return fail(RESPONSE)
  return value
}
function uuid(value: unknown, fault: Fault): string {
  if (typeof value !== 'string' || value.length !== 36 || !UUID.test(value)) return fail(fault)
  return value
}
function dateTime(value: unknown): string {
  if (typeof value !== 'string') return fail(RESPONSE)
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    )
  if (!match || match[0] !== value) return fail(RESPONSE)
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3])
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6]) > 59 ||
    (match[7] !== undefined && (Number(match[8]) > 23 || Number(match[9]) > 59))
  )
    return fail(RESPONSE)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (day > days[month - 1]!) return fail(RESPONSE)
  return value
}
function successful(httpStatus: unknown): void {
  if (
    typeof httpStatus !== 'number' ||
    !Number.isInteger(httpStatus) ||
    httpStatus < 100 ||
    httpStatus > 599
  )
    return fail({ code: 'INVALID_HTTP_STATUS', httpStatus: null })
  if (httpStatus !== 200) return fail({ code: 'HTTP_ERROR', httpStatus })
}
function pageRequest(value: unknown): SpirisPageRequest {
  const input = object(value, REQUEST)
  if (
    Object.getOwnPropertyNames(input).some((key) => key !== 'page' && key !== 'pageSize') ||
    Object.getOwnPropertySymbols(input).length !== 0
  )
    return fail(REQUEST)
  const page = int32(field(input, 'page', REQUEST), REQUEST, 1)
  const pageSize = int32(field(input, 'pageSize', REQUEST), REQUEST, 1)
  if (pageSize > 1000) return fail(REQUEST)
  return Object.freeze({ page, pageSize })
}
function query(value: unknown): SpirisPageQuery {
  const request = pageRequest(value)
  return Object.freeze({ $page: request.page, $pagesize: request.pageSize })
}

export function describeCompanySettings(): SpirisCompanySettingsGet {
  return Object.freeze({
    provider: 'SPIRIS',
    method: 'GET',
    operation: 'companysettings',
    path: '/companysettings',
  })
}
export function describeFiscalYears(request: unknown = DEFAULT_PAGE): SpirisFiscalYearsGet {
  return Object.freeze({
    provider: 'SPIRIS',
    method: 'GET',
    operation: 'fiscalyears',
    path: '/fiscalyears',
    query: query(request),
  })
}
export function describeAccountsForYear(
  fiscalYearId: unknown,
  request: unknown = DEFAULT_PAGE,
): SpirisAccountsGet {
  const id = uuid(fiscalYearId, REQUEST)
  const path: SpirisAccountsGet['path'] = `/accounts/${id}`
  return Object.freeze({
    provider: 'SPIRIS',
    method: 'GET',
    operation: 'accounts-year',
    path,
    query: query(request),
  })
}

export function parseCompanySettings(httpStatus: unknown, body: unknown): SpirisCompanySettings {
  successful(httpStatus)
  const source = object(body, RESPONSE)
  const CompanyIdentifier = text(field(source, 'CompanyIdentifier', RESPONSE), RESPONSE, 1)
  if (CompanyIdentifier.trim().length === 0) return fail(RESPONSE)
  return Object.freeze({
    CompanyIdentifier,
    Name: text(field(source, 'Name', RESPONSE), RESPONSE, 0, 100),
    CountryCode: text(field(source, 'CountryCode', RESPONSE), RESPONSE, 0, 2),
    ...(has(source, 'CorporateIdentityNumber')
      ? {
          CorporateIdentityNumber: nullableText(field(source, 'CorporateIdentityNumber', RESPONSE)),
        }
      : {}),
    ...(has(source, 'CurrencyCode')
      ? { CurrencyCode: nullableText(field(source, 'CurrencyCode', RESPONSE)) }
      : {}),
    ...(has(source, 'CompanyStatus')
      ? { CompanyStatus: int32(field(source, 'CompanyStatus', RESPONSE), RESPONSE) }
      : {}),
  })
}
function fiscalYear(value: unknown): SpirisFiscalYear {
  const source = object(value, RESPONSE)
  const method = has(source, 'BookkeepingMethod')
    ? bookkeepingMethod(field(source, 'BookkeepingMethod', RESPONSE))
    : undefined
  return Object.freeze({
    Id: uuid(field(source, 'Id', RESPONSE), RESPONSE),
    StartDate: dateTime(field(source, 'StartDate', RESPONSE)),
    EndDate: dateTime(field(source, 'EndDate', RESPONSE)),
    ...(has(source, 'IsLockedForAccounting')
      ? { IsLockedForAccounting: boolean(field(source, 'IsLockedForAccounting', RESPONSE)) }
      : {}),
    ...(method === undefined ? {} : { BookkeepingMethod: method }),
  })
}
function account(value: unknown, expectedFiscalYearId: string): SpirisAccount {
  const source = object(value, RESPONSE)
  const FiscalYearId = uuid(field(source, 'FiscalYearId', RESPONSE), RESPONSE)
  // UUID textual case does not change identity; neither representation is rewritten.
  if (FiscalYearId.toLowerCase() !== expectedFiscalYearId.toLowerCase())
    return fail({ code: 'YEAR_MISMATCH', httpStatus: 200 })
  return Object.freeze({
    FiscalYearId,
    Number: text(field(source, 'Number', RESPONSE), RESPONSE, 1),
    Name: text(field(source, 'Name', RESPONSE), RESPONSE, 0, 100),
    IsActive: boolean(field(source, 'IsActive', RESPONSE)),
    ...(has(source, 'IsBlockedForManualBooking')
      ? { IsBlockedForManualBooking: boolean(field(source, 'IsBlockedForManualBooking', RESPONSE)) }
      : {}),
  })
}
function page<T>(
  body: unknown,
  requested: SpirisPageRequest,
  item: (value: unknown) => T,
): SpirisPage<T> {
  const source = object(body, RESPONSE)
  const data = field(source, 'Data', RESPONSE)
  if (types.isProxy(data) || !Array.isArray(data)) return fail(RESPONSE)
  const rawMeta = object(field(source, 'Meta', RESPONSE), RESPONSE)
  const Meta: SpirisPageMetadata = Object.freeze({
    CurrentPage: int32(field(rawMeta, 'CurrentPage', RESPONSE), RESPONSE, 1),
    PageSize: int32(field(rawMeta, 'PageSize', RESPONSE), RESPONSE, 1),
    TotalNumberOfPages: int32(field(rawMeta, 'TotalNumberOfPages', RESPONSE), RESPONSE, 0),
    TotalNumberOfResults: int32(field(rawMeta, 'TotalNumberOfResults', RESPONSE), RESPONSE, 0),
    ServerTimeUtc: dateTime(field(rawMeta, 'ServerTimeUtc', RESPONSE)),
  })
  if (
    Meta.CurrentPage !== requested.page ||
    Meta.PageSize !== requested.pageSize ||
    (data.length > 0 && Meta.TotalNumberOfPages < Meta.CurrentPage) ||
    data.length > requested.pageSize ||
    data.length > Meta.TotalNumberOfResults
  )
    return fail(RESPONSE)
  // No guessed relation between pages/results, empty-last-page convention,
  // complete flag, next link, snapshot ID or cross-page consistency guarantee.
  const Data: T[] = []
  for (let i = 0; i < data.length; i++) Data.push(item(field(data, String(i), RESPONSE)))
  return Object.freeze({ Data: Object.freeze(Data), Meta })
}
export function parseFiscalYearsPage(
  httpStatus: unknown,
  body: unknown,
  requested: SpirisPageRequest,
): SpirisPage<SpirisFiscalYear> {
  successful(httpStatus)
  return page(body, pageRequest(requested), fiscalYear)
}
export function parseAccountsPage(
  httpStatus: unknown,
  body: unknown,
  expectedFiscalYearId: string,
  requested: SpirisPageRequest,
): SpirisPage<SpirisAccount> {
  successful(httpStatus)
  const expected = uuid(expectedFiscalYearId, REQUEST)
  return page(body, pageRequest(requested), (value) => account(value, expected))
}
