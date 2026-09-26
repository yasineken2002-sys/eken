/**
 * EMPTY_JSON_500 — en tom kropp med `Content-Type: application/json` är ett
 * KLIENTFEL (400), inte ett serverfel.
 *
 * ── VAD SOM VAR FEL ─────────────────────────────────────────────────────────
 *
 * Fastifys JSON-parser avvisar en tom kropp med `FST_ERR_CTP_EMPTY_JSON_BODY`
 * (statusCode 400). Nest registrerar exception-filtren som Fastifys
 * errorHandler, så felet når `GlobalExceptionFilter` — som bara kände
 * `HttpException` och gjorde allt annat till 500, med CRITICAL-rad i ErrorLog
 * och ett Sentry-event för en klients felaktiga anrop.
 *
 * ── VARFÖR RIKTIG FASTIFY-HTTP OCH RIKTIG DATABAS ───────────────────────────
 *
 * Felet uppstår i PARSERN, före Nest-rutten. Ett direkt filteranrop bevisar inte
 * att det är just det felet som når filtret, eller vilken fastify-version som
 * skapar det: adaptern kör sin egen fastify (4.x), inte apps/api:s (5.x). Därför
 * går varje fall genom `app.inject` med produktionens pipe, guards och filter,
 * och raden i Postgres läses före och efter.
 *
 * ── VAD DEN HÄR FILEN INTE SER ──────────────────────────────────────────────
 *
 * Den mäter en rutt (PATCH /organizations/me). Klassningen är global, men att
 * varje annan rutt beter sig likadant följer av att parsern körs före alla
 * rutter — det är inte uppmätt per rutt. Sentry-anropet mäts inte; ErrorLog-
 * sänkan (`logInternalError`) är det som mäts som sidoeffekt.
 */

jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))

import { randomUUID } from 'node:crypto'
import { BadRequestException, ValidationPipe, VersioningType } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { JwtStrategy } from '../../auth/strategies/jwt.strategy'
import { VALIDATION_PIPE_OPTIONS } from '../contract/validation-pipe-options'
import { JwtAuthGuard } from '../guards/jwt-auth.guard'
import { RolesGuard } from '../guards/roles.guard'
import { TransformInterceptor } from '../interceptors/transform.interceptor'
import { GlobalExceptionFilter } from './global-exception.filter'
import { PrismaService } from '../prisma/prisma.service'
import { OrganizationsController } from '../../organizations/organizations.controller'
import { OrganizationsService } from '../../organizations/organizations.service'
import { DelegationService } from '../../ai/delegation/delegation.service'
import { StorageService } from '../../storage/storage.service'

const hasDatabase = Boolean(process.env.DATABASE_URL)
const withDb = hasDatabase ? describe : describe.skip
it('EMPTY_JSON HTTP-provet kräver en uttrycklig provdatabas', () => {
  expect(hasDatabase).toBe(true)
})

const HEMLIGHET = 'ej400-syntetisk-provhemlighet'
const GILTIGT = '5050-1055'
const ANNAT = '5402-9681'
const HEMLIG_DETALJ = 'ej400-HEMLIG-intern-detalj-postgres://user:pw@db'

withDb('EMPTY_JSON · tom JSON-kropp genom riktig Fastify', () => {
  let app: NestFastifyApplication
  let prisma: PrismaService
  let tjanst: OrganizationsService
  let orgId: string
  const logInternalError = jest.fn(async () => undefined)
  const jwt = new JwtService({ secret: HEMLIGHET })
  const auth = () =>
    `Bearer ${jwt.sign({ sub: randomUUID(), organizationId: orgId, role: 'OWNER' })}`

  // Rå begäran — `payload` är exakt de bytes som skickas, och headern sätts
  // uttryckligen, så "tom kropp" och "{}" inte kan förväxlas av inject.
  const skicka = (body: string, contentType: string | null) =>
    app.inject({
      method: 'PATCH',
      url: '/v1/organizations/me',
      headers: {
        authorization: auth(),
        ...(contentType ? { 'content-type': contentType } : {}),
      },
      payload: body,
    })

  const rad = () => prisma.organization.findUniqueOrThrow({ where: { id: orgId } })

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [OrganizationsController],
      providers: [
        OrganizationsService,
        PrismaService,
        JwtStrategy,
        { provide: StorageService, useValue: {} },
        {
          provide: DelegationService,
          useValue: {
            pauseAllForOrganization: () => {
              throw new Error('EMPTY_JSON: delegationspausen anropades oväntat')
            },
          },
        },
        { provide: ConfigService, useValue: { getOrThrow: () => HEMLIGHET } },
      ],
    }).compile()
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    })
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS))
    app.useGlobalGuards(new JwtAuthGuard(new Reflector()), new RolesGuard(new Reflector()))
    app.useGlobalInterceptors(new TransformInterceptor())
    app.useGlobalFilters(new GlobalExceptionFilter({ logInternalError } as never))
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    prisma = module.get(PrismaService)
    tjanst = module.get(OrganizationsService)
    const org = await prisma.organization.create({
      data: {
        name: 'EJ400 syntetisk',
        email: `ej400-${randomUUID()}@example.invalid`,
        street: 'Testgatan 1',
        city: 'Teststad',
        postalCode: '11122',
        bankgiro: GILTIGT,
      },
    })
    orgId = org.id
  }, 30_000)

  beforeEach(async () => {
    await prisma.organization.update({ where: { id: orgId }, data: { bankgiro: GILTIGT } })
    jest.restoreAllMocks()
    logInternalError.mockReset()
    logInternalError.mockResolvedValue(undefined)
  })

  afterAll(async () => {
    if (prisma && orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
    if (app) await app.close()
  })

  // ── KÄRNAN ─────────────────────────────────────────────────────────────────
  it.each([['application/json'], ['application/json; charset=utf-8']])(
    'EJ.1 tom kropp med %s → 400, ingen tjänst, ingen ErrorLog, raden orörd',
    async (ct) => {
      const uppdatera = jest.spyOn(tjanst, 'update')
      const fore = await rad()
      const svar = await skicka('', ct)
      expect(svar.statusCode).toBe(400)
      const kropp = svar.json()
      expect(kropp).toMatchObject({
        success: false,
        error: { code: 'BAD_REQUEST', path: '/v1/organizations/me' },
      })
      expect(kropp.error.message).toMatch(/saknar innehåll/)
      // Parserns engelska text är inte vårt kontrakt och ska inte eka tillbaka.
      expect(JSON.stringify(kropp)).not.toContain('FST_ERR')
      expect(uppdatera).not.toHaveBeenCalled()
      expect(logInternalError).not.toHaveBeenCalled()
      expect(await rad()).toEqual(fore)
    },
  )

  // ── SKILJ TOMMA BYTES FRÅN GILTIGT {} OCH FRÅN SAKNAD HEADER ──────────────
  it('EJ.2 positiv kontroll: `{}` → 200 och raden byte-identisk', async () => {
    const fore = await rad()
    const svar = await skicka('{}', 'application/json')
    expect(svar.statusCode).toBe(200)
    expect({ ...(await rad()), updatedAt: null }).toEqual({ ...fore, updatedAt: null })
    expect(logInternalError).not.toHaveBeenCalled()
  })

  it('EJ.3 positiv kontroll: giltig kropp → 200 och uppmätt effekt', async () => {
    const svar = await skicka(JSON.stringify({ bankgiro: ANNAT }), 'application/json')
    expect(svar.statusCode).toBe(200)
    expect((await rad()).bankgiro).toBe(ANNAT)
    expect(svar.json().data.bankgiro).toBe(ANNAT)
  })

  // Tom kropp UTAN content-type når aldrig JSON-parsern. Befintligt kontrakt,
  // uppmätt på basen 8ddc5263 före rättningen — ska vara identiskt efter.
  it('EJ.4 tom kropp utan content-type: oförändrat mot basen', async () => {
    const fore = await rad()
    const svar = await skicka('', null)
    expect(svar.statusCode).toBe(UTAN_CT_STATUS)
    expect({ ...(await rad()), updatedAt: null }).toEqual({ ...fore, updatedAt: null })
  })

  // Grannfelet ogiltig JSON har REDAN ett kontrakt, och det är inte filtrets:
  // Nests errorHandler-proxy gör varje SyntaxError till en
  // `BadRequestException(err.message)` innan filtret nås
  // (`@nestjs/core/router/routes-resolver.js`, `mapExternalException`). Uppmätt
  // på basen 8ddc5263: 400. Texten är parserns och beror på Node-versionen, så
  // den låses inte här — bara att kontraktet består och att inget loggas som
  // serverfel.
  it('EJ.5 ogiltig JSON: befintligt 400-kontrakt består', async () => {
    const fore = await rad()
    const svar = await skicka('{', 'application/json')
    expect(svar.statusCode).toBe(OGILTIG_JSON_STATUS)
    expect(svar.json().error.code).toBe('BAD_REQUEST')
    expect(logInternalError).not.toHaveBeenCalled()
    expect(await rad()).toEqual(fore)
  })

  // ── INTERNA FEL ÄR FORTFARANDE 500 ────────────────────────────────────────
  it('EJ.6 internt fel i tjänsten → 500, säkert besked, ErrorLog ×1', async () => {
    jest.spyOn(tjanst, 'update').mockRejectedValueOnce(new Error(HEMLIG_DETALJ))
    const svar = await skicka(JSON.stringify({ bankgiro: ANNAT }), 'application/json')
    expect(svar.statusCode).toBe(500)
    expect(svar.json().error).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
    })
    expect(svar.body).not.toContain('HEMLIG')
    expect(logInternalError).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['statusCode 400', { statusCode: 400 }],
    ['status 400 + expose', { status: 400, expose: true }],
    [
      'förfalskat parserfel (samma code, statusCode och name)',
      { code: 'FST_ERR_CTP_EMPTY_JSON_BODY', statusCode: 400, name: 'FastifyError' },
    ],
  ])('EJ.7 applikationsfel med %s maskeras INTE som klientfel → 500', async (_n, falt) => {
    jest
      .spyOn(tjanst, 'update')
      .mockRejectedValueOnce(Object.assign(new Error(HEMLIG_DETALJ), falt))
    const svar = await skicka(JSON.stringify({ bankgiro: ANNAT }), 'application/json')
    expect(svar.statusCode).toBe(500)
    expect(svar.body).not.toContain('HEMLIG')
    expect(logInternalError).toHaveBeenCalledTimes(1)
  })

  // ── HTTPEXCEPTION-KONTRAKTET ÄR ORÖRT ─────────────────────────────────────
  it('EJ.8 DTO-valideringsfel (HttpException) → 400 med valideringstexten', async () => {
    const svar = await skicka(JSON.stringify({ paymentTermsDays: 0 }), 'application/json')
    expect(svar.statusCode).toBe(400)
    expect(svar.json().error.details.validation.length).toBeGreaterThan(0)
    expect(logInternalError).not.toHaveBeenCalled()
  })

  it('EJ.8 tjänstens egen BadRequestException → 400 med dess text', async () => {
    jest
      .spyOn(tjanst, 'update')
      .mockRejectedValueOnce(new BadRequestException('Tjänstens egen svenska text'))
    const svar = await skicka('{}', 'application/json')
    expect(svar.statusCode).toBe(400)
    expect(svar.json().error.message).toBe('Tjänstens egen svenska text')
  })
})

// Uppmätta på basen 8ddc5263 (se FACIT/logg). Ett ändrat tal här är ett ändrat
// kontrakt och ska motiveras, inte justeras.
const UTAN_CT_STATUS = 200
const OGILTIG_JSON_STATUS = 400
