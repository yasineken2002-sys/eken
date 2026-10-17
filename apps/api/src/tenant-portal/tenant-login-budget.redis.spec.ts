/**
 * Riktig Redis/Lua för kvoter och atomisk reservation. Klocka och svarsbarriärer
 * styr bara avbrottsfallen; inga bcrypt-jämförelser eller externa anrop görs.
 * Varje prov har egen keyPrefix, och städningen rör endast den namnrymden.
 */
import { HttpException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Test, type TestingModule } from '@nestjs/testing'
import { createHmac, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import Redis from 'ioredis'
import { RedisService } from '../common/redis/redis.service'
import {
  MAX_LOGIN_CANDIDATES,
  TenantLoginBudget,
  type TenantLoginContext,
  type TenantLoginPermit,
} from './tenant-login-budget.service'

const SECRET = 'syntetisk-loginbudget-hemlighet-enbart-for-prov'
const KEY_ROOT = 'tenant-login:v1:{tenant-login-budget}'
const CONTEXT = { email: 'alice@example.invalid', ip: '192.0.2.10' }
const CAPACITY_MESSAGE = 'Inloggning är tillfälligt begränsad. Försök igen senare.'
const CREDENTIAL_MESSAGE = 'Felaktig e-post eller lösenord'
const hash = (cost = 12) => `$2b$${String(cost).padStart(2, '0')}$${'A'.repeat(53)}`

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function identifier(kind: 'email' | 'ip', value: string, secret = SECRET): string {
  return createHmac('sha256', secret)
    .update(`tenant-login-budget:v1:${kind}\0`)
    .update(value)
    .digest('hex')
}

function key(kind: 'request' | 'work', scope: 'global' | 'ip' | 'email'): string {
  const suffix = scope === 'global' ? scope : `${scope}:${identifier(scope, CONTEXT[scope])}`
  return `${KEY_ROOT}:${kind}:${suffix}`
}

async function rejected(promise: Promise<unknown>, status = 429): Promise<HttpException> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException)
    if (!(error instanceof HttpException)) throw error
    expect(error.getStatus()).toBe(status)
    expect(error.message).toBe(status === 401 ? CREDENTIAL_MESSAGE : CAPACITY_MESSAGE)
    expect(error.getResponse()).toEqual(
      status === 401
        ? { message: CREDENTIAL_MESSAGE, error: 'Unauthorized', statusCode: 401 }
        : CAPACITY_MESSAGE,
    )
    return error
  }
  throw new Error('Försöket skulle ha nekats')
}

describe('portalens loginbudget · verklig Redis', () => {
  jest.setTimeout(20_000)
  let url: string
  let raw: Redis
  let first: Redis
  let second: Redis
  let prefix: string
  const modules: TestingModule[] = []
  const releases: Array<() => void> = []
  const pending: Promise<unknown>[] = []
  let restoreClock: (() => void) | undefined

  beforeAll(async () => {
    const configured = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL
    if (!configured)
      throw new Error('Explicit TEST_REDIS_URL eller REDIS_URL krävs för Redis-provet')
    const parsed = new URL(configured)
    const local = ['localhost', '127.0.0.1'].includes(parsed.hostname) && parsed.port === '56379'
    const ci =
      process.env.CI === 'true' &&
      ['localhost', '127.0.0.1', 'redis'].includes(parsed.hostname) &&
      (parsed.port === '6379' || parsed.port === '')
    if (
      parsed.protocol !== 'redis:' ||
      (!local && !ci) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !/^\/(?:[0-9]|1[0-5])?$/.test(parsed.pathname || '/')
    ) {
      throw new Error('Redis-provet kräver avgränsad lokal Redis eller uttrycklig CI-fixtur')
    }
    url = parsed.toString()
    raw = new Redis(url, {
      lazyConnect: true,
      connectTimeout: 2_000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    })
    await raw.connect()
    expect(await raw.ping()).toBe('PONG')
  })

  beforeEach(async () => {
    prefix = `tenant-login-budget-test:${randomUUID()}:`
    const options = {
      keyPrefix: prefix,
      lazyConnect: true,
      connectTimeout: 2_000,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    }
    first = new Redis(url, options)
    second = new Redis(url, options)
    await Promise.all([first.connect(), second.connect()])
  })

  afterEach(async () => {
    releases.splice(0).forEach((release) => release())
    jest.useRealTimers()
    restoreClock?.()
    restoreClock = undefined
    await Promise.allSettled(pending.splice(0))
    jest.restoreAllMocks()
    for (const module of modules.splice(0)) await module.close()
    const keys = await namespaceKeys()
    if (keys.length) await raw.del(...keys)
    expect(await namespaceKeys()).toEqual([])
    await Promise.all([first.quit(), second.quit()])
  })

  afterAll(async () => {
    if (raw) await raw.quit()
  })

  async function namespaceKeys(): Promise<string[]> {
    const keys = new Set<string>()
    let cursor = '0'
    do {
      const page = await raw.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100)
      cursor = page[0]
      page[1].forEach((value) => keys.add(value))
    } while (cursor !== '0')
    return [...keys].sort()
  }

  async function counters(kind?: 'request' | 'work'): Promise<Record<string, string | null>> {
    const keys = (await namespaceKeys()).filter((value) => !kind || value.includes(`:${kind}:`))
    const entries = await Promise.all(
      keys.map(async (value) => [value, await raw.get(value)] as const),
    )
    return Object.fromEntries(entries)
  }

  async function budget(client = first, secret = SECRET): Promise<TenantLoginBudget> {
    const redisBoundary = { client } satisfies Pick<RedisService, 'client'>
    const module = await Test.createTestingModule({
      providers: [
        TenantLoginBudget,
        { provide: RedisService, useValue: redisBoundary },
        { provide: ConfigService, useValue: new ConfigService({ JWT_SECRET: secret }) },
      ],
    }).compile()
    modules.push(module)
    return module.get(TenantLoginBudget)
  }

  function start<T>(
    service: TenantLoginBudget,
    work: (permit: TenantLoginPermit) => Promise<T>,
    context: TenantLoginContext = CONTEXT,
  ): Promise<T> {
    const promise = service.run(context, work)
    // Även fel före testets barriär fångas direkt, utan unhandled rejection.
    pending.push(
      promise.then(
        () => undefined,
        () => undefined,
      ),
    )
    return promise
  }

  async function accepted(service: TenantLoginBudget, hashes: readonly string[] = [hash()]) {
    return start(service, async (permit) => {
      await permit.reserve(hashes)
      permit.assertActive()
      return 'accepted'
    })
  }

  function barrier() {
    const entered = deferred<void>()
    const release = deferred<void>()
    releases.push(() => release.resolve())
    return { entered, release }
  }

  function clock() {
    let now = 0
    const previous = Object.getOwnPropertyDescriptor(performance, 'now')
    Object.defineProperty(performance, 'now', { configurable: true, value: () => now })
    restoreClock = () => {
      if (previous) Object.defineProperty(performance, 'now', previous)
      else Reflect.deleteProperty(performance, 'now')
    }
    return {
      advance: (milliseconds: number) => {
        now += milliseconds
      },
    }
  }

  it('använder riktiga EVAL-prefix, domänseparerad HMAC och TTL utan råa identiteter eller hashar', async () => {
    const service = await budget()
    const evalCalls = jest.spyOn(first, 'eval')
    await accepted(service)
    await start(service, async (permit) => permit.reserve([hash()]), {
      email: `  ${CONTEXT.email.toUpperCase()}  `,
      ip: CONTEXT.ip,
    })
    const keys = await namespaceKeys()
    expect(keys).toEqual(
      (['request', 'work'] as const)
        .flatMap((kind) =>
          (['global', 'ip', 'email'] as const).map((scope) => `${prefix}${key(kind, scope)}`),
        )
        .sort(),
    )
    for (const name of keys) {
      expect(await raw.get(name)).toBe('2')
      expect(await raw.pttl(name)).toBeGreaterThan(0)
      expect(await raw.pttl(name)).toBeLessThanOrEqual(60_000)
    }
    const serialized = JSON.stringify({ keys, commands: evalCalls.mock.calls })
    for (const value of [CONTEXT.email, CONTEXT.ip, hash(), SECRET]) {
      expect(serialized).not.toContain(value)
    }
    expect(identifier('email', 'same')).not.toBe(identifier('ip', 'same'))
  })

  it('skiljer identitetsnycklar åt när HMAC-hemligheten ändras', async () => {
    await accepted(await budget())
    await accepted(await budget(second, `${SECRET}-annan`))
    expect(await first.get(key('request', 'global'))).toBe('2')
    const keys = await namespaceKeys()
    expect(keys).toContain(
      `${prefix}${KEY_ROOT}:request:email:${identifier('email', CONTEXT.email, `${SECRET}-annan`)}`,
    )
    expect(keys).toHaveLength(10)
  })

  it('två instanser konkurrerar atomiskt om sista request-platsen utan halvdebitering', async () => {
    const [a, b] = await Promise.all([budget(), budget(second)])
    await first.set(key('request', 'global'), 119, 'PX', 60_000)
    const work = jest.fn(async (permit: TenantLoginPermit) => {
      await permit.reserve([])
      return 'accepted'
    })
    const outcomes = await Promise.allSettled([start(a, work), start(b, work)])
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((item) => item.status === 'rejected')).toHaveLength(1)
    for (const outcome of outcomes)
      if (outcome.status === 'rejected') await rejected(Promise.reject(outcome.reason))
    expect(work).toHaveBeenCalledTimes(1)
    expect(
      await first.mget(key('request', 'global'), key('request', 'ip'), key('request', 'email')),
    ).toEqual(['120', '1', '1'])
  })

  it('två instanser konkurrerar atomiskt om sista arbetsenheten utan halvdebitering', async () => {
    const [a, b] = await Promise.all([budget(), budget(second)])
    await first.set(key('work', 'global'), 59, 'PX', 60_000)
    const ready = deferred<void>()
    releases.push(() => ready.resolve())
    let entered = 0
    const work = async (permit: TenantLoginPermit) => {
      if (++entered === 2) ready.resolve()
      await ready.promise
      await permit.reserve([hash()])
      return 'accepted'
    }
    const outcomes = await Promise.allSettled([start(a, work), start(b, work)])
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((item) => item.status === 'rejected')).toHaveLength(1)
    for (const outcome of outcomes)
      if (outcome.status === 'rejected') await rejected(Promise.reject(outcome.reason))
    expect(
      await first.mget(key('work', 'global'), key('work', 'ip'), key('work', 'email')),
    ).toEqual(['60', '1', '1'])
    expect(await first.get(key('request', 'global'))).toBe('2')
  })

  it.each([
    ['global', 120],
    ['ip', 10],
    ['email', 10],
  ] as const)(
    'request-kvoten %s=%i stoppar callbacken och debiterar inga andra request-nycklar',
    async (scope, limit) => {
      const service = await budget()
      await first.set(key('request', scope), limit, 'PX', 60_000)
      const before = await counters()
      const work = jest.fn(async (permit: TenantLoginPermit) => permit.reserve([]))
      await rejected(start(service, work))
      expect(work).not.toHaveBeenCalled()
      expect(await counters()).toEqual(before)
    },
  )

  it.each([
    ['global', 60],
    ['ip', 15],
    ['email', 15],
  ] as const)(
    'arbetskvoten %s=%i avvisar hela reservationen utan halvdebitering',
    async (scope, limit) => {
      const service = await budget()
      await first.set(key('work', scope), limit - 1, 'PX', 60_000)
      const before = await counters('work')
      await rejected(accepted(service, [hash(13)]))
      expect(await counters('work')).toEqual(before)
      expect(await first.get(key('request', 'global'))).toBe('1')
    },
  )

  it('en verkligt utgången kvotnyckel börjar om med TTL vid nästa godkända anrop', async () => {
    const service = await budget()
    await first.set(key('request', 'global'), 120, 'PX', 60_000)
    await rejected(accepted(service))
    await first.pexpireat(key('request', 'global'), 1)
    await expect(accepted(service)).resolves.toBe('accepted')
    expect(await first.get(key('request', 'global'))).toBe('1')
    expect(await first.pttl(key('request', 'global'))).toBeGreaterThan(0)
  })

  it.each([
    [[], 1],
    [[hash(4)], 1],
    [[hash(12)], 1],
    [[hash(13)], 2],
    [[hash(14)], 4],
    [[hash(13), hash(), hash(), hash()], 5],
  ] as const)('debiterar hela bcrypt-kostnaden för %j: %i enheter', async (hashes, units) => {
    await accepted(await budget(), hashes)
    expect(
      await first.mget(key('work', 'global'), key('work', 'ip'), key('work', 'email')),
    ).toEqual(Array(3).fill(String(units)))
  })

  it.each([
    ['fler än fem kandidater', Array.from({ length: 6 }, () => hash())],
    ['en kostnad över hela budgeten', [hash(15)]],
    ['summan över budgeten', [hash(14), hash(13)]],
    ['okänd hashform', ['syntetisk-ogiltig-hash']],
  ] as const)(
    '%s ger samma 401 som fel lösenord, utan arbete eller arbetsdebitering',
    async (_label, hashes) => {
      expect(MAX_LOGIN_CANDIDATES).toBe(5)
      const service = await budget()
      const compare = jest.fn()
      await rejected(
        start(service, async (permit) => {
          await permit.reserve(hashes)
          compare()
        }),
        401,
      )
      expect(compare).not.toHaveBeenCalled()
      expect(await counters('work')).toEqual({})
      expect(await first.get(key('request', 'global'))).toBe('1')
    },
  )

  it('kräver reserve, tillåter den exakt en gång och ogiltigförklarar sparade permit efter avslut', async () => {
    const service = await budget()
    let captured: TenantLoginPermit | undefined
    await rejected(
      start(service, async (permit) => {
        captured = permit
      }),
    )
    expect(captured).toBeDefined()
    expect(() => captured?.assertActive()).toThrow(CAPACITY_MESSAGE)
    await rejected(
      start(service, async (permit) => {
        await permit.reserve([])
        await permit.reserve([])
      }),
    )
    expect(await first.get(key('work', 'global'))).toBe('1')
    await expect(accepted(service)).resolves.toBe('accepted')
  })

  it('håller lokal plats tills callbacken verkligen avslutas och frigör den även vid callback-fel', async () => {
    const service = await budget()
    const gate = barrier()
    const originalError = new Error('Syntetiskt domänfel')
    const running = start(service, async (permit) => {
      await permit.reserve([])
      gate.entered.resolve()
      await gate.release.promise
      throw originalError
    })
    await gate.entered.promise
    await rejected(accepted(service))
    expect(await first.get(key('request', 'global'))).toBe('1')
    gate.release.resolve()
    await expect(running).rejects.toBe(originalError)
    await expect(accepted(service)).resolves.toBe('accepted')
  })

  it('två samtidiga reserve på samma permit kan inte debitera två gånger eller kringgå avslaget', async () => {
    const service = await budget()
    const gate = barrier()
    const original = first.eval.bind(first)
    let calls = 0
    jest.spyOn(first, 'eval').mockImplementation(async (...args) => {
      const result = await original(...args)
      if (++calls === 2) {
        gate.entered.resolve()
        await gate.release.promise
      }
      return result
    })
    await rejected(
      start(service, async (permit) => {
        const reservation = permit.reserve([])
        pending.push(
          reservation.then(
            () => undefined,
            () => undefined,
          ),
        )
        await gate.entered.promise
        await rejected(permit.reserve([]))
        gate.release.resolve()
        await rejected(reservation)
        // Att callbacken fångar avslaget får inte göra hela försöket giltigt.
      }),
    )
    expect(calls).toBe(2)
    expect(await first.get(key('work', 'global'))).toBe('1')
  })

  it('observerar hela försökets 5s-gräns även när callbacken glömmer en sista kontrollpunkt', async () => {
    const service = await budget()
    const time = clock()
    await rejected(
      start(service, async (permit) => {
        await permit.reserve([])
        time.advance(5_000)
        return 'får inte returneras'
      }),
    )
    await expect(accepted(service)).resolves.toBe('accepted')
  })

  it('deadline före reserve stoppar arbetskvot och jämförelse innan de startar', async () => {
    const service = await budget()
    const time = clock()
    const compare = jest.fn()
    await rejected(
      start(service, async (permit) => {
        time.advance(5_000)
        await permit.reserve([])
        compare()
      }),
    )
    expect(compare).not.toHaveBeenCalled()
    expect(await counters('work')).toEqual({})
  })

  it.each(['abort', 'deadline'] as const)(
    '%s under callbacken frigör inte platsen innan pågående arbete avslutats',
    async (cause) => {
      const service = await budget()
      const time = clock()
      const controller = new AbortController()
      const gate = barrier()
      const afterCheckpoint = jest.fn()
      const running = start(
        service,
        async (permit) => {
          await permit.reserve([])
          gate.entered.resolve()
          await gate.release.promise
          permit.assertActive()
          afterCheckpoint()
        },
        { ...CONTEXT, signal: controller.signal },
      )
      await gate.entered.promise
      if (cause === 'abort') controller.abort()
      else time.advance(5_000)
      await rejected(accepted(service))
      gate.release.resolve()
      await rejected(running)
      expect(afterCheckpoint).not.toHaveBeenCalled()
      await expect(accepted(service)).resolves.toBe('accepted')
    },
  )

  it('redan avbrutet försök rör varken Redis eller callbacken', async () => {
    const service = await budget()
    const controller = new AbortController()
    controller.abort()
    const calls = jest.spyOn(first, 'eval')
    const work = jest.fn(async (permit: TenantLoginPermit) => permit.reserve([]))
    await rejected(start(service, work, { ...CONTEXT, signal: controller.signal }))
    expect(calls).not.toHaveBeenCalled()
    expect(work).not.toHaveBeenCalled()
  })

  it.each(['request', 'work'] as const)(
    'abort under %s-Redis väntan hindrar fortsatt arbete trots sen verklig debitering',
    async (stage) => {
      const service = await budget()
      const controller = new AbortController()
      const gate = barrier()
      const original = first.eval.bind(first)
      let calls = 0
      jest.spyOn(first, 'eval').mockImplementation(async (...args) => {
        const result = await original(...args)
        if (++calls === (stage === 'request' ? 1 : 2)) {
          gate.entered.resolve()
          await gate.release.promise
        }
        return result
      })
      const compare = jest.fn()
      const work = jest.fn(async (permit: TenantLoginPermit) => {
        await permit.reserve([])
        compare()
      })
      const running = start(service, work, { ...CONTEXT, signal: controller.signal })
      await gate.entered.promise
      controller.abort()
      await rejected(running)
      gate.release.resolve()
      await Promise.resolve()
      expect(work).toHaveBeenCalledTimes(stage === 'request' ? 0 : 1)
      expect(compare).not.toHaveBeenCalled()
      expect(await first.get(key(stage, 'global'))).toBe('1')
    },
  )

  it.each([1_000, 5_000])(
    'sent Redis-svar efter %ims startar aldrig callbacken även om timern inte hunnit köras',
    async (elapsed) => {
      const service = await budget()
      const time = clock()
      const gate = barrier()
      jest.spyOn(first, 'eval').mockImplementation(async () => {
        gate.entered.resolve()
        await gate.release.promise
        return 1
      })
      const work = jest.fn(async (permit: TenantLoginPermit) => permit.reserve([]))
      const running = start(service, work)
      await gate.entered.promise
      time.advance(elapsed)
      gate.release.resolve()
      await rejected(running)
      expect(work).not.toHaveBeenCalled()
    },
  )

  it('Redis-kommandots 1000ms-timer avbryter ett hängande svar och sena svar återupptar inget', async () => {
    const service = await budget()
    const reply = deferred<unknown>()
    releases.push(() => reply.resolve(1))
    jest.spyOn(first, 'eval').mockReturnValue(reply.promise)
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'performance'] })
    const work = jest.fn(async (permit: TenantLoginPermit) => permit.reserve([]))
    const running = start(service, work)
    await jest.advanceTimersByTimeAsync(1_000)
    await rejected(running)
    reply.resolve(1)
    await Promise.resolve()
    expect(work).not.toHaveBeenCalled()
  })

  it.each(['reject', 'unexpected-reply', 'corrupt-counter'] as const)(
    'Redis-fel %s stänger vägen med samma maskerade 429',
    async (fault) => {
      const service = await budget()
      if (fault === 'reject')
        jest
          .spyOn(first, 'eval')
          .mockRejectedValue(new Error(`Redis-detalj ${CONTEXT.email} ${CONTEXT.ip}`))
      if (fault === 'unexpected-reply') jest.spyOn(first, 'eval').mockResolvedValue('1')
      if (fault === 'corrupt-counter')
        await first.set(key('request', 'global'), 'trasig', 'PX', 60_000)
      const work = jest.fn(async (permit: TenantLoginPermit) => permit.reserve([]))
      const error = await rejected(start(service, work))
      expect(work).not.toHaveBeenCalled()
      expect(JSON.stringify(error)).not.toContain(CONTEXT.email)
      expect(JSON.stringify(error)).not.toContain(CONTEXT.ip)
    },
  )
})
