/**
 * Litet syntetiskt integrationsprov: riktig HTTP/JWT/tenantsession/PostgreSQL,
 * preview/generate med AccountingService, lokal kö/mailacceptans, faktisk
 * processNoticeSendJob och portalens listor/scopade PDF-produktväg.
 * Endast externa blad ersätts. Ingen Redis, Chromium, provider eller leverans.
 * Negativa oskickad-OVERDUE-prov ligger kvar i sin separata befintliga spec.
 * Förberett mot 6280c16f492b09e1c4d5a62f31e1e5d2709e168e; ingen körning vid skrivning.
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
import { PrismaClient } from '@prisma/client'
import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { AviseringController } from '../avisering/avisering.controller'
import { AviseringService } from '../avisering/avisering.service'
import { RentNoticeEventsService } from '../avisering/rent-notice-events.service'
import { JwtStrategy } from '../auth/strategies/jwt.strategy'
import { VALIDATION_PIPE_OPTIONS } from '../common/contract/validation-pipe-options'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { TransformInterceptor } from '../common/interceptors/transform.interceptor'
import { OcrService } from '../common/ocr/ocr.service'
import { PrismaService } from '../common/prisma/prisma.service'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { ConsumptionService } from '../consumption/consumption.service'
import { InvoiceEventsService } from '../invoices/invoice-events.service'
import { PdfService } from '../invoices/pdf.service'
import type { MailService, SendRentNoticeOptions } from '../mail/mail.service'
import { MiscChargeService } from '../misc-charges/misc-charge.service'
import type { PdfQueue } from '../pdf-jobs/pdf.queue'
import type { PdfJobPayload } from '../pdf-jobs/pdf.types'
import { TenantAuthGuard } from './tenant-auth.guard'
import { TenantAuthService } from './tenant-auth.service'
import { TenantPortalController } from './tenant-portal.controller'
import { TenantPortalService } from './tenant-portal.service'

type ConstructorToken = new (...args: never[]) => unknown
type Actor = {
  tenantId: string
  leaseId: string
  unitId: string
  organizationId: string
  email: string
  firstName: string
  rent: number
  token: string
}
type RenderNotice = { id: string; noticeNumber: string; ocrNumber: string; actor: Actor }
type LocalJob = Extract<PdfJobPayload, { kind: 'avisering-send' }>

// Året fryses en gång, inte mellan faser. Ingen produktkalender används som facit.
const YEAR = new Date().getUTCFullYear() + 1
const MONTH = 11
const OCTOBER_31_WEEKDAY = new Date(Date.UTC(YEAR, 9, 31)).getUTCDay()
// Söndag→fredag29, lördag→fredag30, övriga→31. Oktober31 är ingen vardagshelgdag.
const DUE_DAY = [29, 31, 31, 31, 31, 31, 30][OCTOBER_31_WEEKDAY]!
const EXPECTED_DUE = `${YEAR}-10-${DUE_DAY}`
const EXPECTED_PERIOD_START = `${YEAR}-11-01`
const EXPECTED_PERIOD_END = `${YEAR}-11-30`
const PDF_BYTES = Buffer.from('%PDF-1.4\nsynthetic-local-renderer-only\n')
const LIST_PATHS = ['/v1/portal/notices', '/v1/portal/rent-notices'] as const
const civilDate = (value: Date | string) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))
const dateColumn = (value: Date | null) => value?.toISOString().slice(0, 10) ?? null

// Alla ägar-id:n finns före första INSERT, även vid fel i setup.
const organizations = ['own', 'foreign'].map((label) => {
  const id = randomUUID()
  return {
    id,
    name: `portal-notice-flow-${label}-${id}`,
    propertyId: randomUUID(),
    userId: randomUUID(),
  }
})
const own = organizations[0]!
const foreign = organizations[1]!
const actor = (organizationId: string, firstName: string, rent: number): Actor => {
  const tenantId = randomUUID()
  return {
    tenantId,
    organizationId,
    firstName,
    rent,
    email: `${tenantId}@example.invalid`,
    leaseId: randomUUID(),
    unitId: randomUUID(),
    token: '',
  }
}
const actors = [actor(own.id, 'Alva', 7500), actor(own.id, 'Bertil', 9250)] as const
const foreignActor = actor(foreign.id, 'Frida', 6100)
const allActors = [...actors, foreignActor]
const foreignNotice = { id: randomUUID(), noticeNumber: `FOREIGN-${randomUUID()}` }

describe('två kontrakt → bokförd avi → lokal mailacceptans → tenantportal', () => {
  jest.setTimeout(30_000)
  let db: PrismaClient | undefined
  let observer: PrismaClient | undefined
  let databaseUrl: string | undefined
  let app: NestFastifyApplication | undefined
  let auth: TenantAuthService
  let avisering: AviseringService
  let adminToken: string
  let foreignAdminToken: string
  const jwtSecret = `synthetic-notice-flow-${randomUUID()}`
  const jwt = new JwtService({ secret: jwtSecret })
  const forbiddenCalls: string[] = []
  const renderable: RenderNotice[] = []
  const rendered: Array<{ id: string; html: string }> = []
  const accepted: SendRentNoticeOptions[] = []
  const queue: LocalJob[] = []
  let queueCount = 0

  function observed(): PrismaClient {
    if (!observer) throw new Error('Separat observer saknas')
    return observer
  }
  function leaf<T>(label: string, allowed: object = {}): T {
    const lifecycle = new Set([
      'then',
      'onModuleInit',
      'onApplicationBootstrap',
      'onModuleDestroy',
      'beforeApplicationShutdown',
      'onApplicationShutdown',
    ])
    return new Proxy(allowed, {
      get: (target, key) => {
        if (typeof key === 'symbol' || lifecycle.has(key)) return undefined
        if (key === 'constructor') return Object
        if (Object.prototype.hasOwnProperty.call(target, key)) return Reflect.get(target, key)
        forbiddenCalls.push(`${label}.${key}`)
        throw new Error(`Oavsiktligt beroende: ${label}.${key}`)
      },
    }) as T
  }
  function http(method: 'GET' | 'POST', url: string, token?: string, payload?: object) {
    if (!app) throw new Error('HTTP-rigg saknas')
    return app.inject({
      method,
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload,
    })
  }
  async function post<T>(path: string, payload: object, status: number): Promise<T> {
    const result = await http('POST', path, adminToken, payload)
    expect(result.statusCode).toBe(status)
    return result.json<{ data: T }>().data
  }
  const pdfPath = (id: string) => `/v1/portal/rent-notices/${id}/download`
  async function assertLists(a: Actor, expected: RenderNotice[]) {
    for (const path of LIST_PATHS) {
      const result = await http('GET', path, a.token)
      expect(result.statusCode).toBe(200)
      const rows = result.json<{ data: Array<Record<string, unknown>> }>().data
      expect(rows.map((r) => r.id).sort()).toEqual(expected.map((n) => n.id).sort())
      for (const row of rows) {
        const n = expected.find((candidate) => candidate.id === row.id)!
        expect(row).toMatchObject({
          id: n.id,
          noticeNumber: n.noticeNumber,
          type: 'RENT',
          ocrNumber: n.ocrNumber,
          month: MONTH,
          year: YEAR,
          status: 'SENT',
          amount: a.rent,
          vatAmount: 0,
          totalAmount: a.rent,
          consumptionAmount: 0,
          miscChargeAmount: 0,
          payableTotal: a.rent,
          nominalTotal: a.rent,
          paid: 0,
          credited: 0,
        })
        expect(civilDate(String(row.dueDate))).toBe(EXPECTED_DUE)
        for (const field of ['organizationId', 'tenantId', 'leaseId', 'sentTo', 'sendError']) {
          expect(row).not.toHaveProperty(field)
        }
      }
    }
  }
  async function assertPdf(n: RenderNotice) {
    const before = rendered.length
    const result = await http('GET', pdfPath(n.id), n.actor.token)
    expect(result.statusCode).toBe(200)
    expect(result.headers['content-type']).toContain('application/pdf')
    expect(result.headers['content-disposition']).toContain(n.noticeNumber)
    expect(result.rawPayload).toEqual(PDF_BYTES)
    expect(rendered).toHaveLength(before + 1)
    expect(rendered[before]!.id).toBe(n.id)
    const html = rendered[before]!.html
    expect(html).toContain(n.noticeNumber)
    expect(html).toContain(n.ocrNumber)
    expect(html).toContain(`${n.actor.firstName} Syntetisk`)
    expect(html).toContain(`Förfallodatum: <strong>${EXPECTED_DUE}</strong>`)
    // Eget bokstavligt beloppsfacit; bara Unicode-mellanslag görs läsbara.
    expect(html.replace(/[\u00a0\u202f]/g, ' ')).toContain(
      n.actor.rent === 7500 ? '7 500,00' : '9 250,00',
    )
  }
  async function financialSnapshot() {
    const p = observed()
    return {
      notices: await p.rentNotice.findMany({
        where: { organizationId: own.id },
        orderBy: { leaseId: 'asc' },
        select: {
          id: true,
          leaseId: true,
          tenantId: true,
          noticeNumber: true,
          ocrNumber: true,
          type: true,
          amount: true,
          vatAmount: true,
          totalAmount: true,
          year: true,
          month: true,
          dueDate: true,
          periodStart: true,
          periodEnd: true,
          daysCharged: true,
          totalDays: true,
          isProrated: true,
        },
      }),
      journals: await p.journalEntry.findMany({
        where: { organizationId: own.id },
        orderBy: { verNumber: 'asc' },
        include: { lines: { orderBy: { account: { number: 'asc' } }, include: { account: true } } },
      }),
      sequence: {
        notice: await p.rentNoticeNumberSequence.findMany({ where: { organizationId: own.id } }),
        ocr: await p.tenantOcrSequence.findMany({ where: { organizationId: own.id } }),
        journal: await p.journalEntrySequence.findMany({ where: { organizationId: own.id } }),
      },
    }
  }
  async function deliverySnapshot() {
    return observed().rentNotice.findMany({
      where: { organizationId: own.id },
      orderBy: { leaseId: 'asc' },
      select: { id: true, status: true, sentAt: true, sentTo: true, sendError: true },
    })
  }
  async function foreignSnapshot() {
    const p = observed()
    return {
      notices: await p.rentNotice.findMany({
        where: { organizationId: foreign.id },
        orderBy: { id: 'asc' },
      }),
      tenants: await p.tenant.findMany({
        where: { organizationId: foreign.id },
        select: { id: true, ocrNumber: true },
      }),
      journals: await p.journalEntry.findMany({ where: { organizationId: foreign.id } }),
      noticeSequence: await p.rentNoticeNumberSequence.findMany({
        where: { organizationId: foreign.id },
      }),
      ocrSequence: await p.tenantOcrSequence.findMany({ where: { organizationId: foreign.id } }),
      journalSequence: await p.journalEntrySequence.findMany({
        where: { organizationId: foreign.id },
      }),
    }
  }

  beforeAll(async () => {
    const expectedTimeZone =
      process.env.PORTAL_FLOW_EXPECT_TZ ?? (process.env.CI === 'true' ? 'UTC' : undefined)
    if (expectedTimeZone !== 'Europe/Stockholm' && expectedTimeZone !== 'UTC') {
      throw new Error('Explicit PORTAL_FLOW_EXPECT_TZ=Europe/Stockholm eller UTC krävs')
    }
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(expectedTimeZone)
    const raw = process.env.DATABASE_URL
    if (!raw) throw new Error('Explicit DATABASE_URL krävs; ingen env-fil eller skip')
    const url = new URL(raw)
    const allowedQuery = new Set(['schema', 'connection_limit', 'pool_timeout'])
    const local =
      ['127.0.0.1', 'localhost'].includes(url.hostname) &&
      url.port === '56432' &&
      /^\/[A-Za-z0-9_]+_test$/.test(url.pathname)
    const ci =
      process.env.CI === 'true' &&
      ['127.0.0.1', 'localhost', 'postgres'].includes(url.hostname) &&
      ['', '5432'].includes(url.port) &&
      url.pathname === '/eken_dev'
    if (
      url.protocol !== 'postgresql:' ||
      (!local && !ci) ||
      process.env.DEV_TENANT_BYPASS_SECRET ||
      [...url.searchParams.keys()].some((key) => !allowedQuery.has(key)) ||
      (url.searchParams.has('schema') && url.searchParams.get('schema') !== 'public')
    ) {
      throw new Error('Kräver isolerad lokal/uttrycklig CI-databas utan tenant-dev-bypass')
    }
    url.searchParams.set('connection_limit', '4')
    databaseUrl = url.toString()
    db = new PrismaClient({
      datasources: { db: { url: databaseUrl } },
      transactionOptions: PRISMA_DEFAULT_TX_LIMITS,
    })
    await db.$connect()
    observer = new PrismaClient({
      datasources: { db: { url: databaseUrl } },
      transactionOptions: PRISMA_DEFAULT_TX_LIMITS,
    })
    await observer.$connect()
    expect(Date.UTC(YEAR, 9, DUE_DAY)).toBeGreaterThan(Date.now())
    // Tidszon redovisas, men ändras inte: @db.Date-avvikelse ska inte döljas av riggen.
    process.stdout.write(
      '[portal-notice-flow] ' +
        JSON.stringify({
          year: YEAR,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          due: EXPECTED_DUE,
          periodStart: EXPECTED_PERIOD_START,
          periodEnd: EXPECTED_PERIOD_END,
        }) +
        '\n',
    )

    const prisma = db as unknown as PrismaService
    const renderer = leaf<PdfService>('pdf', {
      generateFromHtml: async (html: string): Promise<Buffer> => {
        const matches = renderable.filter((n) => html.includes(n.noticeNumber))
        expect(matches).toHaveLength(1)
        rendered.push({ id: matches[0]!.id, html })
        return PDF_BYTES
      },
    } satisfies Pick<PdfService, 'generateFromHtml'>)
    const mail = leaf<MailService>('mail', {
      sendRentNotice: async (input: SendRentNoticeOptions): Promise<string> => {
        expect(input.organizationId).toBe(own.id)
        expect(actors.some((a) => a.email === input.to)).toBe(true)
        accepted.push({ ...input, pdfBuffer: Buffer.from(input.pdfBuffer) })
        return `local-mail-accepted-${accepted.length}`
      },
    } satisfies Pick<MailService, 'sendRentNotice'>)
    const pdfQueue = leaf<PdfQueue>('pdfQueue', {
      enqueue: async (job: PdfJobPayload): Promise<string> => {
        expect(job.kind).toBe('avisering-send')
        if (job.kind !== 'avisering-send') throw new Error('Fel jobbtyp i lokal FIFO')
        expect(job.organizationId).toBe(own.id)
        queue.push({ ...job })
        return `local-pdf-job-${++queueCount}`
      },
    } satisfies Pick<PdfQueue, 'enqueue'>)
    const accounting = new AccountingService(prisma, new VerifikationsnummerService(prisma))
    const consumption = new ConsumptionService(prisma, accounting, new InvoiceEventsService(prisma))
    const misc = new MiscChargeService(prisma, accounting)
    avisering = new AviseringService(
      prisma,
      new OcrService(prisma),
      mail,
      renderer,
      leaf('storage'),
      pdfQueue,
      accounting,
      consumption,
      misc,
      leaf('deposits'),
      new RentNoticeEventsService(prisma),
    )
    const portal = new TenantPortalService(
      prisma,
      leaf('personalNumber'),
      leaf('maintenance'),
      leaf('notifications'),
      leaf('inspections'),
      leaf('imageIntegrity'),
      leaf('portalStorage'),
    )
    auth = new TenantAuthService(
      prisma,
      leaf('authMail'),
      new ConfigService({ JWT_SECRET: jwtSecret }),
      leaf('contracts'),
      leaf('locks'),
      leaf('cronErrors'),
      leaf('loginBudget'),
    )
    const controllers = [AviseringController, TenantPortalController]
    const values = new Map<unknown, unknown>([
      [AviseringService, avisering],
      [TenantPortalService, portal],
      [PrismaService, prisma],
      [PdfService, renderer],
    ])
    const dependencies = new Set(
      controllers.flatMap((c) => Reflect.getMetadata('design:paramtypes', c) as ConstructorToken[]),
    )
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers,
      providers: [
        ...[...dependencies].map((provide) => ({
          provide,
          useValue: values.has(provide) ? values.get(provide) : leaf(provide.name),
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

    for (const org of organizations) {
      await db.organization.create({
        data: {
          id: org.id,
          name: org.name,
          email: `${org.id}@example.invalid`,
          street: 'Testgatan 1',
          city: 'Teststad',
          postalCode: '11111',
          bankgiro: '5050-1055',
          logoStorageKey: null,
          billingCutoverDate: null,
          fiscalYearStartMonth: 1,
        },
      })
      await db.user.create({
        data: {
          id: org.userId,
          organizationId: org.id,
          email: `${org.userId}@example.invalid`,
          passwordHash: 'synthetic-not-used-for-login',
          firstName: 'Ägare',
          lastName: 'Syntetisk',
          role: 'OWNER',
        },
      })
      await db.property.create({
        data: {
          id: org.propertyId,
          organizationId: org.id,
          name: `Test ${org.id}`,
          propertyDesignation: org.propertyId,
          type: 'RESIDENTIAL',
          street: 'Testgatan 1',
          city: 'Teststad',
          postalCode: '11111',
          totalArea: 100,
        },
      })
      await db.account.createMany({
        data: [
          { organizationId: org.id, number: 1510, name: 'Kundfordringar', type: 'ASSET' },
          { organizationId: org.id, number: 3911, name: 'Bostadshyra', type: 'REVENUE' },
        ],
      })
    }
    for (const a of allActors) {
      const org = organizations.find((o) => o.id === a.organizationId)!
      await db.tenant.create({
        data: {
          id: a.tenantId,
          organizationId: a.organizationId,
          type: 'INDIVIDUAL',
          email: a.email,
          firstName: a.firstName,
          lastName: 'Syntetisk',
        },
      })
      await db.unit.create({
        data: {
          id: a.unitId,
          propertyId: org.propertyId,
          name: `Bostad ${a.firstName}`,
          unitNumber: a.unitId,
          type: 'APARTMENT',
          area: 50,
          monthlyRent: a.rent,
          voluntaryTaxLiability: false,
        },
      })
      await db.lease.create({
        data: {
          id: a.leaseId,
          organizationId: a.organizationId,
          tenantId: a.tenantId,
          unitId: a.unitId,
          contractNumber: a.leaseId,
          status: 'ACTIVE',
          startDate: new Date('2026-01-01'),
          tenancyStartDate: new Date('2026-01-01'),
          endDate: null,
          monthlyRent: a.rent,
          monthlyRentExcludingVat: false,
          depositAmount: 0,
        },
      })
      a.token = (await auth.createSessionForTenant(a.tenantId)).sessionToken
    }
    await db.rentNotice.create({
      data: {
        id: foreignNotice.id,
        organizationId: foreign.id,
        tenantId: foreignActor.tenantId,
        leaseId: foreignActor.leaseId,
        noticeNumber: foreignNotice.noticeNumber,
        ocrNumber: 'foreign-synthetic-ocr',
        year: YEAR,
        month: MONTH,
        amount: foreignActor.rent,
        totalAmount: foreignActor.rent,
        dueDate: new Date(`${EXPECTED_DUE}T12:00:00Z`),
        status: 'SENT',
        sentAt: new Date('2026-01-01T12:00:00Z'),
        sentTo: foreignActor.email,
      },
    })
    adminToken = jwt.sign({ sub: own.userId, organizationId: own.id, role: 'OWNER' })
    foreignAdminToken = jwt.sign({ sub: foreign.userId, organizationId: foreign.id, role: 'OWNER' })
  })

  it('bevarar belopp, bokföring, sekventiell idempotens och tenantgräns genom hela kedjan', async () => {
    // A — riktig auth/scope och tomt startläge; främmande rader sparas som sentinel.
    const foreignBefore = await foreignSnapshot()
    expect(await observed().rentNotice.count({ where: { organizationId: own.id } })).toBe(0)
    expect(await observed().journalEntry.count({ where: { organizationId: own.id } })).toBe(0)
    for (const path of [
      '/v1/avisering/generate/preview',
      '/v1/avisering/generate',
      '/v1/avisering/send',
    ]) {
      expect((await http('POST', path, undefined, { month: MONTH, year: YEAR })).statusCode).toBe(
        401,
      )
    }
    const viewer = jwt.sign({ sub: own.userId, organizationId: own.id, role: 'VIEWER' })
    expect(
      (await http('POST', '/v1/avisering/generate', viewer, { month: MONTH, year: YEAR }))
        .statusCode,
    ).toBe(403)
    for (const path of LIST_PATHS) expect((await http('GET', path)).statusCode).toBe(401)
    expect((await http('GET', pdfPath(foreignNotice.id))).statusCode).toBe(401)

    // B — preview är läsande; förväntat datum kommer från den bokstavliga tabellen.
    const beforePreview = await financialSnapshot()
    expect(await post('/v1/avisering/generate/preview', { month: MONTH, year: YEAR }, 200)).toEqual(
      {
        month: MONTH,
        year: YEAR,
        toCreate: 2,
        skipped: 0,
        dueDates: [{ dueDate: EXPECTED_DUE, count: 2 }],
        existingDueDates: [],
        beforeCutover: null,
      },
    )
    expect(await financialSnapshot()).toEqual(beforePreview)
    expect(beforePreview.sequence).toEqual({ notice: [], ocr: [], journal: [] })
    expect(
      (
        await observed().tenant.findMany({
          where: { organizationId: own.id },
          select: { ocrNumber: true },
        })
      ).every((a) => a.ocrNumber === null),
    ).toBe(true)
    expect(accepted).toEqual([])
    expect(queue).toEqual([])

    // C — riktig generation och riktig dubbel bokföring, lästa via separat klient.
    const generated = await post<{
      created: number
      skipped: number
      failed: number
      notices: Array<{ id: string }>
      beforeCutover: null
    }>('/v1/avisering/generate', { month: MONTH, year: YEAR }, 201)
    expect(generated).toMatchObject({ created: 2, skipped: 0, failed: 0, beforeCutover: null })
    const saved = await financialSnapshot()
    expect(saved.notices).toHaveLength(2)
    expect(generated.notices.map((n) => n.id).sort()).toEqual(saved.notices.map((n) => n.id).sort())
    expect(saved.journals).toHaveLength(2)
    expect(saved.journals.map((j) => j.verNumber).sort()).toEqual([1, 2])
    expect(new Set(saved.notices.map((n) => n.noticeNumber)).size).toBe(2)
    expect(new Set(saved.notices.map((n) => n.ocrNumber)).size).toBe(2)
    expect(saved.sequence.notice).toEqual([
      expect.objectContaining({ organizationId: own.id, year: YEAR, month: MONTH, lastNumber: 2 }),
    ])
    expect(saved.sequence.ocr).toEqual([
      expect.objectContaining({ organizationId: own.id, lastNumber: 2 }),
    ])
    expect(saved.sequence.journal).toEqual([
      expect.objectContaining({
        organizationId: own.id,
        fiscalYear: YEAR,
        series: 'A',
        lastNumber: 2,
      }),
    ])
    let debits = 0
    let credits = 0
    for (const a of actors) {
      const n = saved.notices.find((row) => row.leaseId === a.leaseId)!
      expect(n).toBeDefined()
      expect(n.tenantId).toBe(a.tenantId)
      expect([Number(n.amount), Number(n.vatAmount), Number(n.totalAmount)]).toEqual([
        a.rent,
        0,
        a.rent,
      ])
      expect(n).toMatchObject({
        type: 'RENT',
        month: MONTH,
        year: YEAR,
        daysCharged: 30,
        totalDays: 30,
        isProrated: false,
      })
      expect(civilDate(n.dueDate)).toBe(EXPECTED_DUE)
      expect(dateColumn(n.periodStart)).toBe(EXPECTED_PERIOD_START)
      expect(dateColumn(n.periodEnd)).toBe(EXPECTED_PERIOD_END)
      expect(
        (await observed().tenant.findUniqueOrThrow({ where: { id: a.tenantId } })).ocrNumber,
      ).toBe(n.ocrNumber)
      expect(n.ocrNumber).toMatch(/^\d{11}$/)
      const j = saved.journals.find((row) => row.sourceId === `rent-notice:${n.id}`)!
      expect(j).toBeDefined()
      expect(j).toMatchObject({
        organizationId: own.id,
        source: 'INVOICE',
        sourceId: `rent-notice:${n.id}`,
        series: 'A',
        fiscalYear: YEAR,
        createdById: null,
      })
      expect(dateColumn(j.date)).toBe(EXPECTED_PERIOD_START)
      expect(
        j.lines.map((line) => ({
          account: line.account.number,
          organizationId: line.account.organizationId,
          debit: line.debit === null ? null : Number(line.debit),
          credit: line.credit === null ? null : Number(line.credit),
        })),
      ).toEqual([
        { account: 1510, organizationId: own.id, debit: a.rent, credit: null },
        { account: 3911, organizationId: own.id, debit: null, credit: a.rent },
      ])
      for (const line of j.lines) {
        debits += Number(line.debit ?? 0)
        credits += Number(line.credit ?? 0)
      }
      renderable.push({ id: n.id, noticeNumber: n.noticeNumber, ocrNumber: n.ocrNumber, actor: a })
    }
    expect([debits, credits]).toEqual([16750, 16750])
    expect(await deliverySnapshot()).toEqual(
      saved.notices.map((n) => ({
        id: n.id,
        status: 'PENDING',
        sentAt: null,
        sentTo: null,
        sendError: null,
      })),
    )
    for (const n of renderable) {
      await assertLists(n.actor, [])
      expect((await http('GET', pdfPath(n.id), n.actor.token)).statusCode).toBe(404)
    }
    expect(rendered).toEqual([])
    expect(accepted).toEqual([])

    // D — sekventiell omkörning lämnar samma id:n/OCR/belopp och alla tre sekvenser.
    expect(await post('/v1/avisering/generate/preview', { month: MONTH, year: YEAR }, 200)).toEqual(
      {
        month: MONTH,
        year: YEAR,
        toCreate: 0,
        skipped: 2,
        dueDates: [],
        existingDueDates: [{ dueDate: EXPECTED_DUE, count: 2 }],
        beforeCutover: null,
      },
    )
    expect(await post('/v1/avisering/generate', { month: MONTH, year: YEAR }, 201)).toEqual({
      created: 0,
      skipped: 2,
      failed: 0,
      notices: [],
      beforeCutover: null,
    })
    expect(await financialSnapshot()).toEqual(saved)

    // E — riktig send-ingång, men endast lokal FIFO och lokal mailacceptans.
    const send = await post<{
      queued: number
      failed: number
      blocked: number
      blockedReason: null
      jobIds: string[]
    }>('/v1/avisering/send', { noticeIds: renderable.map((n) => n.id) }, 202)
    expect(send).toEqual({
      queued: 2,
      failed: 0,
      blocked: 0,
      blockedReason: null,
      jobIds: ['local-pdf-job-1', 'local-pdf-job-2'],
    })
    expect(queue).toEqual(
      renderable.map((n) => ({ kind: 'avisering-send', organizationId: own.id, noticeId: n.id })),
    )
    expect(
      (await deliverySnapshot()).every((n) => n.status === 'PENDING' && n.sentAt === null),
    ).toBe(true)
    expect(accepted).toEqual([])
    const sentIds = new Set<string>()
    while (queue.length > 0) {
      const job = queue.shift()!
      const n = renderable.find((candidate) => candidate.id === job.noticeId)!
      await avisering.processNoticeSendJob(job.organizationId, job.noticeId)
      sentIds.add(n.id)
      expect(accepted).toHaveLength(sentIds.size)
      const acceptance = accepted[accepted.length - 1]!
      expect(acceptance).toMatchObject({
        rentNoticeId: n.id,
        organizationId: own.id,
        to: n.actor.email,
        tenantName: `${n.actor.firstName} Syntetisk`,
        ocrNumber: n.ocrNumber,
        amount: n.actor.rent,
        organizationName: own.name,
        noticeNumber: n.noticeNumber,
        idempotencyKey: `rent-notice-${n.id}`,
      })
      expect(civilDate(acceptance.dueDate)).toBe(EXPECTED_DUE)
      expect(acceptance.pdfBuffer).toEqual(PDF_BYTES)
      for (const candidate of renderable) {
        await assertLists(candidate.actor, sentIds.has(candidate.id) ? [candidate] : [])
        if (sentIds.has(candidate.id)) await assertPdf(candidate)
        else
          expect((await http('GET', pdfPath(candidate.id), candidate.actor.token)).statusCode).toBe(
            404,
          )
      }
    }
    const sent = await deliverySnapshot()
    for (const row of sent) {
      const n = renderable.find((candidate) => candidate.id === row.id)!
      expect(row).toEqual({
        id: n.id,
        status: 'SENT',
        sentAt: expect.any(Date),
        sentTo: n.actor.email,
        sendError: null,
      })
    }
    expect(await financialSnapshot()).toEqual(saved)

    // F — worker-replay skickar/renderar inte igen; ingen garanti om exakt-en-köning.
    const renderedBeforeReplay = rendered.length
    for (const n of renderable) await avisering.processNoticeSendJob(own.id, n.id)
    expect(accepted).toHaveLength(2)
    expect(rendered).toHaveLength(renderedBeforeReplay)
    expect(await deliverySnapshot()).toEqual(sent)
    expect(await financialSnapshot()).toEqual(saved)

    // G — bekräftad positiv PDF plus negativa scopekanarier; inget externleveransspår.
    for (const n of renderable) {
      const other = actors.find((a) => a.tenantId !== n.actor.tenantId)!
      const before = rendered.length
      expect((await http('GET', pdfPath(n.id), other.token)).statusCode).toBe(404)
      expect((await http('GET', pdfPath(n.id), foreignActor.token)).statusCode).toBe(404)
      expect((await http('GET', pdfPath(foreignNotice.id), n.actor.token)).statusCode).toBe(404)
      expect(rendered).toHaveLength(before)
    }
    for (const path of LIST_PATHS) {
      const response = await http('GET', path, foreignActor.token)
      expect(response.statusCode).toBe(200)
      expect(response.json<{ data: Array<{ id: string }> }>().data.map((n) => n.id)).toEqual([
        foreignNotice.id,
      ])
    }
    const admin = await http('GET', '/v1/avisering', adminToken)
    expect(admin.statusCode).toBe(200)
    expect(
      admin
        .json<{ data: Array<{ id: string; status: string }> }>()
        .data.map((n) => n.id)
        .sort(),
    ).toEqual(renderable.map((n) => n.id).sort())
    const foreignAdmin = await http('GET', '/v1/avisering', foreignAdminToken)
    expect(foreignAdmin.statusCode).toBe(200)
    expect(foreignAdmin.json<{ data: Array<{ id: string }> }>().data.map((n) => n.id)).toEqual([
      foreignNotice.id,
    ])
    expect(await deliverySnapshot()).toEqual(sent)
    expect(await financialSnapshot()).toEqual(saved)
    expect(await foreignSnapshot()).toEqual(foreignBefore)
    const noticeScope = { rentNotice: { organizationId: { in: organizations.map((o) => o.id) } } }
    expect(await observed().rentNoticeSend.count({ where: noticeScope })).toBe(0)
    expect(await observed().rentNoticeEvent.count({ where: noticeScope })).toBe(0)
    expect(await observed().rentNoticeLine.count({ where: noticeScope })).toBe(0)
    expect(await observed().invoice.count({ where: { organizationId: own.id } })).toBe(0)
    expect(forbiddenCalls).toEqual([])
  })

  afterAll(async () => {
    try {
      if (databaseUrl) {
        // Egen ny klient, även om ursprunglig anslutning eller setup har fallerat.
        const cleanup = new PrismaClient({
          datasources: { db: { url: databaseUrl } },
          transactionOptions: PRISMA_DEFAULT_TX_LIMITS,
        })
        const ids = organizations.map((o) => o.id)
        const scope = { organizationId: { in: ids } }
        const tenantIds = allActors.map((a) => a.tenantId)
        try {
          const owned = await cleanup.organization.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true },
          })
          for (const org of owned)
            expect(organizations.map(({ id, name }) => ({ id, name }))).toContainEqual(org)
          const notices = await cleanup.rentNotice.findMany({ where: scope, select: { id: true } })
          const noticeIds = notices.map((n) => n.id)
          const journals = await cleanup.journalEntry.findMany({
            where: scope,
            select: { id: true },
          })
          const journalIds = journals.map((j) => j.id)
          await cleanup.journalEntryLine.deleteMany({
            where: { journalEntryId: { in: journalIds } },
          })
          await cleanup.journalEntry.deleteMany({ where: scope })
          await cleanup.journalEntrySequence.deleteMany({ where: scope })
          await cleanup.account.deleteMany({ where: scope })
          await cleanup.rentNoticeEvent.deleteMany({ where: { rentNoticeId: { in: noticeIds } } })
          await cleanup.rentNoticeSend.deleteMany({ where: { rentNoticeId: { in: noticeIds } } })
          await cleanup.rentNoticeLine.deleteMany({ where: { rentNoticeId: { in: noticeIds } } })
          await cleanup.rentNotice.deleteMany({ where: scope })
          await cleanup.tenantSession.deleteMany({ where: { tenantId: { in: tenantIds } } })
          await cleanup.lease.deleteMany({ where: scope })
          await cleanup.unit.deleteMany({ where: { id: { in: allActors.map((a) => a.unitId) } } })
          await cleanup.property.deleteMany({ where: scope })
          await cleanup.tenant.deleteMany({ where: scope })
          await cleanup.user.deleteMany({
            where: { id: { in: organizations.map((o) => o.userId) } },
          })
          await cleanup.tenantOcrSequence.deleteMany({ where: scope })
          await cleanup.rentNoticeNumberSequence.deleteMany({ where: scope })
          await cleanup.organization.deleteMany({ where: { id: { in: ids } } })
          const remaining = {
            organizations: await cleanup.organization.count({ where: { id: { in: ids } } }),
            users: await cleanup.user.count({
              where: { id: { in: organizations.map((o) => o.userId) } },
            }),
            tenants: await cleanup.tenant.count({ where: { id: { in: tenantIds } } }),
            sessions: await cleanup.tenantSession.count({ where: { tenantId: { in: tenantIds } } }),
            properties: await cleanup.property.count({ where: scope }),
            units: await cleanup.unit.count({
              where: { id: { in: allActors.map((a) => a.unitId) } },
            }),
            leases: await cleanup.lease.count({ where: scope }),
            notices: await cleanup.rentNotice.count({ where: scope }),
            noticeLines: await cleanup.rentNoticeLine.count({
              where: { rentNoticeId: { in: noticeIds } },
            }),
            events: await cleanup.rentNoticeEvent.count({
              where: { rentNoticeId: { in: noticeIds } },
            }),
            sends: await cleanup.rentNoticeSend.count({
              where: { rentNoticeId: { in: noticeIds } },
            }),
            accounts: await cleanup.account.count({ where: scope }),
            journals: await cleanup.journalEntry.count({ where: scope }),
            journalLines: await cleanup.journalEntryLine.count({
              where: { journalEntryId: { in: journalIds } },
            }),
            noticeSequence: await cleanup.rentNoticeNumberSequence.count({ where: scope }),
            ocrSequence: await cleanup.tenantOcrSequence.count({ where: scope }),
            journalSequence: await cleanup.journalEntrySequence.count({ where: scope }),
          }
          expect(remaining).toEqual({
            organizations: 0,
            users: 0,
            tenants: 0,
            sessions: 0,
            properties: 0,
            units: 0,
            leases: 0,
            notices: 0,
            noticeLines: 0,
            events: 0,
            sends: 0,
            accounts: 0,
            journals: 0,
            journalLines: 0,
            noticeSequence: 0,
            ocrSequence: 0,
            journalSequence: 0,
          })
          process.stdout.write('[portal-notice-flow cleanup] ' + JSON.stringify(remaining) + '\n')
        } finally {
          await cleanup.$disconnect()
        }
      }
    } finally {
      try {
        await app?.close()
      } finally {
        const closed = await Promise.allSettled([observer?.$disconnect(), db?.$disconnect()])
        const failure = closed.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        )
        if (failure) throw failure.reason
      }
    }
    expect(forbiddenCalls).toEqual([])
  })
})
