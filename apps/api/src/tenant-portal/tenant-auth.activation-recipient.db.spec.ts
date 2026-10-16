/**
 * Aktiveringsutskick mot riktig PostgreSQL. Barriärerna pausar EFTER verkliga
 * kandidatläsningar; inget eget mottagarresultat eller tokenvillkor ersätter DB.
 * Bara mejlkö, Redis-lås och cronets felsänka är gränsattrapper. Inga utskick.
 */
jest.mock('../contracts/contract-template.service', () => ({ ContractTemplateService: class {} }))
jest.mock('../mail/mail.service', () => ({ MailService: class {} }))

import { createHash, randomUUID } from 'node:crypto'
import { UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Test, type TestingModule } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { CronErrorSink } from '../common/cron/cron-error-sink'
import { LockService } from '../common/redis/lock.service'
import { ContractTemplateService } from '../contracts/contract-template.service'
import { MailService } from '../mail/mail.service'
import { TenantAuthService } from './tenant-auth.service'
import { TenantInvitationsService } from './tenant-invitations.service'

type WelcomeMail = Parameters<MailService['sendTenantWelcomeWithContract']>[0]
type ReminderMail = Parameters<MailService['sendTenantActivationReminder']>[0]
type InvitationMail = Parameters<MailService['sendTenantPortalInvite']>[0]
const PORTAL_URL = 'https://portal.example.invalid'
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function bounded(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Verklig kandidatläsning nådde inte barriären')),
          5000,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function outcome<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  )
}

describe('aktiveringsutskick · mottagarbyte och tokenrotation i riktig DB', () => {
  let db: PrismaClient
  let auth: TenantAuthService
  const modules: TestingModule[] = []
  const orgIds: string[] = []
  const tenantIds: string[] = []
  const welcome: WelcomeMail[] = []
  const reminders: ReminderMail[] = []
  const invitations: InvitationMail[] = []
  const lockKeys: string[] = []
  let duringReminderMail: ((message: ReminderMail) => Promise<void>) | undefined

  const mail: Pick<
    MailService,
    'sendTenantWelcomeWithContract' | 'sendTenantActivationReminder' | 'sendTenantPortalInvite'
  > = {
    sendTenantWelcomeWithContract: async (message) => {
      welcome.push(message)
      return `synthetic-welcome-${welcome.length}`
    },
    sendTenantActivationReminder: async (message) => {
      reminders.push(message)
      await duringReminderMail?.(message)
      return `synthetic-reminder-${reminders.length}`
    },
    sendTenantPortalInvite: async (message) => {
      invitations.push(message)
      return `synthetic-invitation-${invitations.length}`
    },
  }
  const locks: Pick<LockService, 'runIfUnlocked'> = {
    runIfUnlocked: async (key, fn) => {
      lockKeys.push(key)
      return { ran: true, value: await fn() }
    },
  }
  const cronErrors: Pick<CronErrorSink, 'report'> = { report: async () => {} }

  async function servicesFor(client: unknown) {
    const module = await Test.createTestingModule({
      providers: [
        TenantAuthService,
        TenantInvitationsService,
        { provide: PrismaService, useValue: client },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => (key === 'PORTAL_URL' ? PORTAL_URL : undefined),
          },
        },
        { provide: MailService, useValue: mail },
        { provide: ContractTemplateService, useValue: {} },
        { provide: LockService, useValue: locks },
        { provide: CronErrorSink, useValue: cronErrors },
      ],
    }).compile()
    modules.push(module)
    return { auth: module.get(TenantAuthService), invites: module.get(TenantInvitationsService) }
  }

  async function fixture(options: { organizationId?: string; reminder?: boolean } = {}) {
    const suffix = randomUUID()
    let organizationId = options.organizationId
    if (!organizationId) {
      const organization = await db.organization.create({
        data: {
          name: `Syntetisk aktiveringsvärd ${suffix}`,
          email: `${suffix}@example.invalid`,
          street: 'Testgatan 1',
          city: 'Teststad',
          postalCode: '11122',
        },
      })
      organizationId = organization.id
      orgIds.push(organization.id)
    }
    const tenant = await db.tenant.create({
      data: {
        organizationId,
        type: 'INDIVIDUAL',
        firstName: 'Syntetisk',
        lastName: 'Hyresgäst',
        email: `${suffix}@example.invalid`,
        portalActivated: false,
        ...(options.reminder
          ? {
              activationTokenHash: sha256(`original-${suffix}`),
              // 72 h TTL med 12 h kvar betyder utfärdad för 60 h sedan: påminnelsebar.
              activationTokenExpiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
            }
          : {}),
      },
    })
    tenantIds.push(tenant.id)
    return tenant
  }

  const stored = (id: string) => db.tenant.findUniqueOrThrow({ where: { id } })
  function rawToken(message: { activationUrl: string }) {
    const url = new URL(message.activationUrl)
    expect(url.origin).toBe(PORTAL_URL)
    expect(url.pathname).toBe('/activate')
    const token = url.searchParams.get('token')
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    return token!
  }

  beforeAll(async () => {
    const value = process.env.DATABASE_URL
    if (!value) throw new Error('DATABASE_URL till isolerad provdatabas krävs; inget skip tillåts.')
    const url = new URL(value)
    if (
      !['localhost', '127.0.0.1', 'postgres'].includes(url.hostname) ||
      !(
        url.pathname.endsWith('_test') ||
        (process.env.CI === 'true' && url.pathname === '/eken_dev')
      )
    ) {
      throw new Error('Endast lokal *_test eller CI:s lokala eken_dev tillåts.')
    }
    url.searchParams.set('connection_limit', '4')
    db = new PrismaClient({ datasources: { db: { url: url.toString() } } })
    await db.$connect()
    auth = (await servicesFor(db)).auth
  }, 30_000)

  beforeEach(() => {
    welcome.length = 0
    reminders.length = 0
    invitations.length = 0
    lockKeys.length = 0
    duringReminderMail = undefined
  })
  afterEach(async () => {
    if (!db) return
    await db.tenantSession.deleteMany({ where: { tenantId: { in: tenantIds } } })
    await db.tenant.deleteMany({ where: { id: { in: tenantIds.splice(0) } } })
    await db.organization.deleteMany({ where: { id: { in: orgIds.splice(0) } } })
  })
  afterAll(async () => {
    for (const module of modules) await module.close()
    if (db) await db.$disconnect()
  })

  it('välkomstvägen nekar gammal mottagarläsning; färskt försök skickar giltig länk till ny adress', async () => {
    const tenant = await fixture()
    const reached = deferred()
    const release = deferred()
    let paused = false
    const client = db.$extends({
      query: {
        tenant: {
          findUnique: async ({ args, query }) => {
            const row = await query(args)
            if (!paused && args.where.id === tenant.id) {
              paused = true
              expect(row?.email).toBe(tenant.email)
              reached.resolve()
              await release.promise
            }
            return row
          },
        },
      },
    })
    const service = (await servicesFor(client)).auth
    const pending = outcome(service.sendWelcomeWithContract(tenant.id))
    let changed: Awaited<ReturnType<typeof stored>> | undefined
    try {
      await bounded(reached.promise)
      await db.tenant.update({
        where: { id: tenant.id },
        data: {
          email: `changed-${randomUUID()}@example.invalid`,
        },
      })
      changed = await stored(tenant.id)
    } finally {
      release.resolve()
      await pending
    }
    const result = await pending
    expect(result.status === 'rejected' && result.reason).toBeInstanceOf(UnauthorizedException)
    expect(changed).toBeDefined()
    expect(await stored(tenant.id)).toEqual(changed)
    expect(welcome).toHaveLength(0)
    await auth.sendWelcomeWithContract(tenant.id)
    expect(welcome).toHaveLength(1)
    expect(welcome[0]?.to).toBe(changed!.email)
    const token = rawToken(welcome[0]!)
    expect((await stored(tenant.id)).activationTokenHash).toBe(sha256(token))
    await expect(auth.findTenantByActivationToken(token)).resolves.toMatchObject({ id: tenant.id })
  })

  it.each(['ny e-post', 'ny aktiveringslänk', 'aktiverat konto'] as const)(
    'påminnelsewrappen fortsätter efter %s på första kandidaten och markerar bara nästa mottagare',
    async (change) => {
      const tenants = [await fixture({ reminder: true }), await fixture({ reminder: true })]
      const reached = deferred()
      const release = deferred()
      let candidateIds: string[] = []
      let paused = false
      const client = db.$extends({
        query: {
          tenant: {
            findMany: async ({ args, query }) => {
              const rows = await query(args)
              if (
                !paused &&
                args.where?.portalActivated === false &&
                args.where?.activationReminderSentAt === null
              ) {
                paused = true
                candidateIds = rows.map((row) => {
                  if (typeof row.id !== 'string') throw new Error('Kandidatläsningen saknar id')
                  return row.id
                })
                reached.resolve()
                await release.promise
              }
              return rows
            },
          },
        },
      })
      const service = (await servicesFor(client)).auth
      const pending = outcome(service.sendActivationReminders())
      let changed: Awaited<ReturnType<typeof stored>> | undefined
      let replacement: string | undefined
      try {
        await bounded(reached.promise)
        expect(new Set(candidateIds)).toEqual(new Set(tenants.map((tenant) => tenant.id)))
        // Utan ORDER BY väljs den FAKTISKT första DB-raden, inte en antagen ordning.
        if (change === 'ny aktiveringslänk') {
          replacement = await auth.issueActivationToken(candidateIds[0]!)
        } else {
          await db.tenant.update({
            where: { id: candidateIds[0]! },
            data:
              change === 'ny e-post'
                ? { email: `changed-${randomUUID()}@example.invalid` }
                : {
                    portalActivated: true,
                    activationTokenHash: null,
                    activationTokenExpiresAt: null,
                  },
          })
        }
        changed = await stored(candidateIds[0]!)
      } finally {
        release.resolve()
        await pending
      }
      expect(await pending).toEqual({ status: 'fulfilled', value: undefined })
      expect(lockKeys).toEqual(['cron:tenant-activation-reminders'])
      expect(changed).toBeDefined()
      expect(await stored(candidateIds[0]!)).toEqual(changed)
      if (replacement) {
        await expect(auth.findTenantByActivationToken(replacement)).resolves.toMatchObject({
          id: candidateIds[0],
        })
      }
      expect(reminders).toHaveLength(1)
      const valid = tenants.find((tenant) => tenant.id === candidateIds[1])!
      expect(reminders[0]?.to).toBe(valid.email)
      const token = rawToken(reminders[0]!)
      const row = await stored(valid.id)
      expect(row.activationTokenHash).toBe(sha256(token))
      expect(row.activationTokenHash).not.toBe(valid.activationTokenHash)
      expect(row.activationReminderSentAt).toBeInstanceOf(Date)
      await expect(auth.findTenantByActivationToken(token)).resolves.toMatchObject({ id: valid.id })
    },
  )

  it('påminnelsens sena kvitto får inte markera en senare roterad token som påmind', async () => {
    const tenant = await fixture({ reminder: true })
    let replacement: string | undefined
    duringReminderMail = async () => {
      replacement = await auth.issueActivationToken(tenant.id)
    }
    await auth.sendActivationReminders()
    expect(reminders).toHaveLength(1)
    expect(replacement).toBeDefined()
    const row = await stored(tenant.id)
    expect(row.activationTokenHash).toBe(sha256(replacement!))
    expect(row.activationReminderSentAt).toBeNull()
    await expect(auth.findTenantByActivationToken(rawToken(reminders[0]!))).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
    await expect(auth.findTenantByActivationToken(replacement!)).resolves.toMatchObject({
      id: tenant.id,
    })
  })

  it('publik invite prövar om mottagaren efter riktig kandidatläsning och låter nästa inbjudan lyckas', async () => {
    const stale = await fixture()
    const valid = await fixture({ organizationId: stale.organizationId })
    const reached = deferred()
    const release = deferred()
    let paused = false
    const client = db.$extends({
      query: {
        tenant: {
          findMany: async ({ args, query }) => {
            const rows = await query(args)
            if (!paused && args.where?.organizationId === stale.organizationId) {
              paused = true
              expect(new Set(rows.map((row) => row.id))).toEqual(new Set([stale.id, valid.id]))
              reached.resolve()
              await release.promise
            }
            return rows
          },
        },
      },
    })
    const { invites } = await servicesFor(client)
    const pending = outcome(
      invites.invite(stale.organizationId, { tenantIds: [stale.id, valid.id] }),
    )
    let changed: Awaited<ReturnType<typeof stored>> | undefined
    try {
      await bounded(reached.promise)
      await db.tenant.update({
        where: { id: stale.id },
        data: {
          email: `changed-${randomUUID()}@example.invalid`,
        },
      })
      changed = await stored(stale.id)
    } finally {
      release.resolve()
      await pending
    }
    expect(await pending).toMatchObject({ status: 'fulfilled', value: { invited: 1, failed: 1 } })
    expect(changed).toBeDefined()
    expect(await stored(stale.id)).toEqual(changed)
    expect(invitations).toHaveLength(1)
    expect(invitations[0]?.to).toBe(valid.email)
    const token = rawToken(invitations[0]!)
    expect((await stored(valid.id)).activationTokenHash).toBe(sha256(token))
    expect((await stored(valid.id)).inviteCount).toBe(1)
    await expect(auth.findTenantByActivationToken(token)).resolves.toMatchObject({ id: valid.id })
  })
})
