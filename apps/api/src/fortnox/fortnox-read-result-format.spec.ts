import { createHash } from 'node:crypto'
import type { ReducedLedgerResult } from './fortnox-read-reduction'
import {
  decodeLedgerResult,
  encodeLedgerResult,
  LedgerResultFormatError,
} from './fortnox-read-result-format'

// Pure format evidence: JSON.parse models returned JSONB values; no real database,
// reducer execution, publication or proof/fence claim is made by these tests.
// This literal is independent of the product's canonical writer and schemas.
const EMPTY_LITERAL =
  '{"coverage":{},"financialYear":{"fromDate":"2026-01-01","id":1,"toDate":"2026-12-31"},"reason":null,"references":[],"rows":[],"status":"COMPLETE","summary":{"byProperty":[],"currency":"SEK","evenoExportOre":0,"totalOre":0,"unallocatedOre":0,"uncertainRemovedOre":0,"unmappedDimensions":[]},"uncertainties":[]}'
const EMPTY_DIGEST = '4bd75db79046ec53a745de05f44c3184080e601b885b6e70d41628b9e4a5839b'
const FAILURE = 'Ogiltigt lagrat huvudboksresultat'
const PRIVATE_VALUE = 'SYNTHETIC_PRIVATE_RESULT_MARKER'
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

function emptyResult(): ReducedLedgerResult {
  return {
    status: 'COMPLETE',
    reason: null,
    financialYear: { id: 1, fromDate: '2026-01-01', toDate: '2026-12-31' },
    summary: {
      currency: 'SEK',
      totalOre: 0,
      byProperty: [],
      unmappedDimensions: [],
      unallocatedOre: 0,
      uncertainRemovedOre: 0,
      evenoExportOre: 0,
    },
    rows: [],
    references: [],
    coverage: {},
    uncertainties: [],
  }
}

function mixedResult(): ReducedLedgerResult {
  return {
    ...emptyResult(),
    status: 'COMPLETE_WITH_UNCERTAINTY',
    summary: {
      currency: 'SEK',
      totalOre: -5,
      byProperty: [{ propertyId: 'p1', propertyName: 'Å\n"\\😀', amountOre: -20 }],
      unmappedDimensions: [{ dimensionType: 'PROJECT', code: 'Ω', amountOre: 10 }],
      unallocatedOre: 5,
      uncertainRemovedOre: 99,
      evenoExportOre: -10,
      balanceBroughtForwardOre: {
        '5171': Number.MAX_SAFE_INTEGER,
        '5160': Number.MAX_SAFE_INTEGER,
        '1510': null,
        '1930': -125,
        '2997': 0,
      },
      financialYearAccountingMethod: '',
    },
    rows: [
      {
        voucher: '1|L|10',
        row: 1,
        transactionDate: '2026-10-01',
        account: 5171,
        amountOre: -20,
        bucket: 'PROPERTY',
        dimensionType: 'COST_CENTER',
        code: 'Å',
        propertyId: 'p1',
        evenoExport: true,
        evenoSource: { journalEntryId: 'j1', sourceAccount: 5160, mappingRevision: 0 },
      },
      {
        voucher: '1|L|2',
        row: 3,
        transactionDate: '2026-10-02',
        account: 5171,
        amountOre: 10,
        bucket: 'UNMAPPED',
        dimensionType: 'PROJECT',
        code: 'Ω',
        propertyId: null,
        evenoExport: true,
        evenoSource: { journalEntryId: 'j2', sourceAccount: null, mappingRevision: -7 },
      },
      {
        voucher: '1|L|2',
        row: 4,
        transactionDate: '2026-10-02',
        account: 5171,
        amountOre: 5,
        bucket: 'UNALLOCATED',
        dimensionType: null,
        code: null,
        propertyId: null,
        evenoExport: false,
      },
      {
        voucher: '1|L|2',
        row: 5,
        transactionDate: '2026-10-02',
        account: 5171,
        amountOre: 99,
        bucket: 'UNCERTAIN_REMOVED',
        dimensionType: null,
        code: null,
        propertyId: null,
        evenoExport: true,
        evenoSource: { journalEntryId: '', sourceAccount: null, mappingRevision: null },
      },
    ],
    references: [
      { voucher: '1|L|999', referenceType: null, referenceNumber: 'INGEN_RESULTATRAD' },
      { voucher: '1|L|2', referenceType: '', referenceNumber: null },
      { voucher: '1|L|2', referenceType: '', referenceNumber: null },
    ],
    coverage: {
      '/3/vouchers/sublist': { pages: 2, totalPages: 2, totalResources: 3, itemsSeen: 3 },
      '/3/costcenters': { pages: 1, totalPages: 1, totalResources: 1, itemsSeen: 1 },
    },
    uncertainties: ['Å\n"\\😀', 'A\u030A', 'samma', 'samma'],
  }
}

type Encoded = ReturnType<typeof encodeLedgerResult>
type Stored = {
  formatVersion: number
  resultDigest: string
  canonicalBytes: number
  status: string
  reason: null
  summary: unknown
  rows: unknown
  coverage: unknown
  uncertainties: unknown
  financialYear: unknown
}
function parse(text: string): unknown {
  const value: unknown = JSON.parse(text)
  return value
}
function stored(encoded: Encoded): Stored {
  return {
    formatVersion: encoded.formatVersion,
    resultDigest: encoded.resultDigest,
    canonicalBytes: encoded.canonicalBytes,
    status: encoded.status,
    reason: encoded.reason,
    summary: parse(encoded.summaryJson),
    rows: parse(encoded.rowsJson),
    coverage: parse(encoded.coverageJson),
    uncertainties: parse(encoded.uncertaintiesJson),
    financialYear: parse(encoded.financialYearJson),
  }
}
function object(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid synthetic fixture object')
}
function formatFailure(work: () => unknown): void {
  let error: unknown
  try {
    work()
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(LedgerResultFormatError)
  if (!(error instanceof Error)) throw new Error('Expected a format error')
  expect(error.name).toBe('LedgerResultFormatError')
  expect(error.message).toBe(FAILURE)
  expect(Reflect.get(error, 'cause')).toBeUndefined()
  expect(JSON.stringify(error)).not.toContain(PRIVATE_VALUE)
  expect(error.stack).not.toContain(PRIVATE_VALUE)
}

describe('Huvudboksresultatets förlustfria v1-format', () => {
  it('matchar ett bokstavligt tomt byte-/SHA-facit och lagrar exakt fem JSON-delar', () => {
    expect(Buffer.byteLength(EMPTY_LITERAL, 'utf8')).toBe(309)
    expect(sha(EMPTY_LITERAL)).toBe(EMPTY_DIGEST)
    const encoded = encodeLedgerResult(emptyResult())
    expect(Object.isFrozen(encoded)).toBe(true)
    expect(Object.keys(encoded).sort()).toEqual([
      'canonicalBytes',
      'coverageJson',
      'financialYearJson',
      'formatVersion',
      'reason',
      'resultDigest',
      'rowsJson',
      'status',
      'summaryJson',
      'uncertaintiesJson',
    ])
    expect(encoded).toMatchObject({
      formatVersion: 1,
      canonicalBytes: 309,
      resultDigest: EMPTY_DIGEST,
      status: 'COMPLETE',
      reason: null,
    })
    expect(parse(encoded.rowsJson)).toEqual({ rows: [], references: [] })
    expect(decodeLedgerResult(stored(encoded))).toEqual(emptyResult())
  })

  it('bevarar full blandad form, Unicode, nullable proveniens och ingående saldon var för sig', () => {
    const input = mixedResult(),
      before = structuredClone(input)
    const output = decodeLedgerResult(stored(encodeLedgerResult(input)))
    expect(input).toEqual(before)
    expect(output).toEqual(before)
    expect(Object.hasOwn(output.rows[2]!, 'evenoSource')).toBe(false)
    expect(output.rows[3]!.evenoSource).toEqual({
      journalEntryId: '',
      sourceAccount: null,
      mappingRevision: null,
    })
    expect(output.summary.balanceBroughtForwardOre).toEqual(before.summary.balanceBroughtForwardOre)
    expect(output.references[0]!.voucher).toBe('1|L|999')
    expect(output.rows.some((row) => row.voucher === output.references[0]!.voucher)).toBe(false)
    expect(output.references[1]).toEqual(output.references[2])
  })

  it('låser numeriska och astrala nycklars JS-ordning utan att använda JSONB:s eller locale-ordning', () => {
    const input = emptyResult()
    const count = { pages: 0, totalPages: 0, totalResources: 0, itemsSeen: 0 }
    input.coverage = {
      '2': { ...count },
      '10': { ...count },
      '\uE000': { ...count },
      '\u{10000}': { ...count },
    }
    const c = '{"itemsSeen":0,"pages":0,"totalPages":0,"totalResources":0}'
    const literal = EMPTY_LITERAL.replace(
      '"coverage":{}',
      `"coverage":{"10":${c},"2":${c},"𐀀":${c},"":${c}}`,
    )
    const encoded = encodeLedgerResult(input)
    expect(encoded.resultDigest).toBe(sha(literal))
    expect(encoded.canonicalBytes).toBe(Buffer.byteLength(literal, 'utf8'))
    expect(decodeLedgerResult(stored(encoded))).toEqual(input)
  })

  it('matchar ett handskrivet Unicode-/escape-facit och normaliserar inte NFC/NFD', () => {
    const input = emptyResult()
    input.uncertainties = ['Å\n"\\😀', 'A\u030A']
    const literal = EMPTY_LITERAL.replace(
      '"uncertainties":[]',
      String.raw`"uncertainties":["Å\n\"\\😀","${'A\u030A'}"]`,
    )
    const encoded = encodeLedgerResult(input)
    expect(encoded.resultDigest).toBe(sha(literal))
    expect(encoded.canonicalBytes).toBe(Buffer.byteLength(literal, 'utf8'))
    expect(decodeLedgerResult(stored(encoded))).toEqual(input)
    input.uncertainties[1] = 'Å'
    expect(encodeLedgerResult(input).resultDigest).not.toBe(encoded.resultDigest)
  })

  it('objektens insättningsordning påverkar inte digest, men arrayordning och dubbletter gör det', () => {
    const input = mixedResult(),
      encoded = encodeLedgerResult(input)
    const reordered = { ...input, summary: { ...input.summary, currency: 'SEK' as const } }
    reordered.coverage = Object.fromEntries(Object.entries(input.coverage).reverse())
    for (const key of Object.keys(reordered.summary).reverse()) {
      const value: unknown = Reflect.get(reordered.summary, key)
      Reflect.deleteProperty(reordered.summary, key)
      Reflect.set(reordered.summary, key, value)
    }
    expect(encodeLedgerResult(reordered).resultDigest).toBe(encoded.resultDigest)
    expect(encodeLedgerResult({ ...input, rows: [...input.rows].reverse() }).resultDigest).not.toBe(
      encoded.resultDigest,
    )
    expect(
      encodeLedgerResult({ ...input, references: [...input.references].reverse() }).resultDigest,
    ).not.toBe(encoded.resultDigest)
    expect(
      encodeLedgerResult({ ...input, references: input.references.slice(0, 2) }).resultDigest,
    ).not.toBe(encoded.resultDigest)
    input.rows.push(input.rows[0]!) // Same identity is shared, not a cycle; no global seen-set.
    expect(decodeLedgerResult(stored(encodeLedgerResult(input)))).toEqual(input)
    expect(input.rows[0]).toBe(input.rows[4])
  })

  it('snapshotsträngar och hash påverkas inte av senare mutation av callerens hela objektgraf', () => {
    const input = mixedResult(),
      before = structuredClone(input),
      encoded = encodeLedgerResult(input)
    const snapshot = { ...encoded }
    input.summary.byProperty[0]!.propertyName = PRIVATE_VALUE
    input.summary.balanceBroughtForwardOre!['5171'] = 3
    input.rows[0]!.evenoSource!.mappingRevision = 999
    input.rows.reverse()
    input.references[0]!.referenceNumber = PRIVATE_VALUE
    input.uncertainties.push(PRIVATE_VALUE)
    input.coverage['/3/costcenters']!.itemsSeen = 99
    input.financialYear.id = 2
    input.status = 'COMPLETE'
    expect(encoded).toEqual(snapshot)
    expect(Reflect.set(encoded, 'rowsJson', '{}')).toBe(false)
    expect(decodeLedgerResult(stored(encoded))).toEqual(before)
  })

  it('bevarar optional frånvaro och explicit tillåtet null utan nya ekonomiska relationer', () => {
    const input = emptyResult(),
      absent = encodeLedgerResult(input)
    const decoded = decodeLedgerResult(stored(absent))
    expect(Object.hasOwn(decoded.summary, 'financialYearAccountingMethod')).toBe(false)
    expect(Object.hasOwn(decoded.summary, 'balanceBroughtForwardOre')).toBe(false)
    input.summary.financialYearAccountingMethod = null
    input.summary.balanceBroughtForwardOre = {}
    const present = encodeLedgerResult(input)
    expect(present.resultDigest).not.toBe(absent.resultDigest)
    expect(decodeLedgerResult(stored(present))).toEqual(input)
    input.status = 'COMPLETE_WITH_UNCERTAINTY'
    input.summary.totalOre = 123 // Format validation must not recalculate economic totals.
    expect(decodeLedgerResult(stored(encodeLedgerResult(input)))).toEqual(input)
  })

  it.each([
    [
      'summary',
      (r: ReducedLedgerResult) => {
        r.summary.totalOre++
      },
    ],
    [
      'rows',
      (r: ReducedLedgerResult) => {
        r.rows[0]!.amountOre++
      },
    ],
    [
      'references',
      (r: ReducedLedgerResult) => {
        r.references[0]!.referenceType = 'annan'
      },
    ],
    [
      'provenance',
      (r: ReducedLedgerResult) => {
        r.rows[0]!.evenoSource!.sourceAccount = 5170
      },
    ],
    [
      'coverage',
      (r: ReducedLedgerResult) => {
        r.coverage['/3/costcenters']!.itemsSeen++
      },
    ],
    [
      'uncertainties',
      (r: ReducedLedgerResult) => {
        r.uncertainties.push('sen varning')
      },
    ],
    [
      'financialYear',
      (r: ReducedLedgerResult) => {
        r.financialYear.toDate = '2026-12-30'
      },
    ],
    [
      'status',
      (r: ReducedLedgerResult) => {
        r.status = 'COMPLETE'
      },
    ],
  ] as const)(
    'hela %s ingår i innehållsdigesten och ingen gammal hash godtas',
    (_label, mutate) => {
      const original = mixedResult(),
        previous = encodeLedgerResult(original)
      mutate(original)
      const changed = encodeLedgerResult(original)
      expect(changed.resultDigest).not.toBe(previous.resultDigest)
      const corrupted = stored(changed)
      corrupted.resultDigest = previous.resultDigest
      formatFailure(() => decodeLedgerResult(corrupted))
      expect(decodeLedgerResult(stored(changed))).toEqual(original)
    },
  )

  it.each([
    ['root', (r: ReducedLedgerResult) => r],
    ['summary', (r: ReducedLedgerResult) => r.summary],
    ['financialYear', (r: ReducedLedgerResult) => r.financialYear],
    ['row', (r: ReducedLedgerResult) => r.rows[0]!],
    ['source', (r: ReducedLedgerResult) => r.rows[0]!.evenoSource!],
    ['property', (r: ReducedLedgerResult) => r.summary.byProperty[0]!],
    ['unmapped', (r: ReducedLedgerResult) => r.summary.unmappedDimensions[0]!],
    ['reference', (r: ReducedLedgerResult) => r.references[0]!],
    ['coverage', (r: ReducedLedgerResult) => r.coverage['/3/costcenters']!],
  ] as const)('nekar extra fält på %s utan att trimma det', (_label, target) => {
    const input = mixedResult()
    Reflect.set(target(input), 'unknownField', PRIVATE_VALUE)
    formatFailure(() => encodeLedgerResult(input))
  })

  it.each([
    [
      'root reason',
      (r: ReducedLedgerResult) => {
        Reflect.deleteProperty(r, 'reason')
      },
    ],
    [
      'summary currency',
      (r: ReducedLedgerResult) => {
        Reflect.deleteProperty(r.summary, 'currency')
      },
    ],
    [
      'row amount',
      (r: ReducedLedgerResult) => {
        Reflect.deleteProperty(r.rows[0]!, 'amountOre')
      },
    ],
    [
      'source revision',
      (r: ReducedLedgerResult) => {
        Reflect.deleteProperty(r.rows[0]!.evenoSource!, 'mappingRevision')
      },
    ],
    [
      'reference nullable field',
      (r: ReducedLedgerResult) => {
        Reflect.deleteProperty(r.references[0]!, 'referenceType')
      },
    ],
    [
      'coverage count',
      (r: ReducedLedgerResult) => {
        Reflect.deleteProperty(r.coverage['/3/costcenters']!, 'itemsSeen')
      },
    ],
    [
      'year boundary',
      (r: ReducedLedgerResult) => {
        Reflect.deleteProperty(r.financialYear, 'toDate')
      },
    ],
  ] as const)('nekar saknat obligatoriskt fält: %s', (_label, mutate) => {
    const input = mixedResult()
    mutate(input)
    formatFailure(() => encodeLedgerResult(input))
  })

  it.each([
    [
      'status',
      (r: ReducedLedgerResult) => {
        Reflect.set(r, 'status', 'PARTIAL')
      },
    ],
    [
      'reason',
      (r: ReducedLedgerResult) => {
        Reflect.set(r, 'reason', PRIVATE_VALUE)
      },
    ],
    [
      'currency',
      (r: ReducedLedgerResult) => {
        Reflect.set(r.summary, 'currency', 'EUR')
      },
    ],
    [
      'bucket',
      (r: ReducedLedgerResult) => {
        Reflect.set(r.rows[0]!, 'bucket', 'OTHER')
      },
    ],
    [
      'dimension',
      (r: ReducedLedgerResult) => {
        Reflect.set(r.rows[0]!, 'dimensionType', 'OTHER')
      },
    ],
    [
      'boolean',
      (r: ReducedLedgerResult) => {
        Reflect.set(r.rows[0]!, 'evenoExport', 'true')
      },
    ],
    [
      'fractional amount',
      (r: ReducedLedgerResult) => {
        r.rows[0]!.amountOre = 0.5
      },
    ],
    [
      'unsafe amount',
      (r: ReducedLedgerResult) => {
        r.summary.totalOre = Number.MAX_SAFE_INTEGER + 1
      },
    ],
    [
      'fractional revision',
      (r: ReducedLedgerResult) => {
        r.rows[0]!.evenoSource!.mappingRevision = 1.5
      },
    ],
    [
      'fractional coverage',
      (r: ReducedLedgerResult) => {
        r.coverage['/3/costcenters']!.pages = 0.5
      },
    ],
    [
      'negative coverage',
      (r: ReducedLedgerResult) => {
        r.coverage['/3/costcenters']!.itemsSeen = -1
      },
    ],
    [
      'impossible day',
      (r: ReducedLedgerResult) => {
        r.rows[0]!.transactionDate = '2026-02-30'
      },
    ],
    [
      'timestamp instead of day',
      (r: ReducedLedgerResult) => {
        r.financialYear.fromDate = '2026-01-01T00:00:00Z'
      },
    ],
    [
      'null summary',
      (r: ReducedLedgerResult) => {
        Reflect.set(r, 'summary', null)
      },
    ],
    [
      'null rows',
      (r: ReducedLedgerResult) => {
        Reflect.set(r, 'rows', null)
      },
    ],
    [
      'null year',
      (r: ReducedLedgerResult) => {
        Reflect.set(r, 'financialYear', null)
      },
    ],
    [
      'null optional object',
      (r: ReducedLedgerResult) => {
        Reflect.set(r.rows[0]!, 'evenoSource', null)
      },
    ],
    [
      'null optional record',
      (r: ReducedLedgerResult) => {
        Reflect.set(r.summary, 'balanceBroughtForwardOre', null)
      },
    ],
    [
      'undefined optional object',
      (r: ReducedLedgerResult) => {
        Reflect.set(r.rows[0]!, 'evenoSource', undefined)
      },
    ],
    [
      'undefined optional scalar',
      (r: ReducedLedgerResult) => {
        Reflect.set(r.summary, 'financialYearAccountingMethod', undefined)
      },
    ],
  ] as const)('nekar ogiltig form: %s', (_label, mutate) => {
    const input = mixedResult()
    mutate(input)
    formatFailure(() => encodeLedgerResult(input))
  })

  it.each([
    ['undefined', undefined],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['bigint', 1n],
    ['symbol', Symbol('synthetic')],
    ['function', () => PRIVATE_VALUE],
    ['Date', new Date('2026-01-01T00:00:00Z')],
    ['Map', new Map([['synthetic', 1]])],
  ] as const)('nekar %s utan JSON.stringify-konvertering', (_label, invalid) => {
    const input = mixedResult()
    Reflect.set(input.summary, 'totalOre', invalid)
    formatFailure(() => encodeLedgerResult(input))
  })

  it('nekar accessors/toJSON innan deras kod körs, även i lagrade delar', () => {
    let accesses = 0
    const getter = () => {
      accesses++
      throw new Error(PRIVATE_VALUE)
    }
    const input = mixedResult()
    Object.defineProperty(input.rows[0]!, 'amountOre', { enumerable: true, get: getter })
    formatFailure(() => encodeLedgerResult(input))
    const withToJson = mixedResult()
    Reflect.set(withToJson.summary, 'toJSON', getter)
    formatFailure(() => encodeLedgerResult(withToJson))
    const persisted = stored(encodeLedgerResult(mixedResult()))
    Object.defineProperty(persisted, 'summary', { enumerable: true, get: getter })
    formatFailure(() => decodeLedgerResult(persisted))
    expect(accesses).toBe(0)
  })

  it('nekar Proxy före get/toJSON-trap i encode och decode samt återkallade proxys', () => {
    let traps = 0
    const input = mixedResult()
    input.summary = new Proxy(input.summary, {
      get(target, key, receiver) {
        traps++
        if (key === 'totalOre') return traps
        if (key === 'toJSON') return () => ({ totalOre: PRIVATE_VALUE })
        return Reflect.get(target, key, receiver)
      },
    })
    formatFailure(() => encodeLedgerResult(input))
    const proxiedArray = mixedResult()
    proxiedArray.rows = new Proxy(proxiedArray.rows, {
      get(target, key, receiver) {
        traps++
        return Reflect.get(target, key, receiver)
      },
    })
    formatFailure(() => encodeLedgerResult(proxiedArray))
    const persisted = stored(encodeLedgerResult(mixedResult()))
    const proxiedStored = new Proxy(persisted, {
      get(target, key, receiver) {
        traps++
        return Reflect.get(target, key, receiver)
      },
    })
    formatFailure(() => decodeLedgerResult(proxiedStored))
    const revokedInput = mixedResult(),
      revocable = Proxy.revocable(revokedInput.summary, {})
    revokedInput.summary = revocable.proxy
    revocable.revoke()
    formatFailure(() => encodeLedgerResult(revokedInput))
    const revokedStored = Proxy.revocable(stored(encodeLedgerResult(mixedResult())), {})
    revokedStored.revoke()
    formatFailure(() => decodeLedgerResult(revokedStored.proxy))
    expect(traps).toBe(0)
  })

  it.each([
    ['Object', 'function'],
    ['Object', 'getter'],
    ['Array', 'function'],
    ['Array', 'getter'],
  ] as const)('nekar ärvd %s.prototype.toJSON som %s före åtkomst', (owner, kind) => {
    const prototype: object = owner === 'Object' ? Object.prototype : Array.prototype
    const before = Object.getOwnPropertyDescriptor(prototype, 'toJSON')
    const input = mixedResult(),
      persisted = stored(encodeLedgerResult(input))
    let calls = 0,
      encodeError: unknown,
      decodeError: unknown
    const hook = () => {
      calls++
      return PRIVATE_VALUE
    }
    const descriptor: PropertyDescriptor =
      kind === 'function'
        ? { configurable: true, enumerable: false, value: hook }
        : {
            configurable: true,
            enumerable: false,
            get: () => {
              calls++
              return hook
            },
          }
    try {
      Object.defineProperty(prototype, 'toJSON', descriptor)
      try {
        encodeLedgerResult(input)
      } catch (error) {
        encodeError = error
      }
      try {
        decodeLedgerResult(persisted)
      } catch (error) {
        decodeError = error
      }
    } finally {
      // Restore BEFORE any Jest matcher/reporting may serialize test values.
      if (before) Object.defineProperty(prototype, 'toJSON', before)
      else Reflect.deleteProperty(prototype, 'toJSON')
    }
    expect(calls).toBe(0)
    formatFailure(() => {
      throw encodeError
    })
    formatFailure(() => {
      throw decodeError
    })
    expect(Object.getOwnPropertyDescriptor(prototype, 'toJSON')).toEqual(before)
  })

  it.each(['symbol-key', 'hidden-property', 'nonplain', 'sparse', 'array-extra', 'cycle'] as const)(
    'nekar icke-JSON-graf: %s',
    (kind) => {
      const input = mixedResult()
      if (kind === 'symbol-key') Reflect.set(input.rows[0]!, Symbol('synthetic'), PRIVATE_VALUE)
      if (kind === 'hidden-property')
        Object.defineProperty(input.summary, 'hidden', { value: PRIVATE_VALUE, enumerable: false })
      if (kind === 'nonplain') Object.setPrototypeOf(input.summary, { syntheticPrototype: true })
      if (kind === 'sparse') Reflect.deleteProperty(input.rows, '1')
      if (kind === 'array-extra') Reflect.set(input.rows, 'extra', PRIVATE_VALUE)
      if (kind === 'cycle') Reflect.set(input.rows, '0', input.rows)
      formatFailure(() => encodeLedgerResult(input))
    },
  )

  it.each(['\u0000', '\uD800', '\uDC00', 'prefix\uD800suffix'])(
    'nekar PostgreSQL-orepresenterbar sträng och recordnyckel %#',
    (invalid) => {
      const value = mixedResult()
      value.summary.byProperty[0]!.propertyName = invalid
      formatFailure(() => encodeLedgerResult(value))
      const key = mixedResult()
      key.coverage[invalid] = { pages: 0, totalPages: 0, totalResources: 0, itemsSeen: 0 }
      formatFailure(() => encodeLedgerResult(key))
      const persisted = stored(encodeLedgerResult(mixedResult()))
      object(persisted.summary)
      persisted.summary.financialYearAccountingMethod = invalid
      formatFailure(() => decodeLedgerResult(persisted))
    },
  )

  it('avvisar -0 djupt i encode och decode utan tyst normalisering till vanlig nolla', () => {
    const input = mixedResult()
    input.summary.balanceBroughtForwardOre!['1930'] = -0
    expect(Object.is(input.summary.balanceBroughtForwardOre!['1930'], -0)).toBe(true)
    formatFailure(() => encodeLedgerResult(input))
    const persisted = stored(encodeLedgerResult(mixedResult()))
    object(persisted.summary)
    object(persisted.summary.balanceBroughtForwardOre)
    persisted.summary.balanceBroughtForwardOre['1930'] = -0
    formatFailure(() => decodeLedgerResult(persisted))
  })

  it.each([
    [
      'version',
      (s: Stored) => {
        s.formatVersion = 2
      },
    ],
    [
      'unknown field',
      (s: Stored) => {
        Reflect.set(s, 'privateProof', PRIVATE_VALUE)
      },
    ],
    [
      'missing field',
      (s: Stored) => {
        Reflect.deleteProperty(s, 'uncertainties')
      },
    ],
    [
      'digest',
      (s: Stored) => {
        s.resultDigest = '0'.repeat(64)
      },
    ],
    [
      'uppercase digest',
      (s: Stored) => {
        s.resultDigest = s.resultDigest.toUpperCase()
      },
    ],
    [
      'wrong bytes',
      (s: Stored) => {
        s.canonicalBytes++
      },
    ],
    [
      'fractional bytes',
      (s: Stored) => {
        s.canonicalBytes = 309.5
      },
    ],
    [
      'negative bytes',
      (s: Stored) => {
        s.canonicalBytes = -1
      },
    ],
    [
      'unsafe bytes',
      (s: Stored) => {
        s.canonicalBytes = Number.MAX_SAFE_INTEGER + 1
      },
    ],
    [
      'JSON text instead of object',
      (s: Stored) => {
        s.summary = JSON.stringify(s.summary)
      },
    ],
    [
      'extra rows-wrapper field',
      (s: Stored) => {
        object(s.rows)
        s.rows.extra = PRIVATE_VALUE
      },
    ],
    [
      'missing references',
      (s: Stored) => {
        object(s.rows)
        Reflect.deleteProperty(s.rows, 'references')
      },
    ],
  ] as const)('nekar korrupta JSON-delar i lagringslayouten: %s', (_label, mutate) => {
    const persisted = stored(encodeLedgerResult(mixedResult()))
    mutate(persisted)
    formatFailure(() => decodeLedgerResult(persisted))
  })
})
