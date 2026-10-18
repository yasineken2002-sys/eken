import { ConfigService } from '@nestjs/config'
import type { FortnoxConnection, Prisma } from '@prisma/client'
import type { PrismaService } from '../common/prisma/prisma.service'
import {
  FortnoxConnectionService,
  FortnoxCredentialBindingError,
  type FortnoxCredentialBinding,
} from './fortnox-connection.service'
import { FortnoxTokenCryptoService } from './fortnox-token-crypto.service'
import type { FortnoxAuthProvider, FortnoxLedgerReader, FortnoxTokenSet } from './fortnox.types'
import { FortnoxRateIdentity } from './provider/fortnox-rate-limiter'

type ConnectionStore = {
  findUnique(args: Prisma.FortnoxConnectionFindUniqueArgs): Promise<FortnoxConnection | null>
  updateMany(args: Prisma.FortnoxConnectionUpdateManyArgs): Promise<Prisma.BatchPayload>
}

const EXPECTED: FortnoxCredentialBinding = {
  organizationId: 'synthetic-bound-org',
  connectionId: 'synthetic-bound-connection',
  connectionGeneration: 4,
  fortnoxDatabaseNumber: 900001,
  fortnoxOrgNumber: null,
}
const TOKEN_A = 'synthetic-bound-access-a'
const TOKEN_B = 'synthetic-bound-access-b'
const REFRESH_A = 'synthetic-bound-refresh-a'
const BINDING_ERROR = 'Fortnox-anslutningen matchar inte det frysta underlaget'

function unexpected(): never {
  throw new Error('Oväntat provideranrop i credential-provet')
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function rig(overrides: Partial<FortnoxConnection> = {}) {
  const config = new ConfigService({ FORTNOX_TOKEN_KEY: 'ab'.repeat(32) })
  const crypto = new FortnoxTokenCryptoService(config)
  const initial: FortnoxConnection = {
    id: EXPECTED.connectionId,
    organizationId: EXPECTED.organizationId,
    status: 'ACTIVE',
    fortnoxDatabaseNumber: EXPECTED.fortnoxDatabaseNumber,
    fortnoxOrgNumber: EXPECTED.fortnoxOrgNumber,
    fortnoxCompanyName: null,
    scope: null,
    accessTokenEnc: crypto.encrypt(TOKEN_A),
    refreshTokenEnc: crypto.encrypt(REFRESH_A),
    accessTokenExpiresAt: new Date('2099-01-01T00:00:00Z'),
    tokenVersion: 7,
    refreshLeaseUntil: null,
    refreshAttemptId: null,
    generation: EXPECTED.connectionGeneration,
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
    ...overrides,
  }
  const store: jest.Mocked<ConnectionStore> = {
    findUnique: jest.fn().mockRejectedValue(new Error('Oväntad extra radläsning')),
    updateMany: jest.fn().mockRejectedValue(new Error('Oväntad skrivning')),
  }
  store.findUnique.mockResolvedValueOnce(initial)
  const auth = {
    name: 'MOCK',
    authorizeUrl: jest.fn(unexpected),
    exchangeCode: jest.fn(unexpected),
    refresh: jest
      .fn<Promise<FortnoxTokenSet>, [string]>()
      .mockRejectedValue(new Error('Oväntad refresh')),
    revoke: jest.fn(unexpected),
  } satisfies FortnoxAuthProvider
  const reader = { get: jest.fn(unexpected) } satisfies FortnoxLedgerReader
  const identity = new FortnoxRateIdentity()
  const bind = jest.spyOn(identity, 'bind')
  const decrypt = jest.spyOn(crypto, 'decrypt')
  // Endast Prisma-konstruktorsgränsen castas; rader, provider och använda metoder är typade.
  const service = new FortnoxConnectionService(
    { fortnoxConnection: store } as unknown as PrismaService,
    crypto,
    config,
    auth,
    reader,
    identity,
  )
  return { service, store, auth, reader, identity, bind, decrypt, crypto, initial }
}

type Rig = ReturnType<typeof rig>

function noProvider(r: Rig) {
  expect(r.auth.refresh).not.toHaveBeenCalled()
  expect(r.auth.authorizeUrl).not.toHaveBeenCalled()
  expect(r.auth.exchangeCode).not.toHaveBeenCalled()
  expect(r.auth.revoke).not.toHaveBeenCalled()
  expect(r.reader.get).not.toHaveBeenCalled()
}

function noCredentialEffects(r: Rig) {
  noProvider(r)
  expect(r.store.updateMany).not.toHaveBeenCalled()
  expect(r.decrypt).not.toHaveBeenCalled()
  expect(r.bind).not.toHaveBeenCalled()
  expect(r.identity.databaseNumber(TOKEN_A)).toBeNull()
  expect(r.identity.databaseNumber(TOKEN_B)).toBeNull()
}

async function bindingRejected(operation: Promise<unknown>) {
  await expect(operation).rejects.toBeInstanceOf(FortnoxCredentialBindingError)
  await expect(operation).rejects.toMatchObject({
    name: 'FortnoxCredentialBindingError',
    message: BINDING_ERROR,
  })
}

function refreshedRow(r: Rig): FortnoxConnection {
  return {
    ...r.initial,
    accessTokenEnc: r.crypto.encrypt(TOKEN_B),
    tokenVersion: 8,
    accessTokenExpiresAt: new Date('2099-01-01T00:00:00Z'),
  }
}

function successfulRefresh(r: Rig) {
  r.store.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })
  r.auth.refresh.mockResolvedValueOnce({
    accessToken: TOKEN_B,
    refreshToken: 'synthetic-bound-refresh-b',
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  })
}

function holdFirstRead(r: Rig) {
  const entered = deferred<void>()
  const released = deferred<FortnoxConnection | null>()
  r.store.findUnique
    .mockReset()
    .mockRejectedValue(new Error('Oväntad extra radläsning'))
    .mockImplementationOnce(async () => {
      entered.resolve()
      return released.promise
    })
  return { entered, released }
}

async function reachedRead(entered: Promise<void>, operation: Promise<unknown>) {
  await Promise.race([
    entered,
    operation.then(() => {
      throw new Error('Operationen avslutades före läsbarriären')
    }),
  ])
}

/**
 * Typade unitgränser med syntetiska radreturer och verklig tokenkrypto/ratebinding.
 * Dessa prov påstår inte DB-race, atomisk framtida GET eller normal OAuth-rotation
 * mellan olika företag. Riktiga CAS-/write-race prövas i separat DB-spec.
 */
describe('Fortnox bunden credential: form, snapshots och legacy-kontrakt', () => {
  afterEach(() => jest.restoreAllMocks())

  it('nekar felaktig expected-form med fast fel före första SQL-anropet', async () => {
    const malformed: unknown[] = [
      undefined,
      null,
      [],
      'not-an-object',
      ...Object.keys(EXPECTED).map((key) => ({ ...EXPECTED, [key]: undefined })),
      { ...EXPECTED, organizationId: '' },
      { ...EXPECTED, connectionId: '' },
      { ...EXPECTED, connectionGeneration: -1 },
      { ...EXPECTED, connectionGeneration: 0.5 },
      { ...EXPECTED, connectionGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { ...EXPECTED, connectionGeneration: '4' },
      { ...EXPECTED, fortnoxDatabaseNumber: 0 },
      { ...EXPECTED, fortnoxDatabaseNumber: 1.5 },
      { ...EXPECTED, fortnoxDatabaseNumber: Number.MAX_SAFE_INTEGER + 1 },
      { ...EXPECTED, fortnoxDatabaseNumber: '900001' },
      { ...EXPECTED, fortnoxOrgNumber: 900001 },
    ]
    const r = rig()
    for (const value of malformed) {
      await bindingRejected(r.service.boundAccessToken(value as FortnoxCredentialBinding))
    }
    expect(r.store.findUnique).not.toHaveBeenCalled()
    noCredentialEffects(r)
  })

  it.each<[string, Partial<FortnoxCredentialBinding>]>([
    ['organizationId', { organizationId: 'synthetic-other-org' }],
    ['connectionId', { connectionId: 'synthetic-other-connection' }],
    ['connectionGeneration', { connectionGeneration: 5 }],
    ['fortnoxDatabaseNumber', { fortnoxDatabaseNumber: 900002 }],
    ['fortnoxOrgNumber: null skiljer från tom sträng', { fortnoxOrgNumber: '' }],
  ])(
    'nekar välformad mismatch i %s efter en SELECT men före decrypt/auth/write',
    async (_label, change) => {
      const r = rig()
      const expected = { ...EXPECTED, ...change }
      // Även organizationId-fallet är en injicerad radretur, inte ett DB-isoleringsbevis.
      await bindingRejected(r.service.boundAccessToken(expected))
      expect(r.store.findUnique).toHaveBeenCalledTimes(1)
      expect(r.store.findUnique).toHaveBeenCalledWith({
        where: { organizationId: expected.organizationId },
      })
      noCredentialEffects(r)
    },
  )

  it('nekar lagrad tom orgNumber mot expected null utan falsy-normalisering', async () => {
    const r = rig({ fortnoxOrgNumber: '' })
    await bindingRejected(r.service.boundAccessToken(EXPECTED))
    expect(r.store.findUnique).toHaveBeenCalledTimes(1)
    noCredentialEffects(r)
  })

  it('binder expected-snapshoten före await och returnerar en separat fryst binding', async () => {
    const r = rig()
    const { entered, released } = holdFirstRead(r)
    const expected = { ...EXPECTED }
    const operation = r.service.boundAccessToken(expected)
    try {
      await reachedRead(entered.promise, operation)
      expected.organizationId = 'mutated-org'
      expected.connectionId = 'mutated-connection'
      expected.connectionGeneration = 99
      expected.fortnoxDatabaseNumber = 900099
      expected.fortnoxOrgNumber = 'mutated-company'
      released.resolve(r.initial)
      const result = await operation
      expect(result).toStrictEqual({ token: TOKEN_A, tokenVersion: 7, binding: EXPECTED })
      expect(result.binding).not.toBe(expected)
      expect(Object.isFrozen(result.binding)).toBe(true)
      expected.organizationId = 'mutated-again'
      expect(result.binding).toStrictEqual(EXPECTED)
      expect(r.store.findUnique).toHaveBeenCalledTimes(1)
      expect(r.store.findUnique).toHaveBeenCalledWith({
        where: { organizationId: EXPECTED.organizationId },
      })
      expect(r.store.updateMany).not.toHaveBeenCalled()
      noProvider(r)
      expect(r.bind.mock.calls).toEqual([[TOKEN_A, 900001]])
      expect(r.identity.databaseNumber(TOKEN_A)).toBe(900001)
    } finally {
      released.resolve(r.initial)
      await Promise.allSettled([operation])
    }
  })

  it.each([false, true])('snapshot av options före await bevarar forced=%s', async (forced) => {
    const r = rig()
    const { entered, released } = holdFirstRead(r)
    const options: { afterUnauthorizedVersion?: number } = forced
      ? { afterUnauthorizedVersion: 7 }
      : {}
    if (forced) {
      successfulRefresh(r)
      r.store.findUnique.mockResolvedValueOnce(refreshedRow(r))
    }
    const operation = r.service.boundAccessToken(EXPECTED, options)
    try {
      await reachedRead(entered.promise, operation)
      options.afterUnauthorizedVersion = forced ? 999 : 7
      released.resolve(r.initial)
      const result = await operation
      expect(result).toStrictEqual({
        token: forced ? TOKEN_B : TOKEN_A,
        tokenVersion: forced ? 8 : 7,
        binding: EXPECTED,
      })
      expect(Object.isFrozen(result.binding)).toBe(true)
      expect(r.store.findUnique).toHaveBeenCalledTimes(forced ? 2 : 1)
      expect(r.store.updateMany).toHaveBeenCalledTimes(forced ? 2 : 0)
      expect(r.auth.refresh).toHaveBeenCalledTimes(forced ? 1 : 0)
      if (forced) expect(r.auth.refresh).toHaveBeenCalledWith(REFRESH_A)
      else noProvider(r)
      expect(r.bind.mock.calls).toEqual([[forced ? TOKEN_B : TOKEN_A, 900001]])
    } finally {
      released.resolve(r.initial)
      await Promise.allSettled([operation])
    }
  })

  it('forced 401 på äldre version accepterar redan högre version inom samma binding', async () => {
    const r = rig({ tokenVersion: 8 })
    r.initial.accessTokenEnc = r.crypto.encrypt(TOKEN_B)
    const result = await r.service.boundAccessToken(EXPECTED, { afterUnauthorizedVersion: 7 })
    expect(result).toStrictEqual({ token: TOKEN_B, tokenVersion: 8, binding: EXPECTED })
    expect(Object.isFrozen(result.binding)).toBe(true)
    expect(r.store.findUnique).toHaveBeenCalledTimes(1)
    expect(r.store.updateMany).not.toHaveBeenCalled()
    noProvider(r)
    expect(r.bind.mock.calls).toEqual([[TOKEN_B, 900001]])
    expect(r.identity.databaseNumber(TOKEN_B)).toBe(900001)
  })

  it.each(['fast', 'fresh', 'refresh'] as const)(
    'legacy %s behåller exakt fyra runtimefält och befintligt queryantal',
    async (path) => {
      const r = rig(path === 'fast' ? {} : { accessTokenExpiresAt: new Date(0) })
      if (path === 'fresh') {
        r.store.updateMany.mockResolvedValueOnce({ count: 0 })
        r.store.findUnique.mockResolvedValueOnce(refreshedRow(r))
      } else if (path === 'refresh') successfulRefresh(r)
      const result = await r.service.accessToken(EXPECTED.organizationId)
      expect(result).toStrictEqual({
        token: path === 'fast' ? TOKEN_A : TOKEN_B,
        connectionId: EXPECTED.connectionId,
        databaseNumber: 900001,
        tokenVersion: path === 'fast' ? 7 : 8,
      })
      expect(Object.keys(result).sort()).toEqual([
        'connectionId',
        'databaseNumber',
        'token',
        'tokenVersion',
      ])
      expect(r.store.findUnique).toHaveBeenCalledTimes(path === 'fresh' ? 2 : 1)
      expect(r.store.updateMany).toHaveBeenCalledTimes(
        path === 'fast' ? 0 : path === 'fresh' ? 1 : 2,
      )
      if (path === 'refresh') {
        expect(r.auth.refresh).toHaveBeenCalledTimes(1)
        expect(r.auth.refresh).toHaveBeenCalledWith(REFRESH_A)
      } else noProvider(r)
      expect(r.bind.mock.calls).toEqual([[path === 'fast' ? TOKEN_A : TOKEN_B, 900001]])
    },
  )

  it.each(['NO_CONNECTION', 'DISCONNECTED', 'AUTH_LOST'] as const)(
    'ger %s utan credential eller ratebinding',
    async (reason) => {
      const r = rig(reason === 'NO_CONNECTION' ? {} : { status: reason })
      if (reason === 'NO_CONNECTION') r.store.findUnique.mockReset().mockResolvedValueOnce(null)
      await expect(r.service.boundAccessToken(EXPECTED)).rejects.toMatchObject({
        name: 'FortnoxNotConnectedError',
        reason,
      })
      expect(r.store.findUnique).toHaveBeenCalledTimes(1)
      noCredentialEffects(r)
    },
  )

  it.each(['read', 'decrypt'] as const)(
    'propagerar ursprungligt %s-fel utan ratebinding eller auth-write',
    async (path) => {
      const r = rig()
      const original = new Error('synthetic credential boundary failure')
      if (path === 'read') r.store.findUnique.mockReset().mockRejectedValueOnce(original)
      else
        r.decrypt.mockImplementationOnce(() => {
          throw original
        })
      await expect(r.service.boundAccessToken(EXPECTED)).rejects.toBe(original)
      expect(r.store.findUnique).toHaveBeenCalledTimes(1)
      expect(r.decrypt).toHaveBeenCalledTimes(path === 'read' ? 0 : 1)
      expect(r.store.updateMany).not.toHaveBeenCalled()
      expect(r.bind).not.toHaveBeenCalled()
      noProvider(r)
    },
  )
})
