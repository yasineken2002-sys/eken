import { createHash } from 'crypto'
import { BadRequestException } from '@nestjs/common'
import { MAX_BELOPP_ORE, tolkaDatum } from './opening-csv'

export const SOURCE_FORMAT = 'EVENO-RESKONTRA-1'
export const MAPPING_FORMAT = 'EVENO-MAPPNING-1'
export const NORMALIZATION = 'EVENO-EVIDENS-NORM-1'
export const SOURCE_HEADER =
  'kallforetag;kund;avtal;dokument;typ;period;forfallodag;ursprungOre;betaltOre;krediteratOre;oppetOre;mottagetDatum;mottagningsbevis'
export const MAPPING_HEADER = 'kallforetag;kund;avtal;tenantId;leaseId;metod'
export const MAX_EVIDENCE_BYTES = 960_000
export const MAX_EVIDENCE_ROWS = 1000
export const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
export const key = (...values: string[]) => JSON.stringify(values)
export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

/** Sorted object keys, preserved array order; only JSON values are accepted. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return (
      '{' +
      Object.keys(value)
        .sort(order)
        .map((k) => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k]))
        .join(',') +
      '}'
    )
  throw new Error('Evidensens kanoniska värde måste vara JSON med exakta heltal')
}

export function assertText(text: unknown): asserts text is string {
  if (typeof text !== 'string' || !text || text.length > 900_000)
    throw new BadRequestException('Underlaget saknas eller är för stort')
  // Reject lone surrogates and controls; UTF-8 encoding must not silently repair bytes.
  if (
    Buffer.from(text, 'utf8').toString('utf8') !== text ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)
  )
    throw new BadRequestException('Underlaget innehåller ogiltiga tecken')
}

export function assertUpload(source: unknown, mapping: unknown) {
  assertText(source)
  assertText(mapping)
  if (Buffer.byteLength(source) + Buffer.byteLength(mapping) > MAX_EVIDENCE_BYTES)
    throw new BadRequestException('Underlaget är för stort')
}

/** Exact header/cell count, quoted CSV with explicit state and bounded rows. */
export function strictCsv(text: string, header: string): string[][] {
  assertText(text)
  const t = text.replace(/^\uFEFF/u, '')
  if (t.includes('\uFEFF')) throw new BadRequestException('BOM tillåts bara i början av filen')
  const rows: string[][] = []
  let row: string[] = [],
    cell = '',
    state: 'start' | 'bare' | 'quoted' | 'closed' = 'start'
  const finishCell = () => {
    row.push(cell)
    cell = ''
    state = 'start'
  }
  const finishRow = () => {
    finishCell()
    rows.push(row)
    row = []
    if (rows.length > MAX_EVIDENCE_ROWS + 1)
      throw new BadRequestException('Underlaget har fler än 1000 rader')
  }
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!
    if (state === 'quoted') {
      if (c === '"') {
        if (t[i + 1] === '"') {
          cell += '"'
          i++
        } else state = 'closed'
      } else cell += c
    } else if (c === ';') finishCell()
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++
      finishRow()
    } else if (c === '"' && state === 'start') state = 'quoted'
    else if (c === '"' || state === 'closed')
      throw new BadRequestException('Felplacerat citattecken i underlaget')
    else {
      cell += c
      state = 'bare'
    }
  }
  if (state === 'quoted') throw new BadRequestException('Oavslutat citattecken i underlaget')
  if (cell || row.length || state !== 'start') finishRow()
  const expected = header.split(';')
  if (canonical(rows[0] ?? []) !== canonical(expected))
    throw new BadRequestException('Fel eller dubbla rubriker i underlaget')
  if (rows.some((r) => r.length !== expected.length))
    throw new BadRequestException('Fel antal kolumner i underlaget')
  return rows.slice(1)
}

export type EvidenceKind = 'RECEIVABLE' | 'DEPOSIT'
export interface SourceDocument {
  row: number
  company: string
  customer: string
  contract: string
  document: string
  kind: EvidenceKind
  period: string
  due: string
  original: number | null
  paid: number | null
  credited: number | null
  open: number | null
  received: string
  receipt: string
  errors: string[]
}
export interface EvidenceMapping {
  row: number
  company: string
  customer: string
  contract: string
  tenantId: string
  leaseId: string
  method: string
}
const ore = (value: string): number | null =>
  /^(0|[1-9]\d*)$/u.test(value) && Number(value) <= MAX_BELOPP_ORE ? Number(value) : null
const identifier = (v: string) => v.length > 0 && v.length <= 200 && !/[\r\n\t]/u.test(v)

export function parseSource(text: string, company: string, cutover: string): SourceDocument[] {
  return strictCsv(text, SOURCE_HEADER).map((r, i) => {
    const [
      co = '',
      customer = '',
      contract = '',
      document = '',
      kind = '',
      period = '',
      due = '',
      original = '',
      paid = '',
      credited = '',
      open = '',
      received = '',
      receipt = '',
    ] = r.map((x) => x.trim())
    const errors: string[] = []
    if ([co, customer, contract, document].some((v) => !identifier(v)))
      errors.push('Dokumentets identitet saknas eller är ogiltig')
    if (co !== company) errors.push('Källföretaget stämmer inte med deklarationen')
    if (kind !== 'RECEIVABLE' && kind !== 'DEPOSIT') errors.push('Okänd dokumenttyp')
    const amounts = {
      original: ore(original),
      paid: ore(paid),
      credited: ore(credited),
      open: ore(open),
    }
    if (Object.values(amounts).some((v) => v === null))
      errors.push('Belopp saknas eller är inte giltiga heltalsören')
    if (amounts.open !== null && amounts.open <= 0)
      errors.push('Öppet belopp måste vara större än noll')
    if (kind === 'RECEIVABLE') {
      if (
        !/^\d{4}-(0[1-9]|1[0-2])$/u.test(period) ||
        !tolkaDatum(period + '-01') ||
        period + '-01' >= cutover
      )
        errors.push('Perioden måste ligga före brytdatum')
      if (!tolkaDatum(due)) errors.push('Förfallodag saknas eller är ogiltig')
      if (received || receipt) errors.push('Mottagningsuppgifter gäller bara deposition')
      if (
        Object.values(amounts).every((v) => v !== null) &&
        amounts.original! - amounts.paid! - amounts.credited! !== amounts.open
      )
        errors.push('Original minus betalt och krediterat är inte öppet belopp')
    } else if (kind === 'DEPOSIT') {
      if (!tolkaDatum(received) || received >= cutover || !receipt || receipt.length > 2000)
        errors.push(
          'Depositionen saknar giltigt mottagetdatum eller deklarerad mottagningsreferens',
        )
      if (
        period ||
        due ||
        amounts.paid !== 0 ||
        amounts.credited !== 0 ||
        (amounts.original !== null && amounts.open !== null && amounts.open > amounts.original)
      )
        errors.push('Depositionen får inte nettas mot hyra, betalningar eller krediter')
    }
    return {
      row: i + 1,
      company: co,
      customer,
      contract,
      document,
      kind: kind as EvidenceKind,
      period,
      due,
      ...amounts,
      received,
      receipt,
      errors,
    }
  })
}

export function parseMapping(text: string): EvidenceMapping[] {
  return strictCsv(text, MAPPING_HEADER).map((r, i) => {
    const [company = '', customer = '', contract = '', tenantId = '', leaseId = '', method = ''] =
      r.map((x) => x.trim())
    if (
      [company, customer, contract, tenantId, leaseId].some((v) => !identifier(v)) ||
      !method ||
      method.length > 2000
    )
      throw new BadRequestException('Mappningen saknar identitet eller metod')
    return { row: i + 1, company, customer, contract, tenantId, leaseId, method }
  })
}
