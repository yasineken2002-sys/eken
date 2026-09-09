import { Test } from '@nestjs/testing'
import { Reflector } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { ValidationPipe, type ExecutionContext } from '@nestjs/common'
import { VALIDATION_PIPE_OPTIONS } from '../common/contract/validation-pipe-options'
import { ReadingReviewFollowUpController } from './reading-review-follow-up.controller'
import { ReadingReviewFollowUpService } from './reading-review-follow-up.service'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { TransformInterceptor } from '../common/interceptors/transform.interceptor'

describe('uppföljning genom HTTP och produktionspipen', () => {
  let app: NestFastifyApplication
  const status = { enabled: false, enabledAt: null, lastCheckedAt: null, lastFailedAt: null }
  const service = { getStatus: jest.fn(), update: jest.fn() }
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ReadingReviewFollowUpController],
      providers: [{ provide: ReadingReviewFollowUpService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const request = context.switchToHttp().getRequest()
          request.user = {
            sub: 'session-user',
            organizationId: 'session-org',
            role: request.headers['x-test-role'],
          }
          return true
        },
      })
      .compile()
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    })
    app.useGlobalGuards(app.get(JwtAuthGuard), new RolesGuard(new Reflector()))
    app.useGlobalInterceptors(new TransformInterceptor())
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS))
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })
  afterAll(async () => {
    await app.close()
  })
  beforeEach(() => {
    service.getStatus.mockReset().mockResolvedValue(status)
    service.update.mockReset().mockResolvedValue(status)
  })
  it.each(['OWNER', 'ADMIN', 'MANAGER', 'ACCOUNTANT', 'VIEWER'])(
    '%s får läsa status ur sin egen org',
    async (role) => {
      const res = await app.inject({
        method: 'GET',
        url: '/consumption/reading-review/follow-up?organizationId=other',
        headers: { 'x-test-role': role },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().data).toEqual(status)
      expect(service.getStatus).toHaveBeenCalledWith('session-org')
    },
  )
  it.each(['ADMIN', 'MANAGER', 'ACCOUNTANT', 'VIEWER', 'UNKNOWN'])(
    '%s får inte ändra reglaget',
    async (role) => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/consumption/reading-review/follow-up',
        headers: { 'x-test-role': role },
        payload: { enabled: true },
      })
      expect(res.statusCode).toBe(403)
      expect(service.update).not.toHaveBeenCalled()
    },
  )
  it.each([true, false, 'false'])(
    'OWNER skickar %s med sessionens identitet och utan sanningskoercion',
    async (enabled) => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/consumption/reading-review/follow-up?organizationId=other',
        headers: { 'x-test-role': 'OWNER' },
        payload: { enabled },
      })
      expect(res.statusCode).toBe(200)
      expect(service.update).toHaveBeenCalledWith('session-org', 'session-user', {
        enabled: enabled === true,
      })
    },
  )
  it.each([
    {},
    { enabled: 'yes' },
    { enabled: 1 },
    { enabled: null },
    { enabled: true, organizationId: 'other' },
  ])('avvisar ogiltig kropp %j innan tjänsten', async (payload) => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/consumption/reading-review/follow-up',
      headers: { 'x-test-role': 'OWNER' },
      payload,
    })
    expect(res.statusCode).toBe(400)
    expect(service.update).not.toHaveBeenCalled()
  })
})
