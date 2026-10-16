/**
 * Lösenordslogin och kontoval med samma e-post hos flera hyresvärdar.
 * Riktig PostgreSQL, bcrypt och sessionsskrivning; inga HTTP-routes eller mejl.
 * Ordningstesten ändrar bara ORDER BY över verkliga rader. De ersätter varken
 * WHERE, resultat, lösenordsjämförelse eller transaktion med en attrapp.
 */
jest.mock('../contracts/contract-template.service', () => ({ ContractTemplateService: class {} }))
jest.mock('../mail/mail.service', () => ({ MailService: class {} }))

import { createHash, randomUUID } from 'node:crypto'
import * as bcrypt from 'bcryptjs'
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
import { TenantLoginBudget } from './tenant-login-budget.service'

const PASSWORD_A = 'Syntetisk-Vard-A-123!'
const PASSWORD_B = 'Syntetisk-Vard-B-456!'
const GENERIC_ERROR = 'Felaktig e-post eller lösenord'
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

function outcome<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  )
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Inloggningsprovet nådde inte DB-barriären')),
          5000,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function expectGenericError(reason: unknown) {
  expect(reason).toBeInstanceOf(UnauthorizedException)
  if (!(reason instanceof UnauthorizedException)) throw reason
  expect(reason.getResponse()).toEqual({
    statusCode: 401,
    message: GENERIC_ERROR,
    error: 'Unauthorized',
  })
}

describe('lösenordslogin · flera hyresvärdskonton i riktig PostgreSQL', () => {
  let db: PrismaClient
  let service: TenantAuthService
  const modules: TestingModule[] = []
  const orgIds: string[] = []
  const tenantIds: string[] = []

  async function serviceFor(client: unknown) {
    const module = await Test.createTestingModule({
      providers: [
        TenantAuthService,
        {
          provide: TenantLoginBudget,
          // Domänprov; den verkliga Redis-budgeten provas i separat svit.
          useValue: {
            run: async (_context, work) =>
              work({ reserve: async () => {}, assertActive: () => {} }),
          } satisfies Pick<TenantLoginBudget, 'run'>,
        },
        { provide: PrismaService, useValue: client },
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: MailService, useValue: {} },
        { provide: ContractTemplateService, useValue: {} },
        { provide: LockService, useValue: {} },
        { provide: CronErrorSink, useValue: {} },
      ],
    }).compile()
    modules.push(module)
    return module.get(TenantAuthService)
  }

  async function fixture(email: string, password: string, active = true) {
    const suffix = randomUUID()
    const organization = await db.organization.create({
      data: {
        name: `Syntetisk kontovärd ${suffix}`,
        email: `${suffix}@example.invalid`,
        street: 'Testgatan 1',
        city: 'Teststad',
        postalCode: '11122',
      },
    })
    orgIds.push(organization.id)
    const tenant = await db.tenant.create({
      data: {
        organizationId: organization.id,
        email,
        type: 'INDIVIDUAL',
        firstName: 'Syntetisk',
        lastName: 'Hyresgäst',
        portalActivated: active,
        portalActivatedAt: active ? new Date(Date.now() - 86_400_000) : null,
        passwordHash: await bcrypt.hash(password, 4),
      },
    })
    tenantIds.push(tenant.id)
    return tenant
  }

  /**
   * Vi observerar DB:s egen sortering och väljer sedan asc/desc så att den
   * angivna verkliga raden kommer först. Insertionordning/physical order antas
   * aldrig. Båda operationerna stöds så en korrekt senare listläsning kan
   * prövas med samma data; nya produktionsfilter (t.ex. aktivt konto) bevaras.
   */
  async function orderedService(email: string, firstTenantId: string) {
    const existing = await db.tenant.findMany({
      where: { email },
      select: { id: true },
      orderBy: { id: 'asc' },
    })
    expect(existing).toHaveLength(2)
    expect(existing.map((row) => row.id)).toContain(firstTenantId)
    const direction = existing[0]?.id === firstTenantId ? 'asc' : 'desc'
    const ordered = direction === 'asc' ? existing : [...existing].reverse()
    expect(ordered[0]?.id).toBe(firstTenantId)
    const observed: Array<{ operation: 'findFirst' | 'findMany'; ids: string[] }> = []
    const client = db.$extends({
      query: {
        tenant: {
          findFirst: async ({ args, query }) => {
            if (args.where?.email !== email) return query(args)
            const row = await query({ ...args, orderBy: { id: direction } })
            const ids: string[] = []
            if (row) {
              if (typeof row.id !== 'string') throw new Error('Kandidatläsningen saknar id')
              ids.push(row.id)
            }
            observed.push({ operation: 'findFirst', ids })
            return row
          },
          findMany: async ({ args, query }) => {
            if (args.where?.email !== email) return query(args)
            const rows = await query({ ...args, orderBy: { id: direction } })
            const ids = rows.map((row) => {
              if (typeof row.id !== 'string') throw new Error('Kandidatläsningen saknar id')
              return row.id
            })
            observed.push({ operation: 'findMany', ids })
            return rows
          },
        },
      },
    })
    return { service: await serviceFor(client), observed }
  }

  async function expectOnlySession(
    session: Awaited<ReturnType<TenantAuthService['login']>>,
    tenant: { id: string; organizationId: string },
  ) {
    expect(session.tenant).toMatchObject({
      id: tenant.id,
      organizationId: tenant.organizationId,
      organization: { id: tenant.organizationId },
    })
    const sessions = await db.tenantSession.findMany({
      where: { tenantId: { in: tenantIds } },
      select: { tenantId: true, token: true, expiresAt: true },
    })
    expect(sessions).toEqual([
      {
        tenantId: tenant.id,
        token: sha256(session.sessionToken),
        expiresAt: session.expiresAt,
      },
    ])
    await expect(service.validateSession(session.sessionToken)).resolves.toMatchObject({
      id: tenant.id,
      organizationId: tenant.organizationId,
    })
  }

  async function expectGenericDenied<T>(promise: Promise<T>) {
    const result = await outcome(promise)
    // Kontrollera även sessionstabellen när dagens login felaktigt lyckas.
    expect(await db.tenantSession.count({ where: { tenantId: { in: tenantIds } } })).toBe(0)
    expect(result.status).toBe('rejected')
    if (result.status !== 'rejected') throw new Error('Inloggningen skulle ha nekats')
    expectGenericError(result.reason)
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
    service = await serviceFor(db)
  }, 30_000)

  afterEach(async () => {
    if (!db) return
    await db.tenantSession.deleteMany({ where: { tenantId: { in: tenantIds } } })
    await db.tenant.deleteMany({ where: { id: { in: tenantIds } } })
    await db.organization.deleteMany({ where: { id: { in: orgIds } } })
    tenantIds.length = 0
    orgIds.length = 0
  })

  afterAll(async () => {
    for (const module of modules) await module.close()
    if (db) await db.$disconnect()
  })

  it.each(['rätt konto skapas först', 'rätt konto skapas sist'] as const)(
    '%s: ett annat aktivt kontos lösenord får inte skugga rätt konto',
    async (insertion) => {
      const email = `shared-${randomUUID()}@example.invalid`
      const created =
        insertion === 'rätt konto skapas först'
          ? [await fixture(email, PASSWORD_A), await fixture(email, PASSWORD_B)]
          : [await fixture(email, PASSWORD_B), await fixture(email, PASSWORD_A)]
      const target = created[insertion === 'rätt konto skapas först' ? 0 : 1]!
      const shadow = created[insertion === 'rätt konto skapas först' ? 1 : 0]!
      const ordered = await orderedService(email, shadow.id)
      const result = await outcome(ordered.service.login(`  ${email.toUpperCase()}  `, PASSWORD_A))
      expect(ordered.observed.length).toBeGreaterThan(0)
      expect(ordered.observed[0]?.ids[0]).toBe(shadow.id)
      if (result.status === 'rejected') throw result.reason
      await expectOnlySession(result.value, target)
    },
  )

  it('oaktiverad första träff får inte skugga ett aktivt konto hos annan hyresvärd', async () => {
    const email = `shared-${randomUUID()}@example.invalid`
    const inactive = await fixture(email, PASSWORD_A, false)
    const active = await fixture(email, PASSWORD_A)
    const ordered = await orderedService(email, inactive.id)
    const result = await outcome(ordered.service.login(email, PASSWORD_A))
    expect(ordered.observed.length).toBeGreaterThan(0)
    // Ett framtida aktivfilter får legitimt sortera bort den inaktiva raden.
    // Dagens findFirst saknar filtret och måste däremot ha träffat den på riktigt.
    const legacy = ordered.observed.find((read) => read.operation === 'findFirst')
    if (legacy) expect(legacy.ids[0]).toBe(inactive.id)
    if (result.status === 'rejected') throw result.reason
    await expectOnlySession(result.value, active)
  })

  it('två aktiva konton med samma lösenord kräver kontoval: legacylogin nekar generiskt utan session', async () => {
    const email = `shared-${randomUUID()}@example.invalid`
    await fixture(email, PASSWORD_A)
    await fixture(email, PASSWORD_A)
    await expectGenericDenied(service.login(`  ${email.toUpperCase()}  `, PASSWORD_A))
  })

  it.each(['A', 'B'] as const)(
    'explicit organisation %s loggar in endast sitt korrekta konto',
    async (choice) => {
      const email = `shared-${randomUUID()}@example.invalid`
      const a = await fixture(email, PASSWORD_A)
      const b = await fixture(email, PASSWORD_B)
      const target = choice === 'A' ? a : b
      const password = choice === 'A' ? PASSWORD_A : PASSWORD_B
      const result = await service.login(
        `  ${email.toUpperCase()}  `,
        password,
        target.organizationId,
      )
      await expectOnlySession(result, target)
    },
  )

  it('lösenordet hos A gäller inte med explicit organisation B och ger ingen cross-org-session', async () => {
    const email = `shared-${randomUUID()}@example.invalid`
    await fixture(email, PASSWORD_A)
    const b = await fixture(email, PASSWORD_B)
    await expectGenericDenied(service.login(email, PASSWORD_A, b.organizationId))
  })

  it('ett lösenord som inte gäller hos någon hyresvärd ger samma generiska fel utan session', async () => {
    const email = `shared-${randomUUID()}@example.invalid`
    await fixture(email, PASSWORD_A)
    await fixture(email, PASSWORD_B)
    await expectGenericDenied(service.login(email, 'Felaktigt-Syntetiskt-789!'))
  })

  it('kontoval visar exakt de två aktiva lösenordsträffarna och skapar ingen session', async () => {
    const email = `choice-${randomUUID()}@example.invalid`
    const a = await fixture(email, PASSWORD_A)
    const b = await fixture(email, PASSWORD_A)
    await fixture(email, PASSWORD_B)
    await fixture(email, PASSWORD_A, false)
    const anonymized = await fixture(email, PASSWORD_A)
    await db.tenant.update({
      where: { id: anonymized.id },
      data: { anonymizedAt: new Date() },
    })
    const expectedOrganizations = await db.organization.findMany({
      where: { id: { in: [a.organizationId, b.organizationId] } },
      select: { id: true, name: true },
    })

    const result = await service.resolveLogin(`  ${email.toUpperCase()}  `, PASSWORD_A)

    expect(result).toEqual({
      status: 'choose',
      candidates: expect.arrayContaining(
        expectedOrganizations.map((org) => ({
          organizationId: org.id,
          organizationName: org.name,
        })),
      ),
    })
    if (result.status !== 'choose') throw new Error('Två giltiga konton kräver ett val')
    expect(result.candidates).toHaveLength(2)
    expect(await db.tenantSession.count({ where: { tenantId: { in: tenantIds } } })).toBe(0)
  })

  it('en enda lösenordsträff ger en session för rätt organisation direkt', async () => {
    const email = `choice-${randomUUID()}@example.invalid`
    const target = await fixture(email, PASSWORD_A)
    await fixture(email, PASSWORD_B)

    const result = await service.resolveLogin(email, PASSWORD_A)

    expect(result.status).toBe('complete')
    if (result.status !== 'complete') throw new Error('En träff ska skapa rätt session')
    await expectOnlySession(result.result, target)
  })

  it('ett uttryckligt val efter två träffar skapar session endast hos den valda hyresvärden', async () => {
    const email = `choice-${randomUUID()}@example.invalid`
    await fixture(email, PASSWORD_A)
    const target = await fixture(email, PASSWORD_A)
    const choice = await service.resolveLogin(email, PASSWORD_A)
    expect(choice.status).toBe('choose')
    expect(await db.tenantSession.count({ where: { tenantId: { in: tenantIds } } })).toBe(0)

    const result = await service.resolveLogin(email, PASSWORD_A, target.organizationId)

    expect(result.status).toBe('complete')
    if (result.status !== 'complete') throw new Error('Det giltiga valet ska skapa session')
    await expectOnlySession(result.result, target)
  })

  it('en manipulerad organisationsreferens ersätter inte lösenordsbeviset', async () => {
    const email = `choice-${randomUUID()}@example.invalid`
    await fixture(email, PASSWORD_A)
    const other = await fixture(email, PASSWORD_B)

    await expectGenericDenied(service.resolveLogin(email, PASSWORD_A, other.organizationId))
  })

  it('verklig lösenordsreset efter kandidatlistningen hindrar en session med det gamla lösenordet', async () => {
    const email = `choice-race-${randomUUID()}@example.invalid`
    const tenant = await fixture(email, PASSWORD_A)
    const token = await service.issuePasswordResetToken(tenant.id)
    const read = deferred()
    const release = deferred()
    let observedIds: string[] = []
    let stopped = false
    const client = db.$extends({
      query: {
        tenant: {
          findMany: async ({ args, query }) => {
            const rows = await query(args)
            if (args.where?.email === email && !stopped) {
              stopped = true
              observedIds = rows.map((row) => {
                if (typeof row.id !== 'string') throw new Error('Kandidatläsningen saknar id')
                return row.id
              })
              read.resolve()
              await bounded(release.promise)
            }
            return rows
          },
        },
      },
    })
    const paused = await serviceFor(client)
    const pending = outcome(paused.resolveLogin(email, PASSWORD_A))
    let resetSession: Awaited<ReturnType<TenantAuthService['resetPassword']>> | undefined
    try {
      await bounded(read.promise)
      expect(observedIds).toEqual([tenant.id])
      resetSession = await service.resetPassword(token, PASSWORD_B)
    } finally {
      release.resolve()
      await bounded(pending)
    }

    const result = await pending
    expect(result.status).toBe('rejected')
    if (result.status !== 'rejected') throw new Error('Det gamla lösenordet skulle ha nekats')
    expectGenericError(result.reason)
    if (!resetSession) throw new Error('Den riktiga lösenordsåterställningen slutfördes inte')
    // Resetens enda nya session består; den pausade lösenordsträffen skapade ingen.
    await expectOnlySession(resetSession, tenant)
  })
})
