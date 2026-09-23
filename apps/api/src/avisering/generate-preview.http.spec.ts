jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { ValidationPipe } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { ConfigService } from '@nestjs/config'
import { Test } from '@nestjs/testing'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { PassportModule } from '@nestjs/passport'
import { JwtService } from '@nestjs/jwt'
import { JwtStrategy } from '../auth/strategies/jwt.strategy'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { AviseringController } from './avisering.controller'
import { AviseringService } from './avisering.service'

/** Real HTTP pipeline and guards; calculation/DB are covered by rent-calendar-day.db.spec. */
describe('POST /avisering/generate/preview', () => {
  let app: NestFastifyApplication
  const secret = 'calendar-test-secret-not-a-production-key'
  const jwt = new JwtService({ secret })
  const preview = jest.fn().mockResolvedValue({
    month: 10,
    year: 2026,
    toCreate: 0,
    skipped: 0,
    dueDates: [],
    existingDueDates: [],
  })
  beforeAll(async () => {
    const dependencies = Reflect.getMetadata('design:paramtypes', AviseringController) as Array<
      new (...args: never[]) => unknown
    >
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [AviseringController],
      providers: [
        ...dependencies.map((provide) => ({
          provide,
          useValue: provide === AviseringService ? { previewMonthlyNotices: preview } : {},
        })),
        JwtStrategy,
        { provide: ConfigService, useValue: new ConfigService({ JWT_SECRET: secret }) },
      ],
    }).compile()
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    app.useGlobalGuards(new JwtAuthGuard(new Reflector()), new RolesGuard(new Reflector()))
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    )
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })
  afterAll(async () => app?.close())
  beforeEach(() => preview.mockClear())

  const request = (role?: string, payload: unknown = { month: 10, year: 2026 }) =>
    app.inject({
      method: 'POST',
      url: '/avisering/generate/preview',
      payload: payload as object,
      headers: role
        ? {
            authorization: `Bearer ${jwt.sign({ sub: 'test-user', organizationId: 'own-org', role })}`,
          }
        : {},
    })

  it.each(['OWNER', 'ADMIN', 'MANAGER'])(
    '%s sees the server preview for their JWT organization',
    async (role) => {
      const response = await request(role)
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ month: 10, year: 2026, dueDates: [] })
      expect(preview).toHaveBeenCalledWith('own-org', 10, 2026)
    },
  )
  it.each(['VIEWER', 'ACCOUNTANT', 'UNKNOWN'])('%s cannot preview generation', async (role) => {
    expect((await request(role)).statusCode).toBe(403)
    expect(preview).not.toHaveBeenCalled()
  })
  it('requires authentication', async () => {
    expect((await request()).statusCode).toBe(401)
    expect(preview).not.toHaveBeenCalled()
  })
  it.each([
    { month: 0, year: 2026 },
    { month: 13, year: 2026 },
    { month: '10', year: 2026 },
    { month: 10 },
    { month: 10, year: 2026, organizationId: 'other-org' },
  ])('rejects invalid input %j before reading data', async (payload) => {
    expect((await request('OWNER', payload)).statusCode).toBe(400)
    expect(preview).not.toHaveBeenCalled()
  })
})
