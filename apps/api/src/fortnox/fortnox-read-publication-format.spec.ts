import { createHash } from 'node:crypto'
import type { NormalizedContextBinding } from './fortnox-read-normalized-context'
import type {
  ReadyLedgerReduction,
  ReducedLedgerResult,
  ReductionProof,
} from './fortnox-read-reduction'
import * as resultFormat from './fortnox-read-result-format'
import {
  decodeLedgerPublication,
  encodeLedgerPublication,
  PublicationFormatError,
  PUBLICATION_OVERFLOW_REASON,
  type EncodedPublication,
} from './fortnox-read-publication-format'

// Pure format tests. JSON.parse models actual JSONB pieces;
// no DB pairing, A–F execution, authorization, lease or authenticity is proven.
// These fixed literals come from the independently written publication testplan.
const SUCCESS_LITERAL =
  '{"binding":{"connection":{"databaseNumber":900001,"generation":3,"id":"00000000-0000-4000-8000-000000000003","orgNumber":null},"counts":{"MAPPINGS":0,"OWN_EXPORTS":0},"input":{"costAccounts":[5170],"financialYearId":1,"periodFrom":"2026-01-01","periodTo":"2026-01-31"},"organizationId":"00000000-0000-4000-8000-000000000001","requestHash":"1111111111111111111111111111111111111111111111111111111111111111","runId":"00000000-0000-4000-8000-000000000002","sourceCaptureId":"00000000-0000-4000-8000-000000000002","stageId":"00000000-0000-4000-8000-000000000002"},"canonicalBytes":309,"failureCode":null,"formatVersion":1,"id":"00000000-0000-4000-8000-000000000005","organizationId":"00000000-0000-4000-8000-000000000001","proof":{"catalogDigest":"4444444444444444444444444444444444444444444444444444444444444444","claimVersion":7,"detailDigest":"6666666666666666666666666666666666666666666666666666666666666666","manifestDigest":"5555555555555555555555555555555555555555555555555555555555555555","manifestItemsSeen":0,"manifestPageCount":1,"organizationId":"00000000-0000-4000-8000-000000000001","runId":"00000000-0000-4000-8000-000000000002","snapshotDigest":"2222222222222222222222222222222222222222222222222222222222222222","snapshotId":"00000000-0000-4000-8000-000000000004","sourceCaptureId":"00000000-0000-4000-8000-000000000002","sourceDigest":"3333333333333333333333333333333333333333333333333333333333333333","version":1,"voucherCount":0},"reason":null,"resultDigest":"4bd75db79046ec53a745de05f44c3184080e601b885b6e70d41628b9e4a5839b","runId":"00000000-0000-4000-8000-000000000002","status":"COMPLETE"}'
const OVERFLOW_LITERAL =
  '{"binding":{"connection":{"databaseNumber":900001,"generation":3,"id":"00000000-0000-4000-8000-000000000003","orgNumber":null},"counts":{"MAPPINGS":0,"OWN_EXPORTS":0},"input":{"costAccounts":[5170],"financialYearId":1,"periodFrom":"2026-01-01","periodTo":"2026-01-31"},"organizationId":"00000000-0000-4000-8000-000000000001","requestHash":"1111111111111111111111111111111111111111111111111111111111111111","runId":"00000000-0000-4000-8000-000000000002","sourceCaptureId":"00000000-0000-4000-8000-000000000002","stageId":"00000000-0000-4000-8000-000000000002"},"canonicalBytes":null,"failureCode":"AMOUNT_OVERFLOW","formatVersion":1,"id":"00000000-0000-4000-8000-000000000005","organizationId":"00000000-0000-4000-8000-000000000001","proof":{"catalogDigest":"4444444444444444444444444444444444444444444444444444444444444444","claimVersion":7,"detailDigest":"6666666666666666666666666666666666666666666666666666666666666666","manifestDigest":"5555555555555555555555555555555555555555555555555555555555555555","manifestItemsSeen":2,"manifestPageCount":1,"organizationId":"00000000-0000-4000-8000-000000000001","runId":"00000000-0000-4000-8000-000000000002","snapshotDigest":"2222222222222222222222222222222222222222222222222222222222222222","snapshotId":"00000000-0000-4000-8000-000000000004","sourceCaptureId":"00000000-0000-4000-8000-000000000002","sourceDigest":"3333333333333333333333333333333333333333333333333333333333333333","version":1,"voucherCount":2},"reason":"Beloppssumman ligger utanför säkert talområde","resultDigest":null,"runId":"00000000-0000-4000-8000-000000000002","status":"FAILED"}'
const SUCCESS_DIGEST = '6e60b1c9719c29ad6bb16a49114b5180fef819abb07e59caa6f88abbfee4f401'
const OVERFLOW_DIGEST = '1e9e45111c935b054912c57551a8f542799e02f5e883b604a02673391fe19e85'
const EMPTY_RESULT_DIGEST = '4bd75db79046ec53a745de05f44c3184080e601b885b6e70d41628b9e4a5839b'
const ERROR_TEXT = 'Ogiltig lagrad huvudbokspublicering'
const ORG = '00000000-0000-4000-8000-000000000001'
const RUN = '00000000-0000-4000-8000-000000000002'
const PUBLICATION = '00000000-0000-4000-8000-000000000005'
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

function binding(): NormalizedContextBinding {
  return {
    organizationId: ORG,
    runId: RUN,
    sourceCaptureId: RUN,
    stageId: RUN,
    requestHash: '1'.repeat(64),
    input: {
      financialYearId: 1,
      periodFrom: '2026-01-01',
      periodTo: '2026-01-31',
      costAccounts: [5170],
    },
    connection: {
      id: '00000000-0000-4000-8000-000000000003',
      generation: 3,
      databaseNumber: 900001,
      orgNumber: null,
    },
    counts: { MAPPINGS: 0, OWN_EXPORTS: 0 },
  }
}
function proof(overflow = false): ReductionProof {
  return {
    version: 1,
    organizationId: ORG,
    runId: RUN,
    sourceCaptureId: RUN,
    snapshotId: '00000000-0000-4000-8000-000000000004',
    snapshotDigest: '2'.repeat(64),
    sourceDigest: '3'.repeat(64),
    catalogDigest: '4'.repeat(64),
    manifestDigest: '5'.repeat(64),
    detailDigest: '6'.repeat(64),
    manifestPageCount: 1,
    manifestItemsSeen: overflow ? 2 : 0,
    voucherCount: overflow ? 2 : 0,
    claimVersion: 7,
  }
}
function empty(): ReducedLedgerResult {
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
const success = (): ReadyLedgerReduction => ({ kind: 'REDUCED', proof: proof(), result: empty() })
const overflow = (): ReadyLedgerReduction => ({
  kind: 'FAILED',
  code: 'AMOUNT_OVERFLOW',
  proof: proof(true),
})
function parse(value: string | null): unknown {
  return value === null ? null : JSON.parse(value)
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid test fixture')
  return value as Record<string, unknown>
}
function stored(value: EncodedPublication): Record<string, unknown> {
  const {
    bindingJson,
    proofJson,
    summaryJson,
    rowsJson,
    coverageJson,
    uncertaintiesJson,
    financialYearJson,
    ...scalars
  } = value
  return {
    ...scalars,
    binding: parse(bindingJson),
    proof: parse(proofJson),
    summary: parse(summaryJson),
    rows: parse(rowsJson),
    coverage: parse(coverageJson),
    uncertainties: parse(uncertaintiesJson),
    financialYear: parse(financialYearJson),
  }
}
function caught(action: () => unknown): unknown {
  try {
    action()
    return undefined
  } catch (error) {
    return error
  }
}
function fixedError(error: unknown) {
  expect(error).toBeInstanceOf(PublicationFormatError)
  expect(error).toMatchObject({ name: 'PublicationFormatError', message: ERROR_TEXT })
}

afterEach(() => jest.restoreAllMocks())

describe('publication format v1, independent literals and actual stored pieces', () => {
  it.each([
    {
      name: 'success',
      literal: SUCCESS_LITERAL,
      bytes: 1608,
      digest: SUCCESS_DIGEST,
      outcome: success,
    },
    {
      name: 'overflow',
      literal: OVERFLOW_LITERAL,
      bytes: 1604,
      digest: OVERFLOW_DIGEST,
      outcome: overflow,
    },
  ])(
    '$name has the fixed full outer hash and exact decoded metadata',
    ({ literal, bytes, digest, outcome }) => {
      expect(Buffer.byteLength(literal, 'utf8')).toBe(bytes)
      expect(sha(literal)).toBe(digest)
      const encoded = encodeLedgerPublication(PUBLICATION, binding(), outcome())
      expect(encoded.publicationDigest).toBe(digest)
      expect(decodeLedgerPublication(stored(encoded))).toStrictEqual({
        ...record(parse(literal)),
        publicationDigest: digest,
      })
      expect(Object.isFrozen(encoded)).toBe(true)
      expect(
        Object.values(encoded).every(
          (v) => v === null || typeof v === 'string' || typeof v === 'number',
        ),
      ).toBe(true)
      if (encoded.status === 'FAILED') {
        expect(encoded.failureCode).toBe('AMOUNT_OVERFLOW')
        expect(encoded.reason).toBe(PUBLICATION_OVERFLOW_REASON)
        for (const key of [
          'canonicalBytes',
          'resultDigest',
          'summaryJson',
          'rowsJson',
          'coverageJson',
          'uncertaintiesJson',
          'financialYearJson',
        ] as const)
          expect(encoded[key]).toBeNull()
      } else {
        expect(encoded.canonicalBytes).toBe(309)
        expect(typeof encoded.canonicalBytes).toBe('number')
        expect(encoded.resultDigest).toBe(EMPTY_RESULT_DIGEST)
      }
    },
  )

  it('keeps ordered duplicate references without rows, Unicode and absent/null summary fields', () => {
    const result = empty()
    result.status = 'COMPLETE_WITH_UNCERTAINTY'
    result.references = [
      { voucher: '1|L|2', referenceType: null, referenceNumber: 'Å😀\n"\\' },
      { voucher: '1|L|1', referenceType: '', referenceNumber: null },
      { voucher: '1|L|2', referenceType: null, referenceNumber: 'Å😀\n"\\' },
    ]
    result.uncertainties = ['β', 'α', 'β']
    result.summary.balanceBroughtForwardOre = { '1510': null, '1930': -125, '2997': 0 }
    const encoded = encodeLedgerPublication(PUBLICATION, binding(), {
      kind: 'REDUCED',
      proof: proof(),
      result,
    })
    const pieces = stored(encoded)
    expect(record(pieces.rows)).toStrictEqual({ rows: [], references: result.references })
    expect(pieces.uncertainties).toStrictEqual(['β', 'α', 'β'])
    expect(Object.hasOwn(record(pieces.summary), 'financialYearAccountingMethod')).toBe(false)
    expect(decodeLedgerPublication(pieces).status).toBe('COMPLETE_WITH_UNCERTAINTY')
    result.summary.financialYearAccountingMethod = null
    const explicitNull = encodeLedgerPublication(PUBLICATION, binding(), {
      kind: 'REDUCED',
      proof: proof(),
      result,
    })
    expect(explicitNull.resultDigest).not.toBe(encoded.resultDigest)
    expect(explicitNull.publicationDigest).not.toBe(encoded.publicationDigest)
    expect(record(parse(explicitNull.summaryJson)).financialYearAccountingMethod).toBeNull()
  })

  it('snapshots all strings before caller mutation; key order changes no hash and array order does', () => {
    const b = binding(),
      p = proof(),
      result = empty()
    const encoded = encodeLedgerPublication(PUBLICATION, b, { kind: 'REDUCED', proof: p, result })
    const before = stored(encoded)
    const { counts, ...restBinding } = b
    const { claimVersion, ...restProof } = p
    const reordered = encodeLedgerPublication(
      PUBLICATION,
      { counts, ...restBinding },
      {
        kind: 'REDUCED',
        proof: { claimVersion, ...restProof },
        result,
      },
    )
    expect(reordered.publicationDigest).toBe(encoded.publicationDigest)
    b.input.costAccounts.push(5190)
    p.claimVersion++
    result.summary.totalOre = 99
    expect(stored(encoded)).toStrictEqual(before)
    expect(decodeLedgerPublication(stored(encoded)).publicationDigest).toBe(SUCCESS_DIGEST)
    const left = binding(),
      right = binding()
    left.input.costAccounts = [5170, 5190]
    right.input.costAccounts = [5190, 5170]
    expect(encodeLedgerPublication(PUBLICATION, left, success()).publicationDigest).not.toBe(
      encodeLedgerPublication(PUBLICATION, right, success()).publicationDigest,
    )
  })

  it('accepts manifest entries4 and unique vouchers3 as distinct nonnegative counters', () => {
    const p = { ...proof(), manifestPageCount: 2, manifestItemsSeen: 4, voucherCount: 3 }
    const encoded = encodeLedgerPublication(PUBLICATION, binding(), {
      kind: 'REDUCED',
      proof: p,
      result: empty(),
    })
    expect(decodeLedgerPublication(stored(encoded)).proof).toStrictEqual(p)
    // Counts are format values here. This test makes no SQL/A–F truth claim.
  })

  const corruptions: readonly [string, (s: Record<string, unknown>) => void][] = [
    [
      'body with old inner hash',
      (s) => {
        record(s.summary).totalOre = 1
      },
    ],
    [
      'outer field with old outer hash',
      (s) => {
        record(s.proof).claimVersion = 8
      },
    ],
    [
      'canonical byte mismatch',
      (s) => {
        s.canonicalBytes = 310
      },
    ],
    [
      'bigint is not the adapter number',
      (s) => {
        s.canonicalBytes = 309n
      },
    ],
    [
      'unsafe canonical bytes',
      (s) => {
        s.canonicalBytes = Number.MAX_SAFE_INTEGER + 1
      },
    ],
    [
      'negative zero',
      (s) => {
        record(s.proof).voucherCount = -0
      },
    ],
    [
      'extra top-level key',
      (s) => {
        s.publishedAt = '2026-01-01T00:00:00Z'
      },
    ],
    [
      'missing required top-level key',
      (s) => {
        Reflect.deleteProperty(s, 'reason')
      },
    ],
    [
      'unknown format version',
      (s) => {
        s.formatVersion = 2
      },
    ],
    [
      'strict nested shape',
      (s) => {
        record(s.proof).privateMarker = 'MUST_NOT_LEAK'
      },
    ],
    [
      'binding/proof org mismatch',
      (s) => {
        record(s.binding).organizationId = 'other'
      },
    ],
    [
      'source/run mismatch',
      (s) => {
        record(s.binding).sourceCaptureId = 'other'
      },
    ],
    [
      'success carrying overflow code',
      (s) => {
        s.failureCode = 'AMOUNT_OVERFLOW'
      },
    ],
    [
      'malformed full payload',
      (s) => {
        record(s.rows).references = null
      },
    ],
  ]
  it.each(corruptions)('rejects %s with a fixed non-data error', (_name, mutate) => {
    const value = stored(encodeLedgerPublication(PUBLICATION, binding(), success()))
    mutate(value)
    fixedError(caught(() => decodeLedgerPublication(value)))
  })

  it.each([
    'summary',
    'rows',
    'coverage',
    'uncertainties',
    'financialYear',
    'resultDigest',
    'canonicalBytes',
  ] as const)('overflow requires exact null for %s', (field) => {
    const value = stored(encodeLedgerPublication(PUBLICATION, binding(), overflow()))
    value[field] = field === 'canonicalBytes' ? 0 : field === 'resultDigest' ? '0'.repeat(64) : {}
    fixedError(caught(() => decodeLedgerPublication(value)))
  })

  it('reuses the strict transport gate before access, including Proxy and own accessor', () => {
    let calls = 0
    const b = binding()
    Object.defineProperty(b.input, 'periodFrom', {
      enumerable: true,
      get() {
        calls++
        return '2026-01-01'
      },
    })
    fixedError(caught(() => encodeLedgerPublication(PUBLICATION, b, success())))
    const value = stored(encodeLedgerPublication(PUBLICATION, binding(), success()))
    value.proof = new Proxy(proof(), {
      get(target, key, receiver) {
        calls++
        return Reflect.get(target, key, receiver)
      },
    })
    fixedError(caught(() => decodeLedgerPublication(value)))
    expect(calls).toBe(0)
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    fixedError(caught(() => decodeLedgerPublication(revoked.proxy)))
  })

  it.each(['encode', 'decode'] as const)(
    'missing own proof field cannot be completed by an inherited getter: %s',
    (direction) => {
      const b = binding(),
        p = proof()
      const value = stored(encodeLedgerPublication(PUBLICATION, b, success()))
      Reflect.deleteProperty(p, 'claimVersion')
      Reflect.deleteProperty(record(value.proof), 'claimVersion')
      const prior = Object.getOwnPropertyDescriptor(Object.prototype, 'claimVersion')
      let calls = 0,
        failure: unknown
      try {
        Object.defineProperty(Object.prototype, 'claimVersion', {
          configurable: true,
          enumerable: false,
          get() {
            calls++
            return 7
          },
        })
        failure = caught(() =>
          direction === 'encode'
            ? encodeLedgerPublication(PUBLICATION, b, {
                kind: 'REDUCED',
                proof: p,
                result: empty(),
              })
            : decodeLedgerPublication(value),
        )
      } finally {
        if (prior) Object.defineProperty(Object.prototype, 'claimVersion', prior)
        else Reflect.deleteProperty(Object.prototype, 'claimVersion')
      }
      fixedError(failure)
      expect(calls).toBe(0)
    },
  )

  it('ignores inherited optional input fields without accessing or inserting them', () => {
    const before = encodeLedgerPublication(PUBLICATION, binding(), success())
    const value = stored(before)
    const prior = Object.getOwnPropertyDescriptor(Object.prototype, 'financialYearStart')
    let calls = 0,
      encoded: EncodedPublication | undefined,
      decoded: unknown,
      failure: unknown
    try {
      Object.defineProperty(Object.prototype, 'financialYearStart', {
        configurable: true,
        enumerable: false,
        get() {
          calls++
          return '2026-01-01'
        },
      })
      try {
        encoded = encodeLedgerPublication(PUBLICATION, binding(), success())
        decoded = decodeLedgerPublication(value)
      } catch (error) {
        failure = error
      }
    } finally {
      if (prior) Object.defineProperty(Object.prototype, 'financialYearStart', prior)
      else Reflect.deleteProperty(Object.prototype, 'financialYearStart')
    }
    expect(failure).toBeUndefined()
    expect(calls).toBe(0)
    expect(encoded).toStrictEqual(before)
    expect(Object.hasOwn(record(record(record(decoded).binding).input), 'financialYearStart')).toBe(
      false,
    )
  })

  it('requires an own REDUCED result before reading it; z.unknown must not adopt an inherited getter', () => {
    const b = binding(),
      outcome = success(),
      inherited = empty()
    Reflect.deleteProperty(outcome, 'result')
    const prior = Object.getOwnPropertyDescriptor(Object.prototype, 'result')
    let calls = 0,
      failure: unknown
    try {
      Object.defineProperty(Object.prototype, 'result', {
        configurable: true,
        enumerable: false,
        get() {
          calls++
          return inherited
        },
      })
      failure = caught(() => encodeLedgerPublication(PUBLICATION, b, outcome))
    } finally {
      if (prior) Object.defineProperty(Object.prototype, 'result', prior)
      else Reflect.deleteProperty(Object.prototype, 'result')
    }
    fixedError(failure)
    expect(calls).toBe(0)
  })

  it('rejects explicit undefined optional input instead of converting it to absence', () => {
    const b = binding()
    Object.defineProperty(b.input, 'financialYearStart', { enumerable: true, value: undefined })
    fixedError(caught(() => encodeLedgerPublication(PUBLICATION, b, success())))
  })

  it('does not mask unknown errors even when they resemble the fixed error text', () => {
    const unknownFailure = Object.assign(new Error(ERROR_TEXT), {
      code: 'P2010',
      meta: { code: '22012' },
    })
    jest.spyOn(resultFormat, 'encodeLedgerResult').mockImplementationOnce(() => {
      throw unknownFailure
    })
    expect(caught(() => encodeLedgerPublication(PUBLICATION, binding(), success()))).toBe(
      unknownFailure,
    )
    // This is a propagation seam, not a real database-failure test.
  })
})
