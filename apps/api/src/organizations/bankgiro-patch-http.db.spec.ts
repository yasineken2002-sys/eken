/**
 * B1 — `PATCH /v1/organizations/me`, betalningsmålets FYRA ingångar.
 *
 * ── VARFÖR RIKTIG HTTP OCH RIKTIG DATABAS ───────────────────────────────────
 *
 * Granskningen av #919 (T1) mätte att `{"bankgiro": null}` passerar hela
 * DTO-valideringen: `@IsOptional()` i class-validator 0.14.4 registrerar en
 * CONDITIONAL_VALIDATION vars villkor är `value !== null && value !== undefined`,
 * så vid `null` hoppas ALLA validatorer över — även `@StrictString()`. Värdet
 * nådde servicen, där `=== undefined` släppte det vidare till `null.trim()` →
 * ohanterat `TypeError` → HTTP 500.
 *
 * Det kan per konstruktion inte mätas av en attrapp som inte kör
 * `ValidationPipe`, och inte av ett tjänstanrop som hoppar över pipen. Därför
 * kör provet den riktiga rutten, den riktiga pipen, de riktiga guardsen och
 * PostgreSQL — och läser RADEN före och efter varje anrop.
 *
 * ── AVGRÄNSNING ─────────────────────────────────────────────────────────────
 *
 * Provet mäter betalningsmålets fält. Övriga fält i `UpdateOrganizationDto`
 * rörs inte, och rollgrindens övriga fältnivåregler (skuggagenten,
 * väsentlighetsgränsen) har egna prov.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { randomUUID } from 'node:crypto'
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
import { GlobalExceptionFilter } from '../common/filters/global-exception.filter'
import { PrismaService } from '../common/prisma/prisma.service'
import { OrganizationsController } from './organizations.controller'
import { OrganizationsService } from './organizations.service'
import { DelegationService } from '../ai/delegation/delegation.service'
import { StorageService } from '../storage/storage.service'

const hasDatabase = Boolean(process.env.DATABASE_URL)
const withDb = hasDatabase ? describe : describe.skip
it('B1 HTTP-provet kräver en uttrycklig provdatabas', () => {
  expect(hasDatabase).toBe(true)
})

const HEMLIGHET = 'b1-syntetisk-provhemlighet'
const GILTIGT = '5050-1055'

withDb('B1 · PATCH /organizations/me — betalningsmålet', () => {
  let app: NestFastifyApplication
  let prisma: PrismaService
  let orgId: string
  let annanOrgId: string
  const jwt = new JwtService({ secret: HEMLIGHET })
  const token = (role = 'OWNER', organizationId = orgId) =>
    jwt.sign({ sub: randomUUID(), organizationId, role })

  const patcha = (payload: unknown, auth = token()) =>
    app.inject({
      method: 'PATCH',
      url: '/v1/organizations/me',
      headers: { authorization: `Bearer ${auth}` },
      payload: payload as object,
    })

  const rad = (id = orgId) => prisma.organization.findUniqueOrThrow({ where: { id } })

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [OrganizationsController],
      providers: [
        OrganizationsService,
        PrismaService,
        JwtStrategy,
        { provide: StorageService, useValue: {} },
        // Delegationerna pausas bara när skuggagenten stängs av; ingen av
        // nyttolasterna här rör den flaggan. Attrappen KASTAR om den anropas,
        // så ett prov som råkar gå in i den vägen inte passerar tyst.
        {
          provide: DelegationService,
          useValue: {
            pauseAllForOrganization: () => {
              throw new Error('B1: delegationspausen anropades oväntat')
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
    // Produktionens felformat: `{ success: false, error: { code, message, … } }`.
    // Utan filtret hade felsvaren burit Nests standardform, och provet hade
    // mätt en annan yta än den kunden ser. Felsänkan är en attrapp — provet
    // mäter svaret, inte att felet loggas.
    app.useGlobalFilters(
      new GlobalExceptionFilter({ logInternalError: async () => undefined } as never),
    )
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    prisma = module.get(PrismaService)
    for (const annan of [false, true]) {
      const org = await prisma.organization.create({
        data: {
          name: 'B1 syntetisk',
          email: `b1-${randomUUID()}@example.invalid`,
          street: 'Testgatan 1',
          city: 'Teststad',
          postalCode: '11122',
          bankgiro: GILTIGT,
        },
      })
      if (annan) annanOrgId = org.id
      else orgId = org.id
    }
  }, 30_000)

  beforeEach(async () => {
    // Varje fall startar från ett KÄNT giltigt mål, så "oförändrad" betyder
    // något annat än "var redan null".
    await prisma.organization.update({ where: { id: orgId }, data: { bankgiro: GILTIGT } })
  })

  afterAll(async () => {
    if (prisma)
      await prisma.organization.deleteMany({
        where: { id: { in: [orgId, annanOrgId].filter(Boolean) } },
      })
    if (app) await app.close()
  })

  // ── B1.1 + B1.2: INGEN ÄNDRING ────────────────────────────────────────────
  it.each([
    ['B1.1 fältet utelämnat', {}],
    ['B1.2 null', { bankgiro: null }],
  ])('%s → 200 och raden byte-identisk', async (_namn, kropp) => {
    const fore = await rad()
    const svar = await patcha({ ...kropp, paymentTermsDays: 30 })
    expect(svar.statusCode).toBe(200)
    const efter = await rad()
    expect(efter.bankgiro).toBe(GILTIGT)
    // Hela raden, inte bara fältet: en no-op får inte röra något annat heller.
    expect({ ...efter, updatedAt: null }).toEqual({ ...fore, updatedAt: null })
  })

  it('B1.2 negativ referens: null gav 500 före rättningen, aldrig 200', async () => {
    // Den här raden är beviset för att fallet PRÖVAS och inte bara passerar av
    // att fältet ignoreras: svaret ska vara 200, och det ska INTE vara 500.
    const svar = await patcha({ bankgiro: null })
    expect(svar.statusCode).not.toBe(500)
    expect(svar.statusCode).toBe(200)
  })

  // ── B1.3: TOMT RENSAR ─────────────────────────────────────────────────────
  it.each([
    ['tom sträng', ''],
    ['enbart blanktecken', '   '],
  ])('B1.3 %s → 200 och bankgiro blir NULL', async (_namn, varde) => {
    const svar = await patcha({ bankgiro: varde })
    expect(svar.statusCode).toBe(200)
    expect((await rad()).bankgiro).toBeNull()
    // Kundeffekten: API:et rapporterar målet som borta, vilket är det webben
    // läser för att visa bannern och släcka sändknapparna.
    expect(svar.json().data.bankgiro).toBeNull()
  })

  // ── B1.4: GILTIGT NORMALISERAS ────────────────────────────────────────────
  it.each([
    ['utan bindestreck', '50501055'],
    ['med blanktecken', ' 5050 1055 '],
    ['redan normaliserat', '5050-1055'],
    ['sjusiffrigt', '9008004'],
  ])('B1.4 %s → 200 och lagras normaliserat', async (_namn, varde) => {
    const svar = await patcha({ bankgiro: varde })
    expect(svar.statusCode).toBe(200)
    const forvantat = varde.replace(/[\s-]/g, '').length === 7 ? '900-8004' : GILTIGT
    expect((await rad()).bankgiro).toBe(forvantat)
    expect(svar.json().data.bankgiro).toBe(forvantat)
  })

  // ── B1.5: OGILTIG ICKE-BLANK AVVISAS FÖRE SKRIVNING ───────────────────────
  it.each([
    ['fel kontrollsiffra', '1234-5678'],
    ['för kort', '900800'],
    ['för långt', '505010551'],
    ['enbart nollor', '0000-0000'],
    ['icke-siffror', '5050-105X'],
  ])('B1.5 %s → 400 och raden OFÖRÄNDRAD', async (_namn, varde) => {
    const fore = await rad()
    const svar = await patcha({ bankgiro: varde })
    expect(svar.statusCode).toBe(400)
    // Ett begripligt svenskt skäl, inte ett stacktrace.
    expect(String(svar.json().error.message)).toMatch(/[Bb]ankgiro/)
    const efter = await rad()
    expect(efter.bankgiro).toBe(GILTIGT)
    expect({ ...efter, updatedAt: null }).toEqual({ ...fore, updatedAt: null })
  })

  // ── B1.6: FEL TYP → 400, ALDRIG 500 ───────────────────────────────────────
  it.each([
    ['tal', 42],
    ['objekt', { a: 1 }],
    ['lista', ['5050-1055']],
    ['boolean', true],
  ])('B1.6 %s → 400 och raden oförändrad', async (_namn, varde) => {
    const fore = await rad()
    const svar = await patcha({ bankgiro: varde })
    expect(svar.statusCode).toBe(400)
    expect(svar.statusCode).not.toBe(500)
    const efter = await rad()
    expect({ ...efter, updatedAt: null }).toEqual({ ...fore, updatedAt: null })
  })

  // ── B1.7: ROLL OCH ORG ────────────────────────────────────────────────────
  it.each([['VIEWER'], ['ACCOUNTANT'], ['MANAGER']])(
    'B1.7 %s nekas 403 och raden är oförändrad',
    async (roll) => {
      const fore = await rad()
      const svar = await patcha({ bankgiro: '' }, token(roll))
      expect(svar.statusCode).toBe(403)
      expect((await rad()).bankgiro).toBe(GILTIGT)
      expect({ ...(await rad()), updatedAt: null }).toEqual({ ...fore, updatedAt: null })
    },
  )

  it.each([['ADMIN'], ['OWNER']])('B1.7 %s får ändra', async (roll) => {
    const svar = await patcha({ bankgiro: '900-8004' }, token(roll))
    expect(svar.statusCode).toBe(200)
    expect((await rad()).bankgiro).toBe('900-8004')
  })

  it('B1.7 org A:s PATCH når aldrig org B:s rad', async () => {
    const annanFore = await rad(annanOrgId)
    const svar = await patcha({ bankgiro: '900-8004' }, token('OWNER', orgId))
    expect(svar.statusCode).toBe(200)
    expect((await rad(orgId)).bankgiro).toBe('900-8004')
    // Org B orörd — `@OrgId()` läser JWT:n, aldrig kroppen.
    expect(await rad(annanOrgId)).toEqual(annanFore)
  })

  it('B1.7 utan token → 401, och raden orörd', async () => {
    const fore = await rad()
    const svar = await app.inject({
      method: 'PATCH',
      url: '/v1/organizations/me',
      payload: { bankgiro: '' },
    })
    expect(svar.statusCode).toBe(401)
    expect(await rad()).toEqual(fore)
  })
})
