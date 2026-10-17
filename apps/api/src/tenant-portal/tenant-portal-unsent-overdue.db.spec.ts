/**
 * Riktig PostgreSQL + Fastify-dispatch + JWT/tenant-session + produktens
 * adminövergång, portallistor och scoped PDF-metod. Endast PDF-renderaren är
 * en lokal bladstub. Inga utskick, köer, Redis, browser eller generering körs.
 * OVERDUE bevisar inte utskick. Seedade status-/sentAt-kombinationer är
 * åtkomstfacit, inte bevis för mejlleverans eller registrerad betalning.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../contracts/contract-template.service', () => ({ ContractTemplateService: class {} }))
jest.mock('../mail/mail.service', () => ({ MailService: class {} }))

import { randomUUID } from 'node:crypto'
import { ValidationPipe } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { PassportModule } from '@nestjs/passport'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { PrismaClient, type RentNoticeStatus } from '@prisma/client'
import { AviseringController } from '../avisering/avisering.controller'
import { AviseringService } from '../avisering/avisering.service'
import { JwtStrategy } from '../auth/strategies/jwt.strategy'
import { VALIDATION_PIPE_OPTIONS } from '../common/contract/validation-pipe-options'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { TransformInterceptor } from '../common/interceptors/transform.interceptor'
import { PrismaService } from '../common/prisma/prisma.service'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { PdfService } from '../invoices/pdf.service'
import { TenantAuthGuard } from './tenant-auth.guard'
import { TenantAuthService } from './tenant-auth.service'
import { TenantPortalController } from './tenant-portal.controller'
import { TenantPortalService } from './tenant-portal.service'

type ConstructorToken = new (...args: never[]) => unknown
type Actor = {
  tenantId: string
  organizationId: string
  email: string
  propertyId: string
  unitId: string
  leaseId: string
}
type Notice = { id: string; number: string }
type Fixture = {
  organizations: Array<{ id: string; name: string }>
  actors: [Actor, Actor]
  otherTenantId: string
  unsent: Notice
  sent: Notice
  foreign: Notice
  token: string
  otherToken: string
  foreignToken: string
  adminToken: string
}

const SENT_AT = new Date('2020-02-25T12:00:00.000Z')
const DUE_DATE = new Date('2020-02-29T12:00:00.000Z')
const PDF_BYTES = Buffer.from('%PDF-1.4\nsynthetic-renderer-boundary-only\n')
const LIST_PATHS = ['/v1/portal/notices', '/v1/portal/rent-notices'] as const

describe('oskickad förfallen avi · adminGET får inte publicera i hyresgästportalen', () => {
  jest.setTimeout(30_000)
  let db: PrismaClient | undefined
  let databaseUrl: string | undefined
  let app: NestFastifyApplication | undefined
  let auth: TenantAuthService
  let fixture: Fixture | undefined
  const forbiddenCalls: string[] = []
  const renderedNoticeIds: string[] = []
  const jwtSecret = `synthetic-unsent-overdue-${randomUUID()}`
  const jwt = new JwtService({ secret: jwtSecret })

  /** Inga verkliga externa klienter konstrueras för dessa oanvända beroenden. */
  function forbidden<T>(label: string): T {
    const lifecycle = new Set([
      'then',
      'onModuleInit',
      'onApplicationBootstrap',
      'onModuleDestroy',
      'beforeApplicationShutdown',
      'onApplicationShutdown',
    ])
    return new Proxy(Object.create(null) as Record<string, unknown>, {
      get: (_target, property) => {
        // Nest frågar efter livscykelmetoder även på ett useValue-blad.
        if (typeof property === 'symbol' || lifecycle.has(property)) return undefined
        if (property === 'constructor') return Object
        forbiddenCalls.push(`${label}.${property}`)
        throw new Error(`Oavsiktligt beroende i avgränsat portalprov: ${label}.${property}`)
      },
    }) as T
  }

  function database(): PrismaClient {
    if (!db) throw new Error('Den isolerade databasen är inte initialiserad')
    return db
  }

  function current(): Fixture {
    if (!fixture) throw new Error('Ägd fixture saknas')
    return fixture
  }

  function http(url: string, token?: string) {
    if (!app) throw new Error('HTTP-riggen är inte initialiserad')
    return app.inject({
      method: 'GET',
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
  }

  async function listIds(path: (typeof LIST_PATHS)[number], token: string) {
    const response = await http(path, token)
    expect(response.statusCode).toBe(200)
    const body = response.json<{ data: Array<{ id: string }> }>()
    expect(Array.isArray(body.data)).toBe(true)
    return body.data.map((row) => row.id).sort()
  }

  const pdfPath = (id: string) => `/v1/portal/rent-notices/${id}/download`

  async function noticeState(id: string) {
    const row = await database().rentNotice.findUniqueOrThrow({
      where: { id },
      select: { id: true, status: true, sentAt: true, sentTo: true, sendError: true },
    })
    const sentEvents = await database().rentNoticeEvent.count({
      where: { rentNoticeId: id, type: 'SENT' },
    })
    const sends = await database().rentNoticeSend.count({ where: { rentNoticeId: id } })
    return { ...row, sentEvents, sends }
  }

  async function foreignSnapshot() {
    return database().rentNotice.findUniqueOrThrow({
      where: { id: current().foreign.id },
      include: { events: true, sends: true, lines: true },
    })
  }

  async function assertGuards() {
    const f = current()
    expect((await http('/v1/avisering')).statusCode).toBe(401)
    for (const path of LIST_PATHS) expect((await http(path)).statusCode).toBe(401)
    expect((await http(pdfPath(f.sent.id))).statusCode).toBe(401)
    // Använd SENT i scopekanarierna: ett PENDING-avslag skulle dölja trasigt scope.
    expect((await http(pdfPath(f.sent.id), f.otherToken)).statusCode).toBe(404)
    expect((await http(pdfPath(f.sent.id), f.foreignToken)).statusCode).toBe(404)
    expect((await http(pdfPath(f.foreign.id), f.token)).statusCode).toBe(404)
    for (const path of LIST_PATHS) {
      expect(await listIds(path, f.otherToken)).toEqual([])
      expect(await listIds(path, f.foreignToken)).toEqual([f.foreign.id])
    }
    expect(renderedNoticeIds).toEqual([])
    expect(forbiddenCalls).toEqual([])
  }

  async function adminReadAndAssertTransition() {
    const f = current()
    const response = await http('/v1/avisering', f.adminToken)
    expect(response.statusCode).toBe(200)
    const rows = response.json<{ data: Array<{ id: string; status: string }> }>().data
    expect(rows.map((row) => row.id).sort()).toEqual([f.unsent.id, f.sent.id].sort())
    expect(rows.every((row) => row.status === 'OVERDUE')).toBe(true)
    expect(await noticeState(f.unsent.id)).toEqual({
      id: f.unsent.id,
      status: 'OVERDUE',
      sentAt: null,
      sentTo: null,
      sendError: null,
      sentEvents: 0,
      sends: 0,
    })
    expect(await noticeState(f.sent.id)).toEqual({
      id: f.sent.id,
      status: 'OVERDUE',
      sentAt: SENT_AT,
      sentTo: f.actors[0].email,
      sendError: null,
      sentEvents: 1,
      sends: 0,
    })
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error('Explicit DATABASE_URL krävs; ingen env-fil eller skip används')
    }
    const url = new URL(process.env.DATABASE_URL)
    const allowedQuery = new Set(['schema', 'connection_limit', 'pool_timeout'])
    const localDatabase =
      ['127.0.0.1', 'localhost'].includes(url.hostname) &&
      url.port === '56432' &&
      /^\/[A-Za-z0-9_]+_test$/.test(url.pathname)
    const ciDatabase =
      process.env.CI === 'true' &&
      ['127.0.0.1', 'localhost', 'postgres'].includes(url.hostname) &&
      ['', '5432'].includes(url.port) &&
      url.pathname === '/eken_dev'
    if (
      url.protocol !== 'postgresql:' ||
      (!localDatabase && !ciDatabase) ||
      [...url.searchParams.keys()].some((key) => !allowedQuery.has(key)) ||
      (url.searchParams.has('schema') && url.searchParams.get('schema') !== 'public') ||
      process.env.DEV_TENANT_BYPASS_SECRET
    ) {
      throw new Error('Kräver isolerad lokal eller uttrycklig CI-databas utan tenant-dev-bypass')
    }
    url.searchParams.set('connection_limit', '4')
    databaseUrl = url.toString()
    db = new PrismaClient({
      datasources: { db: { url: databaseUrl } },
      transactionOptions: PRISMA_DEFAULT_TX_LIMITS,
    })
    await db.$connect()
    expect(Date.now()).toBeGreaterThan(new Date('2020-03-03T12:00:00Z').getTime())

    const prisma = db as unknown as PrismaService
    const renderer = {
      generateFromHtml: async (html: string): Promise<Buffer> => {
        const f = current()
        const matches = [f.unsent, f.sent, f.foreign].filter((notice) =>
          html.includes(notice.number),
        )
        expect(matches).toHaveLength(1)
        renderedNoticeIds.push(matches[0]!.id)
        return PDF_BYTES
      },
    } satisfies Pick<PdfService, 'generateFromHtml'>
    const avisering = new AviseringService(
      prisma,
      forbidden('ocr'),
      forbidden('mail'),
      renderer as PdfService,
      forbidden('storage'),
      forbidden('pdfQueue'),
      forbidden('accounting'),
      forbidden('consumption'),
      forbidden('miscCharges'),
      forbidden('deposits'),
      forbidden('rentNoticeEvents'),
    )
    const portal = new TenantPortalService(
      prisma,
      forbidden('personalNumber'),
      forbidden('maintenance'),
      forbidden('notifications'),
      forbidden('inspections'),
      forbidden('imageIntegrity'),
      forbidden('portalStorage'),
    )
    auth = new TenantAuthService(
      prisma,
      forbidden('authMail'),
      new ConfigService({ JWT_SECRET: jwtSecret }),
      forbidden('contracts'),
      forbidden('locks'),
      forbidden('cronErrors'),
      forbidden('loginBudget'),
    )
    const controllers = [AviseringController, TenantPortalController]
    const values = new Map<unknown, unknown>([
      [AviseringService, avisering],
      [TenantPortalService, portal],
      [PrismaService, prisma],
      [PdfService, renderer],
    ])
    const dependencies = new Set(
      controllers.flatMap(
        (controller) => Reflect.getMetadata('design:paramtypes', controller) as ConstructorToken[],
      ),
    )
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers,
      providers: [
        ...[...dependencies].map((provide) => ({
          provide,
          useValue: values.has(provide) ? values.get(provide) : forbidden(provide.name),
        })),
        { provide: TenantAuthService, useValue: auth },
        TenantAuthGuard,
        JwtStrategy,
        { provide: ConfigService, useValue: new ConfigService({ JWT_SECRET: jwtSecret }) },
      ],
    }).compile()
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    app.setGlobalPrefix('v1')
    app.useGlobalGuards(new JwtAuthGuard(new Reflector()), new RolesGuard(new Reflector()))
    app.useGlobalInterceptors(new TransformInterceptor())
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS))
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  beforeEach(async () => {
    forbiddenCalls.length = 0
    renderedNoticeIds.length = 0
    const organizations = ['own', 'foreign'].map((label) => {
      const id = randomUUID()
      return { id, name: `portal-unsent-${label}-${id}` }
    })
    const actor = (organizationId: string): Actor => {
      const tenantId = randomUUID()
      return {
        tenantId,
        organizationId,
        email: `${tenantId}@example.invalid`,
        propertyId: randomUUID(),
        unitId: randomUUID(),
        leaseId: randomUUID(),
      }
    }
    const notice = (label: string): Notice => {
      const id = randomUUID()
      return { id, number: `UNSENT-${label}-${id}` }
    }
    // Ägarskapet finns före första INSERT, även om setup skulle avbrytas.
    fixture = {
      organizations,
      actors: [actor(organizations[0]!.id), actor(organizations[1]!.id)],
      otherTenantId: randomUUID(),
      unsent: notice('U'),
      sent: notice('S'),
      foreign: notice('F'),
      token: '',
      otherToken: '',
      foreignToken: '',
      adminToken: '',
    }
    const f = current()
    for (const organization of organizations) {
      await database().organization.create({
        data: {
          ...organization,
          email: `${organization.id}@example.invalid`,
          street: 'Testgatan 1',
          city: 'Teststad',
          postalCode: '11111',
          bankgiro: null,
          logoStorageKey: null,
        },
      })
    }
    for (const a of f.actors) {
      await database().tenant.create({
        data: {
          id: a.tenantId,
          organizationId: a.organizationId,
          type: 'INDIVIDUAL',
          email: a.email,
          firstName: 'Syntetisk',
          lastName: 'Portalperson',
        },
      })
      await database().property.create({
        data: {
          id: a.propertyId,
          organizationId: a.organizationId,
          name: `Syntetisk ${a.propertyId}`,
          propertyDesignation: a.propertyId,
          type: 'RESIDENTIAL',
          street: 'Testgatan 1',
          city: 'Teststad',
          postalCode: '11111',
          totalArea: 50,
        },
      })
      await database().unit.create({
        data: {
          id: a.unitId,
          propertyId: a.propertyId,
          name: 'Syntetisk bostad',
          unitNumber: '1001',
          type: 'APARTMENT',
          area: 50,
          monthlyRent: 7500,
        },
      })
      await database().lease.create({
        data: {
          id: a.leaseId,
          organizationId: a.organizationId,
          tenantId: a.tenantId,
          unitId: a.unitId,
          contractNumber: a.leaseId,
          status: 'ACTIVE',
          startDate: new Date('2020-01-01'),
          tenancyStartDate: new Date('2020-01-01'),
          monthlyRent: 7500,
          depositAmount: 0,
        },
      })
    }
    await database().tenant.create({
      data: {
        id: f.otherTenantId,
        organizationId: f.actors[0].organizationId,
        type: 'INDIVIDUAL',
        email: `${f.otherTenantId}@example.invalid`,
      },
    })
    for (const [n, a, month, sent] of [
      [f.unsent, f.actors[0], 1, false],
      [f.sent, f.actors[0], 2, true],
      [f.foreign, f.actors[1], 2, true],
    ] as const) {
      await database().rentNotice.create({
        data: {
          id: n.id,
          organizationId: a.organizationId,
          tenantId: a.tenantId,
          leaseId: a.leaseId,
          noticeNumber: n.number,
          ocrNumber: `synthetic-${n.id}`,
          year: 2020,
          month,
          amount: 7500,
          totalAmount: 7500,
          dueDate: DUE_DATE,
          status: sent ? 'SENT' : 'PENDING',
          sentAt: sent ? SENT_AT : null,
          sentTo: sent ? a.email : null,
        },
      })
      if (sent) {
        // Avsiktligt historiskt tillstånd. Ingen mail/provider har anropats.
        await database().rentNoticeEvent.create({
          data: {
            rentNoticeId: n.id,
            type: 'SENT',
            actorType: 'SYSTEM',
            actorLabel: 'synthetic historical fixture',
            payload: { fixture: true },
            createdAt: SENT_AT,
          },
        })
      }
    }
    f.token = (await auth.createSessionForTenant(f.actors[0].tenantId)).sessionToken
    f.otherToken = (await auth.createSessionForTenant(f.otherTenantId)).sessionToken
    f.foreignToken = (await auth.createSessionForTenant(f.actors[1].tenantId)).sessionToken
    f.adminToken = jwt.sign({
      sub: `synthetic-admin-${randomUUID()}`,
      organizationId: f.actors[0].organizationId,
      role: 'VIEWER',
    })
  })

  it('båda portallistorna döljer den oskickade avin även efter upprepad adminGET', async () => {
    const f = current()
    await assertGuards()
    const foreignBefore = await foreignSnapshot()
    expect((await noticeState(f.unsent.id)).status).toBe('PENDING')
    expect((await noticeState(f.sent.id)).status).toBe('SENT')
    for (const path of LIST_PATHS) expect(await listIds(path, f.token)).toEqual([f.sent.id])

    await adminReadAndAssertTransition()
    const first = await Promise.all(LIST_PATHS.map((path) => listIds(path, f.token)))
    await adminReadAndAssertTransition()
    const repeated = await Promise.all(LIST_PATHS.map((path) => listIds(path, f.token)))
    expect(await foreignSnapshot()).toEqual(foreignBefore)
    for (const path of LIST_PATHS) {
      expect(await listIds(path, f.otherToken)).toEqual([])
      expect(await listIds(path, f.foreignToken)).toEqual([f.foreign.id])
    }
    expect(renderedNoticeIds).toEqual([])
    expect(forbiddenCalls).toEqual([])
    // Samla BÅDA faktiska svaren före assertion så första röda listan inte gömmer den andra.
    expect({ first, repeated }).toEqual({
      first: [[f.sent.id], [f.sent.id]],
      repeated: [[f.sent.id], [f.sent.id]],
    })
  })

  it('PDF-grinden döljer oskickat OVERDUE men tillåter den skickade kontrollavin', async () => {
    const f = current()
    await assertGuards()
    const foreignBefore = await foreignSnapshot()
    expect((await http(pdfPath(f.unsent.id), f.token)).statusCode).toBe(404)
    expect(renderedNoticeIds).toEqual([])
    const before = await http(pdfPath(f.sent.id), f.token)
    expect(before.statusCode).toBe(200)
    expect(before.headers['content-type']).toContain('application/pdf')
    expect(before.rawPayload).toEqual(PDF_BYTES)
    expect(renderedNoticeIds).toEqual([f.sent.id])

    await adminReadAndAssertTransition()
    const firstUnsent = await http(pdfPath(f.unsent.id), f.token)
    const firstSent = await http(pdfPath(f.sent.id), f.token)
    await adminReadAndAssertTransition()
    const repeatedUnsent = await http(pdfPath(f.unsent.id), f.token)
    const repeatedSent = await http(pdfPath(f.sent.id), f.token)
    expect(firstSent.statusCode).toBe(200)
    expect(repeatedSent.statusCode).toBe(200)
    expect(firstSent.rawPayload).toEqual(PDF_BYTES)
    expect(repeatedSent.rawPayload).toEqual(PDF_BYTES)
    expect((await http(pdfPath(f.sent.id), f.otherToken)).statusCode).toBe(404)
    expect((await http(pdfPath(f.sent.id), f.foreignToken)).statusCode).toBe(404)
    expect((await http(pdfPath(f.foreign.id), f.token)).statusCode).toBe(404)
    expect(await foreignSnapshot()).toEqual(foreignBefore)
    expect(await noticeState(f.unsent.id)).toMatchObject({ sentAt: null, sentEvents: 0, sends: 0 })
    expect(forbiddenCalls).toEqual([])
    expect({
      unsentStatus: [firstUnsent.statusCode, repeatedUnsent.statusCode],
      renderedNoticeIds,
    }).toEqual({
      unsentStatus: [404, 404],
      renderedNoticeIds: [f.sent.id, f.sent.id, f.sent.id],
    })
  })

  // Fristående bokstavligt facit för alla enumstatusar; ingen produktregel importeras.
  // SENT/null och PAID/null bevarar den befintliga portalvisningen. SENT/null är
  // inte bevisat skickat, men här ändras endast oskickat OVERDUE och PDF-allowlisten.
  it.each<{ status: RentNoticeStatus; hasSentAt: boolean; visible: boolean }>([
    { status: 'PENDING', hasSentAt: false, visible: false },
    { status: 'PENDING', hasSentAt: true, visible: false },
    { status: 'SENT', hasSentAt: false, visible: true },
    { status: 'SENT', hasSentAt: true, visible: true },
    { status: 'PAID', hasSentAt: false, visible: true },
    { status: 'PAID', hasSentAt: true, visible: true },
    { status: 'OVERDUE', hasSentAt: false, visible: false },
    { status: 'OVERDUE', hasSentAt: true, visible: true },
    { status: 'CANCELLED', hasSentAt: false, visible: false },
    { status: 'CANCELLED', hasSentAt: true, visible: false },
    { status: 'FAILED', hasSentAt: false, visible: false },
    { status: 'FAILED', hasSentAt: true, visible: false },
    { status: 'OPENING', hasSentAt: false, visible: false },
    { status: 'OPENING', hasSentAt: true, visible: false },
  ])(
    'samma list-/PDF-policy för $status med sentAt=$hasSentAt',
    async ({ status, hasSentAt, visible }) => {
      const f = current()
      await database().rentNotice.update({
        where: { id: f.unsent.id },
        data: { status, sentAt: hasSentAt ? SENT_AT : null },
      })
      const expected = (visible ? [f.unsent.id, f.sent.id] : [f.sent.id]).sort()
      for (const path of LIST_PATHS) expect(await listIds(path, f.token)).toEqual(expected)
      const result = await http(pdfPath(f.unsent.id), f.token)
      expect(result.statusCode).toBe(visible ? 200 : 404)
      if (visible) expect(result.rawPayload).toEqual(PDF_BYTES)
      expect(renderedNoticeIds).toEqual(visible ? [f.unsent.id] : [])
      // Ett dolt måltillstånd får inte ge grönt bara för att hela PDF-vägen är trasig.
      expect((await http(pdfPath(f.sent.id), f.token)).statusCode).toBe(200)
      expect(renderedNoticeIds).toEqual(visible ? [f.unsent.id, f.sent.id] : [f.sent.id])
      expect((await http(pdfPath(f.unsent.id), f.otherToken)).statusCode).toBe(404)
      expect((await http(pdfPath(f.unsent.id), f.foreignToken)).statusCode).toBe(404)
      expect(forbiddenCalls).toEqual([])
    },
  )

  afterEach(async () => {
    const f = fixture
    if (!f || !databaseUrl) return // setup-fel före ägarskap har inte skapat DB-rader
    const observer = new PrismaClient({
      datasources: { db: { url: databaseUrl } },
      transactionOptions: PRISMA_DEFAULT_TX_LIMITS,
    })
    const organizationIds = f.organizations.map((org) => org.id)
    const tenantIds = [...f.actors.map((a) => a.tenantId), f.otherTenantId]
    const noticeIds = [f.unsent.id, f.sent.id, f.foreign.id]
    try {
      const owned = await observer.organization.findMany({
        where: { id: { in: organizationIds } },
        select: { id: true, name: true },
      })
      for (const org of owned) expect(f.organizations).toContainEqual(org)
      await observer.rentNoticeEvent.deleteMany({ where: { rentNoticeId: { in: noticeIds } } })
      await observer.rentNoticeSend.deleteMany({ where: { rentNoticeId: { in: noticeIds } } })
      await observer.rentNoticeLine.deleteMany({ where: { rentNoticeId: { in: noticeIds } } })
      await observer.rentNotice.deleteMany({ where: { organizationId: { in: organizationIds } } })
      await observer.tenantSession.deleteMany({ where: { tenantId: { in: tenantIds } } })
      await observer.lease.deleteMany({ where: { organizationId: { in: organizationIds } } })
      await observer.unit.deleteMany({ where: { id: { in: f.actors.map((a) => a.unitId) } } })
      await observer.property.deleteMany({ where: { organizationId: { in: organizationIds } } })
      await observer.tenant.deleteMany({ where: { organizationId: { in: organizationIds } } })
      await observer.organization.deleteMany({ where: { id: { in: organizationIds } } })
      expect({
        organizations: await observer.organization.count({
          where: { id: { in: organizationIds } },
        }),
        tenants: await observer.tenant.count({ where: { id: { in: tenantIds } } }),
        sessions: await observer.tenantSession.count({ where: { tenantId: { in: tenantIds } } }),
        properties: await observer.property.count({
          where: { organizationId: { in: organizationIds } },
        }),
        units: await observer.unit.count({ where: { id: { in: f.actors.map((a) => a.unitId) } } }),
        leases: await observer.lease.count({ where: { organizationId: { in: organizationIds } } }),
        notices: await observer.rentNotice.count({
          where: { organizationId: { in: organizationIds } },
        }),
        lines: await observer.rentNoticeLine.count({ where: { rentNoticeId: { in: noticeIds } } }),
        events: await observer.rentNoticeEvent.count({
          where: { rentNoticeId: { in: noticeIds } },
        }),
        sends: await observer.rentNoticeSend.count({ where: { rentNoticeId: { in: noticeIds } } }),
      }).toEqual({
        organizations: 0,
        tenants: 0,
        sessions: 0,
        properties: 0,
        units: 0,
        leases: 0,
        notices: 0,
        lines: 0,
        events: 0,
        sends: 0,
      })
    } finally {
      await observer.$disconnect()
      fixture = undefined
    }
    expect(forbiddenCalls).toEqual([])
  })

  afterAll(async () => {
    try {
      await app?.close()
    } finally {
      await db?.$disconnect()
    }
  })
})
