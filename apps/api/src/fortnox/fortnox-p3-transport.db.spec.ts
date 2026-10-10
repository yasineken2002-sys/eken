/**
 * TESTKUND-035 (P3, KRITERIER-P3-038 B1–B6, C1–C3): den skarpa skrivvägen
 * (RealFortnoxVoucherWriter + FortnoxTransport + RealFortnoxLedgerReader + RedisFortnoxRateLimiter)
 * genom den genuina sändkedjan mot riktig Postgres och riktig Redis. Fortnox ersätts av den
 * syntetiska HTTP-ytan (`FakeFortnoxApi`), som räknar POST oberoende av produktens tillstånd.
 * Inget nätverk utöver lokal Postgres/Redis.
 */
import { randomUUID } from 'node:crypto'
import { ConflictException } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { PrismaClient } from '@prisma/client'
import Redis from 'ioredis'
import type { PrismaService } from '../common/prisma/prisma.service'
import { FortnoxConnectionService } from './fortnox-connection.service'
import { FortnoxExportService, type FortnoxVoucherDraftBuilder } from './fortnox-export.service'
import { FortnoxTokenCryptoService } from './fortnox-token-crypto.service'
import { MockFortnoxAuthProvider, MockFortnoxLedgerReader } from './fortnox-providers'
import { VerifiedVoucherDraftBuilder } from './fortnox-export-builder'
import {
  godkannMappning,
  leverantorsfaktura,
  stadaKontomappning,
} from './fortnox-kontomappning.testing'
import { FortnoxSendService } from './fortnox-send.service'
import { RealFortnoxVoucherWriter } from './fortnox-voucher-writer'
import { RealFortnoxLedgerReader } from './fortnox-real-provider'
import { FortnoxTransport } from './provider/fortnox-transport'
import {
  FortnoxRateIdentity,
  RedisFortnoxRateLimiter,
  fortnoxRateLimitKey,
  fortnoxRedisClient,
  fortnoxRedisKeys,
} from './provider/fortnox-rate-limiter'
import type { FortnoxRateLimiter } from './provider/fortnox-transport.types'
import { FakeFortnoxApi } from './fortnox-fake-api.testing'

const HAR_DB = Boolean(process.env.DATABASE_URL) && Boolean(process.env.REDIS_URL)
const medDb = HAR_DB ? describe : describe.skip
const KEY = 'cd'.repeat(32)
const TEST_COMPANY = 1868238
const OWNER = { sub: 'u1', role: 'OWNER' }
// Den riktiga begränsaren gäller även provets egna läsningar (20 per 5 s per klient och företag);
// en uppkoppling + förhandskontroll + skanning tar därför flera fönster.
jest.setTimeout(120_000)

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot RIKTIG Postgres och RIKTIG Redis', () =>
    expect(HAR_DB).toBe(true))
})

medDb('TESTKUND-035 P3: ekonomisk gräns och avstämning genom den skarpa vägen', () => {
  let prisma: PrismaClient
  let redis: Redis
  const orgs: string[] = []
  const redisKeys: string[] = []

  beforeAll(async () => {
    const u = new URL(process.env.DATABASE_URL!)
    u.searchParams.set('connection_limit', '16')
    prisma = new PrismaClient({ datasources: { db: { url: u.toString() } } })
    await prisma.$connect()
    redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 })
  })

  afterAll(async () => {
    for (const id of orgs) {
      await prisma.fortnoxVoucherExport.deleteMany({ where: { organizationId: id } })
      await prisma.fortnoxReadRun.deleteMany({ where: { organizationId: id } })
      await prisma.journalEntryLine.deleteMany({ where: { journalEntry: { organizationId: id } } })
      await prisma.journalEntry.deleteMany({ where: { organizationId: id } })
      await prisma.supplierInvoice.deleteMany({ where: { organizationId: id } })
      await prisma.user.deleteMany({ where: { organizationId: id } })
      await prisma.journalEntrySequence.deleteMany({ where: { organizationId: id } })
      await stadaKontomappning(prisma, id)
      await prisma.account.deleteMany({ where: { organizationId: id } })
      await prisma.organization.delete({ where: { id } }).catch(() => undefined)
    }
    if (redisKeys.length) await redis.del(...redisKeys)
    await redis.quit()
    await prisma.$disconnect()
  })

  /**
   * Skrivtransporten får en egen tunn omslutning runt SAMMA Redis-begränsare, så att fel kan
   * injiceras exakt vid POST:ens reservation eller spärr utan att läsningarna påverkas.
   */
  function skrivbegransare(inner: FortnoxRateLimiter) {
    const fel = { acquire: false, defer: false }
    const limiter: FortnoxRateLimiter = {
      acquire: async (k, s) => {
        if (fel.acquire) throw new Error('ECONNRESET (injicerat Redis-fel)')
        return inner.acquire(k, s)
      },
      defer: async (k, ms) => {
        if (fel.defer) throw new Error('READONLY (injicerat Redis-fel)')
        return inner.defer(k, ms)
      },
    }
    return { limiter, fel }
  }

  async function setup() {
    const sfx = randomUUID().slice(0, 8)
    const clientId = `p3-prov-${sfx}`
    const org = await prisma.organization.create({
      data: {
        name: `p3-${sfx}`,
        email: `p3-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '1',
      },
    })
    orgs.push(org.id)
    const env: Record<string, string> = { FORTNOX_TOKEN_KEY: KEY }
    const config = { get: (k: string) => env[k] } as unknown as ConfigService
    const crypto = new FortnoxTokenCryptoService(config)
    const ledger = new MockFortnoxLedgerReader()
    ledger.company = {
      CompanyName: 'Eveno integrationstest 2026-10-02',
      OrganizationNumber: '555555-5555',
      DatabaseNumber: TEST_COMPANY,
    }
    const api = new FakeFortnoxApi(ledger)
    const fetch = api.fetch as unknown as typeof globalThis.fetch
    const delad = new RedisFortnoxRateLimiter({ redis: fortnoxRedisClient(redis) })
    const skriv = skrivbegransare(delad)
    const identity = new FortnoxRateIdentity()
    const reader = new RealFortnoxLedgerReader({
      transport: new FortnoxTransport({ fetch, rateLimiter: delad }),
      clientId,
      enabled: true,
      identity,
    })
    const writer = new RealFortnoxVoucherWriter({
      transport: new FortnoxTransport({
        fetch,
        rateLimiter: skriv.limiter,
        allowVoucherWrites: true,
      }),
      reader,
      clientId,
    })
    for (const db of [TEST_COMPANY, null]) {
      const r = fortnoxRedisKeys(fortnoxRateLimitKey(clientId, db))
      redisKeys.push(r.starts, r.deferred)
    }
    // Felinjektion i databasen: nästa $executeRaw (låsningen av utfallet) kastar.
    const dbFel = { executeRaw: false }
    const db = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === '$executeRaw')
          return (...args: unknown[]) => {
            if (dbFel.executeRaw) {
              dbFel.executeRaw = false
              return Promise.reject(new Error('injicerat DB-fel vid låsning'))
            }
            return (target.$executeRaw as (...a: unknown[]) => unknown).apply(target, args)
          }
        return Reflect.get(target, prop, receiver)
      },
    }) as unknown as PrismaService
    const auth = new MockFortnoxAuthProvider()
    const connections = new FortnoxConnectionService(db, crypto, config, auth, reader, identity)
    const builder: FortnoxVoucherDraftBuilder = new VerifiedVoucherDraftBuilder(
      db,
      connections,
      reader,
    )
    const exports = new FortnoxExportService(db, builder)
    const sender = new FortnoxSendService(db, connections, builder, reader, writer)
    const { authUrl } = await connections.begin(org.id, 'u1')
    const state = new URL(authUrl).searchParams.get('state')!
    await connections.handleCallback(state, `mock-code-${state.slice(0, 8)}`)
    await connections.setExportVoucherSeries(org.id, 'A')
    await connections.setExportOmitDimensions(org.id, 'u1', true)
    await godkannMappning(prisma, connections, reader, org.id)
    const ready = async (amount = '1234.50') => {
      const je = await leverantorsfaktura(prisma, org.id, {
        belopp: amount,
        beskrivning: `EVENO TEST P3 ${sfx} ${amount}`,
        radtext: [null, null],
      })
      const row = await exports.dryRun(org.id, je.id)
      expect(row.state).toBe('DRY_RUN_READY')
      return { je, row: row as typeof row & { draftHash: string } }
    }
    const dbRow = (id: string) => prisma.fortnoxVoucherExport.findUniqueOrThrow({ where: { id } })
    const historik = async (id: string) =>
      (await dbRow(id)).attemptHistory as Array<Record<string, unknown>>
    const posts = () => api.requests.filter((r) => r.method === 'POST').length
    const deferredKey = fortnoxRedisKeys(fortnoxRateLimitKey(clientId, TEST_COMPANY)).deferred
    return {
      org,
      api,
      ledger,
      sender,
      exports,
      ready,
      dbRow,
      historik,
      posts,
      skriv,
      dbFel,
      deferredKey,
    }
  }

  it('B1: Redis-fel vid POST:ens reservation (före fetch) → not_sent, tillbaka till READY, 0 POST', async () => {
    const t = await setup()
    const { row } = await t.ready()
    t.skriv.fel.acquire = true
    const res = await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    expect([res.state, res.lastOutcome]).toEqual(['DRY_RUN_READY', 'NOT_SENT'])
    expect([t.posts(), t.api.writes]).toEqual([0, 0])
    expect((await t.dbRow(row.id)).sendAttemptId).toBeNull()
  })

  it('B3/A6: POST 429 utan Retry-After → UNKNOWN_429 med bevarat försök; delad spärr ≥ 5 s i Redis; ingen omsändning', async () => {
    const t = await setup()
    const { je, row } = await t.ready()
    t.api.faults.push('status_429')
    const res = await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    expect([res.state, res.lastOutcome]).toEqual(['UNKNOWN', 'UNKNOWN_429'])
    expect(t.posts()).toBe(1)
    const raw = await t.dbRow(row.id)
    expect(raw.sendAttemptId).not.toBeNull()
    expect(raw.sentPayloadHash).toBe(row.draftHash)
    expect(raw.draft).not.toBeNull()
    expect(await t.historik(row.id)).toEqual([
      expect.objectContaining({
        typ: 'OKANT_UTFALL',
        utfall: 'UNKNOWN_429',
        http: 429,
        retryAfterMs: 5000,
        sparrSparad: true,
        sendAttemptId: raw.sendAttemptId,
        sentPayloadHash: row.draftHash,
      }),
    ])
    const pttl = await redis.pttl(t.deferredKey)
    expect(pttl).toBeGreaterThan(4000)
    await expect(t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).rejects.toThrow(
      ConflictException,
    )
    expect((await t.exports.dryRun(t.org.id, je.id)).state).toBe('UNKNOWN')
    await expect(
      t.sender.releaseRejected(t.org.id, OWNER, row.id, { reason: 'rate limit' }),
    ).rejects.toThrow(ConflictException)
    expect(t.posts()).toBe(1)
  })

  it('B3/A6: POST 429 med giltigt Retry-After 9 → spärren i Redis är serverns tid + 9 s', async () => {
    const t = await setup()
    const { row } = await t.ready()
    t.api.faults.push('status_429')
    t.api.retryAfter429 = '9'
    await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    expect((await t.historik(row.id))[0]).toMatchObject({ retryAfterMs: 9000 })
    expect(await redis.pttl(t.deferredKey)).toBeGreaterThan(8000)
  })

  it('B2/T-4: spärren kan inte sparas efter POST 429 → fortfarande UNKNOWN_429 (sparrSparad=false), exakt 1 POST', async () => {
    const t = await setup()
    const { row } = await t.ready()
    t.api.faults.push('status_429')
    t.skriv.fel.defer = true
    const res = await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    expect([res.state, res.lastOutcome]).toEqual(['UNKNOWN', 'UNKNOWN_429'])
    expect((await t.historik(row.id))[0]).toMatchObject({ sparrSparad: false })
    await expect(t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).rejects.toThrow(
      ConflictException,
    )
    expect(t.posts()).toBe(1)
  })

  it('B2: DB-fel när utfallet låses efter dispatch → aldrig READY; försöket bevaras och leasen ger UNKNOWN; 1 POST', async () => {
    const t = await setup()
    const { je, row } = await t.ready()
    t.api.faults.push('drop_response_after_write')
    t.dbFel.executeRaw = true
    await expect(t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).rejects.toThrow(
      /injicerat DB-fel/,
    )
    const mitt = await t.dbRow(row.id)
    expect(mitt.state).toBe('SENDING')
    expect(mitt.sendAttemptId).not.toBeNull()
    expect((await t.exports.dryRun(t.org.id, je.id)).state).not.toBe('DRY_RUN_READY')
    await expect(t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).rejects.toThrow(
      ConflictException,
    )
    await prisma.fortnoxVoucherExport.update({
      where: { id: row.id },
      data: { sendLeaseUntil: new Date(Date.now() - 1000) },
    })
    expect(await t.sender.expireLeases(t.org.id)).toBe(1)
    const efter = await t.dbRow(row.id)
    expect([efter.state, efter.lastOutcome, efter.sendAttemptId]).toEqual([
      'UNKNOWN',
      'LEASE_EXPIRED',
      mitt.sendAttemptId,
    ])
    expect([t.posts(), t.api.writes]).toEqual([1, 1])
  })

  it('B6: processen dör mellan dispatch och låst utfall → omstart ger UNKNOWN via leasen, aldrig READY; 0 ny POST', async () => {
    const t = await setup()
    const { row } = await t.ready()
    let dispatch: () => void = () => {}
    const dispatched = new Promise<void>((r) => (dispatch = r))
    // Svaret kommer aldrig: processen "dör" medan POST är ute.
    t.api.onPost = async () => {
      dispatch()
      await new Promise<never>(() => undefined)
    }
    void t.sender.send(t.org.id, 'u1', row.id, row.draftHash).catch(() => undefined)
    await dispatched
    expect((await t.dbRow(row.id)).state).toBe('SENDING')
    // "Omstart": en ny process ser bara databasen; leasen har gått ut.
    await prisma.fortnoxVoucherExport.update({
      where: { id: row.id },
      data: { sendLeaseUntil: new Date(Date.now() - 1000) },
    })
    t.api.onPost = null
    const ny = await setup()
    void ny
    expect(await t.sender.expireLeases(t.org.id)).toBe(1)
    expect((await t.dbRow(row.id)).state).toBe('UNKNOWN')
    await expect(t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).rejects.toThrow(
      ConflictException,
    )
    expect(t.posts()).toBe(1)
  })

  it('B5/C1: tappat POST-svar där posten skapades → UNKNOWN; ny send ger 0 POST; avstämning genom skanning (FOUND) → CONFIRMED på exakt den posten', async () => {
    const t = await setup()
    const { row } = await t.ready('77.00')
    // Främmande poster i samma år och en annan serie, så att skanningen läser flera sidor och serier.
    for (let n = 1; n <= 3; n++)
      t.ledger.vouchers.push({
        Year: 1,
        VoucherSeries: 'B',
        VoucherNumber: n,
        TransactionDate: '2026-10-02',
        Description: 'främmande',
        Comments: null,
        VoucherRows: [],
      })
    t.api.faults.push('drop_response_after_write')
    expect((await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).state).toBe('UNKNOWN')
    await expect(t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).rejects.toThrow(
      ConflictException,
    )
    expect([t.posts(), t.api.writes]).toEqual([1, 1])
    const res = await t.sender.reconcileScan(t.org.id, 'u1', row.id)
    expect([res.state, res.externalYear, res.externalSeries, res.externalNumber]).toEqual([
      'CONFIRMED',
      1,
      'A',
      1,
    ])
    const raw = await t.dbRow(row.id)
    expect(raw.reconcileDecision).toMatchObject({
      identity: { databaseNumber: TEST_COMPANY, year: 1, series: 'A', number: 1 },
      basis: expect.stringMatching(/Fullständig skanning/),
    })
    expect(t.posts()).toBe(1)
  })

  it.each([
    ['avvikande rader', 'rader'],
    ['dubblett (två poster med samma proveniens)', 'dubblett'],
    ['ofullständig sida', 'sidfel'],
    ['proveniensen är inte exakt (prefix)', 'prefix'],
  ] as const)('C1: %s → 409, ingenting ändras', async (_namn, fall) => {
    const t = await setup()
    const { row } = await t.ready('88.00')
    t.api.faults.push('drop_response_after_write')
    await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    const skapad = t.ledger.vouchers.find((v) => v.VoucherSeries === 'A')!
    if (fall === 'rader') {
      const rader = skapad.VoucherRows as Array<Record<string, unknown>>
      rader[0] = { ...rader[0], Debit: Number(rader[0]!.Debit) + 1 }
    }
    if (fall === 'dubblett')
      t.ledger.vouchers.push({ ...structuredClone(skapad), VoucherNumber: 2 })
    if (fall === 'sidfel')
      t.api.listTamper = (b) => ({
        ...b,
        MetaInformation: {
          ...((b as { MetaInformation?: object }).MetaInformation ?? {}),
          '@TotalResources': 99,
        },
      })
    if (fall === 'prefix') skapad.Comments = `${String(skapad.Comments)}-annan`
    const fore = await t.dbRow(row.id)
    await expect(t.sender.reconcileScan(t.org.id, 'u1', row.id)).rejects.toThrow(ConflictException)
    const efter = await t.dbRow(row.id)
    expect([efter.state, efter.lastOutcome, efter.reconciledAt, efter.updatedAt]).toEqual([
      fore.state,
      fore.lastOutcome,
      null,
      fore.updatedAt,
    ])
    expect(t.posts()).toBe(1)
  })

  it('C2: ABSENT två gånger → fortfarande UNKNOWN; två historikposter med tid och räckvidd; 0 ny POST', async () => {
    const t = await setup()
    const { row } = await t.ready('99.00')
    t.api.faults.push('status_429')
    await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    for (let i = 0; i < 2; i++) {
      const res = await t.sender.reconcileScan(t.org.id, 'u1', row.id)
      expect([res.state, res.lastOutcome]).toEqual(['UNKNOWN', 'UNKNOWN_429'])
      expect(res.avstamning).toMatchObject({ utfall: 'EJ_HITTAD', financialYear: 1 })
    }
    const h = await t.historik(row.id)
    expect(h.map((x) => x.typ)).toEqual([
      'OKANT_UTFALL',
      'AVSTAMNING_EJ_HITTAD',
      'AVSTAMNING_EJ_HITTAD',
    ])
    expect(h[1]).toMatchObject({
      rackvidd: expect.objectContaining({
        databaseNumber: TEST_COMPANY,
        financialYear: 1,
        serier: 'alla',
        verifikatLasta: expect.any(Number),
      }),
      tolkning: expect.stringMatching(/bevisar inte/),
    })
    expect((await t.dbRow(row.id)).state).toBe('UNKNOWN')
    await expect(t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).rejects.toThrow(
      ConflictException,
    )
    expect(t.posts()).toBe(1)
  })

  it('C3: äldre REJECTED_429_NA (före P3) → frisläppning nekas; skanning tillåten och lämnar raden oförändrad (ingen backfill)', async () => {
    const t = await setup()
    const { row } = await t.ready('55.00')
    t.api.faults.push('status_400')
    await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    // Som en rad skriven av produkten före TESTKUND-035.
    await prisma.fortnoxVoucherExport.update({
      where: { id: row.id },
      data: { lastOutcome: 'REJECTED_429_NA' },
    })
    await expect(
      t.sender.releaseRejected(t.org.id, OWNER, row.id, { reason: 'äldre 429' }),
    ).rejects.toThrow(/429/)
    const res = await t.sender.reconcileScan(t.org.id, 'u1', row.id)
    expect([res.state, res.lastOutcome]).toEqual(['REJECTED', 'REJECTED_429_NA'])
    expect(res.avstamning?.utfall).toBe('EJ_HITTAD')
    expect(t.posts()).toBe(1)
  })

  it('C: skanning av en export som inte behöver avstämning → 409', async () => {
    const t = await setup()
    const { row } = await t.ready('66.00')
    await expect(t.sender.reconcileScan(t.org.id, 'u1', row.id)).rejects.toThrow(ConflictException)
  })
})
