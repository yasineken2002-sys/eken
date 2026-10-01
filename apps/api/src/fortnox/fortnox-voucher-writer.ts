import type { FortnoxVoucher } from './fortnox.types'
import type { MockFortnoxLedgerReader } from './fortnox-providers'

/**
 * Skrivport för POST /3/vouchers (FORTNOX-SANDNING).
 *
 * I den LEVERERADE produktkonfigurationen finns ingen kapabel skrivare: Stub och
 * REAL får `DisabledVoucherWriter` (och transporten har allowVoucherWrites=false).
 * Ingen miljöflagga slår på skrivning — aktivering kräver ändrad och granskad kod.
 * Den enda kapabla skrivaren är den syntetiska Mock-skrivaren (NODE_ENV=test).
 */
export const FORTNOX_VOUCHER_WRITER = Symbol('FORTNOX_VOUCHER_WRITER')

export interface FortnoxVoucherWriter {
  /** False = sändning är tekniskt avstängd; inget anspråk får tas. */
  readonly capable: boolean
  /** Returnerar rått, ännu ovaliderat svar. Kastar FortnoxWriteError. */
  createVoucher(token: string, query: { financialyear: number }, payload: unknown): Promise<unknown>
}

/**
 * Utfall utan token, URL eller svarstext (samma klasser som transporten):
 *   not_sent  — bevisligen aldrig skickat (före nätanrop)
 *   rejected  — uttryckligt avvisande (4xx); INTE bevis för att inget skrevs
 *   unknown   — kan ha skrivits (nät, timeout, 5xx, tvetydigt svar)
 */
export class FortnoxWriteError extends Error {
  constructor(
    readonly outcome: 'not_sent' | 'rejected' | 'unknown',
    readonly status?: number,
  ) {
    super(`Fortnox write: ${outcome}`)
    this.name = 'FortnoxWriteError'
  }
}

export class DisabledVoucherWriter implements FortnoxVoucherWriter {
  readonly capable = false
  async createVoucher(): Promise<unknown> {
    throw new FortnoxWriteError('not_sent')
  }
}

/** Felinjektion för prov. Varje värde förbrukas av ETT anrop. */
export type MockWriteFault =
  | 'not_sent'
  | 'rejected'
  | 'unknown_before_write'
  | 'unknown_after_write'
  | 'invalid_success'
  | 'wrong_year'
  | 'wrong_series'

/**
 * Syntetisk Fortnox-huvudbok för skrivning. Skriver in i SAMMA Mock-läsare som
 * återläsningen använder, så att verifiering och readback mäter verklig effekt.
 * `writes` räknar externa effekter (poster som faktiskt skapats).
 */
export class MockVoucherWriter implements FortnoxVoucherWriter {
  readonly capable = true
  writes = 0
  faults: MockWriteFault[] = []
  /** Prov: körs före respektive efter den externa effekten (barriärer). */
  beforeWrite: (() => Promise<void>) | null = null
  afterWrite: (() => Promise<void>) | null = null

  constructor(private readonly ledger: MockFortnoxLedgerReader) {}

  async createVoucher(
    _token: string,
    query: { financialyear: number },
    payload: unknown,
  ): Promise<unknown> {
    const fault = this.faults.shift()
    if (fault === 'not_sent') throw new FortnoxWriteError('not_sent')
    if (fault === 'rejected') throw new FortnoxWriteError('rejected', 400)
    if (fault === 'unknown_before_write') throw new FortnoxWriteError('unknown', 504)
    if (this.beforeWrite) await this.beforeWrite()
    const v = (payload as { Voucher?: Record<string, unknown> })?.Voucher ?? {}
    const series = String(v.VoucherSeries)
    const number =
      Math.max(
        0,
        ...this.ledger.vouchers
          .filter((x) => x.VoucherSeries === series && x.Year === query.financialyear)
          .map((x) => Number(x.VoucherNumber)),
      ) + 1
    const created: FortnoxVoucher = {
      Year: query.financialyear,
      VoucherSeries: series,
      VoucherNumber: number,
      TransactionDate: v.TransactionDate,
      Description: v.Description,
      VoucherRows: structuredClone(v.VoucherRows),
    }
    this.ledger.vouchers.push(created)
    this.writes += 1
    if (this.afterWrite) await this.afterWrite()
    if (fault === 'unknown_after_write') throw new FortnoxWriteError('unknown', 504)
    if (fault === 'invalid_success') return { Voucher: { Year: query.financialyear } }
    if (fault === 'wrong_year') return { Voucher: { ...created, Year: query.financialyear + 1 } }
    if (fault === 'wrong_series') return { Voucher: { ...created, VoucherSeries: `${series}X` } }
    return { Voucher: structuredClone(created) }
  }
}
