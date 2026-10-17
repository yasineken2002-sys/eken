/**
 * EN syntetisk HTTP/DB-kedja: nollöppning → två ordinarie avier → tenantportal.
 * Riktiga kundstart-, auth-, bokförings- och utskicksmetoder. Endast renderer,
 * mailacceptans och lokal FIFO ersätter externa blad. Inga provideranrop.
 * Legacy Fortnox-nollsaldo är uttrycklig DB-fixture, inte ett leverantörsbevis.
 * Default-TX 5s/2s; evidence create/review och approve/execute behåller
 * produktens egna 60s/3s-undantag (SERIALIZABLE).
 * Jesttak30s/pool3+1; lokal stopp-/cleanupbudget25s, ingen DB-annullering.
 * DELETE först efter faktisk settlement + app.close, annars INCOMPLETE.
 * Inget produkt-TX-/import-override och ingen AppModule.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../contracts/contract-template.service', () => ({ ContractTemplateService: class {} }))
jest.mock('../mail/mail.service', () => ({ MailService: class {} }))

import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { ValidationPipe } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { PassportModule } from '@nestjs/passport'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test, type TestingModule } from '@nestjs/testing'
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
import { CutoverService } from '../kundstart/cutover.service'
import { KundstartController } from '../kundstart/kundstart.controller'
import { OpeningPackageService } from '../kundstart/opening-package.service'
import { OpeningEvidenceService } from '../kundstart/opening-evidence.service'
import { SOURCE_HEADER, MAPPING_HEADER } from '../kundstart/opening-evidence-format'
import {
  fixtureEvidenceInput,
  IMPORT_HEADER_207,
  nextFixtureOrgNumber,
} from '../kundstart/opening-evidence.fixtures'
import type { MailService, SendRentNoticeOptions } from '../mail/mail.service'
import { MiscChargeService } from '../misc-charges/misc-charge.service'
import type { PdfQueue } from '../pdf-jobs/pdf.queue'
import type { PdfJobPayload } from '../pdf-jobs/pdf.types'
import { TenantAuthGuard } from './tenant-auth.guard'
import { TenantAuthService } from './tenant-auth.service'
import { TenantPortalController } from './tenant-portal.controller'
import { TenantPortalService } from './tenant-portal.service'

type ConstructorToken = new (...args: never[]) => unknown
type LocalJob = Extract<PdfJobPayload, { kind: 'avisering-send' }>
type PackageView = { id: string; status: string; version: number; sourceSha256: string }
const YEAR = new Date().getUTCFullYear() + 1
const PERIOD = { year: YEAR, month: 11 }
const CUTOVER = `${YEAR}-11-01`
const PERIOD_END = `${YEAR}-11-30`
const AS_OF = `${YEAR}-10-31`
const DUE = `${YEAR}-10-${[29, 31, 31, 31, 31, 31, 30][new Date(Date.UTC(YEAR, 9, 31)).getUTCDay()]!}`
const LISTS = ['/v1/portal/notices', '/v1/portal/rent-notices'] as const
const pdfPath = (id: string) => `/v1/portal/rent-notices/${id}/download`
const pdfBytes = (org: string, id: string) => Buffer.from(`%PDF-1.4\nsynthetic:${org}:${id}\n`)
const day = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null
const civil = (d: Date | string) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(d))
// Samtliga ägar-id:n fryses före första INSERT och används även efter setupfel.
const organizations = ['own', 'foreign'].map((label) => {
  const id = randomUUID()
  return {
    id,
    name: `portal-kundstart-${label}-${id}`,
    userId: randomUUID(),
    propertyId: randomUUID(),
  }
})
const own = organizations[0]!,
  foreign = organizations[1]!
const orgIds = organizations.map((o) => o.id)
const reviewerId = randomUUID()
const userIds = [...organizations.map((o) => o.userId), reviewerId]
const connectionId = randomUUID(),
  readId = randomUUID()
const makeActor = (orgId: string, name: string, rent: number) => {
  const id = randomUUID()
  return {
    id,
    orgId,
    name,
    rent,
    email: `${id}@example.invalid`,
    unitId: randomUUID(),
    leaseId: randomUUID(),
    token: '',
  }
}
const actors = [makeActor(own.id, 'Alva', 7500), makeActor(own.id, 'Bertil', 9250)]
const outsider = makeActor(foreign.id, 'Frida', 6100)
const allActors = [...actors, outsider]
type Actor = (typeof allActors)[number]
type Notice = { id: string; noticeNumber: string; ocrNumber: string; actor: Actor }
const foreignNoticeId = randomUUID()

describe('kundstart via HTTP → två avier → isolerad tenantportal', () => {
  jest.setTimeout(30_000)
  let db: PrismaClient
  let observer: PrismaClient | undefined
  let observerUrl: string | undefined
  let app: NestFastifyApplication | undefined
  let compiledModule: TestingModule | undefined
  let avisering: AviseringService
  let ownerToken: string, reviewerToken: string, foreignToken: string, orgNumber: string
  const jwtSecret = `synthetic-kundstart-flow-${randomUUID()}`
  const jwt = new JwtService({ secret: jwtSecret })
  const notices: Notice[] = [],
    jobs: LocalJob[] = []
  const accepted: SendRentNoticeOptions[] = []
  let rendered = 0,
    queued = 0
  const forbidden: string[] = []

  // Lokal livstidsgrind: inga produktinterna queries/transaction-options ändras.
  // 25s är en stopp-/drainbudget INOM oförändrat Jesttak30s, inte en DB-cancel.
  const LOCAL_BUDGET_MS = 25_000
  const inFlight = new Set<Promise<unknown>>()
  let stopped = false
  let phaseDeadline = Number.POSITIVE_INFINITY
  function track<T>(work: () => T | PromiseLike<T>): Promise<T> {
    const promise = Promise.resolve().then(work)
    inFlight.add(promise)
    // Båda handlers kopplas innan work körs; sena avslag blir inte oobserverade.
    void promise.then(
      () => {
        inFlight.delete(promise)
      },
      () => {
        inFlight.delete(promise)
      },
    )
    return promise
  }
  function assertRunning() {
    if (stopped || performance.now() >= phaseDeadline) {
      stopped = true
      throw new Error('FIXTURE_STOPPED')
    }
  }
  function step<T>(work: () => T | PromiseLike<T>): Promise<T> {
    return track(async () => {
      assertRunning()
      const value = await work()
      assertRunning()
      return value
    })
  }
  function phase(work: () => Promise<void>): Promise<void> {
    phaseDeadline = performance.now() + LOCAL_BUDGET_MS
    const timer = setTimeout(() => {
      stopped = true
    }, LOCAL_BUDGET_MS)
    return track(async () => {
      try {
        assertRunning()
        await work()
        assertRunning()
      } finally {
        clearTimeout(timer)
        phaseDeadline = Number.POSITIVE_INFINITY
      }
    })
  }
  function assertCleanupTime(deadline: number) {
    if (performance.now() >= deadline) throw new Error('FIXTURE_CLEANUP_DEADLINE')
  }
  async function until<T>(promise: Promise<T>, deadline: number): Promise<T> {
    assertCleanupTime(deadline)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const value = await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('FIXTURE_CLEANUP_DEADLINE')),
            Math.max(0, deadline - performance.now()),
          )
        }),
      ])
      assertCleanupTime(deadline)
      return value
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  async function drain(deadline: number) {
    while (inFlight.size > 0) {
      assertCleanupTime(deadline)
      // Aggregatet är ingen ny operation och får inte registrera sig självt.
      await until(Promise.allSettled([...inFlight]), deadline)
    }
  }

  function observed() {
    if (!observer) throw new Error('Oberoende observer saknas')
    return observer
  }
  // Samma fail-closed externa blad som i befintliga portalflödesprovet.
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
      get(target, key) {
        if (typeof key === 'symbol' || lifecycle.has(key)) return undefined
        if (key === 'constructor') return Object
        if (Object.prototype.hasOwnProperty.call(target, key)) return Reflect.get(target, key)
        forbidden.push(`${label}.${key}`)
        throw new Error(`Oavsiktligt beroende: ${label}.${key}`)
      },
    }) as T
  }
  function http(method: 'GET' | 'POST' | 'PUT', url: string, token?: string, payload?: object) {
    if (!app) throw new Error('HTTP-rigg saknas')
    const currentApp = app
    return step(() =>
      currentApp.inject({
        method,
        url,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        ...(payload === undefined ? {} : { payload }),
      }),
    )
  }
  async function request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    status: number,
    payload?: object,
    token?: string,
  ): Promise<T> {
    const response = await http(method, path, token ?? ownerToken, payload)
    expect(response.statusCode).toBe(status)
    return response.json<{ data: T }>().data
  }
  async function financial() {
    const p = observed()
    const scope = { organizationId: own.id }
    return {
      notices: await step(() =>
        p.rentNotice.findMany({
          where: scope,
          orderBy: { leaseId: 'asc' },
          select: {
            id: true,
            leaseId: true,
            tenantId: true,
            noticeNumber: true,
            ocrNumber: true,
            type: true,
            origin: true,
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
      ),
      journals: await step(() =>
        p.journalEntry.findMany({
          where: scope,
          orderBy: { verNumber: 'asc' },
          include: {
            lines: { orderBy: { account: { number: 'asc' } }, include: { account: true } },
          },
        }),
      ),
      noticeSequence: await step(() => p.rentNoticeNumberSequence.findMany({ where: scope })),
      ocrSequence: await step(() => p.tenantOcrSequence.findMany({ where: scope })),
      journalSequence: await step(() => p.journalEntrySequence.findMany({ where: scope })),
      tenantOcr: await step(() =>
        p.tenant.findMany({
          where: scope,
          orderBy: { id: 'asc' },
          select: { id: true, ocrNumber: true },
        }),
      ),
      payments: await step(() => p.rentNoticePayment.count({ where: { rentNotice: scope } })),
      deposits: await step(() => p.deposit.count({ where: scope })),
      bankRows: await step(() => p.bankTransaction.count({ where: scope })),
    }
  }
  async function delivery() {
    return step(() =>
      observed().rentNotice.findMany({
        where: { organizationId: own.id },
        orderBy: { id: 'asc' },
        select: { id: true, status: true, sentAt: true, sentTo: true, sendError: true },
      }),
    )
  }
  async function sentinel() {
    const p = observed(),
      scope = { organizationId: foreign.id }
    return {
      org: await step(() => p.organization.findUniqueOrThrow({ where: { id: foreign.id } })),
      notices: await step(() => p.rentNotice.findMany({ where: scope, orderBy: { id: 'asc' } })),
      journals: await step(() => p.journalEntry.findMany({ where: scope })),
      packages: await step(() => p.openingPackage.findMany({ where: scope })),
      evidence: await step(() => p.openingEvidence.count({ where: scope })),
      tenantOcr: await step(() =>
        p.tenant.findMany({ where: scope, select: { id: true, ocrNumber: true } }),
      ),
      noticeSequence: await step(() => p.rentNoticeNumberSequence.findMany({ where: scope })),
      ocrSequence: await step(() => p.tenantOcrSequence.findMany({ where: scope })),
      journalSequence: await step(() => p.journalEntrySequence.findMany({ where: scope })),
    }
  }
  async function assertPortal(a: Actor, ids: string[]) {
    for (const path of LISTS) {
      const rows = await request<Array<Record<string, unknown>>>(
        'GET',
        path,
        200,
        undefined,
        a.token,
      )
      expect(rows.map((n) => n.id).sort()).toEqual([...ids].sort())
      for (const row of rows) {
        expect(row).toMatchObject({
          status: 'SENT',
          amount: a.rent,
          totalAmount: a.rent,
          payableTotal: a.rent,
          paid: 0,
          credited: 0,
        })
        expect(civil(String(row.dueDate))).toBe(DUE)
        for (const field of ['organizationId', 'tenantId', 'leaseId', 'sentTo', 'sendError'])
          expect(row).not.toHaveProperty(field)
      }
    }
  }
  async function assertBlocked(baseline?: Awaited<ReturnType<typeof financial>>) {
    expect(await request('POST', '/v1/avisering/generate', 201, PERIOD)).toEqual({
      created: 0,
      skipped: 0,
      failed: 0,
      notices: [],
      beforeCutover: null,
      blockedByOpening: 2,
      blockedReason: expect.stringContaining('ofärdigt öppningspaket'),
    })
    const after = await financial()
    if (baseline) expect(after).toEqual(baseline)
    for (const a of actors) await assertPortal(a, [])
    expect(
      await step(() =>
        observed().rentNoticeSend.count({ where: { rentNotice: { organizationId: own.id } } }),
      ),
    ).toBe(0)
    expect([jobs.length, accepted.length, rendered, queued]).toEqual([0, 0, 0, 0])
    return after
  }

  beforeAll(() =>
    phase(async () => {
      const tz =
        process.env.PORTAL_FLOW_EXPECT_TZ ?? (process.env.CI === 'true' ? 'UTC' : undefined)
      if (tz !== 'Europe/Stockholm' && tz !== 'UTC')
        throw new Error('Explicit PORTAL_FLOW_EXPECT_TZ=Europe/Stockholm eller UTC krävs')
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(tz)
      const raw = process.env.DATABASE_URL
      if (!raw) throw new Error('Explicit DATABASE_URL krävs; ingen env-fil eller skip')
      const url = new URL(raw),
        allowed = new Set(['schema', 'connection_limit', 'pool_timeout'])
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
        [...url.searchParams.keys()].some((key) => !allowed.has(key)) ||
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
      await step(() => db.$connect())
      await step(() => observed().$connect())
      orgNumber = await step(() => nextFixtureOrgNumber(db))
      expect(new Date(`${DUE}T00:00:00Z`).getTime()).toBeGreaterThan(Date.now())
      process.stdout.write(
        '[portal-kundstart] ' +
          JSON.stringify({
            year: YEAR,
            tz,
            leases: 2,
            primaryPool: 3,
            observerPool: 1,
            defaultTx: PRISMA_DEFAULT_TX_LIMITS,
            openingTx: { timeout: 60000, maxWait: 3000, isolation: 'Serializable' },
          }) +
          '\n',
      )
      const prisma = db as unknown as PrismaService
      const renderer = leaf<PdfService>('pdf', {
        generateFromHtml: async (html: string) => {
          const matching = notices.filter(
            (n) =>
              html.includes(n.noticeNumber) &&
              html.includes(own.name) &&
              html.includes(`${n.actor.name} Syntetisk`),
          )
          expect(matching).toHaveLength(1)
          const n = matching[0]!
          expect(html).toContain(n.ocrNumber)
          expect(html).toContain(`Förfallodatum: <strong>${DUE}</strong>`)
          expect(html.replace(/[\u00a0\u202f]/g, ' ')).toContain(
            n.actor.rent === 7500 ? '7 500,00' : '9 250,00',
          )
          rendered++
          return pdfBytes(own.id, n.id)
        },
      } satisfies Pick<PdfService, 'generateFromHtml'>)
      const mail = leaf<MailService>('mail', {
        sendRentNotice: async (input: SendRentNoticeOptions) => {
          const n = notices.find((candidate) => candidate.id === input.rentNoticeId)
          expect(n).toBeDefined()
          if (!n) throw new Error('Okänd lokal avi')
          expect(input).toMatchObject({
            organizationId: own.id,
            to: n.actor.email,
            tenantName: `${n.actor.name} Syntetisk`,
            amount: n.actor.rent,
            noticeNumber: n.noticeNumber,
            ocrNumber: n.ocrNumber,
            idempotencyKey: `rent-notice-${n.id}`,
          })
          expect(civil(input.dueDate)).toBe(DUE)
          expect(input.pdfBuffer).toEqual(pdfBytes(own.id, n.id))
          expect(accepted.some((previous) => previous.rentNoticeId === n.id)).toBe(false)
          accepted.push({ ...input, pdfBuffer: Buffer.from(input.pdfBuffer) })
          return `local-accepted-${accepted.length}`
        },
      } satisfies Pick<MailService, 'sendRentNotice'>)
      const queue = leaf<PdfQueue>('queue', {
        enqueue: async (job: PdfJobPayload) => {
          expect(job.kind).toBe('avisering-send')
          if (job.kind !== 'avisering-send') throw new Error('Fel lokal jobbtyp')
          expect(job.organizationId).toBe(own.id)
          expect(jobs.length).toBeLessThan(2)
          jobs.push({ ...job })
          return `local-job-${++queued}`
        },
      } satisfies Pick<PdfQueue, 'enqueue'>)
      const accounting = new AccountingService(prisma, new VerifikationsnummerService(prisma))
      avisering = new AviseringService(
        prisma,
        new OcrService(prisma),
        mail,
        renderer,
        leaf('storage'),
        queue,
        accounting,
        new ConsumptionService(prisma, accounting, new InvoiceEventsService(prisma)),
        new MiscChargeService(prisma, accounting),
        leaf('deposits'),
        new RentNoticeEventsService(prisma),
      )
      const evidence = new OpeningEvidenceService(prisma)
      const auth = new TenantAuthService(
        prisma,
        leaf('authMail'),
        new ConfigService({ JWT_SECRET: jwtSecret }),
        leaf('contracts'),
        leaf('locks'),
        leaf('cronErrors'),
        leaf('loginBudget'),
      )
      const controllers = [KundstartController, AviseringController, TenantPortalController]
      const values = new Map<unknown, unknown>([
        [PrismaService, prisma],
        [PdfService, renderer],
        [AviseringService, avisering],
        [OpeningEvidenceService, evidence],
        [
          OpeningPackageService,
          new OpeningPackageService(prisma, new OcrService(prisma), evidence),
        ],
        [CutoverService, new CutoverService(prisma)],
        [
          TenantPortalService,
          new TenantPortalService(
            prisma,
            leaf('personalNumber'),
            leaf('maintenance'),
            leaf('notifications'),
            leaf('inspections'),
            leaf('imageIntegrity'),
            leaf('portalStorage'),
          ),
        ],
      ])
      const dependencies = new Set(
        controllers.flatMap(
          (c) => Reflect.getMetadata('design:paramtypes', c) as ConstructorToken[],
        ),
      )
      const module = await step(async () => {
        const created = await Test.createTestingModule({
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
        // Spara även ett sent färdigkompilerat module före step:s stoppkontroll.
        compiledModule = created
        return created
      })
      app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
      app.setGlobalPrefix('v1')
      app.useGlobalGuards(new JwtAuthGuard(new Reflector()), new RolesGuard(new Reflector()))
      app.useGlobalInterceptors(new TransformInterceptor())
      app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS))
      await step(() => app!.init())
      await step(() => app!.getHttpAdapter().getInstance().ready())
      for (const org of organizations) {
        await step(() =>
          db.organization.create({
            data: {
              id: org.id,
              name: org.name,
              ...(org.id === own.id ? { orgNumber } : {}),
              email: `${org.id}@example.invalid`,
              street: 'Testgatan 1',
              city: 'Teststad',
              postalCode: '11111',
              bankgiro: '5050-1055',
              logoStorageKey: null,
              billingCutoverDate: null,
              fiscalYearStartMonth: 1,
            },
          }),
        )
        await step(() =>
          db.user.create({
            data: {
              id: org.userId,
              organizationId: org.id,
              email: `${org.userId}@example.invalid`,
              passwordHash: 'synthetic-not-login',
              firstName: 'Ägare',
              lastName: 'Syntetisk',
              role: 'OWNER',
            },
          }),
        )
        await step(() =>
          db.property.create({
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
          }),
        )
        await step(() =>
          db.account.createMany({
            data: [
              { organizationId: org.id, number: 1510, name: 'Kundfordringar', type: 'ASSET' },
              { organizationId: org.id, number: 3911, name: 'Bostadshyra', type: 'REVENUE' },
            ],
          }),
        )
      }
      await step(() =>
        db.user.create({
          data: {
            id: reviewerId,
            organizationId: own.id,
            email: `${reviewerId}@example.invalid`,
            passwordHash: 'synthetic-not-login',
            firstName: 'Granskare',
            lastName: 'Syntetisk',
            role: 'ACCOUNTANT',
          },
        }),
      )
      for (const a of allActors) {
        const org = organizations.find((o) => o.id === a.orgId)!
        await step(() =>
          db.tenant.create({
            data: {
              id: a.id,
              organizationId: a.orgId,
              type: 'INDIVIDUAL',
              email: a.email,
              firstName: a.name,
              lastName: 'Syntetisk',
            },
          }),
        )
        await step(() =>
          db.unit.create({
            data: {
              id: a.unitId,
              propertyId: org.propertyId,
              name: a.name,
              unitNumber: a.unitId,
              type: 'APARTMENT',
              area: 50,
              monthlyRent: a.rent,
              voluntaryTaxLiability: false,
            },
          }),
        )
        await step(() =>
          db.lease.create({
            data: {
              id: a.leaseId,
              organizationId: a.orgId,
              tenantId: a.id,
              unitId: a.unitId,
              contractNumber: a.leaseId,
              status: 'ACTIVE',
              startDate: new Date(`${YEAR}-01-01`),
              tenancyStartDate: new Date(`${YEAR}-01-01`),
              endDate: null,
              monthlyRent: a.rent,
              monthlyRentExcludingVat: false,
              depositAmount: 0,
            },
          }),
        )
        a.token = (await step(() => auth.createSessionForTenant(a.id))).sessionToken
      }
      await step(() =>
        db.rentNotice.create({
          data: {
            id: foreignNoticeId,
            organizationId: foreign.id,
            tenantId: outsider.id,
            leaseId: outsider.leaseId,
            noticeNumber: `FOREIGN-${foreignNoticeId}`,
            ocrNumber: 'foreign-synthetic-ocr',
            ...PERIOD,
            amount: outsider.rent,
            totalAmount: outsider.rent,
            dueDate: new Date(`${DUE}T12:00:00Z`),
            status: 'SENT',
            sentAt: new Date(),
            sentTo: outsider.email,
          },
        }),
      )
      ownerToken = jwt.sign({ sub: own.userId, organizationId: own.id, role: 'OWNER' })
      reviewerToken = jwt.sign({ sub: reviewerId, organizationId: own.id, role: 'ACCOUNTANT' })
      foreignToken = jwt.sign({ sub: foreign.userId, organizationId: foreign.id, role: 'OWNER' })
    }),
  )

  it('blockerar före verkställning och visar därefter bara rätt skickade avi, utan dubbla effekter', () =>
    phase(async () => {
      const foreignBefore = await sentinel(),
        empty = await financial()
      expect(empty).toMatchObject({
        notices: [],
        journals: [],
        noticeSequence: [],
        ocrSequence: [],
        journalSequence: [],
        payments: 0,
        deposits: 0,
        bankRows: 0,
      })
      expect(empty.tenantOcr).toEqual(
        actors
          .map((a) => a.id)
          .sort()
          .map((id) => ({ id, ocrNumber: null })),
      )
      expect(
        (await http('PUT', '/v1/kundstart/cutover', undefined, { cutoverDate: CUTOVER }))
          .statusCode,
      ).toBe(401)
      expect(
        (await http('PUT', '/v1/kundstart/cutover', reviewerToken, { cutoverDate: CUTOVER }))
          .statusCode,
      ).toBe(403)
      expect(
        await request('PUT', '/v1/kundstart/cutover', 200, { cutoverDate: CUTOVER }),
      ).toMatchObject({ cutoverDate: CUTOVER, setById: own.userId })
      const pkg = await request<PackageView>('POST', '/v1/kundstart/opening-packages', 201, {
        sourceName: 'synthetic-zero.csv',
        innehall: IMPORT_HEADER_207,
        nollOppning: true,
      })
      const base = `/v1/kundstart/opening-packages/${pkg.id}`
      expect(pkg.status).toBe('DRAFT')
      expect((await http('GET', base, foreignToken)).statusCode).toBe(404)
      const baseline = await assertBlocked()
      // Befintligt kontrakt tillåter OCR i egen TX före avi-/intäktsspärren.
      // Tilldelningen sker här, inte i seed: exakt två egna id:n och två kända nummer.
      const ownTenantIds = actors.map((a) => a.id).sort()
      expect(baseline.tenantOcr.map((t) => t.id)).toEqual(ownTenantIds)
      expect(baseline.tenantOcr.map((t) => t.ocrNumber).sort()).toEqual([
        '00000000019',
        '00000000028',
      ])
      const allocatedOcr = new Map(baseline.tenantOcr.map((t) => [t.id, t.ocrNumber]))
      expect(baseline).toEqual({
        ...empty,
        tenantOcr: ownTenantIds.map((id) => ({ id, ocrNumber: allocatedOcr.get(id) })),
        ocrSequence: [{ organizationId: own.id, lastNumber: 2, updatedAt: expect.any(Date) }],
      })
      // Hela observerade snapshoten, inklusive sekvensens DB-tid, är nu fryst facit.
      // Avier, journaler, dokumentnummer, betalningar, depositioner och bank är orörda.
      // Anslutningsidentiteten finns redan när paketets validering binder den.
      await step(() =>
        db.fortnoxConnection.create({
          data: {
            id: connectionId,
            organizationId: own.id,
            status: 'ACTIVE',
            fortnoxDatabaseNumber: 990301,
            fortnoxOrgNumber: orgNumber,
            connectedAt: new Date(Date.now() - 3600000),
            exportVoucherSeries: 'A',
          },
        }),
      )
      expect(await request('POST', `${base}/validate`, 200, {})).toMatchObject({
        status: 'VALIDATED',
        felrader: 0,
      })
      expect(await financial()).toEqual(baseline)
      await assertBlocked(baseline)

      // Endast extern saldokälla är syntetisk. Paket/evidens/status går via verklig HTTP.
      await step(() =>
        db.fortnoxReadRun.create({
          data: {
            id: readId,
            organizationId: own.id,
            connectionId,
            fortnoxDatabaseNumber: 990301,
            workVersion: null,
            status: 'COMPLETE',
            financialYearId: 1,
            financialYearStart: new Date(`${YEAR}-01-01`),
            financialYearEnd: new Date(`${YEAR}-12-31`),
            periodFrom: new Date(`${YEAR}-01-01`),
            periodTo: new Date(AS_OF),
            costAccounts: [1510, 2890],
            startedAt: new Date(),
            completedAt: new Date(),
            summary: { balanceBroughtForwardOre: { '1510': 0, '2890': 0 } },
            rows: { rows: [], references: [] },
          },
        }),
      )
      await request('POST', `${base}/fortnox-read`, 200, { readRunId: readId })
      await request('PUT', `${base}/first-period-register`, 200, {
        filnamn: 'synthetic-first-period.csv',
        innehall: 'radId;hyresgast;avtal;periodAr;periodManad;dokument;fakturerat;betalt',
        system: 'Syntetiskt tidigare system',
        ansvarig: 'Syntetisk ansvarig',
        tackningFran: CUTOVER,
        tackningTill: `${YEAR}-12-31`,
        intaktskonton: [3911],
        forskottskonton: [2420],
      })
      const evidence = await request<{
        id: string
        evidenceSha256: string
        comparisonStatus: string
      }>('POST', `${base}/evidence`, 201, {
        ...fixtureEvidenceInput(
          orgNumber,
          new Date(CUTOVER),
          SOURCE_HEADER,
          MAPPING_HEADER,
          'SYNTHETIC_ZERO',
        ),
        sourceExportedAt: `${YEAR}-11-01T00:00:00.000Z`,
      })
      expect(evidence.comparisonStatus).toBe('OK')
      expect(await financial()).toEqual(baseline)
      const approval = {
        version: pkg.version,
        sourceSha256: pkg.sourceSha256,
        evidenceSha256: evidence.evidenceSha256,
      }
      expect((await http('POST', `${base}/approve`, ownerToken, approval)).statusCode).toBe(409)
      expect(
        (
          await http('POST', `${base}/evidence/${evidence.id}/review`, ownerToken, {
            evidenceSha256: evidence.evidenceSha256,
          })
        ).statusCode,
      ).toBe(403)
      await request(
        'POST',
        `${base}/evidence/${evidence.id}/review`,
        200,
        { evidenceSha256: evidence.evidenceSha256 },
        reviewerToken,
      )
      expect(
        await step(() =>
          observed().openingEvidenceReview.findUniqueOrThrow({
            where: { evidenceId: evidence.id },
          }),
        ),
      ).toMatchObject({
        organizationId: own.id,
        reviewerUserId: reviewerId,
        evidenceSha256: evidence.evidenceSha256,
      })
      expect(await request('POST', `${base}/approve`, 200, approval)).toMatchObject({
        status: 'APPROVED',
        approvedEvidenceId: evidence.id,
        approvedById: own.userId,
      })
      expect(await financial()).toEqual(baseline)
      await assertBlocked(baseline)
      expect(await request('POST', `${base}/execute`, 200, {})).toMatchObject({
        status: 'EXECUTED',
        fordringar: 0,
        depositioner: 0,
      })
      const executed = await step(() =>
        observed().openingPackage.findUniqueOrThrow({ where: { id: pkg.id } }),
      )
      expect(executed).toMatchObject({
        status: 'EXECUTED',
        zeroOpening: true,
        executedById: own.userId,
      })
      expect(executed.executedAt).toBeInstanceOf(Date)
      expect(await financial()).toEqual(baseline)
      expect(
        await step(() => observed().openingPackageRow.count({ where: { packageId: pkg.id } })),
      ).toBe(0)
      expect(
        await step(() =>
          observed().openingExecutedSource.count({ where: { organizationId: own.id } }),
        ),
      ).toBe(0)
      expect(await request('POST', `${base}/execute`, 200, {})).toEqual({
        status: 'EXECUTED',
        redanVerkstallt: true,
        id: pkg.id,
      })
      expect(
        await step(() => observed().openingPackage.findUniqueOrThrow({ where: { id: pkg.id } })),
      ).toEqual(executed)
      expect(await financial()).toEqual(baseline)

      expect(await request('POST', '/v1/avisering/generate/preview', 200, PERIOD)).toEqual({
        ...PERIOD,
        toCreate: 2,
        skipped: 0,
        dueDates: [{ dueDate: DUE, count: 2 }],
        existingDueDates: [],
        beforeCutover: null,
      })
      expect(await financial()).toEqual(baseline)
      const generated = await request<{ notices: Array<{ id: string }> }>(
        'POST',
        '/v1/avisering/generate',
        201,
        PERIOD,
      )
      expect(generated).toMatchObject({
        created: 2,
        skipped: 0,
        failed: 0,
        blockedByOpening: 0,
        blockedReason: null,
      })
      const saved = await financial()
      expect(saved.notices).toHaveLength(2)
      expect(saved.journals).toHaveLength(2)
      expect(generated.notices.map((n) => n.id).sort()).toEqual(
        saved.notices.map((n) => n.id).sort(),
      )
      expect(saved.journals.map((j) => j.verNumber)).toEqual([1, 2])
      expect(saved.noticeSequence).toEqual([
        expect.objectContaining({ organizationId: own.id, ...PERIOD, lastNumber: 2 }),
      ])
      expect(saved.ocrSequence).toEqual(baseline.ocrSequence)
      expect(saved.tenantOcr).toEqual(baseline.tenantOcr)
      expect(saved.journalSequence).toEqual([
        expect.objectContaining({
          organizationId: own.id,
          fiscalYear: YEAR,
          series: 'A',
          lastNumber: 2,
        }),
      ])
      expect(new Set(saved.notices.map((n) => n.ocrNumber)).size).toBe(2)
      let debit = 0,
        credit = 0
      for (const a of actors) {
        const n = saved.notices.find((row) => row.leaseId === a.leaseId)!
        expect(n).toMatchObject({
          tenantId: a.id,
          type: 'RENT',
          origin: 'EVENO',
          ...PERIOD,
          daysCharged: 30,
          totalDays: 30,
          isProrated: false,
        })
        expect([Number(n.amount), Number(n.vatAmount), Number(n.totalAmount)]).toEqual([
          a.rent,
          0,
          a.rent,
        ])
        expect([day(n.periodStart), day(n.periodEnd), civil(n.dueDate)]).toEqual([
          CUTOVER,
          PERIOD_END,
          DUE,
        ])
        expect(n.ocrNumber).toBe(allocatedOcr.get(a.id))
        expect(n.ocrNumber).toMatch(/^\d{11}$/)
        const j = saved.journals.find((row) => row.sourceId === `rent-notice:${n.id}`)!
        expect(j).toMatchObject({
          organizationId: own.id,
          source: 'INVOICE',
          series: 'A',
          fiscalYear: YEAR,
          createdById: null,
        })
        expect(day(j.date)).toBe(CUTOVER)
        expect(
          j.lines.map((l) => ({
            account: l.account.number,
            org: l.account.organizationId,
            debit: l.debit === null ? null : Number(l.debit),
            credit: l.credit === null ? null : Number(l.credit),
          })),
        ).toEqual([
          { account: 1510, org: own.id, debit: a.rent, credit: null },
          { account: 3911, org: own.id, debit: null, credit: a.rent },
        ])
        debit += j.lines.reduce((sum, l) => sum + Number(l.debit ?? 0), 0)
        credit += j.lines.reduce((sum, l) => sum + Number(l.credit ?? 0), 0)
        notices.push({ id: n.id, noticeNumber: n.noticeNumber, ocrNumber: n.ocrNumber, actor: a })
      }
      expect([debit, credit, saved.payments, saved.deposits, saved.bankRows]).toEqual([
        16750, 16750, 0, 0, 0,
      ])
      expect((await delivery()).every((n) => n.status === 'PENDING' && n.sentAt === null)).toBe(
        true,
      )
      for (const n of notices) {
        await assertPortal(n.actor, [])
        expect((await http('GET', pdfPath(n.id), n.actor.token)).statusCode).toBe(404)
      }
      expect([rendered, accepted.length, jobs.length]).toEqual([0, 0, 0])
      expect(await request('POST', '/v1/avisering/generate', 201, PERIOD)).toEqual({
        created: 0,
        skipped: 2,
        failed: 0,
        notices: [],
        beforeCutover: null,
        blockedByOpening: 0,
        blockedReason: null,
      })
      expect(await financial()).toEqual(saved)
      expect(
        await request('POST', '/v1/avisering/send', 202, { noticeIds: notices.map((n) => n.id) }),
      ).toEqual({
        queued: 2,
        failed: 0,
        blocked: 0,
        blockedReason: null,
        jobIds: ['local-job-1', 'local-job-2'],
      })
      expect(jobs).toEqual(
        notices.map((n) => ({ kind: 'avisering-send', organizationId: own.id, noticeId: n.id })),
      )
      const sentIds = new Set<string>()
      while (jobs.length) {
        const job = jobs.shift()!
        await step(() => avisering.processNoticeSendJob(job.organizationId, job.noticeId))
        sentIds.add(job.noticeId)
        expect(accepted).toHaveLength(sentIds.size)
        for (const n of notices) await assertPortal(n.actor, sentIds.has(n.id) ? [n.id] : [])
      }
      const sent = await delivery()
      for (const row of sent) {
        const n = notices.find((x) => x.id === row.id)!
        expect(row).toEqual({
          id: n.id,
          status: 'SENT',
          sentAt: expect.any(Date),
          sentTo: n.actor.email,
          sendError: null,
        })
        const response = await http('GET', pdfPath(n.id), n.actor.token)
        expect(response.statusCode).toBe(200)
        expect(response.headers['content-type']).toContain('application/pdf')
        expect(response.headers['content-disposition']).toContain(n.noticeNumber)
        expect(response.rawPayload).toEqual(pdfBytes(own.id, n.id))
        const before = rendered
        const other = actors.find((a) => a.id !== n.actor.id)!
        for (const token of [other.token, outsider.token])
          expect((await http('GET', pdfPath(n.id), token)).statusCode).toBe(404)
        expect((await http('GET', pdfPath(foreignNoticeId), n.actor.token)).statusCode).toBe(404)
        expect(rendered).toBe(before)
      }
      await assertPortal(outsider, [foreignNoticeId])
      const beforeReplay = rendered
      for (const n of notices) await step(() => avisering.processNoticeSendJob(own.id, n.id))
      expect([rendered, accepted.length, queued]).toEqual([beforeReplay, 2, 2])
      expect(await delivery()).toEqual(sent)
      expect(await financial()).toEqual(saved)
      expect(
        await step(() => observed().openingPackage.findUniqueOrThrow({ where: { id: pkg.id } })),
      ).toEqual(executed)
      expect(await sentinel()).toEqual(foreignBefore)
      expect(
        await step(() =>
          observed().fortnoxCustomerActivation.count({ where: { organizationId: own.id } }),
        ),
      ).toBe(0)
      expect(forbidden).toEqual([])
    }))

  afterAll(async () => {
    stopped = true // Första åtgärden, även när Jest har övergett testpromisen.
    const deadline = performance.now() + LOCAL_BUDGET_MS
    const failures: unknown[] = []
    let cleanup: PrismaClient | undefined
    let remaining: Record<string, number> | undefined
    async function cleanupStep<T>(work: () => T | PromiseLike<T>): Promise<T> {
      assertCleanupTime(deadline)
      // Kontroll även inne i microtasken: inte ens en ny DELETE får starta för sent.
      const promise = track(() => {
        assertCleanupTime(deadline)
        return work()
      })
      return until(promise, deadline)
    }
    try {
      await drain(deadline)
      // Ingen radering om close kastar, tidsgränsen nås eller dess promise lever kvar.
      if (app) await cleanupStep(() => app!.close())
      else if (compiledModule) await cleanupStep(() => compiledModule!.close())
      app = undefined
      compiledModule = undefined
      if (observer) await cleanupStep(() => observed().$disconnect())
      observer = undefined
      if (observerUrl) {
        assertCleanupTime(deadline)
        const client = new PrismaClient({
          datasources: { db: { url: observerUrl } },
          transactionOptions: PRISMA_DEFAULT_TX_LIMITS,
        })
        cleanup = client
        const scope = { organizationId: { in: orgIds } },
          tenantIds = allActors.map((a) => a.id)
        const owned = await cleanupStep(() =>
          client.organization.findMany({
            where: { id: { in: orgIds } },
            select: { id: true, name: true },
          }),
        )
        for (const row of owned)
          expect(organizations.map(({ id, name }) => ({ id, name }))).toContainEqual(row)
        const noticeIds = (
          await cleanupStep(() =>
            client.rentNotice.findMany({ where: scope, select: { id: true } }),
          )
        ).map((n) => n.id)
        const journalIds = (
          await cleanupStep(() =>
            client.journalEntry.findMany({ where: scope, select: { id: true } }),
          )
        ).map((j) => j.id)
        const packageIds = (
          await cleanupStep(() =>
            client.openingPackage.findMany({ where: scope, select: { id: true } }),
          )
        ).map((p) => p.id)
        const noticeChildren = { rentNoticeId: { in: noticeIds } },
          journalChildren = { journalEntryId: { in: journalIds } }
        await cleanupStep(() => client.journalEntryLine.deleteMany({ where: journalChildren }))
        await cleanupStep(() => client.journalEntry.deleteMany({ where: scope }))
        await cleanupStep(() => client.journalEntrySequence.deleteMany({ where: scope }))
        await cleanupStep(() =>
          client.rentNoticePayment.deleteMany({ where: { rentNotice: scope } }),
        )
        await cleanupStep(() => client.rentNoticeEvent.deleteMany({ where: noticeChildren }))
        await cleanupStep(() => client.rentNoticeSend.deleteMany({ where: noticeChildren }))
        await cleanupStep(() => client.rentNoticeLine.deleteMany({ where: noticeChildren }))
        await cleanupStep(() => client.rentNotice.deleteMany({ where: scope }))
        await cleanupStep(() => client.deposit.deleteMany({ where: scope }))
        await cleanupStep(() => client.fortnoxCustomerActivation.deleteMany({ where: scope }))
        await cleanupStep(() => client.openingExecutedSource.deleteMany({ where: scope }))
        // Paketets borttagning tar dess evidens/review via riktiga FK-cascades.
        await cleanupStep(() => client.openingPackage.deleteMany({ where: scope }))
        await cleanupStep(() => client.fortnoxReadRun.deleteMany({ where: scope }))
        await cleanupStep(() => client.fortnoxConnection.deleteMany({ where: scope }))
        await cleanupStep(() => client.account.deleteMany({ where: scope }))
        await cleanupStep(() =>
          client.tenantSession.deleteMany({ where: { tenantId: { in: tenantIds } } }),
        )
        await cleanupStep(() => client.lease.deleteMany({ where: scope }))
        await cleanupStep(() =>
          client.unit.deleteMany({ where: { id: { in: allActors.map((a) => a.unitId) } } }),
        )
        await cleanupStep(() => client.property.deleteMany({ where: scope }))
        await cleanupStep(() => client.tenant.deleteMany({ where: scope }))
        await cleanupStep(() =>
          client.user.deleteMany({ where: { id: { in: userIds }, ...scope } }),
        )
        await cleanupStep(() => client.tenantOcrSequence.deleteMany({ where: scope }))
        await cleanupStep(() => client.rentNoticeNumberSequence.deleteMany({ where: scope }))
        await cleanupStep(() => client.organization.deleteMany({ where: { id: { in: orgIds } } }))
        remaining = {
          organizations: await cleanupStep(() =>
            client.organization.count({ where: { id: { in: orgIds } } }),
          ),
          users: await cleanupStep(() => client.user.count({ where: { id: { in: userIds } } })),
          tenants: await cleanupStep(() =>
            client.tenant.count({ where: { id: { in: tenantIds } } }),
          ),
          sessions: await cleanupStep(() =>
            client.tenantSession.count({ where: { tenantId: { in: tenantIds } } }),
          ),
          properties: await cleanupStep(() =>
            client.property.count({
              where: { id: { in: organizations.map((o) => o.propertyId) } },
            }),
          ),
          units: await cleanupStep(() =>
            client.unit.count({ where: { id: { in: allActors.map((a) => a.unitId) } } }),
          ),
          leases: await cleanupStep(() =>
            client.lease.count({ where: { id: { in: allActors.map((a) => a.leaseId) } } }),
          ),
          notices: await cleanupStep(() => client.rentNotice.count({ where: scope })),
          noticeLines: await cleanupStep(() =>
            client.rentNoticeLine.count({ where: noticeChildren }),
          ),
          events: await cleanupStep(() => client.rentNoticeEvent.count({ where: noticeChildren })),
          sends: await cleanupStep(() => client.rentNoticeSend.count({ where: noticeChildren })),
          payments: await cleanupStep(() =>
            client.rentNoticePayment.count({ where: noticeChildren }),
          ),
          accounts: await cleanupStep(() => client.account.count({ where: scope })),
          journals: await cleanupStep(() => client.journalEntry.count({ where: scope })),
          journalLines: await cleanupStep(() =>
            client.journalEntryLine.count({ where: journalChildren }),
          ),
          noticeSequence: await cleanupStep(() =>
            client.rentNoticeNumberSequence.count({ where: scope }),
          ),
          ocrSequence: await cleanupStep(() => client.tenantOcrSequence.count({ where: scope })),
          journalSequence: await cleanupStep(() =>
            client.journalEntrySequence.count({ where: scope }),
          ),
          packages: await cleanupStep(() => client.openingPackage.count({ where: scope })),
          packageRows: await cleanupStep(() =>
            client.openingPackageRow.count({ where: { packageId: { in: packageIds } } }),
          ),
          evidence: await cleanupStep(() => client.openingEvidence.count({ where: scope })),
          reviews: await cleanupStep(() => client.openingEvidenceReview.count({ where: scope })),
          executedSources: await cleanupStep(() =>
            client.openingExecutedSource.count({ where: scope }),
          ),
          reads: await cleanupStep(() => client.fortnoxReadRun.count({ where: scope })),
          connections: await cleanupStep(() => client.fortnoxConnection.count({ where: scope })),
          activations: await cleanupStep(() =>
            client.fortnoxCustomerActivation.count({ where: scope }),
          ),
          deposits: await cleanupStep(() => client.deposit.count({ where: scope })),
          bankRows: await cleanupStep(() => client.bankTransaction.count({ where: scope })),
        }
        expect(Object.values(remaining)).toEqual(Object.keys(remaining).map(() => 0))
      }
    } catch (error) {
      failures.push(error)
    } finally {
      // Ingen fördröjd .then-cleanup. Om något fortfarande körs lämnas ägda data.
      // Frånkoppling är också ett budgeterat steg, aldrig ett cancel-löfte.
      for (const client of [cleanup, observer, db]) {
        if (!client || inFlight.size > 0 || performance.now() >= deadline) continue
        try {
          await cleanupStep(() => client.$disconnect())
        } catch (error) {
          failures.push(error)
        }
      }
    }
    if (inFlight.size > 0 || performance.now() >= deadline || !remaining || failures.length > 0) {
      process.stdout.write(
        '[portal-kundstart cleanup] ' +
          JSON.stringify({
            cleanupStatus: 'INCOMPLETE',
            organizationIds: orgIds,
            userIds,
            tenantIds: allActors.map((a) => a.id),
            unitIds: allActors.map((a) => a.unitId),
            leaseIds: allActors.map((a) => a.leaseId),
            propertyIds: organizations.map((o) => o.propertyId),
            connectionId,
            readId,
            foreignNoticeId,
          }) +
          '\n',
      )
      throw new AggregateError(
        failures,
        'FIXTURE_CLEANUP_INCOMPLETE: inget nollbevis; ägda UUID-fixturer måste kontrolleras efter verklig settlement',
      )
    }
    process.stdout.write(
      '[portal-kundstart cleanup] ' +
        JSON.stringify({ cleanupStatus: 'COMPLETE', remaining }) +
        '\n',
    )
    expect(forbidden).toEqual([])
  })
})
