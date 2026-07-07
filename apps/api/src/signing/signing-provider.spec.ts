/**
 * Provider-kontrakts-spec: Stub (inert) och Mock (test-dubbel) mot samma
 * DocumentSigningProvider-kontrakt. Detta är nyckeln till leverantörsbytbarhet —
 * en skarp Scrive-adapter (S3) måste passera samma spec.
 */

import { StubSigningProvider } from './providers/stub-signing.provider'
import { MockSigningProvider } from './providers/mock-signing.provider'
import type { CreateSigningRequestInput } from './signing.types'

const INPUT: CreateSigningRequestInput = {
  documentId: 'doc-1',
  contentHash: 'hash-abc',
  storageKey: 'documents/org/doc-1.pdf',
  parties: [{ role: 'TENANT', name: 'Hyresgäst' }],
  visibleText: 'Jag signerar hyreskontrakt doc-1',
  idempotencyKey: 'idem-1',
}

describe('StubSigningProvider — strukturellt oförmögen att signera', () => {
  const stub = new StubSigningProvider()

  it('createRequest kastar 503', async () => {
    await expect(stub.createRequest(INPUT)).rejects.toThrow(/inte aktiverad/i)
  })
  it('getStatus/fetchSealed/cancel kastar 503', async () => {
    await expect(stub.getStatus('x')).rejects.toThrow()
    await expect(stub.fetchSealed('x')).rejects.toThrow()
    await expect(stub.cancel('x')).rejects.toThrow()
  })
  it('verifyWebhook returnerar alltid ogiltig', () => {
    expect(stub.verifyWebhook({}, Buffer.alloc(0)).valid).toBe(false)
  })
})

describe('MockSigningProvider — driver hela kedjan i test', () => {
  it('createRequest → completeParty → completed → fetchSealed', async () => {
    const mock = new MockSigningProvider()
    const { providerRequestId } = await mock.createRequest(INPUT)

    let status = await mock.getStatus(providerRequestId)
    expect(status.overall).toBe('pending')
    expect(await mock.fetchSealed(providerRequestId)).toBeNull()

    mock.completeParty(providerRequestId, 'TENANT', {
      personalNumber: '199001011234',
      signerName: 'Anna Andersson',
    })

    status = await mock.getStatus(providerRequestId)
    expect(status.overall).toBe('completed')
    expect(status.parties[0]!.evidence!.signedContentHash).toBe(INPUT.contentHash)

    const sealed = await mock.fetchSealed(providerRequestId)
    expect(sealed?.bytes.length).toBeGreaterThan(0)
    expect(sealed?.hasEvidencePage).toBe(true)
  })

  it('declineParty → declined', async () => {
    const mock = new MockSigningProvider()
    const { providerRequestId } = await mock.createRequest(INPUT)
    mock.declineParty(providerRequestId, 'TENANT')
    expect((await mock.getStatus(providerRequestId)).overall).toBe('declined')
  })

  it('completeParty kan skicka avvikande hash (för hashMismatch-test)', async () => {
    const mock = new MockSigningProvider()
    const { providerRequestId } = await mock.createRequest(INPUT)
    mock.completeParty(providerRequestId, 'TENANT', {
      personalNumber: '199001011234',
      signerName: 'Anna',
      signedContentHash: 'FEL-HASH',
    })
    const status = await mock.getStatus(providerRequestId)
    expect(status.parties[0]!.evidence!.signedContentHash).toBe('FEL-HASH')
  })
})
