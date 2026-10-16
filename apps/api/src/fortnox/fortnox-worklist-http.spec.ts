/** Riktig controller, JWT, rollgrind och produktionspipe; inga externa tjänster. */
import { ValidationPipe, VersioningType } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { JwtStrategy } from '../auth/strategies/jwt.strategy'
import { VALIDATION_PIPE_OPTIONS } from '../common/contract/validation-pipe-options'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { TransformInterceptor } from '../common/interceptors/transform.interceptor'
import { FortnoxConnectionService } from './fortnox-connection.service'
import { FortnoxController } from './fortnox.controller'
import { FortnoxExportService } from './fortnox-export.service'
import { FortnoxKontomappningService } from './fortnox-kontomappning.service'
import { FortnoxMappingService } from './fortnox-mapping.service'
import { FortnoxReadbackService } from './fortnox-readback.service'
import { FortnoxSendService } from './fortnox-send.service'

const SECRET = 'syntetisk-fortnox-arbetslista-http-hemlighet'

describe('Fortnox arbetslista genom HTTP', () => {
  let app: NestFastifyApplication
  const listPage = jest.fn()
  const expireLeases = jest.fn()
  const token = (role: string, organizationId = 'org-A') =>
    new JwtService({ secret: SECRET }).sign({ sub: 'syntetisk-user', organizationId, role })
  const get = (query = '', auth: string | null = token('OWNER')) =>
    app.inject({
      method: 'GET',
      url: `/v1/integrations/fortnox/exports-page${query ? `?${query}` : ''}`,
      headers: auth === null ? {} : { authorization: `Bearer ${auth}` },
    })

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [FortnoxController],
      providers: [
        JwtStrategy,
        { provide: ConfigService, useValue: { getOrThrow: () => SECRET } },
        { provide: FortnoxConnectionService, useValue: {} },
        { provide: FortnoxReadbackService, useValue: {} },
        { provide: FortnoxExportService, useValue: { listPage } },
        { provide: FortnoxMappingService, useValue: {} },
        { provide: FortnoxSendService, useValue: { expireLeases } },
        { provide: FortnoxKontomappningService, useValue: {} },
      ],
    }).compile()
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    })
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS))
    app.useGlobalGuards(new JwtAuthGuard(new Reflector()), new RolesGuard(new Reflector()))
    app.useGlobalInterceptors(new TransformInterceptor())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  beforeEach(() => {
    listPage.mockReset().mockImplementation(async (_org, input) => ({
      items: [],
      total: 0,
      offset: input.offset ?? 0,
      limit: input.limit ?? 50,
    }))
    expireLeases.mockReset().mockResolvedValue(undefined)
  })

  afterAll(async () => app?.close())

  it.each(['OWNER', 'ADMIN'])('%s får typad sida med organisation endast ur JWT', async (role) => {
    const response = await get(
      'offset=50&limit=25&group=NEEDS_REVIEW&from=2025-01-01&to=2025-12-31&source=PAYMENT',
      token(role, 'org-B'),
    )
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      success: true,
      data: { items: [], total: 0, offset: 50, limit: 25 },
    })
    expect(listPage).toHaveBeenCalledWith(
      'org-B',
      expect.objectContaining({
        offset: 50,
        limit: 25,
        group: 'NEEDS_REVIEW',
        from: '2025-01-01',
        to: '2025-12-31',
        source: 'PAYMENT',
      }),
    )
    expect(expireLeases).toHaveBeenCalledWith('org-B')
  })

  it('utelämnade queryval ger första sidan utan dold datumbegränsning', async () => {
    expect((await get()).statusCode).toBe(200)
    const input = listPage.mock.calls[0]![1] as Record<string, unknown>
    expect(input.from).toBeUndefined()
    expect(input.to).toBeUndefined()
  })

  it.each([null, 'felaktig-token'])('utan giltig JWT %s nekas före tjänsten', async (auth) => {
    expect((await get('', auth)).statusCode).toBe(401)
    expect(listPage).not.toHaveBeenCalled()
    expect(expireLeases).not.toHaveBeenCalled()
  })

  it.each(['MANAGER', 'ACCOUNTANT', 'VIEWER', 'TENANT', 'OKAND'])(
    'rollen %s nekas före tjänsten',
    async (role) => {
      expect((await get('', token(role))).statusCode).toBe(403)
      expect(listPage).not.toHaveBeenCalled()
      expect(expireLeases).not.toHaveBeenCalled()
    },
  )

  it.each([
    'organizationId=org-B',
    '__kontraktsvillkor=ok',
    'offset=12abc',
    'offset=-1',
    'offset=01',
    'limit=0',
    'limit=201',
    'limit=5&limit=6',
    'from=2025-02-30',
    'from=2026-01-02&to=2026-01-01',
    'group=ALLT',
    'source=OKAND',
  ])('ogiltig query %s nekas innan leasekontroll eller läsning', async (query) => {
    expect((await get(query)).statusCode).toBe(400)
    expect(listPage).not.toHaveBeenCalled()
    expect(expireLeases).not.toHaveBeenCalled()
  })
})
