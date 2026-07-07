/**
 * Psd2ConsentService — consent-säkerhet (ingen DB/nätverk):
 *   • state är single-use: en andra callback med samma state avvisas,
 *   • organizationId hämtas ur den server-lagrade state, ALDRIG ur callback-queryn,
 *   • tokens lagras KRYPTERADE (aldrig klartext i BankConsent),
 *   • utgången state avvisas,
 *   • revoke markerar REVOKED + anropar providern.
 */

import { BadRequestException } from '@nestjs/common'
import { Psd2ConsentService } from './psd2-consent.service'
import { BankConsentCryptoService } from './bank-consent-crypto.service'
import { MockBankDataProvider } from './providers/mock-bank-data.provider'

const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'

function makeFake() {
  const states: Array<Record<string, unknown>> = []
  const consents: Array<Record<string, unknown>> = []
  let seq = 0

  const prisma = {
    psd2ConsentState: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `st-${(seq += 1)}`, consumedAt: null, ...data }
        states.push(row)
        return Promise.resolve(row)
      }),
      updateMany: jest.fn(
        ({
          where,
          data,
        }: {
          where: { state: string; consumedAt: null; expiresAt: { gt: Date } }
          data: Record<string, unknown>
        }) => {
          const row = states.find(
            (s) =>
              s.state === where.state &&
              s.consumedAt == null &&
              (s.expiresAt as Date) > where.expiresAt.gt,
          )
          if (!row) return Promise.resolve({ count: 0 })
          Object.assign(row, data)
          return Promise.resolve({ count: 1 })
        },
      ),
      findUniqueOrThrow: jest.fn(({ where }: { where: { state: string } }) =>
        Promise.resolve(states.find((s) => s.state === where.state)!),
      ),
    },
    bankConsent: {
      upsert: jest.fn(
        ({
          where,
          create,
          update,
        }: {
          where: {
            organizationId_provider_consentId: {
              organizationId: string
              provider: string
              consentId: string
            }
          }
          create: Record<string, unknown>
          update: Record<string, unknown>
        }) => {
          const key = where.organizationId_provider_consentId
          const found = consents.find(
            (c) =>
              c.organizationId === key.organizationId &&
              c.provider === key.provider &&
              c.consentId === key.consentId,
          )
          if (found) {
            Object.assign(found, update)
            return Promise.resolve(found)
          }
          const row = { id: `bc-${(seq += 1)}`, ...create }
          consents.push(row)
          return Promise.resolve(row)
        },
      ),
      findMany: jest.fn(({ where }: { where: { organizationId: string } }) =>
        Promise.resolve(consents.filter((c) => c.organizationId === where.organizationId)),
      ),
      findFirst: jest.fn(({ where }: { where: { id: string; organizationId: string } }) =>
        Promise.resolve(
          consents.find((c) => c.id === where.id && c.organizationId === where.organizationId) ??
            null,
        ),
      ),
      update: jest.fn(
        ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = consents.find((c) => c.id === where.id)!
          Object.assign(row, data)
          return Promise.resolve(row)
        },
      ),
    },
  }
  return { prisma, states, consents }
}

function makeService(provider = new MockBankDataProvider()) {
  const fake = makeFake()
  const crypto = new BankConsentCryptoService({ get: () => KEY } as never)
  const config = { get: (_k: string) => undefined }
  const service = new Psd2ConsentService(fake.prisma as never, crypto, config as never, provider)
  return { service, provider, crypto, ...fake }
}

describe('Psd2ConsentService', () => {
  it('beginConsent lagrar state med organizationId server-side och returnerar authUrl', async () => {
    const { service, states } = makeService()
    const { authUrl } = await service.beginConsent('org-1', 'user-1')
    expect(states).toHaveLength(1)
    expect(states[0]!.organizationId).toBe('org-1')
    expect(authUrl).toContain('state=')
  })

  it('handleCallback: org från state, tokens KRYPTERADE, ej klartext', async () => {
    const { service, states, consents, crypto } = makeService()
    await service.beginConsent('org-42', 'user-1')
    const state = states[0]!.state as string

    const res = await service.handleCallback(state, 'code-abc')
    expect(res.organizationId).toBe('org-42') // från state, inte queryn

    const consent = consents[0]!
    expect(consent.organizationId).toBe('org-42')
    // accessToken var 'mock-access-code-abc' → lagras krypterat, aldrig klartext.
    expect(consent.accessTokenEnc).not.toContain('mock-access')
    expect(crypto.decrypt(consent.accessTokenEnc as string)).toBe('mock-access-code-abc')
  })

  it('state är SINGLE-USE: andra callbacken med samma state avvisas', async () => {
    const { service, states, consents } = makeService()
    await service.beginConsent('org-1', 'user-1')
    const state = states[0]!.state as string

    await service.handleCallback(state, 'code-1')
    await expect(service.handleCallback(state, 'code-1')).rejects.toBeInstanceOf(
      BadRequestException,
    )
    expect(consents).toHaveLength(1) // ingen andra consent skapad
  })

  it('utgången state avvisas', async () => {
    const { service, states } = makeService()
    await service.beginConsent('org-1', 'user-1')
    ;(states[0]! as { expiresAt: Date }).expiresAt = new Date(Date.now() - 1000)
    await expect(service.handleCallback(states[0]!.state as string, 'code')).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })

  it('saknad state/code avvisas', async () => {
    const { service } = makeService()
    await expect(service.handleCallback('', 'code')).rejects.toBeInstanceOf(BadRequestException)
    await expect(service.handleCallback('state', '')).rejects.toBeInstanceOf(BadRequestException)
  })

  it('revoke: anropar providern och markerar REVOKED', async () => {
    const { service, provider, states, consents } = makeService()
    await service.beginConsent('org-1', 'user-1')
    await service.handleCallback(states[0]!.state as string, 'code-1') // skapar ett consent
    const consentId = consents[0]!.id as string

    await service.revokeConsent('org-1', consentId, 'user-1')
    expect(consents[0]!.status).toBe('REVOKED')
    expect(provider.revoked.length).toBeGreaterThan(0)
  })

  it('revoke: annan org kan inte återkalla (org-scoping)', async () => {
    const { service, states, consents } = makeService()
    await service.beginConsent('org-1', 'user-1')
    await service.handleCallback(states[0]!.state as string, 'code-1')
    await expect(
      service.revokeConsent('org-ANNAN', consents[0]!.id as string, 'user-x'),
    ).rejects.toThrow(/hittades inte/i)
  })
})
