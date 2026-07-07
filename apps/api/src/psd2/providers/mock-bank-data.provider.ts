import type {
  BankDataProvider,
  ProviderAccount,
  ProviderTokens,
  ProviderConsentStatus,
  ProviderRawTx,
} from '../psd2.types'

/**
 * Skriptad testdubbel för bank-data-porten. Låter hela kedjan samtycke →
 * callback → sync → ingestFromApi → matchning testas UTAN nycklar/nätverk.
 * In-memory; deterministisk. Aldrig i produktion (DI-factoryn väljer den bara i
 * test/kontraktsspec).
 */
export class MockBankDataProvider implements BankDataProvider {
  readonly name = 'MOCK'

  // Skriptas av testet: transaktioner som fetchTransactions returnerar.
  transactions: ProviderRawTx[] = []
  accounts: ProviderAccount[] = [{ accountId: 'acc-1', currency: 'SEK' }]
  consentStatus: ProviderConsentStatus = 'ACTIVE'
  revoked: string[] = []
  fetchCalls: Array<{ accountId: string; since?: string | undefined }> = []

  async beginConsent(input: {
    organizationId: string
    state: string
    redirectUri: string
  }): Promise<{ consentId: string; authUrl: string }> {
    return {
      consentId: `mock-consent-${input.organizationId}`,
      authUrl: `https://mock-bank.example/auth?state=${input.state}`,
    }
  }

  async exchangeCallback(input: { code: string; state: string }): Promise<ProviderTokens> {
    return {
      consentId: `mock-consent-${input.state}`,
      accessToken: `mock-access-${input.code}`,
      refreshToken: `mock-refresh-${input.code}`,
      scope: 'accounts transactions',
      expiresAt: new Date('2026-10-05T00:00:00Z'),
    }
  }

  async getConsentStatus(_input: {
    consentId: string
    accessToken: string
  }): Promise<{ status: ProviderConsentStatus; expiresAt?: Date }> {
    return { status: this.consentStatus }
  }

  async listAccounts(_input: {
    consentId: string
    accessToken: string
  }): Promise<ProviderAccount[]> {
    return this.accounts
  }

  async fetchTransactions(input: {
    consentId: string
    accessToken: string
    accountId: string
    since?: string | undefined
  }): Promise<{ transactions: ProviderRawTx[]; cursor?: string }> {
    this.fetchCalls.push({ accountId: input.accountId, since: input.since })
    return { transactions: this.transactions, cursor: 'mock-cursor-1' }
  }

  async revokeConsent(input: { consentId: string; accessToken: string }): Promise<void> {
    this.revoked.push(input.consentId)
  }
}
