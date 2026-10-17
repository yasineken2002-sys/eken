/**
 * Tre syntetiska organisationer × tio avtal: korrekthetskanarie, inte last/SLA.
 * Riktig HTTP/auth/Prisma, AccountingService och processNoticeSendJob. Endast
 * renderer/mail/lokal FIFO ersätts; lokal acceptans är inte extern leverans.
 * Befintligt tvåavtalsprov och oskickad-OVERDUE-prov förblir separata.
 * Ingen AppModule, scheduler, Redis, browser, AI, BankID eller provider startas.
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
// Även syntetiska bytes bär avins identitet: två renderade bilagor får inte
// kunna byta plats medan enbart mailmetadata och HTML-facit ser riktiga ut.
const pdfBytes = (organizationId: string, noticeId: string) =>
  Buffer.from(`%PDF-1.4\nsynthetic-local-renderer-only\n${organizationId}\n${noticeId}\n`)
const LIST_PATHS = ['/v1/portal/notices', '/v1/portal/rent-notices'] as const
const civilDate = (value: Date | string) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))
const dateColumn = (value: Date | null) => value?.toISOString().slice(0, 10) ?? null

// Samtliga ägar-ID:n, inklusive båda läs-/skrivrollerna, finns före INSERT.
const organizations = Array.from({ length: 3 }, (_, index) => {
  const id = randomUUID()
  return {
    id,
    name: `portal-thirty-${index}-${id}`,
    propertyId: randomUUID(),
    userId: randomUUID(),
    viewerId: randomUUID(),
    ownerToken: '',
    viewerToken: '',
  }
})
type Organization = (typeof organizations)[number]
type Notice = {
  id: string
  noticeNumber: string
  ocrNumber: string
  actor: Actor
  org: Organization
}
const actors: Actor[] = organizations.flatMap((org) =>
  Array.from({ length: 10 }, (_, index) => {
    const tenantId = randomUUID()
    return {
      tenantId,
      organizationId: org.id,
      leaseId: randomUUID(),
      unitId: randomUUID(),
      firstName: `Hyresgast-${tenantId}`,
      email: `${tenantId}@example.invalid`,
      rent: index < 5 ? 7500 : 9250,
      token: '',
    }
  }),
)
const ownedOrgIds = organizations.map((o) => o.id)
const ownedUserIds = organizations.flatMap((o) => [o.userId, o.viewerId])
const ownActors = (org: Organization) => actors.filter((a) => a.organizationId === org.id)
const numbered = Array.from({ length: 10 }, (_, i) => i + 1)
const expectedNoticeNumbers = numbered.map((n) => `AVI-${YEAR}-11-${String(n).padStart(4, '0')}`)

describe('tre organisationer × tio avtal genom bokföring, lokal acceptans och portal', () => {
  jest.setTimeout(30_000)
  let db: PrismaClient | undefined
  let observer: PrismaClient | undefined
  let observerUrl: string | undefined
  let app: NestFastifyApplication | undefined
  let auth: TenantAuthService
  let avisering: AviseringService
  const jwtSecret = `synthetic-thirty-${randomUUID()}`
  const jwt = new JwtService({ secret: jwtSecret })
  // Hårda fixturegränser: 30 scalära kvitton och högst tio väntande jobb.
  // HTML/PDF/mailargument och jest.mock-anropshistorik behålls inte.
  const notices = new Map<string, Notice>()
  const renderCount = new Map<string, number>()
  const acceptCount = new Map<string, number>()
  const queue: LocalJob[] = []
  let renderedTotal = 0
  let acceptedTotal = 0
  let queuedTotal = 0
  let forbiddenCount = 0
  let firstForbidden: string | null = null
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
        forbiddenCount++
        firstForbidden ??= `${label}.${key}`
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
      ...(payload === undefined ? {} : { payload }),
    })
  }
  async function post<T>(
    org: Organization,
    path: string,
    payload: object,
    status: number,
  ): Promise<T> {
    const result = await http('POST', path, org.ownerToken, payload)
    expect(result.statusCode).toBe(status)
    return result.json<{ data: T }>().data
  }
  const pdfPath = (id: string) => `/v1/portal/rent-notices/${id}/download`
  async function deniedPdf(a: Actor, id: string) {
    const before = renderedTotal
    expect((await http('GET', pdfPath(id), a.token)).statusCode).toBe(404)
    expect(renderedTotal).toBe(before)
  }
  async function assertLists(a: Actor, n?: Notice) {
    for (const path of LIST_PATHS) {
      const response = await http('GET', path, a.token)
      expect(response.statusCode).toBe(200)
      const rows = response.json<{ data: Array<Record<string, unknown>> }>().data
      expect(rows.map((r) => r.id)).toEqual(n ? [n.id] : [])
      if (!n) continue
      const row = rows[0]!
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
      for (const field of ['organizationId', 'tenantId', 'leaseId', 'sentTo', 'sendError'])
        expect(row).not.toHaveProperty(field)
    }
  }
  async function assertPdf(n: Notice) {
    const before = renderCount.get(n.id) ?? 0
    const response = await http('GET', pdfPath(n.id), n.actor.token)
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/pdf')
    expect(response.headers['content-disposition']).toContain(n.noticeNumber)
    expect(response.rawPayload).toEqual(pdfBytes(n.org.id, n.id))
    expect(renderCount.get(n.id)).toBe(before + 1)
  }
  async function financialSnapshot(org: Organization) {
    const p = observed()
    const where = { organizationId: org.id }
    return {
      notices: await p.rentNotice.findMany({
        where,
        orderBy: { leaseId: 'asc' },
        select: {
          id: true,
          organizationId: true,
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
        where,
        orderBy: { verNumber: 'asc' },
        include: { lines: { orderBy: { account: { number: 'asc' } }, include: { account: true } } },
      }),
      tenants: await p.tenant.findMany({
        where,
        orderBy: { id: 'asc' },
        select: { id: true, ocrNumber: true },
      }),
      sequence: {
        notice: await p.rentNoticeNumberSequence.findMany({ where }),
        ocr: await p.tenantOcrSequence.findMany({ where }),
        journal: await p.journalEntrySequence.findMany({ where }),
      },
    }
  }
  async function deliverySnapshot(org: Organization) {
    return observed().rentNotice.findMany({
      where: { organizationId: org.id },
      orderBy: { leaseId: 'asc' },
      select: { id: true, status: true, sentAt: true, sentTo: true, sendError: true },
    })
  }
  async function otherOrganizationsSnapshot(org: Organization) {
    const result = []
    for (const other of organizations.filter((o) => o.id !== org.id))
      result.push({
        id: other.id,
        financial: await financialSnapshot(other),
        delivery: await deliverySnapshot(other),
      })
    return result
  }
  function checkFinancial(org: Organization, saved: Awaited<ReturnType<typeof financialSnapshot>>) {
    expect(saved.notices).toHaveLength(10)
    expect(saved.journals).toHaveLength(10)
    expect(saved.tenants).toHaveLength(10)
    expect(saved.notices.map((n) => n.noticeNumber).sort()).toEqual(expectedNoticeNumbers)
    expect(new Set(saved.notices.map((n) => n.ocrNumber)).size).toBe(10)
    expect(saved.journals.map((j) => j.verNumber).sort((a, b) => a - b)).toEqual(numbered)
    expect(saved.sequence.notice).toEqual([
      expect.objectContaining({ organizationId: org.id, year: YEAR, month: MONTH, lastNumber: 10 }),
    ])
    expect(saved.sequence.ocr).toEqual([
      expect.objectContaining({ organizationId: org.id, lastNumber: 10 }),
    ])
    expect(saved.sequence.journal).toEqual([
      expect.objectContaining({
        organizationId: org.id,
        fiscalYear: YEAR,
        series: 'A',
        lastNumber: 10,
      }),
    ])
    let debits = 0
    let credits = 0
    for (const a of ownActors(org)) {
      const n = saved.notices.find((row) => row.leaseId === a.leaseId)!
      expect(n).toBeDefined()
      expect(n).toMatchObject({
        organizationId: org.id,
        tenantId: a.tenantId,
        type: 'RENT',
        month: MONTH,
        year: YEAR,
        daysCharged: 30,
        totalDays: 30,
        isProrated: false,
      })
      expect([Number(n.amount), Number(n.vatAmount), Number(n.totalAmount)]).toEqual([
        a.rent,
        0,
        a.rent,
      ])
      expect(civilDate(n.dueDate)).toBe(EXPECTED_DUE)
      expect(dateColumn(n.periodStart)).toBe(EXPECTED_PERIOD_START)
      expect(dateColumn(n.periodEnd)).toBe(EXPECTED_PERIOD_END)
      expect(saved.tenants.find((t) => t.id === a.tenantId)?.ocrNumber).toBe(n.ocrNumber)
      expect(n.ocrNumber).toMatch(/^\d{11}$/)
      const matches = saved.journals.filter((j) => j.sourceId === `rent-notice:${n.id}`)
      expect(matches).toHaveLength(1)
      const j = matches[0]!
      expect(j).toMatchObject({
        organizationId: org.id,
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
        { account: 1510, organizationId: org.id, debit: a.rent, credit: null },
        { account: 3911, organizationId: org.id, debit: null, credit: a.rent },
      ])
      for (const line of j.lines) {
        debits += Number(line.debit ?? 0)
        credits += Number(line.credit ?? 0)
      }
      expect(notices.size).toBeLessThan(30)
      notices.set(n.id, {
        id: n.id,
        noticeNumber: n.noticeNumber,
        ocrNumber: n.ocrNumber,
        actor: a,
        org,
      })
    }
    expect([debits, credits]).toEqual([83750, 83750])
  }

  beforeAll(async () => {
    const expectedTimeZone =
      process.env.PORTAL_FLOW_EXPECT_TZ ?? (process.env.CI === 'true' ? 'UTC' : undefined)
    if (expectedTimeZone !== 'Europe/Stockholm' && expectedTimeZone !== 'UTC')
      throw new Error('Explicit PORTAL_FLOW_EXPECT_TZ=Europe/Stockholm eller UTC krävs')
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
    )
      throw new Error('Kräver isolerad lokal/uttrycklig CI-databas utan tenant-dev-bypass')
    url.searchParams.set('connection_limit', '3')
    db = new PrismaClient({
      datasources: { db: { url: url.toString() } },
      transactionOptions: PRISMA_DEFAULT_TX_LIMITS,
    })
    url.searchParams.set('connection_limit', '1')
    observerUrl = url.toString()
    observer = new PrismaClient({
      datasources: { db: { url: observerUrl } },
      transactionOptions: PRISMA_DEFAULT_TX_LIMITS,
    })
    await db.$connect()
    await observer.$connect()
    expect(Date.UTC(YEAR, 9, DUE_DAY)).toBeGreaterThan(Date.now())
    process.stdout.write(
      '[portal-thirty] ' +
        JSON.stringify({
          year: YEAR,
          timeZone: expectedTimeZone,
          organizations: 3,
          leases: 30,
          primaryPool: 3,
          observerPool: 1,
          due: EXPECTED_DUE,
          periodStart: EXPECTED_PERIOD_START,
          periodEnd: EXPECTED_PERIOD_END,
        }) +
        '\n',
    )
    const prisma = db as unknown as PrismaService
    const renderer = leaf<PdfService>('pdf', {
      generateFromHtml: async (html: string): Promise<Buffer> => {
        // Avinummer/OCR är org-scopade. Ingen global unikhetsförväntan.
        const matches = [...notices.values()].filter(
          (n) =>
            html.includes(n.noticeNumber) &&
            html.includes(n.org.name) &&
            html.includes(`${n.actor.firstName} Syntetisk`),
        )
        expect(matches).toHaveLength(1)
        const n = matches[0]!
        expect(html).toContain(n.ocrNumber)
        expect(html).toContain(`Förfallodatum: <strong>${EXPECTED_DUE}</strong>`)
        expect(html.replace(/[\u00a0\u202f]/g, ' ')).toContain(
          n.actor.rent === 7500 ? '7 500,00' : '9 250,00',
        )
        renderCount.set(n.id, (renderCount.get(n.id) ?? 0) + 1)
        renderedTotal++
        return pdfBytes(n.org.id, n.id)
      },
    } satisfies Pick<PdfService, 'generateFromHtml'>)
    const mail = leaf<MailService>('mail', {
      sendRentNotice: async (input: SendRentNoticeOptions): Promise<string> => {
        const n = notices.get(input.rentNoticeId)
        expect(n).toBeDefined()
        if (!n) throw new Error('Okänd avi i lokal mailadapter')
        expect(input).toMatchObject({
          rentNoticeId: n.id,
          organizationId: n.org.id,
          to: n.actor.email,
          tenantName: `${n.actor.firstName} Syntetisk`,
          ocrNumber: n.ocrNumber,
          amount: n.actor.rent,
          organizationName: n.org.name,
          noticeNumber: n.noticeNumber,
          idempotencyKey: `rent-notice-${n.id}`,
        })
        expect(civilDate(input.dueDate)).toBe(EXPECTED_DUE)
        expect(input.pdfBuffer).toEqual(pdfBytes(n.org.id, n.id))
        expect(acceptCount.get(n.id) ?? 0).toBe(0)
        acceptCount.set(n.id, 1)
        acceptedTotal++
        return `local-mail-accepted-${acceptedTotal}`
      },
    } satisfies Pick<MailService, 'sendRentNotice'>)
    const pdfQueue = leaf<PdfQueue>('pdfQueue', {
      enqueue: async (job: PdfJobPayload): Promise<string> => {
        expect(job.kind).toBe('avisering-send')
        if (job.kind !== 'avisering-send') throw new Error('Fel jobbtyp i lokal FIFO')
        expect(notices.get(job.noticeId)?.org.id).toBe(job.organizationId)
        expect(queue.length).toBeLessThan(10)
        queue.push({ ...job })
        return `local-pdf-job-${++queuedTotal}`
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
      for (const role of ['OWNER', 'VIEWER'] as const) {
        const id = role === 'OWNER' ? org.userId : org.viewerId
        await db.user.create({
          data: {
            id,
            organizationId: org.id,
            email: `${id}@example.invalid`,
            passwordHash: 'synthetic-not-used-for-login',
            firstName: role,
            lastName: 'Syntetisk',
            role,
          },
        })
      }
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
          totalArea: 500,
        },
      })
      await db.account.createMany({
        data: [
          { organizationId: org.id, number: 1510, name: 'Kundfordringar', type: 'ASSET' },
          { organizationId: org.id, number: 3911, name: 'Bostadshyra', type: 'REVENUE' },
        ],
      })
    }
    for (const a of actors) {
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
    for (const org of organizations) {
      org.ownerToken = jwt.sign({ sub: org.userId, organizationId: org.id, role: 'OWNER' })
      org.viewerToken = jwt.sign({ sub: org.viewerId, organizationId: org.id, role: 'VIEWER' })
    }
  })

  it('bevarar varje avi/journal, numrens orgscope, roller och sekventiell idempotens för alla tre orgar', async () => {
    // A — autentisering och läsroll; ingen token från något annat realm används.
    const period = { month: MONTH, year: YEAR }
    const writeRequests = [
      { path: '/v1/avisering/generate/preview', payload: period },
      { path: '/v1/avisering/generate', payload: period },
      { path: '/v1/avisering/send', payload: { noticeIds: [randomUUID()] } },
    ]
    for (const request of writeRequests) {
      expect((await http('POST', request.path, undefined, request.payload)).statusCode).toBe(401)
      for (const org of organizations)
        expect(
          (await http('POST', request.path, org.viewerToken, request.payload)).statusCode,
        ).toBe(403)
    }
    for (const path of LIST_PATHS) expect((await http('GET', path)).statusCode).toBe(401)
    expect((await http('GET', pdfPath(randomUUID()))).statusCode).toBe(401)

    for (const org of organizations) {
      // B — varje annan ägd org är en sentinel före/efter hela orgens kedja.
      const othersBefore = await otherOrganizationsSnapshot(org)
      const before = await financialSnapshot(org)
      expect(before.notices).toEqual([])
      expect(before.journals).toEqual([])
      expect(before.sequence).toEqual({ notice: [], ocr: [], journal: [] })
      expect(before.tenants).toHaveLength(10)
      expect(before.tenants.every((t) => t.ocrNumber === null)).toBe(true)
      expect(await post(org, '/v1/avisering/generate/preview', period, 200)).toEqual({
        ...period,
        toCreate: 10,
        skipped: 0,
        dueDates: [{ dueDate: EXPECTED_DUE, count: 10 }],
        existingDueDates: [],
        beforeCutover: null,
      })
      expect(await financialSnapshot(org)).toEqual(before)
      const acceptedBefore = acceptedTotal
      const renderedBefore = renderedTotal
      expect(queue).toEqual([])

      // C — faktisk generation/bokföring; perpostfacit, inte bara mängder/summor.
      const generated = await post<{
        created: number
        skipped: number
        failed: number
        notices: Array<{ id: string }>
        beforeCutover: null
        blockedByOpening: number
        blockedReason: null
      }>(org, '/v1/avisering/generate', period, 201)
      expect(generated).toMatchObject({
        created: 10,
        skipped: 0,
        failed: 0,
        beforeCutover: null,
        blockedByOpening: 0,
        blockedReason: null,
      })
      const saved = await financialSnapshot(org)
      checkFinancial(org, saved)
      expect(generated.notices.map((n) => n.id).sort()).toEqual(
        saved.notices.map((n) => n.id).sort(),
      )
      const orgNotices = saved.notices.map((n) => notices.get(n.id)!)
      expect(await deliverySnapshot(org)).toEqual(
        saved.notices.map((n) => ({
          id: n.id,
          status: 'PENDING',
          sentAt: null,
          sentTo: null,
          sendError: null,
        })),
      )
      for (const n of orgNotices) {
        await assertLists(n.actor)
        await deniedPdf(n.actor, n.id)
      }
      expect([renderedTotal, acceptedTotal]).toEqual([renderedBefore, acceptedBefore])

      // D — preview/generate-replay förbrukar inga nya nummer eller journaler.
      expect(await post(org, '/v1/avisering/generate/preview', period, 200)).toEqual({
        ...period,
        toCreate: 0,
        skipped: 10,
        dueDates: [],
        existingDueDates: [{ dueDate: EXPECTED_DUE, count: 10 }],
        beforeCutover: null,
      })
      expect(await post(org, '/v1/avisering/generate', period, 201)).toEqual({
        created: 0,
        skipped: 10,
        failed: 0,
        notices: [],
        beforeCutover: null,
        blockedByOpening: 0,
        blockedReason: null,
      })
      expect(await financialSnapshot(org)).toEqual(saved)

      // E — verklig send-producent + worker, men lokal acceptans/renderer/FIFO.
      const queueBefore = queuedTotal
      expect(
        await post(org, '/v1/avisering/send', { noticeIds: orgNotices.map((n) => n.id) }, 202),
      ).toEqual({
        queued: 10,
        failed: 0,
        blocked: 0,
        blockedReason: null,
        jobIds: numbered.map((n) => `local-pdf-job-${queueBefore + n}`),
      })
      expect(queue).toEqual(
        orgNotices.map((n) => ({ kind: 'avisering-send', organizationId: org.id, noticeId: n.id })),
      )
      expect(acceptedTotal).toBe(acceptedBefore)
      expect(
        (await deliverySnapshot(org)).every((n) => n.status === 'PENDING' && n.sentAt === null),
      ).toBe(true)
      let completed = 0
      while (queue.length) {
        const job = queue.shift()!
        await avisering.processNoticeSendJob(job.organizationId, job.noticeId)
        expect(acceptCount.get(job.noticeId)).toBe(1)
        expect(acceptedTotal).toBe(acceptedBefore + ++completed)
        if (completed === 1) {
          // En faktisk mellanövergång, sedan en linjär slutkontroll för alla tio.
          await assertLists(orgNotices[0]!.actor, orgNotices[0]!)
          await assertLists(orgNotices[1]!.actor)
          await deniedPdf(orgNotices[1]!.actor, orgNotices[1]!.id)
        }
      }
      const sent = await deliverySnapshot(org)
      for (const row of sent) {
        const n = notices.get(row.id)!
        expect(row).toEqual({
          id: n.id,
          status: 'SENT',
          sentAt: expect.any(Date),
          sentTo: n.actor.email,
          sendError: null,
        })
      }
      expect(await financialSnapshot(org)).toEqual(saved)
      for (const n of orgNotices) {
        await assertLists(n.actor, n)
        await assertPdf(n)
      }

      // F — worker-replay lämnar kvittot och ekonomi identiska, utan ny acceptans.
      const rendersBeforeReplay = renderedTotal
      for (const n of orgNotices) await avisering.processNoticeSendJob(org.id, n.id)
      expect(acceptedTotal).toBe(acceptedBefore + 10)
      expect(renderedTotal).toBe(rendersBeforeReplay)
      expect(await deliverySnapshot(org)).toEqual(sent)
      expect(await financialSnapshot(org)).toEqual(saved)

      // G — varje skickad avi provas med både annan tenant och annan org.
      for (let i = 0; i < orgNotices.length; i++) {
        const n = orgNotices[i]!
        await deniedPdf(orgNotices[(i + 1) % 10]!.actor, n.id)
        await deniedPdf(actors.find((a) => a.organizationId !== org.id)!, n.id)
      }
      for (const token of [org.ownerToken, org.viewerToken]) {
        const admin = await http('GET', `/v1/avisering?month=${MONTH}&year=${YEAR}`, token)
        expect(admin.statusCode).toBe(200)
        const rows = admin.json<{ data: Array<{ id: string; status: string }> }>().data
        expect(rows.map((n) => n.id).sort()).toEqual(orgNotices.map((n) => n.id).sort())
        expect(rows.every((n) => n.status === 'SENT')).toBe(true)
      }
      expect(await deliverySnapshot(org)).toEqual(sent)
      expect(await financialSnapshot(org)).toEqual(saved)
      expect(await otherOrganizationsSnapshot(org)).toEqual(othersBefore)
    }

    // Alla tre har avsiktligt samma 0001..0010, med skilda verkliga post-ID:n.
    expect(notices.size).toBe(30)
    expect(new Set([...notices.values()].map((n) => n.noticeNumber)).size).toBe(10)
    expect(new Set([...notices.values()].map((n) => n.id)).size).toBe(30)
    expect([...notices.values()].reduce((sum, n) => sum + n.actor.rent, 0)).toBe(251250)
    expect([queuedTotal, acceptedTotal, renderedTotal]).toEqual([30, 30, 60])
    expect([...acceptCount.values()]).toEqual(Array(30).fill(1))
    expect([...renderCount.values()]).toEqual(Array(30).fill(2))
    expect(queue).toEqual([])
    const scope = { organizationId: { in: ownedOrgIds } }
    const noticeScope = { rentNotice: scope }
    expect(await observed().rentNoticeSend.count({ where: noticeScope })).toBe(0)
    expect(await observed().rentNoticeEvent.count({ where: noticeScope })).toBe(0)
    expect(await observed().rentNoticeLine.count({ where: noticeScope })).toBe(0)
    expect(await observed().invoice.count({ where: scope })).toBe(0)
    expect([
      await observed().rentNoticeNumberSequence.count({ where: scope }),
      await observed().tenantOcrSequence.count({ where: scope }),
      await observed().journalEntrySequence.count({ where: scope }),
    ]).toEqual([3, 3, 3])
    expect({ forbiddenCount, firstForbidden }).toEqual({ forbiddenCount: 0, firstForbidden: null })
  })

  afterAll(async () => {
    // Cleanup ersätter observern: primär pool3 + som mest en pool1 även vid fel.
    const failures: unknown[] = []
    try {
      try {
        await observer?.$disconnect()
        observer = undefined
      } catch (error) {
        failures.push(error)
      }
      if (observerUrl && !observer) {
        const cleanup = new PrismaClient({
          datasources: { db: { url: observerUrl } },
          transactionOptions: PRISMA_DEFAULT_TX_LIMITS,
        })
        const scope = { organizationId: { in: ownedOrgIds } }
        const tenantIds = actors.map((a) => a.tenantId)
        const unitIds = actors.map((a) => a.unitId)
        const leaseIds = actors.map((a) => a.leaseId)
        const propertyIds = organizations.map((o) => o.propertyId)
        try {
          const owned = await cleanup.organization.findMany({
            where: { id: { in: ownedOrgIds } },
            select: { id: true, name: true },
          })
          for (const org of owned)
            expect(organizations.map(({ id, name }) => ({ id, name }))).toContainEqual(org)
          const noticeIds = (
            await cleanup.rentNotice.findMany({ where: scope, select: { id: true } })
          ).map((n) => n.id)
          const journalIds = (
            await cleanup.journalEntry.findMany({ where: scope, select: { id: true } })
          ).map((j) => j.id)
          const noticeChildren = { rentNoticeId: { in: noticeIds } }
          const journalChildren = { journalEntryId: { in: journalIds } }
          await cleanup.journalEntryLine.deleteMany({ where: journalChildren })
          await cleanup.journalEntry.deleteMany({ where: scope })
          await cleanup.journalEntrySequence.deleteMany({ where: scope })
          await cleanup.account.deleteMany({ where: scope })
          await cleanup.rentNoticeEvent.deleteMany({ where: noticeChildren })
          await cleanup.rentNoticeSend.deleteMany({ where: noticeChildren })
          await cleanup.rentNoticeLine.deleteMany({ where: noticeChildren })
          await cleanup.rentNotice.deleteMany({ where: scope })
          await cleanup.tenantSession.deleteMany({ where: { tenantId: { in: tenantIds } } })
          await cleanup.lease.deleteMany({ where: { id: { in: leaseIds }, ...scope } })
          await cleanup.unit.deleteMany({ where: { id: { in: unitIds } } })
          await cleanup.property.deleteMany({ where: { id: { in: propertyIds }, ...scope } })
          await cleanup.tenant.deleteMany({ where: { id: { in: tenantIds }, ...scope } })
          await cleanup.user.deleteMany({ where: { id: { in: ownedUserIds }, ...scope } })
          await cleanup.tenantOcrSequence.deleteMany({ where: scope })
          await cleanup.rentNoticeNumberSequence.deleteMany({ where: scope })
          await cleanup.organization.deleteMany({ where: { id: { in: ownedOrgIds } } })
          const remaining = {
            organizations: await cleanup.organization.count({ where: { id: { in: ownedOrgIds } } }),
            users: await cleanup.user.count({ where: { id: { in: ownedUserIds } } }),
            tenants: await cleanup.tenant.count({ where: { id: { in: tenantIds } } }),
            sessions: await cleanup.tenantSession.count({ where: { tenantId: { in: tenantIds } } }),
            properties: await cleanup.property.count({ where: { id: { in: propertyIds } } }),
            units: await cleanup.unit.count({ where: { id: { in: unitIds } } }),
            leases: await cleanup.lease.count({ where: { id: { in: leaseIds } } }),
            notices: await cleanup.rentNotice.count({ where: scope }),
            noticeLines: await cleanup.rentNoticeLine.count({ where: noticeChildren }),
            events: await cleanup.rentNoticeEvent.count({ where: noticeChildren }),
            sends: await cleanup.rentNoticeSend.count({ where: noticeChildren }),
            accounts: await cleanup.account.count({ where: scope }),
            journals: await cleanup.journalEntry.count({ where: scope }),
            journalLines: await cleanup.journalEntryLine.count({ where: journalChildren }),
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
          process.stdout.write('[portal-thirty cleanup] ' + JSON.stringify(remaining) + '\n')
        } catch (error) {
          failures.push(error)
        } finally {
          try {
            await cleanup.$disconnect()
          } catch (error) {
            failures.push(error)
          }
        }
      }
    } finally {
      try {
        await app?.close()
      } catch (error) {
        failures.push(error)
      }
      try {
        await db?.$disconnect()
      } catch (error) {
        failures.push(error)
      }
      if (observer)
        try {
          await observer.$disconnect()
        } catch (error) {
          failures.push(error)
        }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Fel vid ägd cleanup/anslutningsstängning')
    expect({ forbiddenCount, firstForbidden }).toEqual({ forbiddenCount: 0, firstForbidden: null })
  })
})
