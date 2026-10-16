/**
 * Lösenordsbyte, engångslänkar och sessionsspärr mot riktig PostgreSQL.
 *
 * Bcrypt är riktig (även produktionskodens 12 rundor). Omslaget nedan kan bara
 * pausa EFTER hash/jämförelse; det ersätter varken resultat, DB-villkor eller lås.
 * Prisma-extensionen i rollbackprovet injicerar ett skrivfel vid sessionsinsert.
 * Inga riktiga mejl, kontrakt, Redis-anslutningar eller kundrader används.
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
      await mockAfterHash?.(password, result)
      return result
    },
    compare: async (password: string, hash: string) => {
      const result = await actual.compare(password, hash)
      await mockAfterCompare?.(password, hash, result)
      return result
    },
  }
})

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
import { TENANT_CREDENTIAL_KEYS } from '../tenants/tenant-credential-keys'
import { TenantAuthService } from './tenant-auth.service'

let mockAfterHash: ((password: string, hash: string) => Promise<void>) | undefined
let mockAfterCompare:
  | ((password: string, hash: string, valid: boolean) => Promise<void>)
  | undefined
const actualBcrypt = jest.requireActual<typeof import('bcryptjs')>('bcryptjs')
const OLD_PASSWORD = 'Gammalt-Syntetiskt-123!'
const NEW_PASSWORD = 'Nytt-Syntetiskt-456!'
const OTHER_PASSWORD = 'Annat-Syntetiskt-789!'
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function bounded(promise: Promise<void>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Racebarriären nåddes inte: ${label}`)), 5000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function pauseAfter(count = 1) {
  const reached = deferred()
  const release = deferred()
  let arrivals = 0
  return {
    reached: reached.promise,
    release: release.resolve,
    wait: async () => {
      arrivals += 1
      if (arrivals === count) reached.resolve()
      await release.promise
    },
    arrivals: () => arrivals,
  }
}

/** Endast Date fryses; PostgreSQL, bcrypt och timeout-barriärer får riktig I/O-tid. */
function freezeDate(now: Date) {
  jest.useFakeTimers({
    doNotFake: [
      'nextTick',
      'queueMicrotask',
      'hrtime',
      'performance',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'setImmediate',
      'clearImmediate',
    ],
  })
  jest.setSystemTime(now)
}

describe('portalens lösenordsåterställning · riktiga DB-race och sessionslivstid', () => {
  let db: PrismaClient
  let service: TenantAuthService
  const modules: TestingModule[] = []
  const orgIds: string[] = []
  const tenantIds: string[] = []

  async function serviceFor(client: unknown) {
    const module = await Test.createTestingModule({
      providers: [
        TenantAuthService,
        { provide: PrismaService, useValue: client },
        { provide: ConfigService, useValue: new ConfigService({}) },
        { provide: MailService, useValue: {} },
        { provide: ContractTemplateService, useValue: {} },
        { provide: LockService, useValue: {} },
        { provide: CronErrorSink, useValue: {} },
      ],
    }).compile()
    modules.push(module)
    return module.get(TenantAuthService)
  }

  async function fixture(organizationId?: string) {
    const suffix = randomUUID()
    let orgId = organizationId
    if (!orgId) {
      const org = await db.organization.create({
        data: {
          name: `Syntetiskt lösenordsprov ${suffix}`,
          email: `${suffix}@example.invalid`,
          street: 'Testgatan 1',
          city: 'Teststad',
          postalCode: '11122',
        },
      })
      orgId = org.id
      orgIds.push(org.id)
    }
    const resetToken = `reset-${randomUUID()}`
    const activationToken = `activation-${randomUUID()}`
    const tenant = await db.tenant.create({
      data: {
        organizationId: orgId,
        type: 'INDIVIDUAL',
        firstName: 'Syntetisk',
        lastName: 'Hyresgäst',
        email: `${suffix}@example.invalid`,
        portalActivated: true,
        portalActivatedAt: new Date(Date.now() - 86_400_000),
        passwordHash: await actualBcrypt.hash(OLD_PASSWORD, 4),
        passwordResetTokenHash: sha256(resetToken),
        passwordResetTokenExpiresAt: new Date(Date.now() + 3_600_000),
        activationTokenHash: sha256(activationToken),
        activationTokenExpiresAt: new Date(Date.now() + 3_600_000),
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
    // Ingen dotenv-loader och ingen automatisk anslutning till utvecklings-/kunddatabas.
    const value = process.env.DATABASE_URL
    if (!value)
      throw new Error('DATABASE_URL till isolerad provdatabas krävs; sviten får inte skippas.')
    const url = new URL(value)
    const local = ['localhost', '127.0.0.1', 'postgres'].includes(url.hostname)
    const testDatabase = url.pathname.endsWith('_test')
    const ciDatabase = process.env.CI === 'true' && url.pathname === '/eken_dev'
    if (!local || !(testDatabase || ciDatabase)) {
      throw new Error('Lösenordsprovet tillåter endast lokal *_test eller CI:s lokala eken_dev.')
    }
    url.searchParams.set('connection_limit', '6')
    db = new PrismaClient({ datasources: { db: { url: url.toString() } } })
    await db.$connect()
    service = await serviceFor(db)
  }, 30_000)

  afterEach(async () => {
    mockAfterHash = undefined
    mockAfterCompare = undefined
    jest.useRealTimers()
    if (!db) return
    // Inga globala deleteMany: endast UUID-rader skapade av den här specen.
    await db.tenantSession.deleteMany({ where: { tenantId: { in: tenantIds } } })
    await db.tenant.deleteMany({ where: { id: { in: tenantIds.splice(0) } } })
    await db.organization.deleteMany({ where: { id: { in: orgIds.splice(0) } } })
  })

  afterAll(async () => {
    for (const module of modules) await module.close()
    if (db) await db.$disconnect()
  })

  it('byter lösenord, förbrukar båda länkarna och ersätter bara den egna hyresgästens sessioner', async () => {
    const a = await fixture()
    const neighbor = await fixture(a.tenant.organizationId)
    const otherOrg = await fixture()
    // Om login hinner committa först måste den sessionen ändå återkallas av reset.
    const oldA = await service.login(a.tenant.email, OLD_PASSWORD, a.tenant.organizationId)
    await expect(service.validateSession(oldA.sessionToken)).resolves.toMatchObject({
      id: a.tenant.id,
    })
    const secondOldA = await service.createSessionForTenant(a.tenant.id)
    const neighborSession = await service.createSessionForTenant(neighbor.tenant.id)
    const otherSession = await service.createSessionForTenant(otherOrg.tenant.id)
    const neighborBefore = await stored(neighbor.tenant.id)
    const otherBefore = await stored(otherOrg.tenant.id)

    const result = await service.resetPassword(a.resetToken, NEW_PASSWORD)
    await expect(service.validateSession(oldA.sessionToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
    await expect(service.validateSession(secondOldA.sessionToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
    await expect(service.validateSession(result.sessionToken)).resolves.toMatchObject({
      id: a.tenant.id,
    })
    await expect(service.validateSession(neighborSession.sessionToken)).resolves.toMatchObject({
      id: neighbor.tenant.id,
    })
    await expect(service.validateSession(otherSession.sessionToken)).resolves.toMatchObject({
      id: otherOrg.tenant.id,
    })
    expect(await stored(neighbor.tenant.id)).toEqual(neighborBefore)
    expect(await stored(otherOrg.tenant.id)).toEqual(otherBefore)

    const after = await stored(a.tenant.id)
    expect(after.sessions).toHaveLength(1)
    expect(after.sessions[0]?.token).toBe(sha256(result.sessionToken))
    expect(after.sessions[0]?.token).not.toBe(result.sessionToken)
    expect(after.tenant).toMatchObject({
      passwordResetTokenHash: null,
      passwordResetTokenExpiresAt: null,
      activationTokenHash: null,
      activationTokenExpiresAt: null,
      portalActivatedAt: a.tenant.portalActivatedAt,
    })
    expect(await actualBcrypt.compare(NEW_PASSWORD, after.tenant.passwordHash!)).toBe(true)
    expect(await actualBcrypt.compare(OLD_PASSWORD, after.tenant.passwordHash!)).toBe(false)
    expect(actualBcrypt.getRounds(after.tenant.passwordHash!)).toBe(12)
    for (const key of TENANT_CREDENTIAL_KEYS) expect(result.tenant).not.toHaveProperty(key)
    await expect(
      service.login(a.tenant.email, OLD_PASSWORD, a.tenant.organizationId),
    ).rejects.toBeInstanceOf(UnauthorizedException)
    const login = await service.login(a.tenant.email, NEW_PASSWORD, a.tenant.organizationId)
    await expect(service.validateSession(login.sessionToken)).resolves.toMatchObject({
      id: a.tenant.id,
    })
  })

  it('två samtidiga anrop med samma återställningstoken har exakt en vinnare', async () => {
    const f = await fixture()
    const pause = pauseAfter(2)
    mockAfterHash = async () => pause.wait()
    const calls = [
      service.resetPassword(f.resetToken, NEW_PASSWORD),
      service.resetPassword(f.resetToken, OTHER_PASSWORD),
    ]
    const outcomes = Promise.allSettled(calls)
    try {
      await bounded(pause.reached, 'båda riktiga lösenordshasharna klara')
      expect(pause.arrivals()).toBe(2)
    } finally {
      pause.release()
    }
    const results = await outcomes
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const failure = results.find((result) => result.status === 'rejected')
    expect(failure?.status === 'rejected' && failure.reason).toBeInstanceOf(UnauthorizedException)
    const index = results.findIndex((result) => result.status === 'fulfilled')
    const winner = results[index]
    if (winner?.status !== 'fulfilled') throw new Error('Ingen vinnande återställning')
    const after = await stored(f.tenant.id)
    expect(after.sessions).toHaveLength(1)
    expect(after.tenant.passwordResetTokenHash).toBeNull()
    expect(
      await actualBcrypt.compare(
        index === 0 ? NEW_PASSWORD : OTHER_PASSWORD,
        after.tenant.passwordHash!,
      ),
    ).toBe(true)
    await expect(service.validateSession(winner.value.sessionToken)).resolves.toMatchObject({
      id: f.tenant.id,
    })
    mockAfterHash = undefined
    await expect(service.resetPassword(f.resetToken, OTHER_PASSWORD)).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
    expect(await stored(f.tenant.id)).toEqual(after)
  })

  it.each([-1, 0])(
    'token med utgångstid now + (%d ms) avvisas utan någon skrivning',
    async (offset) => {
      const now = new Date('2026-10-16T10:00:00.000Z')
      freezeDate(now)
      const f = await fixture()
      await db.tenant.update({
        where: { id: f.tenant.id },
        data: { passwordResetTokenExpiresAt: new Date(now.getTime() + offset) },
      })
      await service.createSessionForTenant(f.tenant.id)
      const before = await stored(f.tenant.id)
      await expect(service.resetPassword(f.resetToken, NEW_PASSWORD)).rejects.toBeInstanceOf(
        UnauthorizedException,
      )
      expect(await stored(f.tenant.id)).toEqual(before)
    },
  )

  it('token måste fortfarande gälla när bcrypt är färdig och lösenordet ska ändras', async () => {
    const now = new Date('2026-10-16T10:00:00.000Z')
    freezeDate(now)
    const f = await fixture()
    await db.tenant.update({
      where: { id: f.tenant.id },
      data: { passwordResetTokenExpiresAt: new Date(now.getTime() + 1000) },
    })
    const before = await stored(f.tenant.id)
    const pause = pauseAfter()
    mockAfterHash = async () => pause.wait()
    const outcome = service.resetPassword(f.resetToken, NEW_PASSWORD).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    )
    try {
      await bounded(pause.reached, 'hash före passerad utgångstid')
      jest.setSystemTime(new Date(now.getTime() + 2000))
    } finally {
      pause.release()
    }
    const result = await outcome
    expect(result.status === 'rejected' && result.reason).toBeInstanceOf(UnauthorizedException)
    expect(await stored(f.tenant.id)).toEqual(before)
  })

  it('ett fel när den nya sessionen skapas återställer lösenord, tokens och alla gamla sessioner', async () => {
    const f = await fixture()
    const old = await service.createSessionForTenant(f.tenant.id)
    const before = await stored(f.tenant.id)
    const failInsert = jest.fn(() => {
      throw new Error('Syntetiskt sessionsinsertfel')
    })
    const broken = db.$extends({ query: { tenantSession: { create: failInsert } } })
    const failingService = await serviceFor(broken)
    await expect(failingService.resetPassword(f.resetToken, NEW_PASSWORD)).rejects.toThrow(
      'Syntetiskt sessionsinsertfel',
    )
    expect(failInsert).toHaveBeenCalledTimes(1)
    expect(await stored(f.tenant.id)).toEqual(before)
    await expect(service.validateSession(old.sessionToken)).resolves.toMatchObject({
      id: f.tenant.id,
    })
    const retry = await service.resetPassword(f.resetToken, NEW_PASSWORD)
    await expect(service.validateSession(retry.sessionToken)).resolves.toMatchObject({
      id: f.tenant.id,
    })
  })

  it('en godkänd gammal bcrypt-jämförelse kan inte skapa en giltig session efter återställningen', async () => {
    const f = await fixture()
    const pause = pauseAfter()
    let comparedValid = false
    mockAfterCompare = async (password, hash, valid) => {
      if (password !== OLD_PASSWORD || hash !== f.tenant.passwordHash) return
      comparedValid = valid
      await pause.wait()
    }
    const pendingLogin = service.login(f.tenant.email, OLD_PASSWORD, f.tenant.organizationId).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    )
    try {
      await bounded(pause.reached, 'verklig godkänd jämförelse med gammalt lösenord')
      expect(comparedValid).toBe(true)
      const reset = await service.resetPassword(f.resetToken, NEW_PASSWORD)
      await expect(service.validateSession(reset.sessionToken)).resolves.toMatchObject({
        id: f.tenant.id,
      })
    } finally {
      pause.release()
    }
    const result = await pendingLogin
    expect(result.status === 'rejected' && result.reason).toBeInstanceOf(UnauthorizedException)
    expect(await db.tenantSession.count({ where: { tenantId: f.tenant.id } })).toBe(1)
  })

  it('en gammal pågående aktivering kan inte återställa sitt lösenord efter lyckad reset', async () => {
    const f = await fixture()
    const pause = pauseAfter()
    mockAfterHash = async (password) => {
      if (password === OTHER_PASSWORD) await pause.wait()
    }
    const activating = service.activate(f.activationToken, OTHER_PASSWORD).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    )
    let resetToken: string | undefined
    try {
      await bounded(pause.reached, 'aktiveringens riktiga hash är klar')
      const reset = await service.resetPassword(f.resetToken, NEW_PASSWORD)
      resetToken = reset.sessionToken
    } finally {
      pause.release()
    }
    const result = await activating
    expect(result.status === 'rejected' && result.reason).toBeInstanceOf(UnauthorizedException)
    const after = await stored(f.tenant.id)
    expect(after.sessions).toHaveLength(1)
    expect(await actualBcrypt.compare(NEW_PASSWORD, after.tenant.passwordHash!)).toBe(true)
    expect(after.tenant.activationTokenHash).toBeNull()
    expect(resetToken).toBeDefined()
    await expect(service.validateSession(resetToken!)).resolves.toMatchObject({ id: f.tenant.id })
  })

  it.each(['reset', 'activation'] as const)(
    'roterad %s-token under bcrypt gör gamla länken ogiltig och bevarar den nya',
    async (kind) => {
      const f = await fixture()
      const oldSession = await service.createSessionForTenant(f.tenant.id)
      const pause = pauseAfter()
      mockAfterHash = async () => pause.wait()
      const change =
        kind === 'reset'
          ? service.resetPassword(f.resetToken, NEW_PASSWORD)
          : service.activate(f.activationToken, NEW_PASSWORD)
      const outcome = change.then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      )
      let rotated: Awaited<ReturnType<typeof stored>> | undefined
      let newToken: string | undefined
      try {
        await bounded(pause.reached, `${kind}: hash klar före tokenrotation`)
        newToken =
          kind === 'reset'
            ? await service.issuePasswordResetToken(f.tenant.id)
            : await service.issueActivationToken(f.tenant.id)
        rotated = await stored(f.tenant.id)
      } finally {
        pause.release()
        await outcome
      }
      const result = await outcome
      expect(result.status === 'rejected' && result.reason).toBeInstanceOf(UnauthorizedException)
      expect(rotated).toBeDefined()
      expect(newToken).toBeDefined()
      const after = await stored(f.tenant.id)
      expect(after).toEqual(rotated)
      expect(
        kind === 'reset' ? after.tenant.passwordResetTokenHash : after.tenant.activationTokenHash,
      ).toBe(sha256(newToken!))
      expect(after.tenant.passwordHash).toBe(f.tenant.passwordHash)
      await expect(service.validateSession(oldSession.sessionToken)).resolves.toMatchObject({
        id: f.tenant.id,
      })
    },
  )

  it('aktivering som vinner över pausad reset återkallar gamla sessioner och behåller ursprunglig aktiveringstid', async () => {
    const f = await fixture()
    const old = await service.login(f.tenant.email, OLD_PASSWORD, f.tenant.organizationId)
    const pause = pauseAfter()
    mockAfterHash = async (password) => {
      if (password === NEW_PASSWORD) await pause.wait()
    }
    const resetting = service.resetPassword(f.resetToken, NEW_PASSWORD).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    )
    let activated: Awaited<ReturnType<TenantAuthService['activate']>> | undefined
    try {
      await bounded(pause.reached, 'reset-hash klar före vinnande aktivering')
      activated = await service.activate(f.activationToken, OTHER_PASSWORD)
    } finally {
      pause.release()
      await resetting
    }
    const result = await resetting
    expect(result.status === 'rejected' && result.reason).toBeInstanceOf(UnauthorizedException)
    expect(activated).toBeDefined()
    const after = await stored(f.tenant.id)
    expect(after.tenant).toMatchObject({
      portalActivated: true,
      portalActivatedAt: f.tenant.portalActivatedAt,
      activationTokenHash: null,
      activationTokenExpiresAt: null,
      passwordResetTokenHash: null,
      passwordResetTokenExpiresAt: null,
    })
    expect(await actualBcrypt.compare(OTHER_PASSWORD, after.tenant.passwordHash!)).toBe(true)
    expect(after.sessions).toHaveLength(1)
    expect(after.sessions[0]?.token).toBe(sha256(activated!.sessionToken))
    for (const key of TENANT_CREDENTIAL_KEYS) expect(activated!.tenant).not.toHaveProperty(key)
    await expect(service.validateSession(old.sessionToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
    await expect(service.validateSession(activated!.sessionToken)).resolves.toMatchObject({
      id: f.tenant.id,
    })
  })

  it('första aktiveringen ger en giltig session och skriver aktiveringstid utan credentials i svaret', async () => {
    const f = await fixture()
    await db.tenant.update({
      where: { id: f.tenant.id },
      data: { portalActivated: false, portalActivatedAt: null, passwordHash: null },
    })
    const startedAt = new Date()
    const result = await service.activate(f.activationToken, NEW_PASSWORD)
    const after = await stored(f.tenant.id)
    expect(after.tenant.portalActivated).toBe(true)
    expect(after.tenant.portalActivatedAt).toBeInstanceOf(Date)
    expect(after.tenant.portalActivatedAt!.getTime()).toBeGreaterThanOrEqual(startedAt.getTime())
    expect(after.tenant.portalActivatedAt!.getTime()).toBeLessThanOrEqual(Date.now())
    expect(after.tenant.activationTokenHash).toBeNull()
    expect(after.tenant.passwordResetTokenHash).toBeNull()
    expect(await actualBcrypt.compare(NEW_PASSWORD, after.tenant.passwordHash!)).toBe(true)
    expect(actualBcrypt.getRounds(after.tenant.passwordHash!)).toBe(12)
    expect(after.sessions).toHaveLength(1)
    for (const key of TENANT_CREDENTIAL_KEYS) expect(result.tenant).not.toHaveProperty(key)
    await expect(service.validateSession(result.sessionToken)).resolves.toMatchObject({
      id: f.tenant.id,
    })
  })

  it('gammalt login nekas när e-postadressen ändras efter lyckad bcrypt-jämförelse', async () => {
    const f = await fixture()
    const pause = pauseAfter()
    let validComparison = false
    mockAfterCompare = async (_password, hash, valid) => {
      if (hash !== f.tenant.passwordHash) return
      validComparison = valid
      await pause.wait()
    }
    const pendingLogin = service.login(f.tenant.email, OLD_PASSWORD, f.tenant.organizationId).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    )
    const newEmail = `changed-${randomUUID()}@example.invalid`
    let changed: Awaited<ReturnType<typeof stored>> | undefined
    try {
      await bounded(pause.reached, 'riktig jämförelse klar före e-postbyte')
      expect(validComparison).toBe(true)
      await db.tenant.update({ where: { id: f.tenant.id }, data: { email: newEmail } })
      changed = await stored(f.tenant.id)
    } finally {
      pause.release()
      await pendingLogin
    }
    const result = await pendingLogin
    expect(result.status === 'rejected' && result.reason).toBeInstanceOf(UnauthorizedException)
    expect(changed).toBeDefined()
    expect(await stored(f.tenant.id)).toEqual(changed)
    expect(changed!.sessions).toHaveLength(0)
    mockAfterCompare = undefined
    const current = await service.login(newEmail, OLD_PASSWORD, f.tenant.organizationId)
    await expect(service.validateSession(current.sessionToken)).resolves.toMatchObject({
      id: f.tenant.id,
      email: newEmail,
    })
  })
})
