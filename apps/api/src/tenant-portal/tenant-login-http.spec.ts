// Endast tunga blad ersätts. Routing, controller, DTO, valideringspipe och
// svarshölje är riktiga; lösenordsjämförelse/Redis/DB provas i egna sviter.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../contracts/contract-template.service', () => ({ ContractTemplateService: class {} }))
jest.mock('../mail/mail.service', () => ({ MailService: class {} }))

import { ValidationPipe, VersioningType } from '@nestjs/common'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { TenantLoginResolveResultSchema } from '@eken/shared'
import { VALIDATION_PIPE_OPTIONS } from '../common/contract/validation-pipe-options'
import { TransformInterceptor } from '../common/interceptors/transform.interceptor'
import { PrismaService } from '../common/prisma/prisma.service'
import { ContractTemplateService } from '../contracts/contract-template.service'
import { StorageService } from '../storage/storage.service'
import { TenantAuthService } from './tenant-auth.service'
import { TenantBankIdService } from './tenant-bankid.service'
import { TenantAuthController } from './tenant-portal.controller'

const ORG_A = '40000000-0000-4000-8000-000000000001'
const ORG_B = '40000000-0000-4000-8000-000000000002'
const TENANT_ID = '50000000-0000-4000-8000-000000000001'
const EMAIL = 'portal-http@example.invalid'
const PASSWORD = 'Syntetiskt-Losenord-123!'
const EXPIRES_AT = new Date('2026-11-16T10:30:00.000Z')
const INTERNAL = 'INTERNAL-MUST-NOT-REACH-HTTP'

const NAMES = [
  { firstName: 'Ada', lastName: 'Test', companyName: null },
  { firstName: null, lastName: null, companyName: 'Syntetiska hyresgästen AB' },
] as const

function tenantSummary(names: (typeof NAMES)[number]) {
  return { id: TENANT_ID, ...names, email: EMAIL }
}

function sessionResult(names: (typeof NAMES)[number] = NAMES[0]) {
  return {
    sessionToken: 'synthetic-session-token',
    expiresAt: EXPIRES_AT,
    internalSessionId: INTERNAL,
    tenant: {
      ...tenantSummary(names),
      organizationId: ORG_A,
      organization: { id: ORG_A, name: 'Intern organisationsrelation' },
      passwordHash: INTERNAL,
      activationTokenHash: INTERNAL,
      passwordResetTokenHash: INTERNAL,
      personalNumberEnc: INTERNAL,
      personalNumberHash: INTERNAL,
      phone: INTERNAL,
      sessions: [{ tokenHash: INTERNAL }],
    },
  }
}

function publicSession(names: (typeof NAMES)[number] = NAMES[0]) {
  return {
    sessionToken: 'synthetic-session-token',
    expiresAt: '2026-11-16T10:30:00.000Z',
    tenant: tenantSummary(names),
  }
}

describe('portalens lösenordsinloggning över HTTP', () => {
  let app: NestFastifyApplication
  // Bred returtyp är avsiktlig: även förbjudna extra tjänstefält måste tas bort
  // av den riktiga controllern. Metodernas inkommande argument är typkontrollerade.
  const login = jest.fn<Promise<unknown>, Parameters<TenantAuthService['login']>>()
  const resolveLogin = jest.fn<Promise<unknown>, Parameters<TenantAuthService['resolveLogin']>>()

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [TenantAuthController],
      providers: [
        { provide: TenantAuthService, useValue: { login, resolveLogin } },
        { provide: PrismaService, useValue: {} },
        { provide: StorageService, useValue: {} },
        { provide: ContractTemplateService, useValue: {} },
        { provide: TenantBankIdService, useValue: {} },
      ],
    }).compile()
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ trustProxy: 1 }),
    )
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS))
    app.useGlobalInterceptors(new TransformInterceptor())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  afterAll(async () => app?.close())

  beforeEach(() => {
    login.mockReset().mockResolvedValue(sessionResult())
    resolveLogin.mockReset().mockResolvedValue({ status: 'complete', result: sessionResult() })
  })

  const request = (route: string, payload: object = { email: EMAIL, password: PASSWORD }) =>
    app.inject({ method: 'POST', url: `/v1/tenant-portal/${route}`, payload })

  it('choose innehåller exakt två hyresvärdar och inga tjänste-, tenant- eller sessionsfält', async () => {
    const candidates = [
      { organizationId: ORG_A, organizationName: 'Hyresvärd A' },
      { organizationId: ORG_B, organizationName: 'Hyresvärd B' },
    ]
    resolveLogin.mockResolvedValue({
      status: 'choose',
      sessionToken: INTERNAL,
      expiresAt: EXPIRES_AT,
      result: sessionResult(),
      candidates: candidates.map((candidate) => ({
        ...candidate,
        tenantId: TENANT_ID,
        tenant: sessionResult().tenant,
        email: EMAIL,
        passwordHash: INTERNAL,
        sessionToken: INTERNAL,
      })),
    })

    const response = await request('login/resolve')
    expect(response.statusCode).toBe(200)
    const body = response.json<{ success: true; data: unknown }>()
    expect(body).toEqual({ success: true, data: { status: 'choose', candidates } })
    expect(TenantLoginResolveResultSchema.safeParse(body.data).success).toBe(true)
    expect(response.body).not.toContain(INTERNAL)
    expect(resolveLogin).toHaveBeenCalledTimes(1)
    expect(login).not.toHaveBeenCalled()
  })

  it.each(NAMES)(
    'complete bevarar nullnamn och tillåter bara den offentliga sessionsformen: %j',
    async (names) => {
      resolveLogin.mockResolvedValue({
        status: 'complete',
        result: sessionResult(names),
        candidates: [{ organizationId: ORG_B, passwordHash: INTERNAL }],
        internalField: INTERNAL,
      })

      const response = await request('login/resolve')
      expect(response.statusCode).toBe(200)
      const body = response.json<{ success: true; data: unknown }>()
      expect(body).toEqual({ success: true, data: { status: 'complete', ...publicSession(names) } })
      expect(TenantLoginResolveResultSchema.safeParse(body.data).success).toBe(true)
      expect(response.body).not.toContain(INTERNAL)
    },
  )

  it('gamla /login behåller sessionsformen utan status eller kandidater', async () => {
    const response = await request('login')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ success: true, data: publicSession() })
    expect(response.body).not.toContain(INTERNAL)
    expect(login).toHaveBeenCalledTimes(1)
    expect(resolveLogin).not.toHaveBeenCalled()
  })

  describe.each(['login', 'login/resolve'] as const)('%s', (route) => {
    it.each([
      ['lösenord som tal', { email: EMAIL, password: 12345 }],
      [
        'ogiltigt organisations-id',
        { email: EMAIL, password: PASSWORD, organizationId: 'not-a-uuid' },
      ],
      ['extra nyckel', { email: EMAIL, password: PASSWORD, tenantId: TENANT_ID }],
    ] as const)('produktionspipen avvisar %s före tjänsteanropet', async (_label, payload) => {
      const response = await request(route, payload)
      expect(response.statusCode).toBe(400)
      expect(login).not.toHaveBeenCalled()
      expect(resolveLogin).not.toHaveBeenCalled()
    })

    it('skickar ip från produktionens en-proxy-inställning och en levande AbortSignal', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/tenant-portal/${route}`,
        remoteAddress: '192.0.2.42',
        headers: { 'x-forwarded-for': '198.51.100.99, 192.0.2.43' },
        payload: { email: EMAIL, password: PASSWORD, organizationId: ORG_B },
      })
      expect(response.statusCode).toBe(200)
      const called = route === 'login' ? login : resolveLogin
      const other = route === 'login' ? resolveLogin : login
      expect(called).toHaveBeenCalledTimes(1)
      expect(other).not.toHaveBeenCalled()
      expect(called).toHaveBeenCalledWith(EMAIL, PASSWORD, ORG_B, {
        ip: '192.0.2.43',
        signal: expect.any(AbortSignal),
      })
      const context = called.mock.calls[0]?.[3]
      expect(context?.signal?.aborted).toBe(false)
    })
  })
})
