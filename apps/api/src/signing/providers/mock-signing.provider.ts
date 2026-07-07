import type {
  DocumentSigningProvider,
  CreateSigningRequestInput,
  ProviderStatusResult,
  ProviderPartyEvidence,
  SealedDocument,
  WebhookVerification,
  SignerRoleT,
} from '../signing.types'

interface MockEnvelope {
  input: CreateSigningRequestInput
  parties: Map<
    SignerRoleT,
    { status: 'pending' | 'signed' | 'declined'; evidence?: ProviderPartyEvidence }
  >
}

/**
 * Test-dubbel: driver HELA signeringskedjan i test utan nycklar/nätverk. Till
 * skillnad från Stub KAN den fullborda en signering — men bara via de explicita
 * test-helpers (completeParty/declineParty), aldrig av sig själv. Registreras
 * ALDRIG i produktion (bara via SIGNING_PROVIDER-factory i test/utveckling).
 */
export class MockSigningProvider implements DocumentSigningProvider {
  readonly name = 'MOCK'
  private readonly envelopes = new Map<string, MockEnvelope>()
  private seq = 0

  createRequest(
    input: CreateSigningRequestInput,
  ): Promise<{ providerRequestId: string; invites: Array<{ role: SignerRoleT; url?: string }> }> {
    const providerRequestId = `mock-req-${(this.seq += 1)}`
    const parties = new Map<SignerRoleT, { status: 'pending' | 'signed' | 'declined' }>()
    for (const p of input.parties) parties.set(p.role, { status: 'pending' })
    this.envelopes.set(providerRequestId, { input, parties })
    return Promise.resolve({
      providerRequestId,
      invites: input.parties.map((p) => ({
        role: p.role,
        url: `mock://sign/${providerRequestId}/${p.role}`,
      })),
    })
  }

  getStatus(providerRequestId: string): Promise<ProviderStatusResult> {
    const env = this.envelopes.get(providerRequestId)
    if (!env) return Promise.resolve({ overall: 'error', parties: [] })
    const parties = [...env.parties.entries()].map(([role, s]) => ({
      role,
      status: s.status,
      ...(s.evidence ? { evidence: s.evidence } : {}),
    }))
    const statuses = parties.map((p) => p.status)
    let overall: ProviderStatusResult['overall'] = 'pending'
    if (statuses.includes('declined')) overall = 'declined'
    else if (statuses.every((s) => s === 'signed')) overall = 'completed'
    else if (statuses.some((s) => s === 'signed')) overall = 'partially_signed'
    return Promise.resolve({ overall, parties })
  }

  fetchSealed(providerRequestId: string): Promise<SealedDocument | null> {
    const env = this.envelopes.get(providerRequestId)
    if (!env) return Promise.resolve(null)
    const allSigned = [...env.parties.values()].every((s) => s.status === 'signed')
    if (!allSigned) return Promise.resolve(null)
    // Syntetisk förseglad PDF (egna bytes → egen hash, som en riktig försegling).
    return Promise.resolve({
      bytes: Buffer.from(`%PDF-1.4 mock-sealed ${providerRequestId}`),
      hasEvidencePage: true,
    })
  }

  cancel(providerRequestId: string): Promise<void> {
    this.envelopes.delete(providerRequestId)
    return Promise.resolve()
  }

  verifyWebhook(headers: Record<string, string | undefined>): WebhookVerification {
    // Mock accepterar sin egen test-header och plockar ut request-id:t.
    const rid = headers['x-mock-request-id']
    return rid ? { valid: true, providerRequestId: rid } : { valid: false }
  }

  // ── Test-helpers (används bara av specar för att driva flödet) ────────────────
  completeParty(
    providerRequestId: string,
    role: SignerRoleT,
    identity: { personalNumber: string; signerName: string; signedContentHash?: string },
  ): void {
    const env = this.envelopes.get(providerRequestId)
    if (!env) throw new Error(`okänt mock-request ${providerRequestId}`)
    env.parties.set(role, {
      status: 'signed',
      evidence: {
        role,
        signerName: identity.signerName,
        personalNumber: identity.personalNumber,
        orderRef: `mock-order-${providerRequestId}-${role}`,
        // Default: signera exakt det frusna innehållet (happy path). Testet kan
        // skicka en avvikande hash för att bevisa hashMismatch-avvisning.
        signedContentHash: identity.signedContentHash ?? env.input.contentHash,
        signaturePayload: `mock-signature-payload-${role}`,
        certificate: 'mock-cert',
        signedAt: new Date('2026-07-07T10:00:00Z'),
        ip: '203.0.113.5',
        userAgent: 'MockBankID/1.0',
      },
    })
  }

  declineParty(providerRequestId: string, role: SignerRoleT): void {
    const env = this.envelopes.get(providerRequestId)
    if (env) env.parties.set(role, { status: 'declined' })
  }
}
