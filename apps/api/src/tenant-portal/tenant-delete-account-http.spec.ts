// Importtunga blad ersätts före controller-importen. Ingen riktig DB, utskick
// eller anonymisering körs. Controller, guard, credential-helper, bcrypt, DTO,
// produktionspipe, svarshölje och fel-filter är däremot verkliga.
jest.mock('../common/prisma/prisma.service', () => ({ PrismaService: class {} }))
jest.mock('../common/crypto/personal-number.service', () => ({ PersonalNumberService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../maintenance/maintenance.service', () => ({ MaintenanceService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../avisering/avisering.service', () => ({ AviseringService: class {} }))
jest.mock('../contracts/contract-template.service', () => ({ ContractTemplateService: class {} }))
jest.mock('./tenant-auth.service', () => ({ TenantAuthService: class {} }))
jest.mock('./tenant-portal.service', () => ({ TenantPortalService: class {} }))
jest.mock('./tenant-invitations.service', () => ({ TenantInvitationsService: class {} }))
jest.mock('./tenant-bankid.service', () => ({ TenantBankIdService: class {} }))
// Endast guardens oanvända dev-bypass behöver denna export. Inga dev-headers skickas.
jest.mock('../tenants/tenants.service', () => ({ SAFE_TENANT_SELECT: { id: true } }))
jest.mock('../platform/errors/platform-errors.service', () => ({ PlatformErrorsService: class {} }))
jest.mock('@sentry/nestjs', () => ({ withScope: jest.fn(), captureException: jest.fn() }))

import { UnauthorizedException, ValidationPipe, VersioningType } from '@nestjs/common'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test, type TestingModule } from '@nestjs/testing'
import * as Sentry from '@sentry/nestjs'
import * as bcrypt from 'bcryptjs'
import { AviseringService } from '../avisering/avisering.service'
import { VALIDATION_PIPE_OPTIONS } from '../common/contract/validation-pipe-options'
import { PersonalNumberService } from '../common/crypto/personal-number.service'
import { GlobalExceptionFilter } from '../common/filters/global-exception.filter'
import { TransformInterceptor } from '../common/interceptors/transform.interceptor'
import { PrismaService } from '../common/prisma/prisma.service'
import { PdfService } from '../invoices/pdf.service'
import { MaintenanceService } from '../maintenance/maintenance.service'
import { PlatformErrorsService } from '../platform/errors/platform-errors.service'
import { StorageService } from '../storage/storage.service'
import { TenantAuthGuard } from './tenant-auth.guard'
import { TenantAuthService } from './tenant-auth.service'
import { TenantPortalController } from './tenant-portal.controller'
import { TenantPortalService } from './tenant-portal.service'

const TENANT_ID = 'd4100000-0000-4000-8000-000000000001'
const ORG_ID = 'd4200000-0000-4000-8000-000000000001'
const SESSION_TOKEN = 'synthetic-delete-session'
const PASSWORD = 'Syntetiskt-raderingslosenord-123!'
const WRONG_PASSWORD = 'Fel-syntetiskt-losenord-456!'
const PATH = '/v1/portal/me'
const IP_ADDRESS = '192.0.2.40'
const USER_AGENT = 'portal-delete-http-test'

type CredentialRow = { passwordHash: string | null }
type ErrorBody = {
  success: false
  error: { code: string; message: string; path: string; timestamp: string }
}

describe('portalens kontoradering över HTTP', () => {
  let app: NestFastifyApplication
  let module: TestingModule
  let passwordHash: string
  // Dessa smala providerreturer är testgränser, inte alternativa auth-/DB-implementationer.
  const validateSession = jest.fn<Promise<unknown>, [string]>()
  const findUnique = jest.fn<Promise<CredentialRow | null>, [{ where: { id: string } }]>()
  const deleteTenantAccount = jest.fn<
    Promise<void>,
    [string, { ipAddress?: string; userAgent?: string }]
  >()
  const logInternalError = jest.fn<Promise<void>, [unknown]>()

  beforeAll(async () => {
    // Riktig bcrypt; den låga kostnaden gäller enbart denna syntetiska testhash.
    passwordHash = await bcrypt.hash(PASSWORD, 4)
    module = await Test.createTestingModule({
      controllers: [TenantPortalController],
      providers: [
        TenantAuthGuard,
        GlobalExceptionFilter,
        { provide: TenantAuthService, useValue: { validateSession } },
        { provide: PrismaService, useValue: { tenant: { findUnique } } },
        { provide: TenantPortalService, useValue: { deleteTenantAccount } },
        { provide: StorageService, useValue: {} },
        { provide: MaintenanceService, useValue: {} },
        { provide: PdfService, useValue: {} },
        { provide: AviseringService, useValue: {} },
        { provide: PersonalNumberService, useValue: {} },
        { provide: PlatformErrorsService, useValue: { logInternalError } },
      ],
    }).compile()
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ trustProxy: 1 }),
    )
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS))
    app.useGlobalInterceptors(new TransformInterceptor())
    app.useGlobalFilters(module.get(GlobalExceptionFilter))
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  afterAll(async () => {
    if (app) await app.close()
    else await module?.close()
  })

  beforeEach(() => {
    validateSession.mockReset().mockResolvedValue({
      id: TENANT_ID,
      organizationId: ORG_ID,
      organization: { id: ORG_ID, name: 'Syntetisk hyresvärd' },
    })
    findUnique.mockReset().mockResolvedValue({ passwordHash })
    deleteTenantAccount.mockReset().mockResolvedValue(undefined)
    logInternalError.mockReset().mockResolvedValue(undefined)
    jest.mocked(Sentry.withScope).mockClear()
    jest.mocked(Sentry.captureException).mockClear()
  })

  afterEach(() => {
    expect(logInternalError).not.toHaveBeenCalled()
    expect(Sentry.withScope).not.toHaveBeenCalled()
    expect(Sentry.captureException).not.toHaveBeenCalled()
  })

  const request = (payload: object) =>
    app.inject({
      method: 'DELETE',
      url: PATH,
      remoteAddress: IP_ADDRESS,
      headers: { authorization: `Bearer ${SESSION_TOKEN}`, 'user-agent': USER_AGENT },
      payload,
    })

  function expectError(body: ErrorBody, code: string, message: string) {
    expect(body).toEqual({
      success: false,
      error: { code, message, path: PATH, timestamp: expect.any(String) },
    })
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain(PASSWORD)
    expect(serialized).not.toContain(WRONG_PASSWORD)
    expect(serialized).not.toContain(passwordHash)
    expect(serialized).not.toContain(SESSION_TOKEN)
  }

  it('fel bekräftelselösenord ger 400 utan radering; en manuell korrekt retry ger 204 en gång', async () => {
    const rejected = await request({ password: WRONG_PASSWORD })
    expect(rejected.statusCode).toBe(400)
    expectError(rejected.json<ErrorBody>(), 'BAD_REQUEST', 'Felaktigt lösenord')
    expect(validateSession).toHaveBeenCalledTimes(1)
    expect(validateSession).toHaveBeenCalledWith(SESSION_TOKEN)
    expect(findUnique).toHaveBeenCalledTimes(1)
    expect(findUnique).toHaveBeenCalledWith({ where: { id: TENANT_ID } })
    expect(deleteTenantAccount).not.toHaveBeenCalled()

    // Ett nytt uttryckligt HTTP-anrop, ingen automatisk retry eller mockad bcrypt.
    const accepted = await request({ password: PASSWORD })
    expect(accepted.statusCode).toBe(204)
    expect(accepted.body).toBe('')
    expect(validateSession).toHaveBeenCalledTimes(2)
    expect(findUnique).toHaveBeenCalledTimes(2)
    expect(deleteTenantAccount).toHaveBeenCalledTimes(1)
    expect(deleteTenantAccount).toHaveBeenCalledWith(TENANT_ID, {
      ipAddress: IP_ADDRESS,
      userAgent: USER_AGENT,
    })
  })

  it('ogiltig session ger fortfarande 401 före credential-läsning och radering', async () => {
    validateSession.mockRejectedValueOnce(new UnauthorizedException('Sessionen är ogiltig'))
    const response = await request({ password: PASSWORD })
    expect(response.statusCode).toBe(401)
    expectError(response.json<ErrorBody>(), 'UNAUTHORIZED', 'Sessionen är ogiltig')
    expect(validateSession).toHaveBeenCalledTimes(1)
    expect(validateSession).toHaveBeenCalledWith(SESSION_TOKEN)
    expect(findUnique).not.toHaveBeenCalled()
    expect(deleteTenantAccount).not.toHaveBeenCalled()
  })

  it.each<[string, CredentialRow | null]>([
    ['saknad tenant', null],
    ['saknad lösenordshash', { passwordHash: null }],
  ])('%s ger fortfarande 401 utan radering', async (_name, row) => {
    findUnique.mockResolvedValueOnce(row)
    const response = await request({ password: PASSWORD })
    expect(response.statusCode).toBe(401)
    expectError(response.json<ErrorBody>(), 'UNAUTHORIZED', 'Kontot saknar lösenord')
    expect(validateSession).toHaveBeenCalledTimes(1)
    expect(findUnique).toHaveBeenCalledTimes(1)
    expect(findUnique).toHaveBeenCalledWith({ where: { id: TENANT_ID } })
    expect(deleteTenantAccount).not.toHaveBeenCalled()
  })

  it.each<[string, { password: string | number }]>([
    ['tom sträng', { password: '' }],
    ['tal utan tillåten strängkoercion', { password: 12345 }],
  ])('ogiltig DTO: %s ger 400 före credential-läsning', async (_name, payload) => {
    const response = await request(payload)
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      success: false,
      error: { code: 'BAD_REQUEST', path: PATH, details: { validation: expect.any(Array) } },
    })
    expect(validateSession).toHaveBeenCalledTimes(1)
    expect(findUnique).not.toHaveBeenCalled()
    expect(deleteTenantAccount).not.toHaveBeenCalled()
  })
})
