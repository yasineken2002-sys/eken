/**
 * Samma e-post hos flera hyresvärdar: riktig PostgreSQL, autentisering och bcrypt.
 * Endast mejlkön är en gränsattrapp. Den samlar syntetiska meddelanden; inga mejl
 * lämnar processen. Ett separat prov injicerar ett DB-skrivfel via Prisma.
 */
jest.mock('../contracts/contract-template.service', () => ({ ContractTemplateService: class {} }))
jest.mock('../mail/mail.service', () => ({ MailService: class {} }))

import { createHash, randomUUID } from 'node:crypto'
import * as bcrypt from 'bcryptjs'
import { Logger, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Test, type TestingModule } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { CronErrorSink } from '../common/cron/cron-error-sink'
import { LockService } from '../common/redis/lock.service'
import { ContractTemplateService } from '../contracts/contract-template.service'
import { MailService } from '../mail/mail.service'
import { TenantAuthService } from './tenant-auth.service'

type ResetMail = Parameters<MailService['sendPasswordReset']>[0]
const PORTAL_URL = 'https://portal.example.invalid'
const PASSWORD = 'Syntetiskt-Gammalt-123!'
const NEW_PASSWORD = 'Syntetiskt-Nytt-456!'
const TTL = 24 * 60 * 60 * 1000
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
          () => reject(new Error('Riktig kandidatfråga nådde inte barriären')),
          5000,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe('glömt lösenord · flera hyresvärdar med samma e-postadress', () => {
  let db: PrismaClient
  let service: TenantAuthService
  const modules: TestingModule[] = []
  const orgIds: string[] = []
  const tenantIds: string[] = []
  const attempted: ResetMail[] = []
  const queued: ResetMail[] = []
  let failFirstMail = false
  const mail: Pick<MailService, 'sendPasswordReset'> = {
    sendPasswordReset: async (options) => {
      attempted.push(options)
      if (failFirstMail && attempted.length === 1) {
        throw new Error(`Syntetiskt köfel för ${options.to}: ${options.resetUrl}`)
      }
      queued.push(options)
      return `synthetic-job-${queued.length}`
    },
  }

  async function serviceFor(client: unknown) {
    const module = await Test.createTestingModule({
      providers: [
        TenantAuthService,
        { provide: PrismaService, useValue: client },
        // Miljöfilens PORTAL_URL får inte styra den syntetiska mottagarlänken.
        {
          provide: ConfigService,
          useValue: { get: (key: string) => (key === 'PORTAL_URL' ? PORTAL_URL : undefined) },
        },
        { provide: MailService, useValue: mail },
        { provide: ContractTemplateService, useValue: {} },
        { provide: LockService, useValue: {} },
        { provide: CronErrorSink, useValue: {} },
      ],
    }).compile()
    modules.push(module)
    return module.get(TenantAuthService)
  }

  async function fixture(email: string, options: { active?: boolean; company?: boolean } = {}) {
    const suffix = randomUUID()
    const org = await db.organization.create({
      data: {
        name: `Syntetisk hyresvärd ${suffix}`,
        email: `${suffix}@example.invalid`,
        street: 'Testgatan 1',
        city: 'Teststad',
        postalCode: '11122',
      },
    })
    orgIds.push(org.id)
    const tenant = await db.tenant.create({
      data: {
        organizationId: org.id,
        email,
        type: options.company ? 'COMPANY' : 'INDIVIDUAL',
        firstName: options.company ? null : 'Syntetisk',
        lastName: options.company ? null : 'Hyresgäst',
        companyName: options.company ? 'Syntetiska Företaget AB' : null,
        portalActivated: options.active ?? true,
        portalActivatedAt: options.active === false ? null : new Date(Date.now() - 86_400_000),
        passwordHash: await bcrypt.hash(PASSWORD, 4),
      },
    })
    tenantIds.push(tenant.id)
    return { org, tenant }
  }

  async function stored(tenantId: string) {
    return {
      tenant: await db.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
      sessions: await db.tenantSession.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
    }
  }

  function rawToken(message: ResetMail) {
    const url = new URL(message.resetUrl)
    expect(url.origin).toBe(PORTAL_URL)
    expect(url.pathname).toBe('/reset-password')
    const token = url.searchParams.get('token')
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    return token!
  }

  beforeAll(async () => {
    const value = process.env.DATABASE_URL
    if (!value) throw new Error('DATABASE_URL till isolerad provdatabas krävs; inget skip tillåts.')
    const url = new URL(value)
    const local = ['localhost', '127.0.0.1', 'postgres'].includes(url.hostname)
    if (
      !local ||
      !(
        url.pathname.endsWith('_test') ||
        (process.env.CI === 'true' && url.pathname === '/eken_dev')
      )
    ) {
      throw new Error('Endast lokal *_test eller CI:s lokala eken_dev tillåts.')
    }
    url.searchParams.set('connection_limit', '6')
    db = new PrismaClient({ datasources: { db: { url: url.toString() } } })
    await db.$connect()
    service = await serviceFor(db)
  }, 30_000)

  beforeEach(() => {
    attempted.length = 0
    queued.length = 0
    failFirstMail = false
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

  it('två aktiverade konton får skilda organisationsmärkta länkar efter e-postnormalisering', async () => {
    const email = `shared-${randomUUID()}@example.invalid`
    const accounts = [await fixture(email), await fixture(email, { company: true })]
    const before = Date.now()
    await expect(service.sendForgotPassword(`  ${email.toUpperCase()}  `)).resolves.toBeUndefined()
    const after = Date.now()
    expect(queued).toHaveLength(2)
    expect(new Set(queued.map((message) => message.organizationId))).toEqual(
      new Set(accounts.map(({ org }) => org.id)),
    )
    expect(new Set(queued.map(rawToken)).size).toBe(2)
    expect(new Set(queued.map((message) => message.idempotencyKey)).size).toBe(2)
    for (const { org, tenant } of accounts) {
      const message = queued.find((item) => item.organizationId === org.id)!
      const token = rawToken(message)
      expect(message).toMatchObject({
        to: email,
        organizationId: org.id,
        organizationName: org.name,
        validForHours: 24,
        recipientName: tenant.type === 'COMPANY' ? tenant.companyName : 'Syntetisk Hyresgäst',
        idempotencyKey: `tenant-reset-${tenant.id}-${token.substring(0, 8)}`,
      })
      const row = await db.tenant.findUniqueOrThrow({ where: { id: tenant.id } })
      expect(row.passwordResetTokenHash).toBe(sha256(token))
      expect(row.passwordResetTokenHash).not.toBe(token)
      expect(row.passwordResetTokenExpiresAt!.getTime()).toBeGreaterThanOrEqual(before + TTL)
      expect(row.passwordResetTokenExpiresAt!.getTime()).toBeLessThanOrEqual(after + TTL)
      expect(row.passwordHash).toBe(tenant.passwordHash)
    }
  })

  it('ett oaktiverat konto blockerar inte det aktiverade kontot hos annan hyresvärd', async () => {
    const email = `shared-${randomUUID()}@example.invalid`
    // Ingen ordning antas för findFirst utan ORDER BY. Båda kontotyperna finns
    // verkligen i DB; tjänstens resultat ska fungera oavsett lagringsordningen.
    const inactive = await fixture(email, { active: false })
    const active = await fixture(email)
    const inactiveBefore = await stored(inactive.tenant.id)
    await expect(service.sendForgotPassword(email)).resolves.toBeUndefined()
    expect(queued).toHaveLength(1)
    expect(queued[0]?.organizationId).toBe(active.org.id)
    expect((await stored(active.tenant.id)).tenant.passwordResetTokenHash).toBe(
      sha256(rawToken(queued[0]!)),
    )
    expect(await stored(inactive.tenant.id)).toEqual(inactiveBefore)
  })

  it.each(['okänd', 'bara oaktiverade'] as const)(
    '%s adress ger samma void och inga mejl',
    async (kind) => {
      const email = `unknown-${randomUUID()}@example.invalid`
      const inactive = kind === 'bara oaktiverade' ? await fixture(email, { active: false }) : null
      const before = inactive ? await stored(inactive.tenant.id) : null
      await expect(service.sendForgotPassword(email)).resolves.toBeUndefined()
      expect(attempted).toHaveLength(0)
      if (inactive) expect(await stored(inactive.tenant.id)).toEqual(before)
    },
  )

  it('köfel för första kontot stoppar inte nästa hyresvärds återställningslänk', async () => {
    const email = `queue-failure-${randomUUID()}@example.invalid`
    const accounts = [await fixture(email), await fixture(email)]
    failFirstMail = true
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    try {
      await expect(service.sendForgotPassword(email)).resolves.toBeUndefined()
      expect(attempted).toHaveLength(2)
      expect(queued).toHaveLength(1)
      expect(attempted[0]?.organizationId).not.toBe(queued[0]?.organizationId)
      expect(new Set(attempted.map((message) => message.organizationId))).toEqual(
        new Set(accounts.map(({ org }) => org.id)),
      )
      const recipient = accounts.find(({ org }) => org.id === queued[0]?.organizationId)!
      expect((await stored(recipient.tenant.id)).tenant.passwordResetTokenHash).toBe(
        sha256(rawToken(queued[0]!)),
      )
      expect(warn).toHaveBeenCalled()
      const logged = warn.mock.calls
        .flat()
        .map((value: unknown) =>
          value instanceof Error
            ? value.message
            : typeof value === 'string'
              ? value
              : JSON.stringify(value),
        )
        .join('\n')
      const failed = accounts.find(({ org }) => org.id === attempted[0]?.organizationId)!
      expect(logged).toContain(failed.tenant.id)
      expect(logged).toContain(failed.org.id)
      expect(logged).toContain('mail')
      expect(logged).not.toContain(email)
      expect(logged).not.toContain(attempted[0]!.resetUrl)
      expect(logged).not.toContain(rawToken(attempted[0]!))
      expect(logged).not.toContain('Syntetiskt köfel')
    } finally {
      warn.mockRestore()
    }
  })

  it('DB-fel när en token skrivs stoppar inte det andra kontot och skapar inget mejl för den felade', async () => {
    const email = `db-failure-${randomUUID()}@example.invalid`
    const accounts = [await fixture(email), await fixture(email)]
    let failedTenantId: string | undefined
    const inject = (id: unknown, hash: unknown) => {
      if (!failedTenantId && typeof id === 'string' && typeof hash === 'string') {
        failedTenantId = id
        throw new Error('Syntetiskt tokenupdatefel')
      }
    }
    const broken = db.$extends({
      query: {
        tenant: {
          update: ({ args, query }) => {
            inject(args.where.id, args.data.passwordResetTokenHash)
            return query(args)
          },
          updateMany: ({ args, query }) => {
            inject(args.where?.id, args.data.passwordResetTokenHash)
            return query(args)
          },
        },
      },
    })
    const failingService = await serviceFor(broken)
    await expect(failingService.sendForgotPassword(email)).resolves.toBeUndefined()
    expect(failedTenantId).toBeDefined()
    expect(attempted).toHaveLength(1)
    const failed = accounts.find(({ tenant }) => tenant.id === failedTenantId)!
    const successful = accounts.find(({ tenant }) => tenant.id !== failedTenantId)!
    expect((await stored(failed.tenant.id)).tenant).toEqual(failed.tenant)
    expect(queued[0]?.organizationId).toBe(successful.org.id)
    expect((await stored(successful.tenant.id)).tenant.passwordResetTokenHash).toBe(
      sha256(rawToken(queued[0]!)),
    )
  })

  it('användning av en länk påverkar bara det kontots lösenord och sessioner', async () => {
    const email = `consume-${randomUUID()}@example.invalid`
    const a = await fixture(email)
    const b = await fixture(email)
    const oldA = await service.createSessionForTenant(a.tenant.id)
    const oldB = await service.createSessionForTenant(b.tenant.id)
    await service.sendForgotPassword(email)
    expect(queued).toHaveLength(2)
    const aToken = rawToken(queued.find((message) => message.organizationId === a.org.id)!)
    const bToken = rawToken(queued.find((message) => message.organizationId === b.org.id)!)
    const bBefore = await stored(b.tenant.id)
    const resetA = await service.resetPassword(aToken, NEW_PASSWORD)
    await expect(service.validateSession(oldA.sessionToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
    await expect(service.validateSession(resetA.sessionToken)).resolves.toMatchObject({
      id: a.tenant.id,
    })
    await expect(service.validateSession(oldB.sessionToken)).resolves.toMatchObject({
      id: b.tenant.id,
    })
    expect(await stored(b.tenant.id)).toEqual(bBefore)
    expect(
      await bcrypt.compare(NEW_PASSWORD, (await stored(a.tenant.id)).tenant.passwordHash!),
    ).toBe(true)
    const resetB = await service.resetPassword(bToken, 'Annat-Syntetiskt-789!')
    await expect(service.validateSession(resetB.sessionToken)).resolves.toMatchObject({
      id: b.tenant.id,
    })
    await expect(service.validateSession(resetA.sessionToken)).resolves.toMatchObject({
      id: a.tenant.id,
    })
  })

  it.each(['emailbyte', 'avaktivering'] as const)(
    '%s efter kandidatläsning stoppar gammal mottagare, men inte den andra organisationen',
    async (change) => {
      const email = `stale-${randomUUID()}@example.invalid`
      const stale = await fixture(email)
      const valid = await fixture(email)
      const reached = deferred()
      const release = deferred()
      let paused = false
      let candidateIds: string[] = []
      const pausingClient = db.$extends({
        query: {
          tenant: {
            findMany: async ({ args, query }) => {
              const rows = await query(args)
              if (!paused && args.where?.email === email) {
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
      const pausingService = await serviceFor(pausingClient)
      const outcome = pausingService.sendForgotPassword(email).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      )
      let changed: Awaited<ReturnType<typeof stored>> | undefined
      try {
        await bounded(reached.promise)
        // Barriären pausar verkliga DB-resultat, aldrig en egen kandidatattrapp.
        expect(new Set(candidateIds)).toEqual(new Set([stale.tenant.id, valid.tenant.id]))
        await db.tenant.update({
          where: { id: stale.tenant.id },
          data:
            change === 'emailbyte'
              ? { email: `changed-${randomUUID()}@example.invalid` }
              : { portalActivated: false },
        })
        changed = await stored(stale.tenant.id)
      } finally {
        release.resolve()
        await outcome
      }
      expect(await outcome).toEqual({ status: 'fulfilled', value: undefined })
      expect(changed).toBeDefined()
      expect(await stored(stale.tenant.id)).toEqual(changed)
      expect(changed!.tenant.passwordResetTokenHash).toBeNull()
      expect(attempted).toHaveLength(1)
      expect(queued[0]?.organizationId).toBe(valid.org.id)
      expect((await stored(valid.tenant.id)).tenant.passwordResetTokenHash).toBe(
        sha256(rawToken(queued[0]!)),
      )
    },
  )

  it('en andra begäran ersätter respektive organisations gamla länk utan att logga ut före lösenordsbytet', async () => {
    const email = `latest-${randomUUID()}@example.invalid`
    const accounts = [await fixture(email), await fixture(email)]
    const sessions = await Promise.all(
      accounts.map(({ tenant }) => service.createSessionForTenant(tenant.id)),
    )
    await expect(service.sendForgotPassword(email)).resolves.toBeUndefined()
    expect(queued).toHaveLength(2)
    const first = [...queued]
    await expect(service.sendForgotPassword(email)).resolves.toBeUndefined()
    expect(queued).toHaveLength(4)
    const latest = queued.slice(2)
    expect(new Set(queued.map(rawToken)).size).toBe(4)
    expect(new Set(queued.map((message) => message.idempotencyKey)).size).toBe(4)
    for (const [index, { org, tenant }] of accounts.entries()) {
      const oldToken = rawToken(first.find((message) => message.organizationId === org.id)!)
      const newToken = rawToken(latest.find((message) => message.organizationId === org.id)!)
      const before = await stored(tenant.id)
      expect(before.tenant.passwordResetTokenHash).toBe(sha256(newToken))
      await expect(service.resetPassword(oldToken, NEW_PASSWORD)).rejects.toBeInstanceOf(
        UnauthorizedException,
      )
      expect(await stored(tenant.id)).toEqual(before)
      await expect(service.validateSession(sessions[index]!.sessionToken)).resolves.toMatchObject({
        id: tenant.id,
      })
      const reset = await service.resetPassword(newToken, NEW_PASSWORD)
      await expect(service.validateSession(reset.sessionToken)).resolves.toMatchObject({
        id: tenant.id,
      })
      await expect(service.validateSession(sessions[index]!.sessionToken)).rejects.toBeInstanceOf(
        UnauthorizedException,
      )
    }
  })
})
