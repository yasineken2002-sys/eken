import { Test } from '@nestjs/testing'
import { Reflector } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import type { ExecutionContext } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { ReadingReviewController } from './reading-review.controller'
import { ReadingReviewService } from './reading-review.service'
import { PrismaService } from '../common/prisma/prisma.service'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { TransformInterceptor } from '../common/interceptors/transform.interceptor'

// HTTP-kopplingen, verklig rollgrind, OrgId och svarskuvert. Bara JWT-identitet
// och Prisma ersätts; detta är inte ett prov på tokenvalidering eller Postgres.
describe('GET consumption/reading-review', () => {
  let app: NestFastifyApplication
  const findMany = jest.fn()
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ReadingReviewController],
      providers: [
        ReadingReviewService,
        { provide: PrismaService, useValue: { meterReading: { findMany } } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const request = context.switchToHttp().getRequest()
          request.user = { organizationId: 'session-org', role: request.headers['x-test-role'] }
          return true
        },
      })
      .compile()
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    })
    // Samma ordning som AuthModule: identitet först, rollgrind sedan.
    app.useGlobalGuards(app.get(JwtAuthGuard), new RolesGuard(new Reflector()))
    app.useGlobalInterceptors(new TransformInterceptor())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })
  afterAll(async () => {
    await app.close()
  })
  beforeEach(() => {
    findMany.mockReset().mockResolvedValue([])
  })
  it.each(['OWNER', 'ADMIN', 'MANAGER', 'ACCOUNTANT', 'VIEWER'])(
    'låter %s läsa men tar organisationen ur sessionen',
    async (role) => {
      const response = await app.inject({
        method: 'GET',
        url: '/consumption/reading-review?organizationId=other&meterId=other&periodStart=2026-09-01',
        headers: { 'x-test-role': role },
      })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ success: true, data: { total: 0, findings: [] } })
      expect(findMany.mock.calls[0]![0].where).toEqual({ organizationId: 'session-org' })
    },
  )
  it('nekar okänd roll innan data läses', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/consumption/reading-review',
      headers: { 'x-test-role': 'UNKNOWN' },
    })
    expect(response.statusCode).toBe(403)
    expect(findMany).not.toHaveBeenCalled()
  })
  it('serialiserar Decimal, datum, underlag och fingerprint genom svarskuvertet', async () => {
    findMany.mockResolvedValue(
      [10, 10, 10, 40].map((value, i) => ({
        id: String(i),
        organizationId: 'session-org',
        meterId: 'meter',
        readingType: 'PERIOD_VOLUME',
        value: new Prisma.Decimal(value),
        periodStart: new Date(Date.UTC(2026, 0, i + 1)),
        periodEnd: new Date(Date.UTC(2026, 0, i + 1)),
      })),
    )
    const response = await app.inject({
      method: 'GET',
      url: '/consumption/reading-review',
      headers: { 'x-test-role': 'VIEWER' },
    })
    expect(response.statusCode).toBe(200)
    const report = response.json().data
    expect(report.findings[0].fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(report.findings[0].sourceReadings[0]).toMatchObject({
      value: '10',
      periodEnd: '2026-01-01T00:00:00.000Z',
    })
    expect(report.findings[0].trend.current).toMatchObject({ quantity: 40, days: 1, perDay: 40 })
  })
  it('visar fel vid DB-fel, inte en tom lyckad rapport', async () => {
    findMany.mockRejectedValue(new Error('offline'))
    const response = await app.inject({
      method: 'GET',
      url: '/consumption/reading-review',
      headers: { 'x-test-role': 'VIEWER' },
    })
    expect(response.statusCode).toBe(500)
    expect(response.json().success).not.toBe(true)
  })
})
