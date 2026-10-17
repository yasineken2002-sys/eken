import { createHash } from 'node:crypto'
import { types } from 'node:util'
import type { Coverage, LedgerRowProvenance, LedgerSummary } from './fortnox-ledger'
import type { ReducedLedgerResult } from './fortnox-read-reduction'
import { isDate } from './fortnox-ledger-validation'

/** Version 1 hashes the complete result as sorted-key, ordered-array UTF-8 JSON.
 * This is a storage format, never proof of origin, authorization or a valid lease.
 */
export type EncodedLedgerResult = Readonly<{
  formatVersion: 1
  resultDigest: string
  canonicalBytes: number
  status: ReducedLedgerResult['status']
  reason: null
  summaryJson: string
  rowsJson: string
  coverageJson: string
  uncertaintiesJson: string
  financialYearJson: string
}>

export class LedgerResultFormatError extends Error {
  constructor() {
    super('Ogiltigt lagrat huvudboksresultat')
    this.name = 'LedgerResultFormatError'
  }
}

const fail = (): never => {
  throw new LedgerResultFormatError()
}

// true = required, false = absent is allowed. Typecheck catches added type fields.
const RESULT_KEYS = {
  status: true,
  reason: true,
  financialYear: true,
  summary: true,
  rows: true,
  references: true,
  coverage: true,
  uncertainties: true,
} satisfies Record<keyof ReducedLedgerResult, boolean>
const ROW_KEYS = {
  voucher: true,
  row: true,
  transactionDate: true,
  account: true,
  amountOre: true,
  bucket: true,
  dimensionType: true,
  code: true,
  propertyId: true,
  evenoExport: true,
  evenoSource: false,
} satisfies Record<keyof LedgerRowProvenance, boolean>
const SUMMARY_KEYS = {
  currency: true,
  totalOre: true,
  byProperty: true,
  unmappedDimensions: true,
  unallocatedOre: true,
  uncertainRemovedOre: true,
  evenoExportOre: true,
  balanceBroughtForwardOre: false,
  financialYearAccountingMethod: false,
} satisfies Record<keyof LedgerSummary, boolean>
const COVERAGE_KEYS = {
  pages: true,
  totalPages: true,
  totalResources: true,
  itemsSeen: true,
} satisfies Record<keyof Coverage, boolean>

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail()
  return value as Record<string, unknown>
}

function fields(value: unknown, expected: Record<string, boolean>): Record<string, unknown> {
  const result = object(value)
  if (Object.keys(result).some((key) => !Object.hasOwn(expected, key))) fail()
  for (const [key, required] of Object.entries(expected)) {
    if (required && !Object.hasOwn(result, key)) fail()
  }
  return result
}

function string(value: unknown): void {
  if (typeof value !== 'string') fail()
}

function integer(value: unknown): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail()
}

function count(value: unknown): void {
  integer(value)
  if ((value as number) < 0) fail()
}

function nullable(value: unknown, validate: (value: unknown) => void): void {
  if (value !== null) validate(value)
}

function array(value: unknown, validate: (value: unknown) => void): void {
  if (!Array.isArray(value)) fail()
  for (const item of value as unknown[]) validate(item)
}

function dimension(value: unknown): void {
  if (value !== 'COST_CENTER' && value !== 'PROJECT') fail()
}

/** PostgreSQL JSONB cannot round-trip NUL or unpaired UTF-16 surrogates. */
function transportString(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code === 0 || (code >= 0xdc00 && code <= 0xdfff)) fail()
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail()
    }
  }
}

function rejectInheritedJsonHooks(): void {
  // Native stringify consults inherited toJSON too. Inspect its descriptor so
  // even a prototype getter is rejected without running application code.
  for (const prototype of [Object.prototype, Array.prototype] as object[]) {
    const hook = Object.getOwnPropertyDescriptor(prototype, 'toJSON')
    if (hook && (!('value' in hook) || typeof hook.value === 'function')) fail()
  }
}

/** Inspect descriptors before reading values: JSON.stringify must not silently
 * drop data, invoke getters/toJSON or normalize a non-JSON value. Ancestors,
 * rather than a global seen set, permit repeated acyclic objects. Valid v1
 * shapes are shallow; the depth guard only bounds malformed nested input.
 */
function transportJson(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  // A Proxy can expose different values between descriptor checks and reads.
  if (types.isProxy(value)) fail()
  if (depth > 16) fail()
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'string') return transportString(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail()
    return
  }
  if (typeof value !== 'object' || value === null || ancestors.has(value)) fail()
  const current = value as object
  const isArray = Array.isArray(current)
  const prototype = Object.getPrototypeOf(current) as unknown
  if (
    isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
  )
    fail()
  if (Object.getOwnPropertySymbols(current).length) fail()
  ancestors.add(current)
  const keys = Object.getOwnPropertyNames(current)
  if (isArray && keys.length !== (current as unknown[]).length + 1) fail()
  for (const key of keys) {
    if (isArray && key === 'length') continue
    transportString(key)
    if (isArray && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= (current as unknown[]).length))
      fail()
    const descriptor = Object.getOwnPropertyDescriptor(current, key)!
    if (!descriptor.enumerable || !('value' in descriptor)) fail()
    transportJson(descriptor.value, ancestors, depth + 1)
  }
  ancestors.delete(current)
}

/** Reuse the exact result transport guard for the small publication envelope. */
export function assertLedgerTransportJson(value: unknown): void {
  rejectInheritedJsonHooks()
  transportJson(value)
}

function row(value: unknown): void {
  const r = fields(value, ROW_KEYS)
  string(r.voucher)
  count(r.row)
  if (!isDate(r.transactionDate)) fail()
  count(r.account)
  integer(r.amountOre)
  if (!['PROPERTY', 'UNMAPPED', 'UNALLOCATED', 'UNCERTAIN_REMOVED'].includes(r.bucket as string))
    fail()
  nullable(r.dimensionType, dimension)
  nullable(r.code, string)
  nullable(r.propertyId, string)
  if (typeof r.evenoExport !== 'boolean') fail()
  if (Object.hasOwn(r, 'evenoSource')) {
    const source = fields(r.evenoSource, {
      journalEntryId: true,
      sourceAccount: true,
      mappingRevision: true,
    })
    string(source.journalEntryId)
    nullable(source.sourceAccount, integer)
    nullable(source.mappingRevision, integer)
  }
}

function summary(value: unknown): void {
  const s = fields(value, SUMMARY_KEYS)
  if (s.currency !== 'SEK') fail()
  for (const key of ['totalOre', 'unallocatedOre', 'uncertainRemovedOre', 'evenoExportOre'])
    integer(s[key])
  array(s.byProperty, (item) => {
    const p = fields(item, { propertyId: true, propertyName: true, amountOre: true })
    string(p.propertyId)
    string(p.propertyName)
    integer(p.amountOre)
  })
  array(s.unmappedDimensions, (item) => {
    const d = fields(item, { dimensionType: true, code: true, amountOre: true })
    dimension(d.dimensionType)
    string(d.code)
    integer(d.amountOre)
  })
  if (Object.hasOwn(s, 'balanceBroughtForwardOre')) {
    for (const amount of Object.values(object(s.balanceBroughtForwardOre)))
      nullable(amount, integer)
  }
  if (Object.hasOwn(s, 'financialYearAccountingMethod'))
    nullable(s.financialYearAccountingMethod, string)
}

function validateResult(value: unknown): asserts value is ReducedLedgerResult {
  const r = fields(value, RESULT_KEYS)
  if ((r.status !== 'COMPLETE' && r.status !== 'COMPLETE_WITH_UNCERTAINTY') || r.reason !== null)
    fail()
  const year = fields(r.financialYear, { id: true, fromDate: true, toDate: true })
  count(year.id)
  if (!isDate(year.fromDate) || !isDate(year.toDate)) fail()
  summary(r.summary)
  array(r.rows, row)
  array(r.references, (item) => {
    const ref = fields(item, { voucher: true, referenceType: true, referenceNumber: true })
    string(ref.voucher)
    nullable(ref.referenceType, string)
    nullable(ref.referenceNumber, string)
  })
  for (const c of Object.values(object(r.coverage))) {
    const coverage = fields(c, COVERAGE_KEYS)
    for (const counter of Object.values(coverage)) count(counter)
  }
  array(r.uncertainties, string)
}

function measure(value: unknown): { resultDigest: string; canonicalBytes: number } {
  const hash = createHash('sha256')
  let canonicalBytes = 0
  const feed = (part: string) => {
    hash.update(part)
    canonicalBytes += Buffer.byteLength(part, 'utf8')
  }
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      feed('[')
      item.forEach((entry, index) => {
        if (index) feed(',')
        visit(entry)
      })
      feed(']')
    } else if (item !== null && typeof item === 'object') {
      feed('{')
      Object.keys(item)
        .sort()
        .forEach((key, index) => {
          if (index) feed(',')
          feed(`${JSON.stringify(key)}:`)
          visit((item as Record<string, unknown>)[key])
        })
      feed('}')
    } else feed(JSON.stringify(item))
  }
  visit(value)
  return { resultDigest: hash.digest('hex'), canonicalBytes }
}

/** Freeze transport strings before any await. Callers cannot later mutate the
 * payload behind its digest. This never stores or authorizes a publication.
 */
export function encodeLedgerResult(result: ReducedLedgerResult): EncodedLedgerResult {
  rejectInheritedJsonHooks()
  transportJson(result)
  validateResult(result)
  return Object.freeze({
    formatVersion: 1,
    ...measure(result),
    status: result.status,
    reason: null,
    summaryJson: JSON.stringify(result.summary),
    rowsJson: JSON.stringify({ rows: result.rows, references: result.references }),
    coverageJson: JSON.stringify(result.coverage),
    uncertaintiesJson: JSON.stringify(result.uncertainties),
    financialYearJson: JSON.stringify(result.financialYear),
  })
}

/** Validate the actual JSONB values, not just the stored digest. The caller must
 * separately verify organization/run/proof and immutable publication binding.
 */
export function decodeLedgerResult(stored: unknown): ReducedLedgerResult {
  rejectInheritedJsonHooks()
  transportJson(stored)
  const s = fields(stored, {
    formatVersion: true,
    resultDigest: true,
    canonicalBytes: true,
    status: true,
    reason: true,
    summary: true,
    rows: true,
    coverage: true,
    uncertainties: true,
    financialYear: true,
  })
  if (
    s.formatVersion !== 1 ||
    typeof s.resultDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(s.resultDigest)
  )
    fail()
  count(s.canonicalBytes)
  const rows = fields(s.rows, { rows: true, references: true })
  const result: unknown = {
    status: s.status,
    reason: s.reason,
    financialYear: s.financialYear,
    summary: s.summary,
    rows: rows.rows,
    references: rows.references,
    coverage: s.coverage,
    uncertainties: s.uncertainties,
  }
  validateResult(result)
  const measured = measure(result)
  if (measured.resultDigest !== s.resultDigest || measured.canonicalBytes !== s.canonicalBytes)
    fail()
  return result
}
