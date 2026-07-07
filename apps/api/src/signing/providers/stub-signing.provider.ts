import { ServiceUnavailableException } from '@nestjs/common'
import type {
  DocumentSigningProvider,
  CreateSigningRequestInput,
  ProviderStatusResult,
  SealedDocument,
  WebhookVerification,
  SignerRoleT,
} from '../signing.types'

/**
 * Inaktiv signeringsprovider — används när SIGNING_ENABLED=false (default).
 * STRUKTURELLT oförmögen att signera: varje väg som skulle kunna producera en
 * giltig signatur kastar 503. Det finns ingen kodväg där denna provider kan
 * returnera en fullbordad signatur, ens vid felkonfiguration.
 */
export class StubSigningProvider implements DocumentSigningProvider {
  readonly name = 'STUB'

  private unavailable(): never {
    throw new ServiceUnavailableException('Signering är inte aktiverad')
  }

  async createRequest(
    _input: CreateSigningRequestInput,
  ): Promise<{ providerRequestId: string; invites: Array<{ role: SignerRoleT; url?: string }> }> {
    return this.unavailable()
  }

  async getStatus(_providerRequestId: string): Promise<ProviderStatusResult> {
    return this.unavailable()
  }

  async fetchSealed(_providerRequestId: string): Promise<SealedDocument | null> {
    return this.unavailable()
  }

  async cancel(_providerRequestId: string): Promise<void> {
    return this.unavailable()
  }

  // Webhooks kan aldrig verifieras mot en inaktiv provider.
  verifyWebhook(
    _headers: Record<string, string | undefined>,
    _rawBody: Buffer,
  ): WebhookVerification {
    return { valid: false }
  }
}
