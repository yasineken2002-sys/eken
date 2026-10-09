/**
 * TESTKUND-035 (P3, KRITERIER-P3-038 A2–A6, D1–D4): den delade begränsaren mot RIKTIG Redis.
 * Atomiciteten är en egenskap hos Redis (Lua körs odelbart) och kan bara mätas mot en server,
 * därför `.db.spec.ts` och `REDIS_URL`. Varje prov använder egna nycklar och städar dem.
 *
 * Det här är enprocessprov med separata Redis-anslutningar. Två verkliga OS-processer mot samma
 * Redis och en oberoende POST-fångare mäts i riggen (CLAUDE1/rigg-p3), inte här.
 */
import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { FortnoxTransport } from './fortnox-transport'
import {
  FORTNOX_STARTS_PER_WINDOW,
  FORTNOX_WINDOW_MS,
  FortnoxRateIdentity,
  RedisFortnoxRateLimiter,
  fortnoxRateLimitKey,
  fortnoxRedisClient,
  fortnoxRedisKeys,
  systemFortnoxClock,
} from './fortnox-rate-limiter'
import type { FortnoxClock } from './fortnox-transport.types'

const HAR_REDIS = Boolean(process.env.REDIS_URL)
const medRedis = HAR_REDIS ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG Redis', () => expect(HAR_REDIS).toBe(true))
})

medRedis('TESTKUND-035: RedisFortnoxRateLimiter mot riktig Redis', () => {
  const clients: Redis[] = []
  const keys: string[] = []
  const anslut = () => {
    const c = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 })
    clients.push(c)
    return c
  }
  let admin: Redis
  const nyNyckel = (db = 1868238) => {
    const k = fortnoxRateLimitKey(`prov-${randomUUID().slice(0, 8)}`, db)
    const r = fortnoxRedisKeys(k)
    keys.push(r.starts, r.deferred)
    return k
  }
  const limiter = (clock?: FortnoxClock) =>
    new RedisFortnoxRateLimiter({
      redis: fortnoxRedisClient(anslut()),
      ...(clock ? { clock } : {}),
    })

  beforeAll(() => {
    admin = anslut()
  })
  afterAll(async () => {
    if (keys.length) await admin.del(...keys)
    await Promise.all(clients.map((c) => c.quit().catch(() => undefined)))
  })

  it('D1/D2: serverversion ≥ 5 (TIME i skript) och eviction-policy redovisas', async () => {
    const info = await admin.info('server')
    const version = /redis_version:(\d+)\.(\d+)\.(\d+)/.exec(info)
    expect(version).not.toBeNull()
    expect(Number(version![1])).toBeGreaterThanOrEqual(5)
    const policy = (await admin.config('GET', 'maxmemory-policy')) as string[]
    // Mätvärde, inte krav: redovisas i RAPPORT-P3-035 (D2).
    console.warn(
      `[P3-D1/D2] redis_version=${version![0].split(':')[1]} maxmemory-policy=${policy[1]}`,
    )
    expect(typeof policy[1]).toBe('string')
  })

  it('A2: exakt 20 starter beviljas per rullande 5 s; den 21:a nekas med väntan ≤ 5 s', async () => {
    const k = nyNyckel()
    const l = limiter()
    const svar = await Promise.all(
      Array.from({ length: FORTNOX_STARTS_PER_WINDOW + 5 }, () => l.reserve(k)),
    )
    expect(svar.filter((s) => s.granted)).toHaveLength(FORTNOX_STARTS_PER_WINDOW)
    for (const s of svar.filter((x) => !x.granted)) {
      expect(s.waitMs).toBeGreaterThan(0)
      expect(s.waitMs).toBeLessThanOrEqual(FORTNOX_WINDOW_MS)
    }
    expect(await admin.zcard(fortnoxRedisKeys(k).starts)).toBe(FORTNOX_STARTS_PER_WINDOW)
  })

  it('A3: sista platsen — två klienter på separata anslutningar släpps samtidigt mot plats 20; exakt en får den (25 upprepningar)', async () => {
    for (let i = 0; i < 25; i++) {
      const k = nyNyckel()
      const forbered = limiter()
      for (let n = 0; n < FORTNOX_STARTS_PER_WINDOW - 1; n++)
        expect((await forbered.reserve(k)).granted).toBe(true)
      const [a, b] = [limiter(), limiter()]
      const utfall = await Promise.all([a.reserve(k), b.reserve(k)])
      expect(utfall.filter((u) => u.granted)).toHaveLength(1)
      expect(await admin.zcard(fortnoxRedisKeys(k).starts)).toBe(FORTNOX_STARTS_PER_WINDOW)
    }
  })

  it('A4: olika företag har oberoende tak; tokenbyte för samma lagrade företag ger samma hink; okänd identitet är en egen hink', async () => {
    const client = `prov-${randomUUID().slice(0, 8)}`
    const id = new FortnoxRateIdentity()
    id.bind('token-gammal', 111)
    id.bind('token-ny', 111)
    id.bind('token-annat', 222)
    const kGammal = fortnoxRateLimitKey(client, id.databaseNumber('token-gammal'))
    const kNy = fortnoxRateLimitKey(client, id.databaseNumber('token-ny'))
    const kAnnat = fortnoxRateLimitKey(client, id.databaseNumber('token-annat'))
    const kOkand = fortnoxRateLimitKey(client, id.databaseNumber('aldrig-kopplad'))
    for (const k of [kGammal, kAnnat, kOkand]) {
      const r = fortnoxRedisKeys(k)
      keys.push(r.starts, r.deferred)
    }
    expect(kGammal).toBe(kNy)
    expect(new Set([kGammal, kAnnat, kOkand]).size).toBe(3)
    expect(kOkand).toMatch(/:unverified$/)
    const l = limiter()
    for (let n = 0; n < FORTNOX_STARTS_PER_WINDOW; n++)
      expect((await l.reserve(kGammal)).granted).toBe(true)
    expect((await l.reserve(kNy)).granted).toBe(false)
    expect((await l.reserve(kAnnat)).granted).toBe(true)
    expect((await l.reserve(kOkand)).granted).toBe(true)
  })

  it('A5/T-5: en köad väntare prövar om efter varje väntan och respekterar en spärr skriven under väntan (barriär, inga sleeps)', async () => {
    const k = nyNyckel()
    const sovningar: Array<{ ms: number; slapp: () => void }> = []
    let vantar: (() => void) | null = null
    const klocka: FortnoxClock = {
      ...systemFortnoxClock,
      sleep: (ms) =>
        new Promise<void>((resolve) => {
          sovningar.push({ ms, slapp: resolve })
          vantar?.()
        }),
    }
    const fyll = limiter()
    for (let n = 0; n < FORTNOX_STARTS_PER_WINDOW; n++) await fyll.reserve(k)
    const a = limiter(klocka)
    const controller = new AbortController()
    const forstaSomn = new Promise<void>((r) => (vantar = r))
    const acquired = a.acquire(k, controller.signal)
    await forstaSomn
    expect(sovningar).toHaveLength(1)
    expect(sovningar[0]!.ms).toBeLessThanOrEqual(FORTNOX_WINDOW_MS)
    // B skriver en spärr på 30 s medan A väntar.
    await limiter().defer(k, 30_000)
    const andraSomn = new Promise<void>((r) => (vantar = r))
    sovningar[0]!.slapp()
    await andraSomn
    // A prövade om och nekades av den NYA spärren; ingen start reserverades.
    expect(sovningar).toHaveLength(2)
    expect(sovningar[1]!.ms).toBeGreaterThan(25_000)
    expect(await admin.zcard(fortnoxRedisKeys(k).starts)).toBe(FORTNOX_STARTS_PER_WINDOW)
    controller.abort()
    sovningar[1]!.slapp()
    await expect(acquired).rejects.toThrow('Aborted')
    expect(await admin.zcard(fortnoxRedisKeys(k).starts)).toBe(FORTNOX_STARTS_PER_WINDOW)
  })

  it('A6: spärren sätts med serverns tid; en kortare spärr förkortar aldrig en längre', async () => {
    const k = nyNyckel()
    const l = limiter()
    await l.defer(k, 5000)
    const forsta = await l.reserve(k)
    expect(forsta.granted).toBe(false)
    expect(forsta.waitMs).toBeGreaterThan(4000)
    expect(forsta.waitMs).toBeLessThanOrEqual(5000)
    await l.defer(k, 1000)
    expect((await l.reserve(k)).waitMs).toBeGreaterThan(4000)
    await l.defer(k, 9000)
    expect((await l.reserve(k)).waitMs).toBeGreaterThan(8000)
    expect(await admin.zcard(fortnoxRedisKeys(k).starts)).toBe(0)
  })

  it('D2/D4: nycklarna har TTL och samma hash-tagg (klusterslot)', async () => {
    const k = nyNyckel()
    const l = limiter()
    await l.reserve(k)
    await l.defer(k, 5000)
    const r = fortnoxRedisKeys(k)
    expect(await admin.pttl(r.starts)).toBeGreaterThan(0)
    expect(await admin.pttl(r.deferred)).toBeGreaterThan(0)
    const tagg = (s: string) => /^\{([^{}]+)\}/.exec(s)?.[1]
    expect(tagg(r.starts)).toBe(k)
    expect(tagg(r.deferred)).toBe(k)
    expect(() => fortnoxRedisKeys('fortnox:{x}:db1')).toThrow()
  })

  it('T-2: EVALSHA faller tillbaka till EVAL vid NOSCRIPT (skriptcachen tömd)', async () => {
    const k = nyNyckel()
    await admin.script('FLUSH')
    expect((await limiter().reserve(k)).granted).toBe(true)
  })

  it('B1: Redis nere → acquire kastar; transporten ger not_sent och 0 fetch (ingen lokal reserv)', async () => {
    const nere = new Redis('redis://127.0.0.1:1', {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    })
    clients.push(nere)
    const l = new RedisFortnoxRateLimiter({ redis: fortnoxRedisClient(nere) })
    await expect(l.reserve(nyNyckel())).rejects.toThrow()
    const fetch = jest.fn()
    const t = new FortnoxTransport({
      fetch: fetch as unknown as typeof globalThis.fetch,
      rateLimiter: l,
      allowVoucherWrites: true,
    })
    await expect(
      t.request({
        accessToken: 'syntetisk',
        rateLimitKey: nyNyckel(),
        method: 'POST',
        path: '/3/vouchers',
        query: { financialyear: 1 },
        body: { Voucher: {} },
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMIT_ERROR', outcome: 'not_sent', attempts: 0 })
    expect(fetch).not.toHaveBeenCalled()
  })
})
