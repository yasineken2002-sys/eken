/** Entirely synthetic projections. Source contract snapshot:
 * spiris-openapi-v2.json, SHA256
 * 556f1937a3007bcae1149fe9564d9eff26be55a3392db8ec27b9fceaeb0da379.
 * These are local contract tests, not authenticated provider evidence.
 */
import {
  describeAccountsForYear,
  describeCompanySettings,
  describeFiscalYears,
  parseAccountsPage,
  parseCompanySettings,
  parseFiscalYearsPage,
  SpirisReadContractError,
  type SpirisPageRequest,
  type SpirisReadErrorCode,
} from './spiris-read-contract'

const YEAR = '00abcdef-1234-5678-9abc-1234567890ab'
const OTHER_YEAR = '00abcdef-1234-5678-9abc-1234567890ac'
const REQUEST: SpirisPageRequest = { page: 1, pageSize: 100 }
const SENTINEL = 'SYNTHETIC_PRIVATE_CONTENT_DO_NOT_EXPOSE'
function company() {
  return { CompanyIdentifier: 'opaque-company-001', Name: 'Ås & Äng', CountryCode: 'SE' }
}
function fiscalYear() {
  return {
    Id: YEAR,
    StartDate: '2024-02-29T00:30:00+02:00',
    EndDate: '2025-02-28T23:59:59.123456-03:00',
  }
}
function account() {
  return { FiscalYearId: YEAR, Number: '0010', Name: 'Syntetiskt konto', IsActive: true }
}
function page(Data: unknown[]) {
  return {
    Data,
    Meta: {
      CurrentPage: 1,
      PageSize: 100,
      TotalNumberOfPages: Data.length ? 1 : 0,
      TotalNumberOfResults: Data.length,
      ServerTimeUtc: '2026-10-17T07:30:00Z',
    },
  }
}
function failure(work: () => unknown, code: SpirisReadErrorCode, httpStatus: number | null) {
  let thrown: unknown
  try {
    work()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(SpirisReadContractError)
  if (!(thrown instanceof SpirisReadContractError))
    throw new Error('Expected a fixed contract error')
  expect(thrown.code).toBe(code)
  expect(thrown.httpStatus).toBe(httpStatus)
  expect(thrown.message).toBe(`Spiris read contract: ${code}`)
  expect(JSON.stringify(thrown)).not.toContain(SENTINEL)
  expect(thrown).not.toHaveProperty('body')
  expect(thrown).not.toHaveProperty('cause')
  expect(thrown).not.toHaveProperty('request')
}

describe('Spiris inert GET descriptions', () => {
  it('returns only the three fixed GET data shapes, without token/header/transport', () => {
    expect(describeCompanySettings()).toStrictEqual({
      provider: 'SPIRIS',
      method: 'GET',
      operation: 'companysettings',
      path: '/companysettings',
    })
    expect(describeFiscalYears()).toStrictEqual({
      provider: 'SPIRIS',
      method: 'GET',
      operation: 'fiscalyears',
      path: '/fiscalyears',
      query: { $page: 1, $pagesize: 100 },
    })
    expect(describeAccountsForYear(YEAR.toUpperCase(), { page: 2, pageSize: 1000 })).toStrictEqual({
      provider: 'SPIRIS',
      method: 'GET',
      operation: 'accounts-year',
      path: `/accounts/${YEAR.toUpperCase()}`,
      query: { $page: 2, $pagesize: 1000 },
    })
    const input = { page: 2, pageSize: 1 }
    const descriptor = describeFiscalYears(input)
    input.page = 7
    expect(descriptor.query.$page).toBe(2)
    expect(Object.isFrozen(descriptor)).toBe(true)
    expect(Object.isFrozen(descriptor.query)).toBe(true)
  })

  it.each([
    null,
    {},
    { page: 0, pageSize: 100 },
    { page: '1', pageSize: 100 },
    { page: 1.5, pageSize: 100 },
    { page: 2_147_483_648, pageSize: 100 },
    { page: 1, pageSize: 0 },
    { page: 1, pageSize: 1001 },
    { page: 1, pageSize: NaN },
    { page: 1, pageSize: Infinity },
    { page: 1, pageSize: 100, path: '/other' },
    { page: 1, pageSize: 100, method: 'POST' },
  ])('rejects an unusable or extended request: %#', (input) => {
    failure(() => describeFiscalYears(input), 'INVALID_REQUEST', null)
  })

  it.each([
    '',
    '123',
    'https://example.invalid/accounts',
    `${YEAR}?token=${SENTINEL}`,
    `${YEAR}/other`,
    `${YEAR}\n`,
    null,
  ])('rejects non-UUID account path input: %#', (input) => {
    failure(() => describeAccountsForYear(input), 'INVALID_REQUEST', null)
  })
})

describe('Spiris selected-company projection', () => {
  it('keeps opaque company identity distinct from name and drops contact/bank/raw data', () => {
    const first = parseCompanySettings(200, {
      ...company(),
      CompanyStatus: 99,
      CorporateIdentityNumber: null,
      CurrencyCode: 'SEK',
      BankAccount: SENTINEL,
      Email: SENTINEL,
      Extra: { secret: SENTINEL },
    })
    expect(first).toStrictEqual({
      ...company(),
      CompanyStatus: 99,
      CorporateIdentityNumber: null,
      CurrencyCode: 'SEK',
    })
    expect(
      parseCompanySettings(200, { ...company(), CompanyIdentifier: 'other-company' }),
    ).toStrictEqual({ ...company(), CompanyIdentifier: 'other-company' })
    expect(JSON.stringify(first)).not.toContain(SENTINEL)
    expect(first).not.toHaveProperty('verified')
    expect(first).not.toHaveProperty('organizationId')
    expect(first).not.toHaveProperty('active')
  })

  it('preserves optional absence/null without constructing a missing flag', () => {
    expect(parseCompanySettings(200, company())).toStrictEqual(company())
    expect(parseCompanySettings(200, { ...company(), CurrencyCode: null })).toStrictEqual({
      ...company(),
      CurrencyCode: null,
    })
    failure(
      () => parseCompanySettings(200, { ...company(), CurrencyCode: undefined }),
      'INVALID_RESPONSE',
      200,
    )
    failure(
      () => parseCompanySettings(200, { ...company(), CompanyStatus: null }),
      'INVALID_RESPONSE',
      200,
    )
  })

  it.each([undefined, null, '', '   ', 42])(
    'does not replace unusable company identity with name/org number: %#',
    (id) => {
      failure(
        () =>
          parseCompanySettings(200, {
            ...company(),
            CompanyIdentifier: id,
            CorporateIdentityNumber: '5560000000',
          }),
        'INVALID_RESPONSE',
        200,
      )
    },
  )

  it('requires own fields and rejects selected getters without invoking them', () => {
    let accessed = 0
    const input = { ...company() }
    Object.defineProperty(input, 'CompanyIdentifier', {
      get() {
        accessed++
        throw new Error(SENTINEL)
      },
    })
    failure(() => parseCompanySettings(200, input), 'INVALID_RESPONSE', 200)
    expect(accessed).toBe(0)
    failure(() => parseCompanySettings(200, Object.create(company())), 'INVALID_RESPONSE', 200)
  })

  it('counts declared string length in Unicode characters', () => {
    expect(parseCompanySettings(200, { ...company(), Name: '🏠'.repeat(100) }).Name).toBe(
      '🏠'.repeat(100),
    )
    failure(
      () => parseCompanySettings(200, { ...company(), Name: '🏠'.repeat(101) }),
      'INVALID_RESPONSE',
      200,
    )
  })
})

describe('Spiris fiscal-year and account pages', () => {
  it('preserves dates/offset/fraction, UUID casing and raw bookkeeping values without a day/method conversion', () => {
    const input = {
      ...fiscalYear(),
      Id: YEAR.toUpperCase(),
      BookkeepingMethod: 0,
      IsLockedForAccounting: false,
    }
    expect(parseFiscalYearsPage(200, page([input]), REQUEST).Data).toStrictEqual([input])
    expect(parseFiscalYearsPage(200, page([fiscalYear()]), REQUEST).Data).toStrictEqual([
      fiscalYear(),
    ])
  })

  it.each([
    '2025-02-29T00:00:00Z',
    '1900-02-29T00:00:00Z',
    '2026-02-31T00:00:00Z',
    '2026-01-01',
    '2026-01-01T00:00:00',
    '2026-01-01T24:00:00Z',
    '2026-01-01T00:00:60Z',
    '2026-01-01T00:00:00+24:00',
    '0000-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z\n',
    null,
  ])('rejects date-time outside the explicitly supported subset: %#', (StartDate) => {
    failure(
      () => parseFiscalYearsPage(200, page([{ ...fiscalYear(), StartDate }]), REQUEST),
      'INVALID_RESPONSE',
      200,
    )
  })

  it('does not invent absent/null identity, dates, boolean flags or enum meaning', () => {
    for (const missing of ['Id', 'StartDate', 'EndDate']) {
      const item = Object.fromEntries(
        Object.entries(fiscalYear()).filter(([key]) => key !== missing),
      )
      failure(() => parseFiscalYearsPage(200, page([item]), REQUEST), 'INVALID_RESPONSE', 200)
    }
    for (const BookkeepingMethod of [null, undefined, 3, '1'])
      failure(
        () => parseFiscalYearsPage(200, page([{ ...fiscalYear(), BookkeepingMethod }]), REQUEST),
        'INVALID_RESPONSE',
        200,
      )
    failure(
      () =>
        parseFiscalYearsPage(
          200,
          page([{ ...fiscalYear(), IsLockedForAccounting: null }]),
          REQUEST,
        ),
      'INVALID_RESPONSE',
      200,
    )
  })

  it('keeps order, duplicates, leading zeros and inactive accounts; compares UUID identity without rewriting it', () => {
    const first = { ...account(), FiscalYearId: YEAR.toUpperCase(), IsActive: false }
    const second = { ...account(), Number: '10', IsBlockedForManualBooking: false }
    const input = page([first, second, first])
    const parsed = parseAccountsPage(200, input, YEAR, REQUEST)
    expect(parsed.Data).toStrictEqual([first, second, first])
    expect(parsed.Meta).toStrictEqual(input.Meta)
    expect(parsed.Data[0]).not.toHaveProperty('IsBlockedForManualBooking')
    expect(Object.isFrozen(parsed.Data)).toBe(true)
    expect(
      parseAccountsPage(200, page([account()]), YEAR.toUpperCase(), REQUEST).Data,
    ).toStrictEqual([account()])
  })

  it('rejects a different fiscal year rather than silently filtering its account', () => {
    failure(
      () =>
        parseAccountsPage(
          200,
          page([account(), { ...account(), FiscalYearId: OTHER_YEAR }]),
          YEAR,
          REQUEST,
        ),
      'YEAR_MISMATCH',
      200,
    )
  })

  it.each([
    { Number: 10 },
    { Number: '' },
    { Name: null },
    { IsActive: null },
    { IsActive: 0 },
    { IsBlockedForManualBooking: null },
    { IsBlockedForManualBooking: undefined },
  ])('rejects malformed used account fields: %#', (change) => {
    failure(
      () => parseAccountsPage(200, page([{ ...account(), ...change }]), YEAR, REQUEST),
      'INVALID_RESPONSE',
      200,
    )
  })

  it('rejects malformed Data, missing Meta and missing required metadata', () => {
    for (const body of [
      null,
      {},
      { Data: [], Meta: null },
      { Data: null, Meta: page([]).Meta },
      { Data: {}, Meta: page([]).Meta },
      page([null]),
      page(['not an account']),
    ])
      failure(() => parseAccountsPage(200, body, YEAR, REQUEST), 'INVALID_RESPONSE', 200)
    for (const missing of Object.keys(page([]).Meta)) {
      const Meta = Object.fromEntries(
        Object.entries(page([]).Meta).filter(([key]) => key !== missing),
      )
      failure(
        () => parseAccountsPage(200, { Data: [], Meta }, YEAR, REQUEST),
        'INVALID_RESPONSE',
        200,
      )
    }
  })

  it.each([
    { CurrentPage: 2 },
    { CurrentPage: '1' },
    { CurrentPage: 0 },
    { PageSize: 99 },
    { TotalNumberOfPages: -1 },
    { TotalNumberOfResults: 0 },
    { TotalNumberOfResults: 2_147_483_648 },
    { TotalNumberOfResults: 1.5 },
    { ServerTimeUtc: '2026-02-30T00:00:00Z' },
  ])('rejects contradictory/request-mismatched metadata: %#', (change) => {
    const input = page([account()])
    failure(
      () => parseAccountsPage(200, { ...input, Meta: { ...input.Meta, ...change } }, YEAR, REQUEST),
      'INVALID_RESPONSE',
      200,
    )
  })

  it('bounds an actual page by requested size, even when claimed totals are larger', () => {
    const input = page([account(), account()])
    input.Meta.PageSize = 1
    failure(
      () => parseAccountsPage(200, input, YEAR, { page: 1, pageSize: 1 }),
      'INVALID_RESPONSE',
      200,
    )
  })

  it('rejects a nonempty first page when metadata claims zero total pages', () => {
    const input = page([account()])
    input.Meta.TotalNumberOfPages = 0
    failure(() => parseAccountsPage(200, input, YEAR, REQUEST), 'INVALID_RESPONSE', 200)
  })

  it('rejects a nonempty requested second page when metadata claims one total page', () => {
    const input = page([account()])
    input.Meta.CurrentPage = 2
    failure(
      () => parseAccountsPage(200, input, YEAR, { page: 2, pageSize: 100 }),
      'INVALID_RESPONSE',
      200,
    )
  })

  it('accepts a nonempty requested second page within three reported pages without inferring completeness', () => {
    const input = page([account()])
    input.Meta.CurrentPage = 2
    input.Meta.TotalNumberOfPages = 3
    input.Meta.TotalNumberOfResults = 201
    expect(parseAccountsPage(200, input, YEAR, { page: 2, pageSize: 100 })).toStrictEqual(input)
  })

  it('returns empty-page metadata without assuming an endpoint-specific empty/last-page convention', () => {
    for (const TotalNumberOfPages of [0, 1]) {
      const input = { Data: [], Meta: { ...page([]).Meta, TotalNumberOfPages } }
      const parsed = parseAccountsPage(200, input, YEAR, REQUEST)
      expect(parsed).toStrictEqual(input)
      expect(Object.keys(parsed).sort()).toEqual(['Data', 'Meta'])
      expect(parsed).not.toHaveProperty('complete')
      expect(parsed).not.toHaveProperty('next')
      expect(parsed).not.toHaveProperty('snapshotId')
    }
  })
})

describe('Spiris fixed failures without upstream response content', () => {
  it.each([204, 301, 400, 401, 403, 404, 429, 500, 599])(
    'does not parse or expose the body on HTTP %s',
    (status) => {
      let accessed = 0
      const body = {
        get Data() {
          accessed++
          throw new Error(SENTINEL)
        },
        DeveloperErrorMessage: SENTINEL,
      }
      failure(() => parseCompanySettings(status, body), 'HTTP_ERROR', status)
      failure(() => parseFiscalYearsPage(status, body, REQUEST), 'HTTP_ERROR', status)
      failure(() => parseAccountsPage(status, body, YEAR, REQUEST), 'HTTP_ERROR', status)
      expect(accessed).toBe(0)
    },
  )

  it.each([undefined, null, '200', NaN, 99, 600, 200.5])(
    'rejects invalid HTTP status: %#',
    (status) => {
      failure(() => parseCompanySettings(status, { secret: SENTINEL }), 'INVALID_HTTP_STATUS', null)
    },
  )

  it('rejects malformed success without retaining its raw body; never invokes a proxy trap', () => {
    failure(
      () => parseAccountsPage(200, { DeveloperErrorMessage: SENTINEL }, YEAR, REQUEST),
      'INVALID_RESPONSE',
      200,
    )
    let calls = 0
    const proxy = new Proxy(company(), {
      getPrototypeOf() {
        calls++
        throw new Error(SENTINEL)
      },
    })
    failure(() => parseCompanySettings(200, proxy), 'INVALID_RESPONSE', 200)
    expect(calls).toBe(0)
  })
})
