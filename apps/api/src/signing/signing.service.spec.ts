/**
 * SigningService end-to-end mot MockSigningProvider (ingen DB/nätverk):
 *   • createSigningRequest fryser contentHash + är idempotent,
 *   • WYSIWYS: hash-mismatch → inget bevis skrivs,
 *   • identitetsavstämning: fel personnr → inget bevis skrivs,
 *   • happy path: bevis skrivs (personnr KRYPTERAT, blind-index satt), FULLY_SIGNED,
 *     förseglad PDF som ny låst version, originalet låst,
 *   • getStatusSafe returnerar aldrig känsliga fält.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Prisma } from '@prisma/client'
import { SigningService } from './signing.service'
import { SigningCryptoService } from './signing-crypto.service'
import { MockSigningProvider } from './providers/mock-signing.provider'

const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
const PEPPER = 'test-pepper-1234567890'
const TENANT_PN = '199001011234'
const FROZEN_HASH = 'frozen-content-hash'

function makeFakePrisma() {
  const signingRequests: Array<Record<string, unknown>> = []
  const evidence: Array<Record<string, unknown>> = []
  const documents = new Map<string, Record<string, unknown>>()
  documents.set('doc-1', {
    id: 'doc-1',
    organizationId: 'org-1',
    name: 'Hyreskontrakt',
    category: 'CONTRACT',
    contentHash: FROZEN_HASH,
    storageKey: 'documents/org-1/doc-1.pdf',
    storageUrl: 'https://r2/doc-1',
    locked: false,
    leaseId: 'lease-1',
    tenantId: 'tenant-1',
    signedAt: null,
  })
  let seq = 0

  const attachEvidence = (reqId: string) => ({
    ...signingRequests.find((r) => r.id === reqId)!,
    evidence: evidence
      .filter((e) => e.signingRequestId === reqId)
      .map((e) => ({ orderRef: e.orderRef, signerRole: e.signerRole })),
  })

  const prisma = {
    document: {
      findFirst: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(documents.get(where.id) ?? null),
      ),
      findFirstOrThrow: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(documents.get(where.id)!),
      ),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const id = `doc-sealed-${(seq += 1)}`
        const row = { id, signedAt: null, ...data }
        documents.set(id, row)
        return Promise.resolve(row)
      }),
      update: jest.fn(
        ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          Object.assign(documents.get(where.id)!, data)
          return Promise.resolve(documents.get(where.id))
        },
      ),
    },
    lease: {
      findFirst: jest.fn(() => Promise.resolve({ tenant: { personalNumber: TENANT_PN } })),
    },
    signingRequest: {
      findFirst: jest.fn(
        ({ where, include }: { where: Record<string, unknown>; include?: unknown }) => {
          const r = signingRequests.find(
            (x) =>
              (where.id === undefined || x.id === where.id) &&
              (where.idempotencyKey === undefined || x.idempotencyKey === where.idempotencyKey) &&
              (where.providerRequestId === undefined ||
                x.providerRequestId === where.providerRequestId),
          )
          if (!r) return Promise.resolve(null)
          return Promise.resolve(include ? attachEvidence(r.id as string) : r)
        },
      ),
      findFirstOrThrow: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(attachEvidence(where.id)),
      ),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `req-${(seq += 1)}`, ...data }
        signingRequests.push(row)
        return Promise.resolve(row)
      }),
      update: jest.fn(
        ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          Object.assign(signingRequests.find((r) => r.id === where.id)!, data)
          return Promise.resolve(signingRequests.find((r) => r.id === where.id))
        },
      ),
    },
    signatureEvidence: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        if (
          evidence.some(
            (e) =>
              e.organizationId === data.organizationId &&
              e.provider === data.provider &&
              e.orderRef === data.orderRef,
          )
        ) {
          throw new Prisma.PrismaClientKnownRequestError('dup', {
            code: 'P2002',
            clientVersion: 'test',
          })
        }
        evidence.push({ id: `ev-${(seq += 1)}`, ...data })
        return Promise.resolve(data)
      }),
    },
  }
  return { prisma, signingRequests, evidence, documents }
}

function makeService(provider = new MockSigningProvider()) {
  const fake = makeFakePrisma()
  const crypto = new SigningCryptoService({
    get: (k: string) => ({ SIGNING_PII_KEY: KEY, SIGNING_PII_PEPPER: PEPPER })[k],
  } as never)
  const storage = { uploadFile: jest.fn().mockResolvedValue('https://r2/sealed') }
  const service = new SigningService(fake.prisma as never, crypto, storage as never, provider)
  return { service, provider, storage, ...fake }
}

describe('SigningService.createSigningRequest', () => {
  it('fryser contentHash och är idempotent', async () => {
    const { service, signingRequests } = makeService()
    const r1 = await service.createSigningRequest('org-1', 'user-1', 'doc-1')
    expect(r1.contentHash).toBe(FROZEN_HASH)
    expect(r1.status).toBe('SIGNING_IN_PROGRESS')
    const r2 = await service.createSigningRequest('org-1', 'user-1', 'doc-1')
    expect(r2.id).toBe(r1.id) // samma request — ingen andra-envelope
    expect(signingRequests).toHaveLength(1)
  })

  it('avvisar ett redan låst kontrakt', async () => {
    const { service, documents } = makeService()
    ;(documents.get('doc-1') as { locked: boolean }).locked = true
    await expect(service.createSigningRequest('org-1', 'user-1', 'doc-1')).rejects.toThrow(/låst/i)
  })
})

describe('SigningService.refreshStatus — säkerhet + happy path', () => {
  it('happy path: bevis skrivs (personnr krypterat + blind-index), FULLY_SIGNED, sealed + låst', async () => {
    const { service, provider, evidence, documents } = makeService()
    const req = await service.createSigningRequest('org-1', 'user-1', 'doc-1')
    provider.completeParty(req.providerRequestId as string, 'TENANT', {
      personalNumber: TENANT_PN,
      signerName: 'Anna Andersson',
    })

    const updated = await service.refreshStatus('org-1', req.id)

    expect(updated.status).toBe('FULLY_SIGNED')
    expect(evidence).toHaveLength(1)
    const ev = evidence[0]!
    // personnr KRYPTERAT (inte klartext) + blind-index satt
    expect(ev.personalNumberEnc).not.toContain(TENANT_PN)
    expect(ev.personalNumberHash).toMatch(/^[0-9a-f]{64}$/)
    expect(ev.signaturePayload).not.toContain('mock-signature') // krypterad
    // originalet låst + signerat, förseglad ny version skapad
    expect((documents.get('doc-1') as { locked: boolean }).locked).toBe(true)
    expect(updated.sealedDocumentId).toBeTruthy()
  })

  it('WYSIWYS: signerad hash ≠ frusen → inget bevis skrivs', async () => {
    const { service, provider, evidence } = makeService()
    const req = await service.createSigningRequest('org-1', 'user-1', 'doc-1')
    provider.completeParty(req.providerRequestId as string, 'TENANT', {
      personalNumber: TENANT_PN,
      signerName: 'Anna',
      signedContentHash: 'MANIPULERAD-HASH',
    })
    await expect(service.refreshStatus('org-1', req.id)).rejects.toThrow(/matchar inte/i)
    expect(evidence).toHaveLength(0)
  })

  it('identitetsavstämning: fel personnr → inget bevis skrivs', async () => {
    const { service, provider, evidence } = makeService()
    const req = await service.createSigningRequest('org-1', 'user-1', 'doc-1')
    provider.completeParty(req.providerRequestId as string, 'TENANT', {
      personalNumber: '198512121212', // ≠ tenantens 199001011234
      signerName: 'Fel Person',
    })
    await expect(service.refreshStatus('org-1', req.id)).rejects.toThrow(/förväntade signeraren/i)
    expect(evidence).toHaveLength(0)
  })

  it('getStatusSafe returnerar aldrig känsliga fält', async () => {
    const { service, provider } = makeService()
    const req = await service.createSigningRequest('org-1', 'user-1', 'doc-1')
    provider.completeParty(req.providerRequestId as string, 'TENANT', {
      personalNumber: TENANT_PN,
      signerName: 'Anna',
    })
    await service.refreshStatus('org-1', req.id)
    const safe = await service.getStatusSafe('org-1', req.id)
    const json = JSON.stringify(safe)
    expect(json).not.toContain(TENANT_PN)
    expect(json).not.toContain('mock-order') // orderRef
    expect(json).not.toContain('mock-cert')
  })
})
