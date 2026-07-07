import { ServiceUnavailableException } from '@nestjs/common'
import type {
  BankDataProvider,
  ProviderAccount,
  ProviderTokens,
  ProviderConsentStatus,
  ProviderRawTx,
} from '../psd2.types'

/**
 * Inaktiv bank-data-provider — används när PSD2_ENABLED=false (default).
 * STRUKTURELLT oförmögen: varje väg som skulle kunna initiera samtycke eller hämta
 * transaktioner kastar 503. Det finns ingen kodväg där denna provider kan skapa en
 * BankConsent eller mata ingestFromApi, ens vid felkonfiguration.
 */
export class StubBankDataProvider implements BankDataProvider {
  readonly name = 'STUB'

  private unavailable(): never {
    throw new ServiceUnavailableException('PSD2-bankkoppling är inte aktiverad')
  }

  async beginConsent(_input: {
    organizationId: string
    state: string
    redirectUri: string
  }): Promise<{ consentId: string; authUrl: string }> {
    return this.unavailable()
  }

  async exchangeCallback(_input: { code: string; state: string }): Promise<ProviderTokens> {
    return this.unavailable()
  }

  async getConsentStatus(_input: {
    consentId: string
    accessToken: string
  }): Promise<{ status: ProviderConsentStatus; expiresAt?: Date }> {
    return this.unavailable()
  }

  async listAccounts(_input: {
    consentId: string
    accessToken: string
  }): Promise<ProviderAccount[]> {
    return this.unavailable()
  }

  async fetchTransactions(_input: {
    consentId: string
    accessToken: string
    accountId: string
    since?: string | undefined
  }): Promise<{ transactions: ProviderRawTx[]; cursor?: string }> {
    return this.unavailable()
  }

  async revokeConsent(_input: { consentId: string; accessToken: string }): Promise<void> {
    return this.unavailable()
  }
}
