import type { FortnoxLedgerReader, FortnoxVoucher } from './fortnox.types'
import type { MockFortnoxLedgerReader } from './fortnox-providers'
import type { FortnoxTransport } from './provider/fortnox-transport'
import { FortnoxTransportError } from './provider/fortnox-transport.types'
import type { FortnoxCustomerBinding } from './fortnox-customer-activation'

/**
 * Skrivport för POST /3/vouchers (FORTNOX-SANDNING, FORTNOX-NATT).
 *
 * Stub och REAL utan uttrycklig opt-in får `DisabledVoucherWriter`. Den skarpa
 * skrivaren (`RealFortnoxVoucherWriter`) skapas bara i REAL-läge med
 * FORTNOX_TEST_VOUCHER_WRITES=<exakt värde> och skriver ENDAST till företag i den
 * hårdkodade listan `FORTNOX_TEST_WRITE_COMPANIES` — riktiga kundföretag kan inte
 * aktiveras med konfiguration, bara med ändrad och granskad kod.
 * Mock-skrivaren är syntetisk (NODE_ENV=test).
 */
export const FORTNOX_VOUCHER_WRITER = Symbol('FORTNOX_VOUCHER_WRITER')

/**
 * Enda externa företag som någonsin får skrivas till: det separata testföretaget
 * "Eveno integrationstest 2026-10-02" (syntetiskt orgnr 555555-5555). Kod, inte
 * konfiguration.
 */
export const FORTNOX_TEST_WRITE_COMPANIES: readonly number[] = Object.freeze([1868238])

/** Exakt opt-in-värde för FORTNOX_TEST_VOUCHER_WRITES; allt annat icke-tomt stoppar boot. */
export const FORTNOX_TEST_VOUCHER_WRITES_VALUE = 'testforetag-1868238'

/** Företaget som anspråket frös (FortnoxVoucherExport.fortnoxDatabaseNumber). */
export interface FortnoxWriteBinding {
  databaseNumber: number | null
  /** KUNDSTART §6: en verifierad kundaktivering (bara för företag utanför testlistan). */
  kund?: FortnoxCustomerBinding | null
}

/** Skrivarens egen DB-kontroll av en kundbindning (försvar på djupet, S-2). */
export type CustomerBindingVerifier = (
  b: FortnoxCustomerBinding,
  transactionDate: string,
) => Promise<boolean>

/** Verifikatsdatum ur skrivarens egen payload (Voucher.TransactionDate); '' om det saknas. */
export function payloadDatum(payload: unknown): string {
  const d = (payload as { Voucher?: { TransactionDate?: unknown } } | null)?.Voucher
    ?.TransactionDate
  return typeof d === 'string' ? d : ''
}

export interface FortnoxVoucherWriter {
  /** False = sändning är tekniskt avstängd; inget anspråk får tas. */
  readonly capable: boolean
  /** KUNDSTART: är kundvägen (FORTNOX_CUSTOMER_WRITES=aktiverad) påslagen? */
  readonly customerWritesEnabled: boolean
  /** KUNDSTART: kräver detta företag en kundaktivering (ligger utanför testvägen)? */
  requiresCustomerActivation(databaseNumber: number | null): boolean
  /**
   * Får skrivaren skriva till detta företag? Kontrolleras före anspråk. Ett kundföretag
   * släpps bara med en kundbindning för just det numret, och skrivaren verifierar den
   * själv mot databasen före POST.
   */
  allowsCompany(databaseNumber: number | null, kund?: FortnoxCustomerBinding | null): boolean
  /** Returnerar rått, ännu ovaliderat svar. Kastar FortnoxWriteError. */
  createVoucher(
    token: string,
    query: { financialyear: number },
    payload: unknown,
    binding: FortnoxWriteBinding,
  ): Promise<unknown>
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
  readonly customerWritesEnabled = false
  requiresCustomerActivation(): boolean {
    return true
  }
  allowsCompany(): boolean {
    return false
  }
  async createVoucher(): Promise<unknown> {
    throw new FortnoxWriteError('not_sent')
  }
}

export interface RealFortnoxVoucherWriterOptions {
  /** Separat transport med allowVoucherWrites=true; delar limiter med läsaren. */
  transport: FortnoxTransport
  /** Läsaren (skrivoförmögen transport) för live-kontrollen av företaget. */
  reader: FortnoxLedgerReader
  clientId: string
  /** FORTNOX_TEST_VOUCHER_WRITES (aldrig i produktion): testlistan är skrivbar. */
  testWrites?: boolean
  /** FORTNOX_CUSTOMER_WRITES=aktiverad: kundvägen med verifierad aktivering. */
  customerWrites?: boolean
  verifyCustomer?: CustomerBindingVerifier
}

/**
 * Skarp skrivare, endast testföretaget. Tre spärrar utöver opt-in vid boot:
 *  1. det frysta företaget måste finnas i FORTNOX_TEST_WRITE_COMPANIES,
 *  2. GET /3/companyinformation med SAMMA token omedelbart före POST måste ge
 *     samma DatabaseNumber (annars not_sent — inget har skickats),
 *  3. transporten tillåter bara POST /3/vouchers?financialyear=<heltal>, utan
 *     omförsök och utan omdirigering.
 * Inga token, URL:er eller svarstexter lämnar klassen i fel.
 */
export class RealFortnoxVoucherWriter implements FortnoxVoucherWriter {
  readonly capable = true
  readonly #transport: FortnoxTransport
  readonly #reader: FortnoxLedgerReader
  readonly #rateLimitKey: string
  readonly #testWrites: boolean
  readonly #verifyCustomer: CustomerBindingVerifier | null
  readonly customerWritesEnabled: boolean

  constructor(options: RealFortnoxVoucherWriterOptions) {
    if (typeof options.clientId !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(options.clientId))
      throw new FortnoxWriteError('not_sent')
    this.#transport = options.transport
    this.#reader = options.reader
    // Samma hink som läsaren: en konservativ gräns för hela klienten.
    this.#rateLimitKey = `fortnox:${options.clientId}:all-tenants`
    // Bakåtkompatibelt: utan uttryckliga val är det testvägen (som före KUNDSTART).
    this.#testWrites = options.testWrites ?? !options.customerWrites
    this.customerWritesEnabled = options.customerWrites === true && !!options.verifyCustomer
    this.#verifyCustomer = options.verifyCustomer ?? null
  }

  #testCompany(databaseNumber: number | null): boolean {
    return (
      this.#testWrites &&
      databaseNumber !== null &&
      FORTNOX_TEST_WRITE_COMPANIES.includes(databaseNumber)
    )
  }

  requiresCustomerActivation(databaseNumber: number | null): boolean {
    return !this.#testCompany(databaseNumber)
  }

  allowsCompany(databaseNumber: number | null, kund?: FortnoxCustomerBinding | null): boolean {
    if (this.#testCompany(databaseNumber)) return true
    return (
      this.customerWritesEnabled &&
      databaseNumber !== null &&
      !FORTNOX_TEST_WRITE_COMPANIES.includes(databaseNumber) &&
      !!kund &&
      kund.databaseNumber === databaseNumber
    )
  }

  async createVoucher(
    token: string,
    query: { financialyear: number },
    payload: unknown,
    binding: FortnoxWriteBinding,
  ): Promise<unknown> {
    if (!this.allowsCompany(binding.databaseNumber, binding.kund))
      throw new FortnoxWriteError('not_sent')
    if (!this.#testCompany(binding.databaseNumber)) {
      // Kundvägen: lita inte på anroparen — pröva aktiveringen i databasen nu.
      let ok = false
      try {
        ok =
          !!binding.kund &&
          !!this.#verifyCustomer &&
          (await this.#verifyCustomer(binding.kund, payloadDatum(payload)))
      } catch {
        ok = false
      }
      if (!ok) throw new FortnoxWriteError('not_sent')
    }
    let live: unknown
    try {
      const ci = await this.#reader.get<{ CompanyInformation?: { DatabaseNumber?: unknown } }>(
        token,
        '/3/companyinformation',
      )
      live = ci?.CompanyInformation?.DatabaseNumber
    } catch {
      throw new FortnoxWriteError('not_sent')
    }
    if (live !== binding.databaseNumber) throw new FortnoxWriteError('not_sent')
    try {
      const res = await this.#transport.request({
        accessToken: token,
        rateLimitKey: this.#rateLimitKey,
        method: 'POST',
        path: '/3/vouchers',
        query: { financialyear: query.financialyear },
        body: payload,
      })
      return res.data
    } catch (err) {
      if (err instanceof FortnoxTransportError) {
        throw new FortnoxWriteError(
          err.outcome === 'not_sent'
            ? 'not_sent'
            : err.outcome === 'rejected'
              ? 'rejected'
              : 'unknown',
          err.status,
        )
      }
      throw new FortnoxWriteError('unknown')
    }
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
  /** Prov: företagen skrivaren vägrar (som om de låg utanför listan). */
  deniedCompanies = new Set<number>()
  /** Prov: senaste bindningen som skrivaren fick. */
  lastBinding: FortnoxWriteBinding | null = null
  /** KUNDSTART-prov: syntetiska KUNDföretag som kräver kundaktivering (som i REAL). */
  customerCompanies = new Set<number>()
  readonly customerWritesEnabled = true
  verifyCustomer: CustomerBindingVerifier | null = null

  constructor(private readonly ledger: MockFortnoxLedgerReader) {}

  requiresCustomerActivation(databaseNumber: number | null): boolean {
    return databaseNumber !== null && this.customerCompanies.has(databaseNumber)
  }

  allowsCompany(databaseNumber: number | null, kund?: FortnoxCustomerBinding | null): boolean {
    if (databaseNumber === null || this.deniedCompanies.has(databaseNumber)) return false
    if (this.customerCompanies.has(databaseNumber))
      return !!kund && kund.databaseNumber === databaseNumber
    return true
  }

  async createVoucher(
    _token: string,
    query: { financialyear: number },
    payload: unknown,
    binding: FortnoxWriteBinding,
  ): Promise<unknown> {
    this.lastBinding = binding
    if (!this.allowsCompany(binding.databaseNumber, binding.kund))
      throw new FortnoxWriteError('not_sent')
    if (binding.databaseNumber !== null && this.customerCompanies.has(binding.databaseNumber)) {
      const ok =
        !!binding.kund &&
        !!this.verifyCustomer &&
        (await this.verifyCustomer(binding.kund, payloadDatum(payload)))
      if (!ok) throw new FortnoxWriteError('not_sent')
    }
    // Mätt mot Fortnox (EX-1): Voucher.Year i POST-kroppen är skrivskyddat → 400.
    if (Object.hasOwn((payload as { Voucher?: object })?.Voucher ?? {}, 'Year'))
      throw new FortnoxWriteError('rejected', 400)
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
