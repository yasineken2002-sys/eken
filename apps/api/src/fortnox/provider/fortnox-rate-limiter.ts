import { createHash, randomUUID } from 'node:crypto'
import type Redis from 'ioredis'
import type { FortnoxClock, FortnoxRateLimiter } from './fortnox-transport.types'

export const systemFortnoxClock: FortnoxClock = {
  now: () => Date.now(),
  schedule: (callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds)
    return () => clearTimeout(timer)
  },
  sleep: (milliseconds, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('Aborted'))
        return
      }
      const finish = () => {
        signal.removeEventListener('abort', abort)
        resolve()
      }
      const timer = setTimeout(finish, milliseconds)
      const abort = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        reject(new Error('Aborted'))
      }
      signal.addEventListener('abort', abort, { once: true })
    }),
}

/**
 * TESTKUND-035 (P3): PRODUKTVAL, inte leverantörsgarantier. Fortnox egen gräns är högre;
 * 20 starter per rullande 5 s per klient och företag och minst 5 s spärr efter 429 utan
 * giltigt Retry-After är medvetna marginaler (COORDINATOR/P3-TRANSPORT-BESLUT-20261009).
 */
export const FORTNOX_RATE_IDENTITY = Symbol('FORTNOX_RATE_IDENTITY')

export const FORTNOX_STARTS_PER_WINDOW = 20
export const FORTNOX_WINDOW_MS = 5000
/**
 * Vaktmarginal mellan reservation och ankomst. Starten reserveras före fetch; tiden till ankomst
 * varierar (mätt i tvåprocessriggen: en första skur kom ~115 ms efter reservationen och den nästa
 * direkt, så 40 starter kom inom 5 s hos mottagaren). Varje start hålls därför i fönstret
 * 5 s + 1 s, så att högst 20 starter når Fortnox per rullande 5 s när spridningen är under 1 s.
 */
export const FORTNOX_ARRIVAL_GUARD_MS = 1000
export const FORTNOX_MIN_429_BACKOFF_MS = 5000
/** Spärrnyckelns livslängd i Redis är begränsad; ett längre Retry-After gäller bara så länge. */
const DEFER_TTL_CAP_MS = 24 * 60 * 60 * 1000

/**
 * Ett steg i Redis (Lua, serverns klocka): rensa fönstret, läs spärren, pröva taket och
 * lägg till EN unik start. Två instanser kan inte båda ta sista platsen: skriptet körs
 * atomiskt och ingen läsning görs i klienten före skrivningen.
 * Svar: {1, 0} = beviljad, {0, väntan i ms} = nekad.
 */
export const FORTNOX_RESERVE_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local deferred = tonumber(redis.call('GET', KEYS[2]) or '0')
if deferred > now then
  return {0, deferred - now}
end
if redis.call('ZCARD', KEYS[1]) >= limit then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {0, math.max(1, tonumber(oldest[2]) + window - now)}
end
redis.call('ZADD', KEYS[1], now, ARGV[1])
redis.call('PEXPIRE', KEYS[1], window + 1000)
return {1, 0}
`

/** Spärr till serverns tid + fördröjning; en kortare spärr ersätter aldrig en längre. */
export const FORTNOX_DEFER_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local untilMs = now + tonumber(ARGV[1])
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if untilMs > current then
  redis.call('SET', KEYS[1], string.format('%.0f', untilMs), 'PX', math.min(untilMs - now + 1000, tonumber(ARGV[2])))
  return untilMs - now
end
return current - now
`

/** Den del av ioredis som används; inget annat (ingen pipeline, ingen MULTI). */
export interface FortnoxRedisClient {
  evalsha(sha: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>
}

/** Bara de två kommandon begränsaren använder, ur den befintliga Redis-klienten. */
export function fortnoxRedisClient(redis: Pick<Redis, 'evalsha' | 'eval'>): FortnoxRedisClient {
  return {
    evalsha: (sha, numKeys, ...args) => redis.evalsha(sha, numKeys, ...args),
    eval: (script, numKeys, ...args) => redis.eval(script, numKeys, ...args),
  }
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex')

/**
 * Hinkens Redis-nycklar. Hash-taggen `{…}` gör att fönster och spärr alltid hamnar på
 * samma slot om Redis någon gång körs i kluster.
 */
export function fortnoxRedisKeys(rateLimitKey: string): { starts: string; deferred: string } {
  if (
    typeof rateLimitKey !== 'string' ||
    !/^[\x21-\x7e]{1,256}$/.test(rateLimitKey) ||
    /[{}]/.test(rateLimitKey)
  )
    throw new Error('Invalid rate limit key')
  return { starts: `{${rateLimitKey}}:starts`, deferred: `{${rateLimitKey}}:deferred` }
}

export interface RedisFortnoxRateLimiterOptions {
  redis: FortnoxRedisClient
  /** Väntan mellan prövningar; varje väntan följs av en NY reservation. */
  clock?: FortnoxClock
}

/**
 * TESTKUND-035 (P3): delad begränsare för alla processer mot samma Redis. Ingen lokal reserv:
 * ett Redis-fel kastar, och transporten gör det till not_sent före fetch.
 */
export class RedisFortnoxRateLimiter implements FortnoxRateLimiter {
  readonly #redis: FortnoxRedisClient
  readonly #clock: FortnoxClock

  constructor(options: RedisFortnoxRateLimiterOptions) {
    if (!options?.redis) throw new Error('Redis is required for the Fortnox rate limiter')
    this.#redis = options.redis
    this.#clock = options.clock ?? systemFortnoxClock
  }

  /** EVALSHA med EVAL som reserv vid NOSCRIPT (t.ex. efter omstart av Redis). */
  async #run(script: string, keys: string[], args: (string | number)[]): Promise<unknown> {
    try {
      return await this.#redis.evalsha(sha1(script), keys.length, ...keys, ...args)
    } catch (error) {
      if (!(error instanceof Error) || !/NOSCRIPT/.test(error.message)) throw error
      return this.#redis.eval(script, keys.length, ...keys, ...args)
    }
  }

  /** En atomisk prövning. Exporterad för mätning; transporten använder `acquire`. */
  async reserve(key: string): Promise<{ granted: boolean; waitMs: number }> {
    const k = fortnoxRedisKeys(key)
    const reply = await this.#run(
      FORTNOX_RESERVE_LUA,
      [k.starts, k.deferred],
      [randomUUID(), FORTNOX_WINDOW_MS + FORTNOX_ARRIVAL_GUARD_MS, FORTNOX_STARTS_PER_WINDOW],
    )
    if (
      !Array.isArray(reply) ||
      reply.length !== 2 ||
      (reply[0] !== 0 && reply[0] !== 1) ||
      !Number.isSafeInteger(reply[1]) ||
      (reply[1] as number) < 0
    )
      throw new Error('Invalid limiter reply')
    return { granted: reply[0] === 1, waitMs: reply[1] as number }
  }

  async acquire(key: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) throw new Error('Aborted')
      const { granted, waitMs } = await this.reserve(key)
      if (granted) return
      // Inget beslut återanvänds: efter väntan prövas reservationen om mot aktuell spärr.
      await this.#clock.sleep(waitMs, signal)
    }
  }

  async defer(key: string, delayMs: number): Promise<void> {
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('Invalid delay')
    const k = fortnoxRedisKeys(key)
    const reply = await this.#run(
      FORTNOX_DEFER_LUA,
      [k.deferred],
      [Math.ceil(Math.min(delayMs, Number.MAX_SAFE_INTEGER / 2)), DEFER_TTL_CAP_MS],
    )
    if (typeof reply !== 'number') throw new Error('Invalid limiter reply')
  }
}

/**
 * Hinkens identitet: klient-id + VERIFIERAT Fortnox-företag ur den lagrade anslutningen,
 * aldrig ur token eller ur svaret. Utan registrerad identitet används en separat konservativ
 * hink (`unverified`) som aldrig är ett företags.
 */
export function fortnoxRateLimitKey(clientId: string, databaseNumber: number | null): string {
  const client = clientId.replace(/[^A-Za-z0-9._-]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)
  return databaseNumber !== null && Number.isSafeInteger(databaseNumber) && databaseNumber > 0
    ? `fortnox:${client}:db${databaseNumber}`
    : `fortnox:${client}:unverified`
}

/**
 * Processens koppling token → lagrat företag. Fylls bara av anslutningstjänsten när den lämnar
 * ut en token ur databasen. Token lagras inte (bara dess sha256), och ett tokenbyte för samma
 * företag ger samma hink.
 */
export class FortnoxRateIdentity {
  readonly #byToken = new Map<string, { databaseNumber: number; until: number }>()
  readonly #max: number
  readonly #ttlMs: number
  readonly #now: () => number

  constructor(options: { max?: number; ttlMs?: number; now?: () => number } = {}) {
    this.#max = options.max ?? 10_000
    this.#ttlMs = options.ttlMs ?? 2 * 60 * 60 * 1000
    this.#now = options.now ?? (() => Date.now())
  }

  bind(token: string, databaseNumber: number): void {
    if (typeof token !== 'string' || !token || !Number.isSafeInteger(databaseNumber)) return
    const h = createHash('sha256').update(token).digest('hex')
    this.#byToken.delete(h)
    this.#byToken.set(h, { databaseNumber, until: this.#now() + this.#ttlMs })
    while (this.#byToken.size > this.#max) {
      const oldest = this.#byToken.keys().next().value
      if (oldest === undefined) break
      this.#byToken.delete(oldest)
    }
  }

  databaseNumber(token: string): number | null {
    if (typeof token !== 'string' || !token) return null
    const h = createHash('sha256').update(token).digest('hex')
    const e = this.#byToken.get(h)
    if (!e) return null
    if (e.until <= this.#now()) {
      this.#byToken.delete(h)
      return null
    }
    return e.databaseNumber
  }
}
