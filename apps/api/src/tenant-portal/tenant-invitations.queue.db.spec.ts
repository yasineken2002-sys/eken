/**
 * Riktig invite → MailService → MailQueue → Bull 4/Redis → MailWorkerHigh → DB.
 * Även e-postbyte och signerad webhook kör produktionens tjänster mot PostgreSQL.
 * Bara Resend-provider, HTML-rendering och oanvända kontrakts/PN-gränser ersätts.
 * Inga nätutskick, köattrapper, privata worker-anrop eller simulerade DB-villkor.
 */
jest.mock('../contracts/contract-template.service', () => ({ ContractTemplateService: class {} }))
jest.mock('../mail/mail.renderer', () => ({ MailRenderer: class {} }))
jest.mock('resend', () => ({
  Resend: class {
    readonly emails = {
      send: (payload: ProviderPayload, options?: ProviderOptions) =>
        mockProviderSend(payload, options),
    }
  },
}))

import { randomBytes, randomUUID } from 'node:crypto'
import { BullModule, getQueueToken } from '@nestjs/bull'
import { Logger, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Test, type TestingModule } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import type { Job, Queue } from 'bull'
import Redis from 'ioredis'
import { Webhook } from 'svix'
import { RentNoticeEventsService } from '../avisering/rent-notice-events.service'
import { PersonalNumberService } from '../common/crypto/personal-number.service'
import { CronErrorSink } from '../common/cron/cron-error-sink'
import { PrismaService } from '../common/prisma/prisma.service'
import { LockService } from '../common/redis/lock.service'
import { ContractTemplateService } from '../contracts/contract-template.service'
import { MailQueue } from '../mail/mail.queue'
import { MailRenderer } from '../mail/mail.renderer'
import { MailService } from '../mail/mail.service'
import { MailWorkerHigh } from '../mail/mail.worker'
import { type MailJobPayload, QUEUE_HIGH, QUEUE_LOW, QUEUE_NORMAL } from '../mail/mail.types'
import { TenantsService } from '../tenants/tenants.service'
import { ResendWebhookService } from '../webhooks/resend-webhook.service'
import { TenantAuthService } from './tenant-auth.service'
import { TenantInvitationsService } from './tenant-invitations.service'

type ProviderPayload = { to: string | string[] }
type ProviderOptions = { idempotencyKey?: string }
type ProviderCall = { to: string; idempotencyKey: string }
type ProviderSend = (
  payload: ProviderPayload,
  options?: ProviderOptions,
) => Promise<{
  data: { id: string }
  error: null
}>
let mockProviderSend: ProviderSend = async () => {
  throw new Error('Resend-provet saknar planerat providersvar; nätanrop är inte tillåtna')
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
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
        timer = setTimeout(
          () => reject(new Error(`Köprovets barriär tog för lång tid: ${label}`)),
          10_000,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function providerReply() {
  return {
    // Avsiktligt jobId-lik form. Härkomsten från provider, inte utseendet, är facit.
    messageId: `tenant-invite-provider-${randomUUID()}`,
    entered: deferred<ProviderCall>(),
    release: deferred<void>(),
    calls: 0,
  }
}
type ProviderReply = ReturnType<typeof providerReply>

function captureLogs() {
  const calls: unknown[][] = []
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      calls.push(args)
    })
  }
  return () =>
    JSON.stringify(calls, (_key, value: unknown) =>
      value instanceof Error ? { message: value.message, stack: value.stack } : value,
    )
}

describe('portalinbjudan · verklig Bull-kö och leveranskorrelation i DB', () => {
  jest.setTimeout(45_000)
  let db: PrismaClient
  let redisUrl: URL
  let module: TestingModule | undefined
  let high: Queue<MailJobPayload>
  let invites: TenantInvitationsService
  let tenants: TenantsService
  let mail: MailService
  let webhook: ResendWebhookService
  let prefix: string
  const secret = `whsec_${randomBytes(32).toString('base64')}`
  const orgIds: string[] = []
  const tenantIds: string[] = []
  const replies: ProviderReply[] = []
  const pendingProducers: Promise<void>[] = []
  const providerByKey = new Map<string, ProviderReply>()
  const ownedJobIds = new Set<string>()
  let fault: { tenantId: string; read?: Error; afterWrite?: Error } | undefined
  let readFaults = 0
  let writeFaults = 0
  let failedEmailPersisted = deferred<void>()
  const pn: Pick<PersonalNumberService, 'protect' | 'reveal'> = {
    protect: (value) => {
      if (value !== undefined) throw new Error('Köprovet får inte ändra personnummer')
      return {}
    },
    reveal: (value) => {
      if (value !== null) throw new Error('Köprovet får inte dekryptera personnummer')
      return null
    },
  }
  const renderer: Pick<MailRenderer, 'render'> = {
    render: async () => ({ html: '<p>Syntetisk inbjudan</p>', text: 'Syntetisk inbjudan' }),
  }

  const metadata = (id: string) =>
    db.tenant.findUniqueOrThrow({
      where: { id },
      select: {
        email: true,
        invitedAt: true,
        inviteCount: true,
        lastInviteMessageId: true,
        inviteDeliveredAt: true,
        inviteBouncedAt: true,
        inviteBounceReason: true,
        inviteComplainedAt: true,
      },
    })

  function planReply() {
    const reply = providerReply()
    replies.push(reply)
    return reply
  }

  async function fixture() {
    const suffix = randomUUID()
    const organization = await db.organization.create({
      data: {
        name: `Syntetisk kövärd ${suffix}`,
        email: `${suffix}@example.invalid`,
        street: 'Testgatan 1',
        city: 'Teststad',
        postalCode: '11122',
        transactionalEmailsDisabled: false,
      },
    })
    orgIds.push(organization.id)
    const tenant = await db.tenant.create({
      data: {
        organizationId: organization.id,
        type: 'INDIVIDUAL',
        firstName: 'Syntetisk',
        lastName: 'Hyresgäst',
        email: `${suffix}@example.invalid`,
        portalActivated: false,
      },
    })
    tenantIds.push(tenant.id)
    return tenant
  }

  function invite(tenant: { id: string; organizationId: string }, force = false) {
    const pending = invites.invite(tenant.organizationId, { tenantIds: [tenant.id], force })
    // Cleanup kan invänta även ett försök vars prov avbrutits vid en barriär.
    pendingProducers.push(
      pending.then(
        () => undefined,
        () => undefined,
      ),
    )
    return bounded(pending, 'producenten')
  }

  async function realJob(id: string): Promise<Job<MailJobPayload>> {
    const job = await high.getJob(id)
    if (!job) throw new Error('Det verkliga Bull-jobbet saknas')
    ownedJobIds.add(String(job.id))
    expect(job.data.template).toBe('tenant-portal-invite')
    expect(job.data.idempotencyKey).toBe(String(job.id))
    return job
  }

  async function complete(reply: ProviderReply) {
    const call = await bounded(reply.entered.promise, 'worker nådde provider')
    const job = await realJob(call.idempotencyKey)
    const finished = job.finished()
    reply.release.resolve()
    await bounded(finished, 'Bull completed')
    expect(await job.getState()).toBe('completed')
    expect(reply.calls).toBe(1)
    expect(String(job.id)).not.toBe(reply.messageId)
    return job
  }

  function signedEvent(messageId: string, kind: 'email.delivered' | 'email.bounced') {
    const at = new Date('2026-10-16T10:00:00.000Z')
    const raw = Buffer.from(
      JSON.stringify({
        type: kind,
        created_at: at.toISOString(),
        data: {
          email_id: messageId,
          ...(kind === 'email.bounced'
            ? { bounce: { message: 'Syntetisk studs', type: 'Permanent' } }
            : {}),
        },
      }),
    )
    const id = `msg_${randomUUID()}`
    const timestamp = Math.floor(Date.now() / 1000)
    return {
      at,
      raw,
      headers: {
        'svix-id': id,
        'svix-timestamp': String(timestamp),
        'svix-signature': new Webhook(secret).sign(
          id,
          new Date(timestamp * 1000),
          raw.toString('utf8'),
        ),
      },
    }
  }

  async function delivery(
    messageId: string,
    kind: 'email.delivered' | 'email.bounced' = 'email.delivered',
  ) {
    const event = signedEvent(messageId, kind)
    await webhook.handle(event.raw, event.headers)
    return event.at
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
      throw new Error('Explicit DATABASE_URL och REDIS_URL till isolerad lokal provmiljö krävs')
    }
    const databaseUrl = new URL(process.env.DATABASE_URL)
    redisUrl = new URL(process.env.REDIS_URL)
    const ci = process.env.CI === 'true'
    const localHost = (host: string) => ['localhost', '127.0.0.1'].includes(host)
    const localDatabase =
      localHost(databaseUrl.hostname) &&
      databaseUrl.port === '56432' &&
      databaseUrl.pathname.endsWith('_test')
    const ciDatabase =
      ci &&
      ['localhost', '127.0.0.1', 'postgres'].includes(databaseUrl.hostname) &&
      (databaseUrl.port === '5432' || databaseUrl.port === '') &&
      databaseUrl.pathname === '/eken_dev'
    const localRedis = localHost(redisUrl.hostname) && redisUrl.port === '56379'
    const ciRedis =
      ci &&
      ['localhost', '127.0.0.1', 'redis'].includes(redisUrl.hostname) &&
      (redisUrl.port === '6379' || redisUrl.port === '')
    if (
      databaseUrl.protocol !== 'postgresql:' ||
      (!localDatabase && !ciDatabase) ||
      redisUrl.protocol !== 'redis:' ||
      (!localRedis && !ciRedis) ||
      redisUrl.username ||
      redisUrl.password ||
      !/^\/(?:[0-9]|1[0-5])?$/.test(redisUrl.pathname || '/')
    ) {
      throw new Error(
        'Köprovet tillåter endast avgränsad lokal PostgreSQL/Redis eller uttrycklig CI-fixtur',
      )
    }
    databaseUrl.searchParams.set('connection_limit', '4')
    db = new PrismaClient({ datasources: { db: { url: databaseUrl.toString() } } })
    await db.$connect()
  })

  beforeEach(async () => {
    prefix = `test:portal-invite:${process.pid}:${randomUUID()}`
    replies.length = 0
    pendingProducers.length = 0
    providerByKey.clear()
    ownedJobIds.clear()
    fault = undefined
    readFaults = 0
    writeFaults = 0
    failedEmailPersisted = deferred<void>()
    mockProviderSend = async (payload, options) => {
      const key = options?.idempotencyKey
      if (!key || typeof payload.to !== 'string' || !payload.to.endsWith('@example.invalid')) {
        throw new Error('Providersvaret kräver syntetisk mottagare och verklig idempotensnyckel')
      }
      let reply = providerByKey.get(key)
      if (!reply) {
        reply = replies.find((candidate) => ![...providerByKey.values()].includes(candidate))
        if (!reply) throw new Error('Oplanerat provider-anrop i köprovet')
        providerByKey.set(key, reply)
      }
      reply.calls++
      reply.entered.resolve({ to: payload.to, idempotencyKey: key })
      await bounded(reply.release.promise, 'provider-svarets release')
      return { data: { id: reply.messageId }, error: null }
    }
    const configuration: Record<string, string> = {
      PORTAL_URL: 'https://portal.example.invalid',
      RESEND_API_KEY: 'synthetic-never-used-on-network',
      RESEND_WEBHOOK_SECRET: secret,
      NODE_ENV: 'test',
      MAIL_FROM: 'Syntetiskt köprov <noreply@example.invalid>',
    }
    // Alla vanliga läsningar/skrivningar går till PostgreSQL. De två sekretessproven
    // injicerar bara ett uttryckligt DB-fel vid rätt gräns; inga DB-resultat hittas på.
    const client = db.$extends({
      query: {
        tenant: {
          findFirst: async ({ args, query }) => {
            if (
              fault?.read &&
              args.where?.id === fault.tenantId &&
              typeof args.where?.activationTokenHash === 'string'
            ) {
              readFaults++
              throw fault.read
            }
            return query(args)
          },
          updateMany: async ({ args, query }) => {
            if (
              fault?.afterWrite &&
              args.where?.id === fault.tenantId &&
              (args.data.invitedAt instanceof Date ||
                typeof args.data.lastInviteMessageId === 'string')
            ) {
              writeFaults++
              throw fault.afterWrite
            }
            return query(args)
          },
        },
        failedEmail: {
          create: async ({ args, query }) => {
            const saved = await query(args)
            failedEmailPersisted.resolve()
            return saved
          },
        },
      },
    })
    module = await Test.createTestingModule({
      imports: [
        BullModule.forRoot({
          prefix,
          redis: {
            host: redisUrl.hostname,
            port: Number(redisUrl.port || 6379),
            db: Number(redisUrl.pathname.slice(1) || 0),
            connectTimeout: 3000,
            retryStrategy: () => null,
          },
          settings: { maxStalledCount: 3 },
        }),
        BullModule.registerQueue({ name: QUEUE_HIGH }, { name: QUEUE_NORMAL }, { name: QUEUE_LOW }),
      ],
      providers: [
        MailQueue,
        MailService,
        MailWorkerHigh,
        RentNoticeEventsService,
        TenantAuthService,
        TenantInvitationsService,
        TenantsService,
        ResendWebhookService,
        { provide: PrismaService, useValue: client },
        { provide: ConfigService, useValue: { get: (key: string) => configuration[key] } },
        { provide: MailRenderer, useValue: renderer },
        { provide: PersonalNumberService, useValue: pn },
        { provide: ContractTemplateService, useValue: {} },
        { provide: LockService, useValue: {} },
        { provide: CronErrorSink, useValue: {} },
      ],
    }).compile()
    await bounded(module.init(), 'Nest init och Bull-processorkoppling')
    high = module.get<Queue<MailJobPayload>>(getQueueToken(QUEUE_HIGH))
    await bounded(high.isReady(), 'Redis-kön redo')
    invites = module.get(TenantInvitationsService)
    tenants = module.get(TenantsService)
    mail = module.get(MailService)
    webhook = module.get(ResendWebhookService)
  })

  afterEach(async () => {
    for (const reply of replies) reply.release.resolve()
    const errors: unknown[] = []
    async function cleanup(label: string, action: () => Promise<unknown>) {
      try {
        await bounded(action(), label)
      } catch (error) {
        errors.push(error)
      }
    }
    // Ett tidigare barriär-/stängningsfel får inte hoppa över återstående städning.
    await cleanup('producenter före städning', () => Promise.all(pendingProducers))
    jest.restoreAllMocks()
    await cleanup('stäng Nest och Bull', async () => {
      if (module) await module.close()
    })
    module = undefined
    await cleanup('rensa egen Redis-namnrymd', async () => {
      // Bara detta provs namnrymd. Ingen FLUSHDB/FLUSHALL eller delad kö töms.
      if (redisUrl && prefix) {
        const cleaner = new Redis(redisUrl.toString(), {
          connectTimeout: 3000,
          retryStrategy: () => null,
        })
        try {
          let cursor = '0'
          do {
            const page = await cleaner.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 100)
            cursor = page[0]
            if (page[1].length) await cleaner.del(...page[1])
          } while (cursor !== '0')
          expect(await cleaner.keys(`${prefix}:*`)).toEqual([])
        } finally {
          await cleaner.quit()
        }
      }
    })
    await cleanup('rensa egna DB-fixturer', async () => {
      if (db) {
        await db.failedEmail.deleteMany({
          where: { jobId: { in: [...providerByKey.keys(), ...ownedJobIds] } },
        })
        await db.tenantSession.deleteMany({ where: { tenantId: { in: tenantIds } } })
        await db.tenant.deleteMany({ where: { id: { in: tenantIds } } })
        await db.organization.deleteMany({ where: { id: { in: orgIds } } })
        tenantIds.length = 0
        orgIds.length = 0
      }
    })
    if (errors.length) throw new AggregateError(errors, 'Köprovets städning misslyckades')
  })

  afterAll(async () => {
    if (db) await db.$disconnect()
  })

  it('kanarie: riktig worker sparar provider-id och riktig signerad webhook hittar rätt hyresgäst', async () => {
    const tenant = await fixture()
    const other = await fixture()
    const otherBefore = await metadata(other.id)
    const reply = planReply()
    try {
      expect(await invite(tenant)).toMatchObject({ invited: 1, failed: 0 })
      const call = await bounded(reply.entered.promise, 'normal konsumtion')
      expect(call.to).toBe(tenant.email)
      await complete(reply)
      expect((await metadata(tenant.id)).lastInviteMessageId).toBe(reply.messageId)
      const event = signedEvent(reply.messageId, 'email.delivered')
      await expect(
        webhook.handle(event.raw, { ...event.headers, 'svix-signature': 'ogiltig' }),
      ).rejects.toBeInstanceOf(UnauthorizedException)
      expect((await metadata(tenant.id)).inviteDeliveredAt).toBeNull()
      await webhook.handle(event.raw, event.headers)
      expect(await metadata(tenant.id)).toMatchObject({
        lastInviteMessageId: reply.messageId,
        inviteDeliveredAt: event.at,
        inviteCount: 1,
      })
      expect(await metadata(other.id)).toEqual(otherBefore)
    } finally {
      reply.release.resolve()
    }
  })

  it('snabb worker och leveranswebhook före producentens retur får inte raderas av sendOne', async () => {
    const tenant = await fixture()
    const reply = planReply()
    let beforeProducerReturn: Awaited<ReturnType<typeof metadata>> | undefined
    const original = mail.sendTenantPortalInvite.bind(mail)
    jest.spyOn(mail, 'sendTenantPortalInvite').mockImplementation(async (options) => {
      const jobId = await original(options) // Verklig MailQueue.add och Redis-serialisering.
      const job = await realJob(jobId)
      await bounded(job.finished(), 'snabb worker före producentretur')
      await delivery(reply.messageId)
      beforeProducerReturn = await metadata(tenant.id)
      return jobId
    })
    reply.release.resolve()
    try {
      expect(await invite(tenant)).toMatchObject({ invited: 1, failed: 0 })
      expect(reply.calls).toBe(1)
      expect(beforeProducerReturn).toMatchObject({
        lastInviteMessageId: reply.messageId,
        inviteDeliveredAt: new Date('2026-10-16T10:00:00.000Z'),
      })
      expect(await metadata(tenant.id)).toMatchObject({
        lastInviteMessageId: reply.messageId,
        inviteDeliveredAt: beforeProducerReturn!.inviteDeliveredAt,
        inviteCount: 1,
      })
    } finally {
      reply.release.resolve()
    }
  })

  it('sent A-kvitto efter riktigt e-postbyte får inte återinföra gammalt message-id eller leveransstatus', async () => {
    const tenant = await fixture()
    const reply = planReply()
    const newEmail = `changed-${randomUUID()}@example.invalid`
    try {
      expect(await invite(tenant)).toMatchObject({ invited: 1, failed: 0 })
      await bounded(reply.entered.promise, 'A nådde provider före e-postbyte')
      await tenants.update(tenant.id, { email: newEmail }, tenant.organizationId)
      await complete(reply)
      await delivery(reply.messageId)
      expect(await metadata(tenant.id)).toMatchObject({
        email: newEmail,
        lastInviteMessageId: null,
        invitedAt: null,
        inviteDeliveredAt: null,
        inviteBouncedAt: null,
        inviteCount: 1,
      })
    } finally {
      reply.release.resolve()
    }
  })

  it('A och B till samma adress: A:s sena kvitto och studs får inte ersätta B:s leverans', async () => {
    const tenant = await fixture()
    const a = planReply()
    const b = planReply()
    try {
      expect(await invite(tenant)).toMatchObject({ invited: 1, failed: 0 })
      const aCall = await bounded(a.entered.promise, 'A hålls i provider')
      expect(await invite(tenant, true)).toMatchObject({ invited: 1, failed: 0 })
      const bCall = await bounded(b.entered.promise, 'B plockas medan A är aktiv')
      expect(bCall.to).toBe(aCall.to)
      expect(bCall.idempotencyKey).not.toBe(aCall.idempotencyKey)
      await complete(b)
      const deliveredAt = await delivery(b.messageId)
      const current = await metadata(tenant.id)
      expect(current).toMatchObject({
        lastInviteMessageId: b.messageId,
        inviteDeliveredAt: deliveredAt,
        inviteCount: 2,
      })
      await complete(a)
      await delivery(a.messageId, 'email.bounced')
      expect(await metadata(tenant.id)).toEqual(current)
    } finally {
      a.release.resolve()
      b.release.resolve()
    }
  })

  it('samma normaliserade adress bevarar metadata; faktiskt byte tillåter ny inbjudan direkt utan force', async () => {
    const tenant = await fixture()
    const first = planReply()
    const second = planReply()
    try {
      expect(await invite(tenant)).toMatchObject({ invited: 1, failed: 0 })
      await complete(first)
      await delivery(first.messageId)
      const before = await metadata(tenant.id)

      await tenants.update(
        tenant.id,
        { email: `  ${tenant.email.toUpperCase()}  ` },
        tenant.organizationId,
      )
      expect(await metadata(tenant.id)).toEqual(before)

      const newEmail = `new-${randomUUID()}@example.invalid`
      await tenants.update(tenant.id, { email: newEmail }, tenant.organizationId)
      expect(await metadata(tenant.id)).toMatchObject({
        email: newEmail,
        invitedAt: null,
        lastInviteMessageId: null,
        inviteDeliveredAt: null,
        inviteBouncedAt: null,
        inviteBounceReason: null,
        inviteComplainedAt: null,
        inviteCount: 1,
      })
      expect(await invite(tenant)).toMatchObject({ invited: 1, failed: 0, skippedRecent: 0 })
      const call = await bounded(second.entered.promise, 'ny mottagare utan force')
      expect(call.to).toBe(newEmail)
      await complete(second)
      expect(await metadata(tenant.id)).toMatchObject({
        email: newEmail,
        lastInviteMessageId: second.messageId,
        inviteCount: 2,
      })
    } finally {
      first.release.resolve()
      second.release.resolve()
    }
  })

  it.each(['undertryckt utskick', 'stängd Bull-producent'] as const)(
    '%s räknas inte som inbjudan och skriver ingen skickatmarkör',
    async (mode) => {
      const tenant = await fixture()
      const unexpected = planReply()
      unexpected.release.resolve() // Felaktigt provider-anrop ska bli direkt mätbart, aldrig hänga.
      if (mode === 'undertryckt utskick') {
        await db.organization.update({
          where: { id: tenant.organizationId },
          data: { transactionalEmailsDisabled: true },
        })
      } else {
        // Verklig stängd anslutning: ingen fake enqueue-funktion avgör utgången.
        await bounded(high.close(), 'stäng producent före enqueue')
      }
      expect(await invite(tenant)).toMatchObject({ invited: 0 })
      expect(await metadata(tenant.id)).toMatchObject({
        invitedAt: null,
        inviteCount: 0,
        lastInviteMessageId: null,
      })
      expect(unexpected.calls).toBe(0)
      if (mode === 'undertryckt utskick') {
        expect(await high.getJobCounts()).toMatchObject({
          waiting: 0,
          active: 0,
          delayed: 0,
          completed: 0,
          failed: 0,
        })
      }
    },
  )

  it.each([
    'fel organisation',
    'fel mottagare',
    'anonymiserad hyresgäst',
    'fel länkvärd',
    'fel länksökväg',
    'dubbla tokenparametrar',
    'extra queryparameter',
    'fel tokenformat',
    'token roterad i DB',
    'portal-mall utan korrelation',
    'annan mall med invite-korrelation',
  ] as const)('riktigt köjobb nekas före provider vid %s', async (invalid) => {
    const tenant = await fixture()
    const auth = module!.get(TenantAuthService)
    const token = await auth.issueActivationToken(tenant.id)
    const url = new URL(auth.buildActivationUrl(token))
    const key = `tenant-invite-negative-${randomUUID()}`
    const payload: MailJobPayload = {
      template: 'tenant-portal-invite',
      organizationId: tenant.organizationId,
      to: tenant.email,
      subject: 'Syntetiskt negativt köprov',
      idempotencyKey: key,
      props: {},
      correlation: { kind: 'tenant-invite', tenantId: tenant.id },
    }
    switch (invalid) {
      case 'fel organisation':
        payload.organizationId = (await fixture()).organizationId
        break
      case 'fel mottagare':
        payload.to = `wrong-${randomUUID()}@example.invalid`
        break
      case 'anonymiserad hyresgäst':
        // Behåll token/mottagare för att isolera anonymiseringsvillkoret.
        await db.tenant.update({ where: { id: tenant.id }, data: { anonymizedAt: new Date() } })
        break
      case 'fel länkvärd':
        url.hostname = 'wrong.example.invalid'
        break
      case 'fel länksökväg':
        url.pathname = '/annan'
        break
      case 'dubbla tokenparametrar':
        url.searchParams.append('token', token)
        break
      case 'extra queryparameter':
        url.searchParams.append('redirect', '/annan')
        break
      case 'fel tokenformat':
        url.searchParams.set('token', 'A'.repeat(64))
        break
      case 'token roterad i DB':
        await auth.issueActivationToken(tenant.id)
        break
      case 'portal-mall utan korrelation':
        delete payload.correlation
        break
      case 'annan mall med invite-korrelation':
        payload.template = 'custom'
        break
    }
    payload.props = {
      activationUrl: url.toString(),
      tenantName: 'Syntetisk hyresgäst',
      organizationName: 'Syntetisk värd',
    }
    const before = await metadata(tenant.id)
    const unexpected = planReply()
    unexpected.release.resolve()
    // Redis och workern är riktiga även för felaktiga/äldre serialiserade payloads.
    // Ett oönskat skick får svar direkt och kan varken dölja sig bakom retries eller timeout.
    const job = await high.add(payload, { jobId: key, attempts: 1, removeOnComplete: false })
    ownedJobIds.add(String(job.id))
    await bounded(job.finished(), 'negativt jobb faktiskt konsumerat')
    expect(await job.getState()).toBe('completed')
    expect(unexpected.calls).toBe(0)
    expect(await metadata(tenant.id)).toEqual(before)
  })

  it('DB-läsfel före provider blir riktigt failed utan hash/länk i loggar eller sparad feltext', async () => {
    const tenant = await fixture()
    const auth = module!.get(TenantAuthService)
    const token = await auth.issueActivationToken(tenant.id)
    const activationUrl = auth.buildActivationUrl(token)
    const sentinelHash = 'b'.repeat(64)
    fault = {
      tenantId: tenant.id,
      read: new Error(
        `Prisma where activationTokenHash=${sentinelHash} activationUrl=${activationUrl}`,
      ),
    }
    const logs = captureLogs()
    const unexpected = planReply()
    unexpected.release.resolve()
    const key = `tenant-invite-private-read-${randomUUID()}`
    const job = await high.add(
      {
        template: 'tenant-portal-invite',
        organizationId: tenant.organizationId,
        to: tenant.email,
        subject: 'Syntetiskt DB-felprov',
        idempotencyKey: key,
        props: { activationUrl, tenantName: 'Syntetisk', organizationName: 'Syntetisk värd' },
        correlation: { kind: 'tenant-invite', tenantId: tenant.id },
      },
      { jobId: key, attempts: 1, removeOnFail: false },
    )
    ownedJobIds.add(String(job.id))
    await expect(bounded(job.finished(), 'riktigt misslyckat workerjobb')).rejects.toThrow(
      'PORTAL_INVITE_BINDING_READ_FAILED',
    )
    await bounded(failedEmailPersisted.promise, 'verklig FailedEmail-rad')
    expect(await job.getState()).toBe('failed')
    expect(readFaults).toBe(1)
    expect(unexpected.calls).toBe(0)
    const savedJob = await high.getJob(key)
    expect(savedJob?.failedReason).toBe('PORTAL_INVITE_BINDING_READ_FAILED')
    const failures = await db.failedEmail.findMany({ where: { jobId: key } })
    expect(failures).toHaveLength(1)
    expect(failures[0]?.error).toBe('PORTAL_INVITE_BINDING_READ_FAILED')
    // Befintlig DLQ lagrar jobbets payload för återkörning. Det är inte feltext;
    // denna leverans ändrar inte det separata, åtkomstskyddade lagringskontraktet.
    expect(failures[0]?.payload).toMatchObject({ props: { activationUrl } })
    expect(logs()).toContain('PORTAL_INVITE_BINDING_READ_FAILED')
    for (const sensitive of [sentinelHash, activationUrl, token]) {
      expect(logs()).not.toContain(sensitive)
    }
  })

  it('fel i producentens eftermarkering och worker-CAS exponerar inte DB-hash/länk i API eller logg', async () => {
    const tenant = await fixture()
    const sentinelHash = 'c'.repeat(64)
    const sentinelToken = 'd'.repeat(64)
    const sentinelUrl = `https://portal.example.invalid/activate?token=${sentinelToken}`
    fault = {
      tenantId: tenant.id,
      afterWrite: new Error(
        `Prisma where activationTokenHash=${sentinelHash} activationUrl=${sentinelUrl}`,
      ),
    }
    const logs = captureLogs()
    const reply = planReply()
    try {
      const result = await invite(tenant)
      expect(result).toMatchObject({ invited: 0, failed: 1 })
      expect(result.failedTenants[0]?.error).toBe(
        'Inbjudan kunde inte bekräftas. Kontrollera aktuell status innan du försöker igen.',
      )
      expect(writeFaults).toBe(1) // Producenten har köat, men eftermarkeringen misslyckades.
      await complete(reply) // Leverantören accepterar; CAS-felet får inte ge nytt utskick/retry.
      expect(writeFaults).toBe(2)
      expect(await metadata(tenant.id)).toMatchObject({
        invitedAt: null,
        inviteCount: 0,
        lastInviteMessageId: null,
      })
      expect(logs()).toContain('mail-correlation-write-failed')
      for (const sensitive of [sentinelHash, sentinelUrl, sentinelToken]) {
        expect(JSON.stringify(result)).not.toContain(sensitive)
        expect(logs()).not.toContain(sensitive)
      }
    } finally {
      reply.release.resolve()
    }
  })
})
