jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('@sentry/nestjs', () => ({ withScope: jest.fn(), captureException: jest.fn() }))

import { Test } from '@nestjs/testing'
import { ConfigService } from '@nestjs/config'
import { JwtService } from '@nestjs/jwt'
import { Reflector } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { AccountingController } from '../accounting/accounting.controller'
import { AccountingService } from '../accounting/accounting.service'
import { AccountingPeriodService } from '../accounting/accounting-period.service'
import { SupplierInvoiceService } from '../accounting/supplier-invoice.service'
import { JwtStrategy } from '../auth/strategies/jwt.strategy'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { GlobalExceptionFilter } from '../common/filters/global-exception.filter'
import { TransformInterceptor } from '../common/interceptors/transform.interceptor'

const SECRET = 'synthetic-report-contract-http-key-not-for-deployment'
const route = '/accounting/reports/profit-loss?from=2026-09-01&to=2026-09-30'
const property = '11111111-2222-3333-4444-555555555555'

describe('rapportkontrakt genom JWT, roller, riktig controller/service och felfilter', () => {
  let app: NestFastifyApplication
  const prisma = {
    organization: { findUnique: jest.fn() },
    journalEntryLine: { findMany: jest.fn() },
  }
  const errors = { logInternalError: jest.fn().mockResolvedValue(undefined) }
  beforeAll(async () => {
    const accounting = new AccountingService(prisma as never, {} as never)
    const module = await Test.createTestingModule({
      controllers: [AccountingController],
      providers: [
        JwtStrategy,
        { provide: ConfigService, useValue: new ConfigService({ JWT_SECRET: SECRET }) },
        { provide: AccountingService, useValue: accounting },
        { provide: SupplierInvoiceService, useValue: {} },
        { provide: AccountingPeriodService, useValue: {} },
      ],
    }).compile()
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    const reflector = app.get(Reflector)
    app.useGlobalGuards(new JwtAuthGuard(reflector), new RolesGuard(reflector))
    app.useGlobalFilters(new GlobalExceptionFilter(errors as never))
    app.useGlobalInterceptors(new TransformInterceptor())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })
  afterAll(async () => {
    await app?.close()
  })
  beforeEach(() => {
    jest.clearAllMocks()
    prisma.organization.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        where.id === 'O-A' ? { ledgerOwner: 'EVENO', fiscalYearStartMonth: 1 } : null,
    )
    prisma.journalEntryLine.findMany.mockResolvedValue([
      { account: { number: 3911, name: 'Hyra' }, debit: 0, credit: 200000 },
      { account: { number: 5010, name: 'Drift' }, debit: 60000, credit: 0 },
    ])
  })
  function http(url = route, role: string | null = 'OWNER', org = 'O-A') {
    return app.inject({
      method: 'GET',
      url,
      headers:
        role === null
          ? {}
          : {
              authorization: `Bearer ${new JwtService({ secret: SECRET }).sign({ sub: 'U-A', organizationId: org, role })}`,
            },
    })
  }
  it.each(['OWNER', 'ADMIN', 'ACCOUNTANT', 'MANAGER'])(
    '%s får lokal org-rapport; query kan inte byta organisation',
    async (role) => {
      const res = await http(`${route}&organizationId=O-B`, role)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ success: true, data: { result: 140000 } })
      expect(
        prisma.journalEntryLine.findMany.mock.calls[0][0].where.journalEntry.organizationId,
      ).toBe('O-A')
    },
  )
  it.each(['VIEWER', 'UNKNOWN'])('%s nekas före läsning', async (role) => {
    expect((await http(route, role)).statusCode).toBe(403)
    expect(prisma.organization.findUnique).not.toHaveBeenCalled()
  })
  it('saknad JWT ger 401 före läsning', async () => {
    expect((await http(route, null)).statusCode).toBe(401)
    expect(prisma.organization.findUnique).not.toHaveBeenCalled()
  })
  it.each([property, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'])(
    'R01: eget/främmande/okänt fastighets-ID %s ger samma beloppsfria 409',
    async (id) => {
      const res = await http(`${route}&propertyId=${id}`)
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({
        success: false,
        error: {
          code: 'REPORT_NOT_DETERMINABLE',
          status: 'NOT_DETERMINABLE',
          reason: 'PROPERTY_ALLOCATION_UNVERIFIED',
        },
      })
      expect(res.json()).not.toHaveProperty('data')
      expect(res.body).not.toContain('140000')
      expect(prisma.journalEntryLine.findMany).not.toHaveBeenCalled()
    },
  )
  it.each([
    route,
    '/accounting/reports/vat?from=2026-09-01&to=2026-09-30',
    '/accounting/reports/balance-sheet?asOf=2026-09-30',
  ])('extern huvudbok avstår på %s utan lokal fallback', async (url) => {
    prisma.organization.findUnique.mockResolvedValue({
      ledgerOwner: 'FORTNOX',
      fiscalYearStartMonth: 1,
    })
    const res = await http(url)
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatchObject({
      code: 'REPORT_NOT_DETERMINABLE',
      reason: 'EXTERNAL_REPORT_UNAVAILABLE',
    })
    expect(prisma.journalEntryLine.findMany).not.toHaveBeenCalled()
  })
  it('saknad organisation blir inte lokal nollrapport', async () => {
    const res = await http(route, 'OWNER', 'O-MISSING')
    expect(res.statusCode).toBe(409)
    expect(res.json().error.reason).toBe('OWNER_UNVERIFIED')
    expect(prisma.journalEntryLine.findMany).not.toHaveBeenCalled()
  })
  it.each([
    '/accounting/reports/profit-loss?from=2026-02-30&to=2026-03-31',
    '/accounting/reports/profit-loss?from=2026-09-30&to=2026-09-01',
    `${route}&propertyId=not-a-uuid`,
  ])('fel period/format nekas med 400: %s', async (url) => {
    expect((await http(url)).statusCode).toBe(400)
    expect(prisma.journalEntryLine.findMany).not.toHaveBeenCalled()
    expect(errors.logInternalError).not.toHaveBeenCalled()
  })
})
