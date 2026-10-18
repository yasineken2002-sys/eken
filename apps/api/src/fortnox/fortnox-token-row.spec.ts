import { ConfigService } from '@nestjs/config'
import type { FortnoxConnection, Prisma } from '@prisma/client'
import type { PrismaService } from '../common/prisma/prisma.service'
import { FortnoxConnectionService } from './fortnox-connection.service'
import { FortnoxTokenCryptoService } from './fortnox-token-crypto.service'
import type { FortnoxAuthProvider, FortnoxLedgerReader } from './fortnox.types'
import { FortnoxRateIdentity } from './provider/fortnox-rate-limiter'

type ConnectionStore = {
  findUnique(args: Prisma.FortnoxConnectionFindUniqueArgs): Promise<FortnoxConnection | null>
  updateMany(args: Prisma.FortnoxConnectionUpdateManyArgs): Promise<Prisma.BatchPayload>
}

const ORG = 'synthetic-token-row-org'
const TOKEN_B = 'synthetic-access-b'

function unexpected(): never {
  throw new Error('Oväntat provideranrop i same-row-provet')
}

function rig(
  freshIdentity: Pick<FortnoxConnection, 'id' | 'fortnoxDatabaseNumber' | 'tokenVersion'>,
) {
  const config = new ConfigService({ FORTNOX_TOKEN_KEY: 'ab'.repeat(32) })
  const crypto = new FortnoxTokenCryptoService(config)
  const initial: FortnoxConnection = {
    id: 'synthetic-connection-a',
    organizationId: ORG,
    status: 'ACTIVE',
    fortnoxDatabaseNumber: 900001,
    fortnoxOrgNumber: null,
    fortnoxCompanyName: null,
    scope: null,
    accessTokenEnc: crypto.encrypt('synthetic-access-a'),
    refreshTokenEnc: crypto.encrypt('synthetic-refresh-a'),
    accessTokenExpiresAt: new Date(0),
    tokenVersion: 11,
    refreshLeaseUntil: null,
    refreshAttemptId: null,
    generation: 0,
    exportVoucherSeries: null,
    exportOmitDimensionsAt: null,
    exportOmitDimensionsBy: null,
    lastErrorClass: null,
    lastErrorAt: null,
    connectedByUserId: null,
    connectedAt: new Date('2026-01-01T00:00:00Z'),
    disconnectedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  }
  const fresh: FortnoxConnection = {
    ...initial,
    ...freshIdentity,
    accessTokenEnc: crypto.encrypt(TOKEN_B),
    accessTokenExpiresAt: new Date('2099-01-01T00:00:00Z'),
  }
  const store: jest.Mocked<ConnectionStore> = {
    findUnique: jest.fn().mockRejectedValue(new Error('Oväntad extra radläsning')),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  }
  store.findUnique.mockResolvedValueOnce(initial).mockResolvedValueOnce(fresh)
  const auth = {
    name: 'MOCK',
    authorizeUrl: jest.fn(unexpected),
    exchangeCode: jest.fn(unexpected),
    refresh: jest.fn(unexpected),
    revoke: jest.fn(unexpected),
  } satisfies FortnoxAuthProvider
  const reader = { get: jest.fn(unexpected) } satisfies FortnoxLedgerReader
  const identity = new FortnoxRateIdentity()
  const bind = jest.spyOn(identity, 'bind')
  // Endast konstruktorns PrismaService-gräns castas; rad och använda metoder är typade.
  const service = new FortnoxConnectionService(
    { fortnoxConnection: store } as unknown as PrismaService,
    crypto,
    config,
    auth,
    reader,
    identity,
  )
  return { service, store, auth, reader, identity, bind }
}

function expectLostLeaseOnly(r: ReturnType<typeof rig>) {
  expect(r.store.findUnique).toHaveBeenCalledTimes(2)
  expect(r.store.findUnique).toHaveBeenNthCalledWith(1, { where: { organizationId: ORG } })
  expect(r.store.findUnique).toHaveBeenNthCalledWith(2, { where: { organizationId: ORG } })
  expect(r.store.updateMany).toHaveBeenCalledTimes(1)
  expect(r.auth.refresh).not.toHaveBeenCalled()
  expect(r.auth.authorizeUrl).not.toHaveBeenCalled()
  expect(r.auth.exchangeCode).not.toHaveBeenCalled()
  expect(r.auth.revoke).not.toHaveBeenCalled()
  expect(r.reader.get).not.toHaveBeenCalled()
}

/**
 * Syntetiskt två-read/projektionsfacit: B har avsiktligt annat id/företag.
 * Detta påstår inte att normal OAuth-callback kan byta dessa värden, eller att
 * provet är en riktig DB-race. Callbackens företagsspärr prövas i fortnox.db.spec.
 */
describe('Fortnox access-token och identitet från samma lästa rad', () => {
  afterEach(() => jest.restoreAllMocks())

  it('förlorad CAS returnerar hela fresh B-tupeln och binder just dess företag', async () => {
    const r = rig({ id: 'synthetic-connection-b', fortnoxDatabaseNumber: 900002, tokenVersion: 12 })
    const result = await r.service.accessToken(ORG)
    expectLostLeaseOnly(r)
    expect({ result, bindings: r.bind.mock.calls }).toEqual({
      result: {
        token: TOKEN_B,
        connectionId: 'synthetic-connection-b',
        databaseNumber: 900002,
        tokenVersion: 12,
      },
      bindings: [[TOKEN_B, 900002]],
    })
    expect(r.identity.databaseNumber(TOKEN_B)).toBe(900002)
  })

  it('samma anslutningsrad med ny version behåller rätt identitet utan egen refresh', async () => {
    const r = rig({ id: 'synthetic-connection-a', fortnoxDatabaseNumber: 900001, tokenVersion: 12 })
    const result = await r.service.accessToken(ORG)
    expectLostLeaseOnly(r)
    expect({ result, bindings: r.bind.mock.calls }).toEqual({
      result: {
        token: TOKEN_B,
        connectionId: 'synthetic-connection-a',
        databaseNumber: 900001,
        tokenVersion: 12,
      },
      bindings: [[TOKEN_B, 900001]],
    })
    expect(r.identity.databaseNumber(TOKEN_B)).toBe(900001)
  })

  it('oförändrad version ger REFRESH_IN_PROGRESS utan tokenbindning eller egen refresh', async () => {
    const r = rig({ id: 'synthetic-connection-a', fortnoxDatabaseNumber: 900001, tokenVersion: 11 })
    await expect(r.service.accessToken(ORG)).rejects.toMatchObject({
      name: 'FortnoxNotConnectedError',
      reason: 'REFRESH_IN_PROGRESS',
    })
    expectLostLeaseOnly(r)
    expect(r.bind).not.toHaveBeenCalled()
    expect(r.identity.databaseNumber(TOKEN_B)).toBeNull()
  })
})
