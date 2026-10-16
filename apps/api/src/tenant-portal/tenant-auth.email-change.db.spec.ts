/**
 * E-postbyte genom riktiga TenantsService.update och autentisering mot PostgreSQL.
 * Ingen mock återkallar sessioner eller avgör om en länk gäller. Bcrypt-omslaget
 * pausar bara efter en riktig hash så att ett administrativt byte kan hinna först.
 * Fixturerna saknar personnummer; PN-gränsen kastar vid alla andra indata än
 * protect(undefined) och reveal(null). Inga mejl eller externa tjänster anropas.
 */
jest.mock('../contracts/contract-template.service', () => ({ ContractTemplateService: class {} }))
jest.mock('../mail/mail.service', () => ({ MailService: class {} }))
jest.mock('bcryptjs', () => {
  const actual = jest.requireActual<typeof import('bcryptjs')>('bcryptjs')
  return {
    ...actual,
    __esModule: true,
    hash: async (password: string, salt: number | string) => {
      const result = await actual.hash(password, salt)
      await mockAfterHash?.()
      return result
    },
  }
})

import { createHash, randomUUID } from 'node:crypto'
import { NotFoundException, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Test, type TestingModule } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { PersonalNumberService } from '../common/crypto/personal-number.service'
import { CronErrorSink } from '../common/cron/cron-error-sink'
import { LockService } from '../common/redis/lock.service'
import { ContractTemplateService } from '../contracts/contract-template.service'
import { MailService } from '../mail/mail.service'
import { TENANT_CREDENTIAL_KEYS } from '../tenants/tenant-credential-keys'
import { TenantsService } from '../tenants/tenants.service'
import { TenantAuthService } from './tenant-auth.service'

let mockAfterHash: (() => Promise<void>) | undefined
const actualBcrypt = jest.requireActual<typeof import('bcryptjs')>('bcryptjs')
const PASSWORD = 'Syntetiskt-Gammalt-123!'
const NEW_PASSWORD = 'Syntetiskt-Nytt-456!'
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
        timer = setTimeout(() => reject(new Error('Riktig bcrypt nådde inte racebarriären')), 5000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe('e-postbyte · återkallade portallänkar och sessioner i riktig DB', () => {
  let db: PrismaClient
  let module: TestingModule
  let tenants: TenantsService
  let auth: TenantAuthService
  const orgIds: string[] = []
  const tenantIds: string[] = []
  const pn: Pick<PersonalNumberService, 'protect' | 'reveal'> = {
    protect: (value) => {
      if (value !== undefined) throw new Error('Provet får inte ändra personnummer')
      return {}
    },
    reveal: (value) => {
      if (value !== null) throw new Error('Provet får inte dekryptera personnummer')
      return null
    },
  }

  async function fixture(options: { organizationId?: string; email?: string } = {}) {
    const suffix = randomUUID()
    let organizationId = options.organizationId
    if (!organizationId) {
      const org = await db.organization.create({
        data: {
          name: `Syntetiskt e-postprov ${suffix}`,
          email: `${suffix}@example.invalid`,
          street: 'Testgatan 1',
          city: 'Teststad',
          postalCode: '11122',
        },
      })
      organizationId = org.id
      orgIds.push(org.id)
    }
    const resetToken = `reset-${randomUUID()}`
    const activationToken = `activation-${randomUUID()}`
    const tenant = await db.tenant.create({
      data: {
        organizationId,
        email: options.email ?? `${suffix}@example.invalid`,
        type: 'INDIVIDUAL',
        firstName: 'Syntetisk',
        lastName: 'Hyresgäst',
        portalActivated: true,
        portalActivatedAt: new Date(Date.now() - 86_400_000),
        passwordHash: await actualBcrypt.hash(PASSWORD, 4),
        passwordResetTokenHash: sha256(resetToken),
        passwordResetTokenExpiresAt: new Date(Date.now() + 3_600_000),
        activationTokenHash: sha256(activationToken),
        activationTokenExpiresAt: new Date(Date.now() + 3_600_000),
        activationReminderSentAt: new Date(Date.now() - 60_000),
      },
    })
    tenantIds.push(tenant.id)
    return { tenant, resetToken, activationToken }
  }

  async function stored(tenantId: string) {
    return {
      tenant: await db.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
      sessions: await db.tenantSession.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
    }
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
    url.searchParams.set('connection_limit', '6')
    db = new PrismaClient({ datasources: { db: { url: url.toString() } } })
    await db.$connect()
    module = await Test.createTestingModule({
      providers: [
        TenantsService,
        TenantAuthService,
        { provide: PrismaService, useValue: db },
        { provide: PersonalNumberService, useValue: pn },
        { provide: ConfigService, useValue: new ConfigService({}) },
        { provide: MailService, useValue: {} },
        { provide: ContractTemplateService, useValue: {} },
        { provide: LockService, useValue: {} },
        { provide: CronErrorSink, useValue: {} },
      ],
    }).compile()
    tenants = module.get(TenantsService)
    auth = module.get(TenantAuthService)
  }, 30_000)

  afterEach(async () => {
    mockAfterHash = undefined
    if (!db) return
    await db.tenantSession.deleteMany({ where: { tenantId: { in: tenantIds } } })
    await db.tenant.deleteMany({ where: { id: { in: tenantIds.splice(0) } } })
    await db.organization.deleteMany({ where: { id: { in: orgIds.splice(0) } } })
  })

  afterAll(async () => {
    if (module) await module.close()
    if (db) await db.$disconnect()
  })

  it('faktiskt normaliserat e-postbyte återkallar egna länkar/sessioner och lämnar andra tenants orörda', async () => {
    const a = await fixture()
    const neighbor = await fixture({ organizationId: a.tenant.organizationId })
    const otherOrg = await fixture({ email: a.tenant.email })
    const oldA = await auth.login(a.tenant.email, PASSWORD, a.tenant.organizationId)
    const secondA = await auth.createSessionForTenant(a.tenant.id)
    const neighborSession = await auth.createSessionForTenant(neighbor.tenant.id)
    const otherSession = await auth.createSessionForTenant(otherOrg.tenant.id)
    const neighborBefore = await stored(neighbor.tenant.id)
    const otherBefore = await stored(otherOrg.tenant.id)
    const newEmail = `changed-${randomUUID()}@example.invalid`
    const result = await tenants.update(
      a.tenant.id,
      { email: `  ${newEmail.toUpperCase()}  ` },
      a.tenant.organizationId,
    )
    const after = await stored(a.tenant.id)
    expect(after.tenant).toMatchObject({
      email: newEmail,
      passwordHash: a.tenant.passwordHash,
      portalActivated: true,
      portalActivatedAt: a.tenant.portalActivatedAt,
      passwordResetTokenHash: null,
      passwordResetTokenExpiresAt: null,
      activationTokenHash: null,
      activationTokenExpiresAt: null,
    })
    expect(after.sessions).toHaveLength(0)
    expect(result.email).toBe(newEmail)
    for (const key of TENANT_CREDENTIAL_KEYS) expect(result).not.toHaveProperty(key)
    await expect(auth.validateSession(oldA.sessionToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
    await expect(auth.validateSession(secondA.sessionToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
    await expect(auth.resetPassword(a.resetToken, NEW_PASSWORD)).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
    await expect(auth.activate(a.activationToken, NEW_PASSWORD)).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
    expect(await stored(neighbor.tenant.id)).toEqual(neighborBefore)
    expect(await stored(otherOrg.tenant.id)).toEqual(otherBefore)
    await expect(auth.validateSession(neighborSession.sessionToken)).resolves.toMatchObject({
      id: neighbor.tenant.id,
    })
    await expect(auth.validateSession(otherSession.sessionToken)).resolves.toMatchObject({
      id: otherOrg.tenant.id,
    })
    const newSession = await auth.login(newEmail, PASSWORD, a.tenant.organizationId)
    await expect(auth.validateSession(newSession.sessionToken)).resolves.toMatchObject({
      id: a.tenant.id,
    })
  })

  it.each(['samma normaliserade e-post', 'bara telefon'] as const)(
    '%s bevarar båda länkfamiljerna och den aktuella sessionen',
    async (kind) => {
      const f = await fixture()
      const session = await auth.createSessionForTenant(f.tenant.id)
      const before = await stored(f.tenant.id)
      const dto =
        kind === 'bara telefon'
          ? { phone: '0700000000' }
          : { email: ` ${f.tenant.email.toUpperCase()} ` }
      await tenants.update(f.tenant.id, dto, f.tenant.organizationId)
      const after = await stored(f.tenant.id)
      expect(after.sessions).toEqual(before.sessions)
      expect(after.tenant).toMatchObject({
        email: f.tenant.email,
        passwordHash: f.tenant.passwordHash,
        passwordResetTokenHash: f.tenant.passwordResetTokenHash,
        passwordResetTokenExpiresAt: f.tenant.passwordResetTokenExpiresAt,
        activationTokenHash: f.tenant.activationTokenHash,
        activationTokenExpiresAt: f.tenant.activationTokenExpiresAt,
        activationReminderSentAt: f.tenant.activationReminderSentAt,
      })
      if (kind === 'bara telefon') expect(after.tenant.phone).toBe('0700000000')
      await expect(auth.validateSession(session.sessionToken)).resolves.toMatchObject({
        id: f.tenant.id,
      })
    },
  )

  it('fel organisation nekas utan att ändra uppgifter, länkar eller sessioner', async () => {
    const a = await fixture()
    const other = await fixture()
    await auth.createSessionForTenant(a.tenant.id)
    const before = await stored(a.tenant.id)
    const otherBefore = await stored(other.tenant.id)
    await expect(
      tenants.update(
        a.tenant.id,
        { email: `blocked-${randomUUID()}@example.invalid` },
        other.tenant.organizationId,
      ),
    ).rejects.toBeInstanceOf(NotFoundException)
    expect(await stored(a.tenant.id)).toEqual(before)
    expect(await stored(other.tenant.id)).toEqual(otherBefore)
  })

  it('en e-postunikhetskonflikt lämnar även den gamla autentiseringen orörd', async () => {
    const a = await fixture()
    const existing = await fixture({ organizationId: a.tenant.organizationId })
    const session = await auth.createSessionForTenant(a.tenant.id)
    const before = await stored(a.tenant.id)
    const existingBefore = await stored(existing.tenant.id)
    await expect(
      tenants.update(a.tenant.id, { email: existing.tenant.email }, a.tenant.organizationId),
    ).rejects.toMatchObject({ code: 'P2002' })
    expect(await stored(a.tenant.id)).toEqual(before)
    expect(await stored(existing.tenant.id)).toEqual(existingBefore)
    await expect(auth.validateSession(session.sessionToken)).resolves.toMatchObject({
      id: a.tenant.id,
    })
  })

  it('sessionsraderingsfel rullar tillbaka hela e-postbytet och bevarar gamla länkar/sessioner', async () => {
    const f = await fixture()
    const old = await auth.createSessionForTenant(f.tenant.id)
    const second = await auth.createSessionForTenant(f.tenant.id)
    const before = await stored(f.tenant.id)
    const newEmail = `retry-${randomUUID()}@example.invalid`
    let failures = 0
    const broken = db.$extends({
      query: {
        tenantSession: {
          deleteMany: ({ args, query }) => {
            if (args.where?.tenantId === f.tenant.id && failures === 0) {
              failures += 1
              throw new Error('Syntetiskt sessionsraderingsfel')
            }
            return query(args)
          },
        },
      },
    })
    const faultModule = await Test.createTestingModule({
      providers: [
        TenantsService,
        { provide: PrismaService, useValue: broken },
        { provide: PersonalNumberService, useValue: pn },
      ],
    }).compile()
    try {
      const failingService = faultModule.get(TenantsService)
      await expect(
        failingService.update(f.tenant.id, { email: newEmail }, f.tenant.organizationId),
      ).rejects.toThrow('Syntetiskt sessionsraderingsfel')
      expect(failures).toBe(1)
      expect(await stored(f.tenant.id)).toEqual(before)
      await expect(auth.validateSession(old.sessionToken)).resolves.toMatchObject({
        id: f.tenant.id,
      })
      await expect(auth.validateSession(second.sessionToken)).resolves.toMatchObject({
        id: f.tenant.id,
      })
    } finally {
      await faultModule.close()
    }
    await tenants.update(f.tenant.id, { email: newEmail }, f.tenant.organizationId)
    const after = await stored(f.tenant.id)
    expect(after.tenant.email).toBe(newEmail)
    expect(after.tenant.passwordResetTokenHash).toBeNull()
    expect(after.tenant.activationTokenHash).toBeNull()
    expect(after.sessions).toHaveLength(0)
    await expect(auth.validateSession(old.sessionToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
  })

  it.each(['reset', 'activation'] as const)(
    'pausad %s med gammal länk nekas om e-postbytet hinner committa först',
    async (kind) => {
      const f = await fixture()
      const session = await auth.createSessionForTenant(f.tenant.id)
      const reached = deferred()
      const release = deferred()
      mockAfterHash = async () => {
        reached.resolve()
        await release.promise
      }
      const changing =
        kind === 'reset'
          ? auth.resetPassword(f.resetToken, NEW_PASSWORD)
          : auth.activate(f.activationToken, NEW_PASSWORD)
      const outcome = changing.then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      )
      let changed: Awaited<ReturnType<typeof stored>> | undefined
      try {
        await bounded(reached.promise)
        await tenants.update(
          f.tenant.id,
          { email: `new-${randomUUID()}@example.invalid` },
          f.tenant.organizationId,
        )
        changed = await stored(f.tenant.id)
      } finally {
        release.resolve()
        await outcome
      }
      const result = await outcome
      expect(result.status === 'rejected' && result.reason).toBeInstanceOf(UnauthorizedException)
      expect(changed).toBeDefined()
      expect(await stored(f.tenant.id)).toEqual(changed)
      expect(changed!.tenant.passwordHash).toBe(f.tenant.passwordHash)
      expect(changed!.sessions).toHaveLength(0)
      await expect(auth.validateSession(session.sessionToken)).rejects.toBeInstanceOf(
        UnauthorizedException,
      )
    },
  )

  it('e-postbyte efter slutförd reset återkallar även sessionen som reset nyss skapade', async () => {
    const f = await fixture()
    const reset = await auth.resetPassword(f.resetToken, NEW_PASSWORD)
    await expect(auth.validateSession(reset.sessionToken)).resolves.toMatchObject({
      id: f.tenant.id,
    })
    const passwordHash = (await stored(f.tenant.id)).tenant.passwordHash
    await tenants.update(
      f.tenant.id,
      { email: `after-reset-${randomUUID()}@example.invalid` },
      f.tenant.organizationId,
    )
    expect((await stored(f.tenant.id)).tenant.passwordHash).toBe(passwordHash)
    expect((await stored(f.tenant.id)).sessions).toHaveLength(0)
    await expect(auth.validateSession(reset.sessionToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
  })
})
