import type { FortnoxVoucher, FortnoxVoucherRow } from './fortnox.types'

/** Läsningen kan inte fullföljas; samma feltyp används av läsning och summering. */
export class Incomplete extends Error {}

const DATE = /^\d{4}-\d{2}-\d{2}$/

export function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** Befintlig sid-/identitetsregel: heltal från noll, trots det historiska namnet. */
export function isPosInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * Belopp → heltal öre, exakt ur talets decimala form. Ingen epsilon eller
 * flyttalsmultiplikation; exponentform, fler decimaler och osäkra heltal avvisas.
 */
export function toOre(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value))
  if (!match) return null
  const ore = BigInt(match[2] ?? '0') * 100n + BigInt((match[3] ?? '').padEnd(2, '0') || '0')
  const signed = match[1] === '-' ? -ore : ore
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < -BigInt(Number.MAX_SAFE_INTEGER))
    return null
  return Number(signed)
}

const absent = (value: unknown) => value === undefined || value === null
const sideOre = (value: unknown): number | null => (absent(value) ? 0 : toOre(value))
const optionalCode = (value: unknown) =>
  value === undefined || value === null || typeof value === 'string'

/** Alla rader i hela året kontrolleras, även utanför valda konton och perioden. */
function rowProblem(row: unknown): string | null {
  if (!row || typeof row !== 'object') return 'rad saknas'
  const value = row as Record<string, unknown>
  if (
    typeof value.Account !== 'number' ||
    !Number.isInteger(value.Account) ||
    value.Account < 1000 ||
    value.Account > 9999
  ) {
    return 'ogiltigt konto'
  }
  if (absent(value.Debit) && absent(value.Credit)) return 'belopp saknas på båda sidor'
  const debit = sideOre(value.Debit)
  const credit = sideOre(value.Credit)
  if (debit === null || credit === null) return 'ogiltigt belopp'
  if (debit < 0 || credit < 0) return 'negativt belopp (semantik obelagd)'
  if (value.Removed !== undefined && typeof value.Removed !== 'boolean')
    return 'ogiltig borttagningsmarkering'
  if (!optionalCode(value.CostCenter) || !optionalCode(value.Project)) return 'ogiltig dimension'
  return null
}

/**
 * Hela listobjektet jämförs före normalisering. Även skillnader i extra fält
 * betyder konflikt för samma identitet; den råa kroppen ingår inte i normalformen.
 */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export function voucherKey(voucher: FortnoxVoucher): string | null {
  if (
    !isPosInt(voucher.Year) ||
    typeof voucher.VoucherSeries !== 'string' ||
    !isPosInt(voucher.VoucherNumber)
  ) {
    return null
  }
  if (!/^[A-Za-z0-9]{1,10}$/.test(voucher.VoucherSeries)) return null
  return `${voucher.Year}|${voucher.VoucherSeries}|${voucher.VoucherNumber}`
}

export interface ValidatedLedgerVoucher {
  key: string
  date: string
  /** Huvudets dimension är aldrig radens dimension; bara den befintliga varningen. */
  headerDimensionPresent: boolean
  /** Truthy rå referens bevarar posten, även om båda normaliserade fälten blir null. */
  reference: { type: string | null; number: string | null } | null
  rows: Array<{
    index1: number
    account: number
    debitOre: number
    creditOre: number
    costCenter: string | null
    project: string | null
    removed: boolean
  }>
}

/**
 * Kontrollerar samma detalj i samma ordning som readLedger gjorde. Normalformen
 * innehåller endast uppgifterna som reduceraren behöver, inga fria API-fält.
 */
export function validateLedgerVoucher(
  key: string,
  voucher: FortnoxVoucher | undefined,
  year: { id: number; fromDate: string; toDate: string },
): ValidatedLedgerVoucher {
  if (!voucher || voucherKey(voucher) !== key)
    throw new Incomplete(`Detalj saknas eller avviker för verifikat ${key}`)
  if (Number(key.split('|')[0]) !== year.id)
    throw new Incomplete(`Verifikat ${key} hör till fel räkenskapsår`)
  if (
    !isDate(voucher.TransactionDate) ||
    voucher.TransactionDate < year.fromDate ||
    voucher.TransactionDate > year.toDate
  ) {
    throw new Incomplete(`Verifikat ${key} har saknat eller ogiltigt datum`)
  }
  if (!Array.isArray(voucher.VoucherRows) || voucher.VoucherRows.length < 2)
    throw new Incomplete(`Verifikat ${key} saknar rader`)
  for (const [index, row] of (voucher.VoucherRows as unknown[]).entries()) {
    const problem = rowProblem(row)
    if (problem) throw new Incomplete(`Verifikat ${key} rad ${index + 1}: ${problem}`)
  }

  // Ingen filtrering sker här: även en rad på ett annat konto ska ha passerat
  // kontrollen ovan. Originalets enbaserade position följer med till proveniensen.
  return {
    key,
    date: voucher.TransactionDate,
    headerDimensionPresent: Boolean(voucher.CostCenter || voucher.Project),
    reference:
      voucher.ReferenceType || voucher.ReferenceNumber
        ? {
            type: typeof voucher.ReferenceType === 'string' ? voucher.ReferenceType : null,
            number: typeof voucher.ReferenceNumber === 'string' ? voucher.ReferenceNumber : null,
          }
        : null,
    rows: (voucher.VoucherRows as FortnoxVoucherRow[]).map((row, index) => ({
      index1: index + 1,
      account: row.Account as number,
      // Båda sidornas giltighet är bevisad för samtliga rader före normalisering.
      debitOre: sideOre(row.Debit)!,
      creditOre: sideOre(row.Credit)!,
      costCenter: typeof row.CostCenter === 'string' && row.CostCenter ? row.CostCenter : null,
      project: typeof row.Project === 'string' && row.Project ? row.Project : null,
      removed: row.Removed === true,
    })),
  }
}
