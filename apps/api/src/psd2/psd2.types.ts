/**
 * PSD2 P2 — aggregator-agnostisk bank-API-port. En adapter (Enable Banking / Tink /
 * GoCardless) ERSÄTTER BARA KÄLLAN för råa transaktioner (fil → bank-API) och matar
 * EXAKT samma härdade pipeline via ReconciliationService.ingestFromApi. Porten rör
 * ALDRIG matchning/bokföring — bara samtycke + inflöde.
 *
 * Providern injiceras via DI-token (flaggan PSD2_ENABLED känd på ETT ställe i
 * psd2.module). Stub = strukturellt oförmögen (503). Mock = skriptad testdubbel.
 * Skarp adapter = P3 (kräver avtal/nycklar).
 */
export const PSD2_PROVIDER = Symbol('PSD2_PROVIDER')

// Rå transaktion från aggregatorn. `externalId` = bankens transaktions-id
// (obligatoriskt → ingest blir idempotent). Mappas till ingestFromApi:s
// ApiRawTransaction. `organizationId` finns MEDVETET inte här — sync-scoping
// härleds alltid ur vår BankConsent, aldrig ur aggregatorns råsvar.
export interface ProviderRawTx {
  externalId: string
  bookingDate: Date
  booked: boolean
  currency: string
  amount: number
  description: string
  ocr?: string | undefined
  reference?: string | undefined
}

export interface ProviderAccount {
  accountId: string
  currency: string
  iban?: string | undefined
}

export interface ProviderTokens {
  consentId: string
  accessToken: string
  refreshToken?: string | undefined
  scope?: string | undefined
  expiresAt?: Date | undefined
}

export type ProviderConsentStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'ERROR'

export interface BankDataProvider {
  readonly name: string

  // Samtyckes-livscykel (SCA-redirect). `state` är vår CSRF-bindning; providern
  // ekar tillbaka den i callbacken.
  beginConsent(input: {
    organizationId: string
    state: string
    redirectUri: string
  }): Promise<{ consentId: string; authUrl: string }>

  // Växlar callback-koden mot tokens. Providern verifierar `state`/koden.
  exchangeCallback(input: { code: string; state: string }): Promise<ProviderTokens>

  getConsentStatus(input: {
    consentId: string
    accessToken: string
  }): Promise<{ status: ProviderConsentStatus; expiresAt?: Date | undefined }>

  listAccounts(input: { consentId: string; accessToken: string }): Promise<ProviderAccount[]>

  // Inkrementell hämtning. `since` = cursor från förra synken (opak sträng).
  fetchTransactions(input: {
    consentId: string
    accessToken: string
    accountId: string
    since?: string | undefined
  }): Promise<{ transactions: ProviderRawTx[]; cursor?: string | undefined }>

  revokeConsent(input: { consentId: string; accessToken: string }): Promise<void>
}
