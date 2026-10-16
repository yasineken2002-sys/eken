/**
 * HTTP → riktig auth-tjänst → riktig Redis-budget → PostgreSQL och bcrypt.
 * Egen Redis-prefix per prov och bara UUID-fixturer raderas. Ingen mejltransport.
 * TCP-provet pausar efter en verklig sessionsinsert, aldrig i behörighetslogiken.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../contracts/contract-template.service', () => ({ ContractTemplateService: class {} }))
jest.mock('../mail/mail.service', () => ({ MailService: class {} }))
// Extern felrapportering är ett blad; det riktiga filtret får aldrig nå det
// för dessa förväntade 4xx-fall. Spionerna bevarar det som ett negativt bevis.
jest.mock('@sentry/nestjs', () => ({ withScope: jest.fn(), captureException: jest.fn() }))

import { createHash, createHmac, randomUUID } from 'node:crypto'
import { request as httpRequest, Server, type ClientRequest } from 'node:http'
import { performance } from 'node:perf_hooks'
import { HttpException, ValidationPipe, VersioningType } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import { TenantLoginResolveResultSchema } from '@eken/shared'
import * as Sentry from '@sentry/nestjs'
import bcrypt from 'bcryptjs'
import Redis from 'ioredis'
import { VALIDATION_PIPE_OPTIONS } from '../common/contract/validation-pipe-options'
import { CronErrorSink } from '../common/cron/cron-error-sink'
import { GlobalExceptionFilter } from '../common/filters/global-exception.filter'
import { TransformInterceptor } from '../common/interceptors/transform.interceptor'
import { PrismaService } from '../common/prisma/prisma.service'
import { LockService } from '../common/redis/lock.service'
import { RedisService } from '../common/redis/redis.service'
import { ContractTemplateService } from '../contracts/contract-template.service'
import { MailService } from '../mail/mail.service'
import { PlatformErrorsService } from '../platform/errors/platform-errors.service'
import { StorageService } from '../storage/storage.service'
import { TenantAuthService } from './tenant-auth.service'
import { TenantBankIdService } from './tenant-bankid.service'
import { TenantLoginBudget } from './tenant-login-budget.service'
import { TenantAuthController } from './tenant-portal.controller'

const PASSWORD = 'Syntetiskt-Flodesprov-123!'
const CLIENT_IP = '198.51.100.42'
const BUDGET_SECRET = 'synthetic-login-flow-secret'
const INVALID_CREDENTIALS = {
  statusCode: 401,
  code: 'UNAUTHORIZED',
  message: 'Felaktig e-post eller lösenord',
}
const LIMITED = {
  statusCode: 429,
  code: 'TOO_MANY_REQUESTS',
  message: 'Inloggning är tillfälligt begränsad. Försök igen senare.',
}

function expectPublicError(
  response: { statusCode: number; json<T>(): T },
  route: 'login' | 'login/resolve',
  expected: typeof INVALID_CREDENTIALS | typeof LIMITED,
) {
  expect(response.statusCode).toBe(expected.statusCode)
  const body = response.json<{ error: { timestamp: string } }>()
  // Exakt nyckelmängd: inga konton, credentials eller interna avslagsorsaker.
  expect(body).toEqual({
    success: false,
    error: {
      code: expected.code,
      message: expected.message,
      path: `/v1/tenant-portal/${route}`,
      timestamp: expect.any(String),
    },
  })
  expect(new Date(body.error.timestamp).toISOString()).toBe(body.error.timestamp)
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Flödesprovets barriär: ${label}`)), 4000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe('portal-login · HTTP, Redis och PostgreSQL tillsammans', () => {
  jest.setTimeout(30_000)
  let db: PrismaClient
  let redisUrl: string
  let redis: Redis | undefined
  let app: NestFastifyApplication | undefined
  let auth: TenantAuthService
  let prefix: string
  let socketRequest: ClientRequest | undefined
  let socketClosed: ReturnType<typeof deferred> | undefined
  let insertion:
    | { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }
    | undefined
  const organizationIds: string[] = []
  const tenantIds: string[] = []
  const logInternalError = jest
    .fn<
      ReturnType<PlatformErrorsService['logInternalError']>,
      Parameters<PlatformErrorsService['logInternalError']>
    >()
    .mockResolvedValue(undefined)

  beforeAll(async () => {
    if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
      throw new Error(
        'Explicit DATABASE_URL och REDIS_URL krävs; ingen env-fil eller skip används.',
      )
    }
    const database = new URL(process.env.DATABASE_URL)
    const cache = new URL(process.env.REDIS_URL)
    const local = (host: string) => ['localhost', '127.0.0.1'].includes(host)
    const ci = process.env.CI === 'true'
    const localDatabase =
      local(database.hostname) && database.port === '56432' && database.pathname.endsWith('_test')
    const ciDatabase =
      ci &&
      ['localhost', '127.0.0.1', 'postgres'].includes(database.hostname) &&
      ['', '5432'].includes(database.port) &&
      database.pathname === '/eken_dev'
    const localRedis = local(cache.hostname) && cache.port === '56379'
    const ciRedis =
      ci &&
      ['localhost', '127.0.0.1', 'redis'].includes(cache.hostname) &&
      ['', '6379'].includes(cache.port)
    if (
      database.protocol !== 'postgresql:' ||
      (!localDatabase && !ciDatabase) ||
      cache.protocol !== 'redis:' ||
      (!localRedis && !ciRedis) ||
      cache.username ||
      cache.password ||
      !/^\/(?:[0-9]|1[0-5])?$/.test(cache.pathname || '/')
    ) {
      throw new Error('Endast isolerad lokal PostgreSQL/Redis eller uttrycklig CI-fixtur tillåts.')
    }
    database.searchParams.set('connection_limit', '4')
    db = new PrismaClient({ datasources: { db: { url: database.toString() } } })
    await db.$connect()
    redisUrl = cache.toString()
  })

  beforeEach(async () => {
    logInternalError.mockClear()
    jest.mocked(Sentry.withScope).mockClear()
    jest.mocked(Sentry.captureException).mockClear()
    prefix = `test:tenant-login-flow:${randomUUID()}:`
    redis = new Redis(redisUrl, {
      keyPrefix: prefix,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      connectTimeout: 3000,
    })
    // Anslutnings-/kommandofel är fortfarande avvisade promises, inte konsolbrus.
    redis.on('error', () => {})
    await redis.connect()
    expect(await redis.ping()).toBe('PONG')
    insertion = undefined
    socketClosed = undefined
    const client = db.$extends({
      query: {
        tenantSession: {
          create: async ({ args, query }) => {
            const row = await query(args)
            if (insertion) {
              insertion.entered.resolve()
              await bounded(insertion.release.promise, 'släpp sessionsinsert')
            }
            return row
          },
        },
      },
    })
    const module = await Test.createTestingModule({
      controllers: [TenantAuthController],
      providers: [
        TenantAuthService,
        TenantLoginBudget,
        GlobalExceptionFilter,
        {
          provide: PlatformErrorsService,
          useValue: { logInternalError } satisfies Pick<PlatformErrorsService, 'logInternalError'>,
        },
        { provide: PrismaService, useValue: client },
        // Endast anslutningens prefix skiljer från drift: eval/Lua körs i Redis.
        {
          provide: RedisService,
          useValue: { client: redis } satisfies Pick<RedisService, 'client'>,
        },
        {
          provide: ConfigService,
          useValue: new ConfigService({ JWT_SECRET: BUDGET_SECRET }),
        },
        { provide: MailService, useValue: {} },
        { provide: ContractTemplateService, useValue: {} },
        { provide: LockService, useValue: {} },
        { provide: CronErrorSink, useValue: {} },
        { provide: StorageService, useValue: {} },
        { provide: TenantBankIdService, useValue: {} },
      ],
    }).compile()
    auth = module.get(TenantAuthService)
    const adapter = new FastifyAdapter({ trustProxy: 1 })
    adapter.getInstance().addHook('onRequest', (_request, reply, done) => {
      const closed = socketClosed
      if (closed) reply.raw.once('close', closed.resolve)
      done()
    })
    app = module.createNestApplication<NestFastifyApplication>(adapter)
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS))
    app.useGlobalFilters(module.get(GlobalExceptionFilter))
    app.useGlobalInterceptors(new TransformInterceptor())
    await app.init()
    await adapter.getInstance().ready()
  })

  async function ownedRedisKeys() {
    if (!redis) throw new Error('Redis-fixturen saknas')
    const found = new Set<string>()
    let cursor = '0'
    do {
      // SCAN-resultat/pattern prefixas inte av ioredis. DEL/GET nedan gör det.
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100)
      cursor = next
      for (const key of keys) {
        if (!key.startsWith(prefix)) throw new Error('Redis-nyckel utanför provets prefix')
        found.add(key.slice(prefix.length))
      }
    } while (cursor !== '0')
    return [...found].sort()
  }

  afterEach(async () => {
    insertion?.release.resolve()
    socketRequest?.destroy()
    socketRequest = undefined
    const errors: unknown[] = []
    const clean = async (work: () => Promise<unknown>) => {
      try {
        await work()
      } catch (error) {
        errors.push(error)
      }
    }
    await clean(async () => app?.close())
    app = undefined
    await clean(async () => {
      if (redis?.status !== 'ready') return
      const keys = await ownedRedisKeys()
      if (keys.length) await redis.del(...keys)
    })
    await clean(async () => {
      if (redis?.status === 'ready') await redis.quit()
    })
    redis?.disconnect()
    redis = undefined
    if (db) {
      await clean(() => db.tenantSession.deleteMany({ where: { tenantId: { in: tenantIds } } }))
      await clean(() => db.tenant.deleteMany({ where: { id: { in: tenantIds } } }))
      await clean(() => db.organization.deleteMany({ where: { id: { in: organizationIds } } }))
    }
    tenantIds.length = 0
    organizationIds.length = 0
    await clean(async () => {
      expect(logInternalError).not.toHaveBeenCalled()
      expect(Sentry.withScope).not.toHaveBeenCalled()
      expect(Sentry.captureException).not.toHaveBeenCalled()
    })
    jest.restoreAllMocks()
    if (errors.length)
      throw new AggregateError(errors, 'Flödesprovets isolerade städning misslyckades')
  })

  afterAll(async () => {
    if (db) await db.$disconnect()
  })

  async function fixture(email: string) {
    const id = randomUUID()
    const organization = await db.organization.create({
      data: {
        id,
        name: `Syntetisk flödesvärd ${id}`,
        email: `${id}@example.invalid`,
        street: 'Testgatan 1',
        city: 'Teststad',
        postalCode: '11122',
      },
    })
    organizationIds.push(organization.id)
    const tenant = await db.tenant.create({
      data: {
        organizationId: organization.id,
        email,
        type: 'INDIVIDUAL',
        firstName: 'Syntetisk',
        lastName: 'Hyresgäst',
        portalActivated: true,
        portalActivatedAt: new Date(),
        passwordHash: await bcrypt.hash(PASSWORD, 4),
      },
    })
    tenantIds.push(tenant.id)
    return { tenant, organization }
  }

  const sessionCount = () => db.tenantSession.count({ where: { tenantId: { in: tenantIds } } })
  const login = (
    route: 'login' | 'login/resolve',
    email: string,
    password = PASSWORD,
    organizationId?: string,
  ) => {
    if (!app) throw new Error('HTTP-fixturen saknas')
    return app.inject({
      method: 'POST',
      url: `/v1/tenant-portal/${route}`,
      remoteAddress: '192.0.2.10',
      headers: { 'x-forwarded-for': CLIENT_IP },
      payload: { email, password, ...(organizationId ? { organizationId } : {}) },
    })
  }

  it('två hyresvärdar ger choose utan session; uttryckligt val ger endast rätt organisationssession', async () => {
    const email = `${randomUUID()}@example.invalid`
    const a = await fixture(email)
    const b = await fixture(email)
    const compare = jest.spyOn(bcrypt, 'compare') // originalet körs fortfarande
    const response = await login('login/resolve', email)
    expect(response.statusCode).toBe(200)
    const choice = TenantLoginResolveResultSchema.parse(response.json<{ data: unknown }>().data)
    expect(choice).toEqual({
      status: 'choose',
      candidates: expect.arrayContaining([
        { organizationId: a.organization.id, organizationName: a.organization.name },
        { organizationId: b.organization.id, organizationName: b.organization.name },
      ]),
    })
    if (choice.status !== 'choose') throw new Error('Två riktiga lösenordsträffar ska kräva val')
    expect(choice.candidates).toHaveLength(2)
    expect(compare).toHaveBeenCalledTimes(2)
    expect(await sessionCount()).toBe(0)

    const selected = await login('login/resolve', email, PASSWORD, b.organization.id)
    expect(selected.statusCode).toBe(200)
    const complete = TenantLoginResolveResultSchema.parse(selected.json<{ data: unknown }>().data)
    if (complete.status !== 'complete') throw new Error('Valet ska ge en fullständig session')
    expect(complete.tenant.id).toBe(b.tenant.id)
    expect(compare).toHaveBeenCalledTimes(3)
    expect(
      await db.tenantSession.findMany({
        where: { tenantId: { in: tenantIds } },
        select: { tenantId: true, token: true },
      }),
    ).toEqual([
      {
        tenantId: b.tenant.id,
        token: createHash('sha256').update(complete.sessionToken).digest('hex'),
      },
    ])
    await expect(auth.validateSession(complete.sessionToken)).resolves.toMatchObject({
      id: b.tenant.id,
      organizationId: b.organization.id,
    })
    const keys = await ownedRedisKeys()
    expect(keys).toHaveLength(6)
    const ipKey = createHmac('sha256', BUDGET_SECRET)
      .update('tenant-login-budget:v1:ip\0')
      .update(CLIENT_IP)
      .digest('hex')
    expect(keys).toContain(`tenant-login:v1:{tenant-login-budget}:request:ip:${ipKey}`)
    expect(keys).toContain(`tenant-login:v1:{tenant-login-budget}:work:ip:${ipKey}`)
    for (const key of keys) expect(await redis!.pttl(key)).toBeGreaterThan(0)
  })

  it('sex aktiva konton ger samma generiska 401 utan en enda bcrypt-jämförelse eller session', async () => {
    const email = `${randomUUID()}@example.invalid`
    for (let i = 0; i < 6; i++) await fixture(email)
    const compare = jest.spyOn(bcrypt, 'compare')
    const overflow = await login('login/resolve', email)
    expectPublicError(overflow, 'login/resolve', INVALID_CREDENTIALS)
    expect(compare).not.toHaveBeenCalled()
    expect(await sessionCount()).toBe(0)
    const missing = await login('login/resolve', `${randomUUID()}@example.invalid`)
    // Samma offentliga svar, förutom den verifierade ISO-tidsstämpeln.
    expectPublicError(missing, 'login/resolve', INVALID_CREDENTIALS)
    expect(compare).not.toHaveBeenCalled()
    expect(await sessionCount()).toBe(0)
  })

  it('gamla login, resolve och explicit orgval förbrukar samma verkliga försöksbudget', async () => {
    const email = `${randomUUID()}@example.invalid`
    const { organization } = await fixture(email)
    const compare = jest.spyOn(bcrypt, 'compare')
    for (let i = 0; i < 10; i++) {
      const route = i % 2 ? 'login' : 'login/resolve'
      const result = await login(
        route,
        email,
        'Felaktigt-losenord',
        i % 3 ? organization.id : undefined,
      )
      expectPublicError(result, route, INVALID_CREDENTIALS)
    }
    expect(compare).toHaveBeenCalledTimes(10)
    for (const route of ['login', 'login/resolve'] as const) {
      for (const organizationId of [undefined, organization.id]) {
        const result = await login(route, email, PASSWORD, organizationId)
        expectPublicError(result, route, LIMITED)
      }
    }
    expect(compare).toHaveBeenCalledTimes(10)
    expect(await sessionCount()).toBe(0)
    const keys = await ownedRedisKeys()
    expect(keys).toHaveLength(6)
    for (const key of keys) expect(await redis!.get(key)).toBe('10')
  })

  it('verkligt TCP-avbrott efter sessionsinsert rullar tillbaka och frigör platsen för nästa login', async () => {
    const email = `${randomUUID()}@example.invalid`
    await fixture(email)
    if (!app) throw new Error('HTTP-fixturen saknas')
    const finished = deferred()
    let observedSignal: AbortSignal | undefined
    let observedError: unknown
    const realResolve = auth.resolveLogin.bind(auth)
    jest.spyOn(auth, 'resolveLogin').mockImplementation(async (...args) => {
      observedSignal = args[3]?.signal
      try {
        return await realResolve(...args)
      } catch (error) {
        observedError = error
        throw error
      } finally {
        finished.resolve()
      }
    })
    insertion = { entered: deferred(), release: deferred() }
    socketClosed = deferred()
    await app.listen(0, '127.0.0.1')
    const server: unknown = app.getHttpServer()
    if (!(server instanceof Server)) throw new Error('En riktig HTTP-server krävs')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Den lokala TCP-porten saknas')
    const body = JSON.stringify({ email, password: PASSWORD })
    const started = performance.now()
    socketRequest = httpRequest({
      host: '127.0.0.1',
      port: address.port,
      path: '/v1/tenant-portal/login/resolve',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-forwarded-for': CLIENT_IP,
      },
    })
    const transportError = deferred()
    socketRequest.on('error', transportError.resolve)
    socketRequest.end(body)
    try {
      await bounded(insertion.entered.promise, 'verklig sessionsinsert')
      socketRequest.destroy()
      await bounded(socketClosed.promise, 'servern observerar stängd TCP-anslutning')
      await bounded(transportError.promise, 'klienten observerar avbrottet')
      expect(observedSignal?.aborted).toBe(true)
      // Avbrottet ska observeras före 5s-budgeten, inte döljas av ett timeoutfel.
      expect(performance.now() - started).toBeLessThan(4000)
    } finally {
      insertion.release.resolve()
      await bounded(finished.promise, 'auth-tjänstens transaktion avslutas')
    }
    insertion = undefined
    socketClosed = undefined
    expect(observedError).toBeInstanceOf(HttpException)
    if (!(observedError instanceof HttpException)) throw observedError
    expect(observedError.getStatus()).toBe(429)
    expect(observedError.message).toBe(LIMITED.message)
    expect(performance.now() - started).toBeLessThan(5000)
    expect(await sessionCount()).toBe(0)
    const next = await login('login', email)
    expect(next.statusCode).toBe(200)
    expect(await sessionCount()).toBe(1)
  })
})
