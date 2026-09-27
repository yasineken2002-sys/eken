/**
 * A5 — `POST /v1/platform/organizations` prövar företagsadressen med SAMMA regel
 * som registreringen och inställningarna.
 *
 * ── VAD SOM VAR FEL ─────────────────────────────────────────────────────────
 *
 * Plattformsadminens `create` hade bara `@IsString` + `@StrictString` på
 * `street`/`postalCode`/`city`. En organisation kunde därför skapas med en adress
 * av blanksteg eller ett ogiltigt svenskt postnummer, och värdena lagrades
 * otrimmade. Registreringen (`AuthService.register`) och inställningarna
 * (`OrganizationsService.update`) prövade redan med `organizationAddressIssues`.
 *
 * ── VARFÖR RIKTIG HTTP OCH RIKTIG DATABAS ───────────────────────────────────
 *
 * Att ett avvisat anrop inte lämnar en halvskapad organisation eller ADMIN-
 * användare efter sig avgörs av vad som finns i PostgreSQL efteråt. Att regeln
 * ligger FÖRE transaktionen syns dessutom på att kundnumret aldrig tilldelas —
 * `allocate` är en omslutning av den riktiga tjänsten, inte en attrapp.
 *
 * Rollgränsen prövas med den RIKTIGA `PlatformGuard` + `PlatformJwtStrategy` och
 * den globala `JwtAuthGuard` påslagen, samma rigg som
 * `report-endpoint-authz.integration.spec.ts`.
 *
 * ── VAD DEN HÄR FILEN INTE SER ──────────────────────────────────────────────
 *
 * Plattformsadminens PATCH (`update`) prövas inte här och har ingen adressregel;
 * den ingår inte i A5. Admin-formulärets egen förkontroll ägs av
 * `apps/admin/src/pages/organizations/new-organization-address.ts`.
 */

jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'
import { Module, ValidationPipe, VersioningType } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { ConfigModule } from '@nestjs/config'
import { JwtService } from '@nestjs/jwt'
import { PassportModule } from '@nestjs/passport'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { VALIDATION_PIPE_OPTIONS } from '../../common/contract/validation-pipe-options'
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard'
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor'
import { GlobalExceptionFilter } from '../../common/filters/global-exception.filter'
import { PrismaService } from '../../common/prisma/prisma.service'
import { CustomerNumberService } from '../../common/customer-number/customer-number.service'
import { PlatformJwtStrategy } from '../auth/platform-jwt.strategy'
import { PlatformOrganizationsController } from './platform-organizations.controller'
import { PlatformOrganizationsService } from './platform-organizations.service'

const hasDatabase = Boolean(process.env.DATABASE_URL)
const withDb = hasDatabase ? describe : describe.skip
it('A5 plattformsprovet kräver en uttrycklig provdatabas', () => {
  expect(hasDatabase).toBe(true)
})

const PLATTFORMSHEMLIGHET = 'a5-syntetisk-plattformshemlighet'
const ORGHEMLIGHET = 'a5-syntetisk-orghemlighet'

const riktigNummer = new CustomerNumberService()
const allocate = jest.fn((tx: Parameters<CustomerNumberService['allocate']>[0]) =>
  riktigNummer.allocate(tx),
)

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      load: [() => ({ PLATFORM_JWT_SECRET: PLATTFORMSHEMLIGHET })],
    }),
    PassportModule,
  ],
  controllers: [PlatformOrganizationsController],
  providers: [
    PlatformOrganizationsService,
    PrismaService,
    PlatformJwtStrategy,
    { provide: CustomerNumberService, useValue: { allocate } },
    { provide: APP_GUARD, useFactory: (r: Reflector) => new JwtAuthGuard(r), inject: [Reflector] },
  ],
})
class ProvModul {}

withDb('A5 · POST /platform/organizations — företagsadressen', () => {
  let app: NestFastifyApplication
  let prisma: PrismaService
  const skapadeEpost: string[] = []
  // #685: nollställ före modulbygget och lägg tillbaka exakt efteråt.
  const sparadHemlighet = process.env.PLATFORM_JWT_SECRET

  const plattformsToken = () =>
    new JwtService({ secret: PLATTFORMSHEMLIGHET }).sign(
      { sub: 'a5-plattformsanvandare', email: 'a5@example.invalid', type: 'platform' },
      { expiresIn: '5m' },
    )

  const kropp = (over: Record<string, unknown> = {}) => {
    const email = `a5-${randomUUID()}@example.invalid`
    const adminEmail = `a5-admin-${randomUUID()}@example.invalid`
    skapadeEpost.push(email, adminEmail)
    return {
      name: 'A5 Syntetisk AB',
      email,
      street: 'Storgatan 1',
      postalCode: '111 22',
      city: 'Stockholm',
      adminEmail,
      adminFirstName: 'Ada',
      adminLastName: 'Fem',
      ...over,
    }
  }

  const skapa = (payload: Record<string, unknown>, token: string | null = plattformsToken()) =>
    app.inject({
      method: 'POST',
      url: '/v1/platform/organizations',
      payload,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    })

  const raderFor = async (k: { email: unknown; adminEmail: unknown }) => ({
    orgs: await prisma.organization.count({ where: { email: k.email as string } }),
    users: await prisma.user.count({ where: { email: k.adminEmail as string } }),
  })

  beforeAll(async () => {
    delete process.env.PLATFORM_JWT_SECRET
    const modul = await Test.createTestingModule({ imports: [ProvModul] }).compile()
    app = modul.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    })
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS))
    app.useGlobalInterceptors(new TransformInterceptor())
    app.useGlobalFilters(
      new GlobalExceptionFilter({ logInternalError: async () => undefined } as never),
    )
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    prisma = modul.get(PrismaService)
  }, 30_000)

  afterAll(async () => {
    if (prisma && skapadeEpost.length > 0) {
      // FK-riktning: användare → organisation.
      await prisma.user.deleteMany({ where: { email: { in: skapadeEpost } } })
      await prisma.organization.deleteMany({ where: { email: { in: skapadeEpost } } })
    }
    if (app) await app.close()
    if (sparadHemlighet === undefined) delete process.env.PLATFORM_JWT_SECRET
    else process.env.PLATFORM_JWT_SECRET = sparadHemlighet
  })

  beforeEach(() => allocate.mockClear())

  it('A5.1 giltig SE-adress → 201, sparad TRIMMAD, land SE', async () => {
    const k = kropp({ street: '  Storgatan 1  ', postalCode: ' 111 22 ', city: ' Stockholm ' })
    const svar = await skapa(k)
    expect(svar.statusCode).toBe(201)
    const org = await prisma.organization.findFirstOrThrow({ where: { email: k.email } })
    expect({
      street: org.street,
      postalCode: org.postalCode,
      city: org.city,
      country: org.country,
    }).toEqual({ street: 'Storgatan 1', postalCode: '111 22', city: 'Stockholm', country: 'SE' })
    expect(await raderFor(k)).toEqual({ orgs: 1, users: 1 })
    expect(allocate).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['gata av blanksteg', { street: '   ' }, 'Gatuadress krävs'],
    ['tom ort', { city: '' }, 'Ort krävs'],
    ['postnummer av blanksteg', { postalCode: '  ' }, 'Postnummer krävs'],
    ['ogiltigt svenskt postnummer', { postalCode: '12' }, 'Postnummer måste vara fem siffror'],
    ['svenskt postnummer utanför PostNord-intervallet', { postalCode: '012 34' }, 'fem siffror'],
    ['uttryckligt SE med ogiltigt postnummer', { country: 'SE', postalCode: 'ABC' }, 'fem siffror'],
  ])(
    'A5.2 %s → 400 före delskrivning (0 org, 0 user, inget kundnummer)',
    async (_n, over, text) => {
      const k = kropp(over)
      const svar = await skapa(k)
      expect(svar.statusCode).toBe(400)
      expect(svar.json().error.message).toContain(text)
      expect(await raderFor(k)).toEqual({ orgs: 0, users: 0 })
      expect(allocate).not.toHaveBeenCalled()
    },
  )

  it('A5.3 utländsk giltig adress (NO, fyrsiffrigt postnummer) → 201, ingen svensk regel', async () => {
    const k = kropp({
      country: 'NO',
      street: 'Karl Johans gate 1',
      postalCode: '0154',
      city: 'Oslo',
    })
    const svar = await skapa(k)
    expect(svar.statusCode).toBe(201)
    const org = await prisma.organization.findFirstOrThrow({ where: { email: k.email } })
    expect({ postalCode: org.postalCode, country: org.country }).toEqual({
      postalCode: '0154',
      country: 'NO',
    })
  })

  it('A5.3 negativ referens: samma postnummer utan land (SE) avvisas', async () => {
    const k = kropp({ street: 'Karl Johans gate 1', postalCode: '0154', city: 'Oslo' })
    const svar = await skapa(k)
    expect(svar.statusCode).toBe(400)
    expect(await raderFor(k)).toEqual({ orgs: 0, users: 0 })
  })

  it('A5.3 utländsk org får ändå inte ett TOMT postnummer', async () => {
    const k = kropp({ country: 'NO', postalCode: ' ', city: 'Oslo' })
    const svar = await skapa(k)
    expect(svar.statusCode).toBe(400)
    expect(svar.json().error.message).toContain('Postnummer krävs')
    expect(await raderFor(k)).toEqual({ orgs: 0, users: 0 })
  })

  it('A5.4 utan token → 401, inga rader', async () => {
    const k = kropp()
    const svar = await skapa(k, null)
    expect(svar.statusCode).toBe(401)
    expect(await raderFor(k)).toEqual({ orgs: 0, users: 0 })
    expect(allocate).not.toHaveBeenCalled()
  })

  it('A5.4 en ORG-token (inte plattform) → 401, inga rader', async () => {
    const orgToken = new JwtService({ secret: ORGHEMLIGHET }).sign(
      { sub: 'a5-anvandare', organizationId: 'a5-org', role: 'OWNER' },
      { expiresIn: '5m' },
    )
    const k = kropp()
    const svar = await skapa(k, orgToken)
    expect(svar.statusCode).toBe(401)
    expect(await raderFor(k)).toEqual({ orgs: 0, users: 0 })
  })

  it('A5.4 plattformshemligheten men fel tokentyp → 401', async () => {
    const felTyp = new JwtService({ secret: PLATTFORMSHEMLIGHET }).sign(
      { sub: 'a5-anvandare', type: 'org' },
      { expiresIn: '5m' },
    )
    const k = kropp()
    const svar = await skapa(k, felTyp)
    expect(svar.statusCode).toBe(401)
    expect(await raderFor(k)).toEqual({ orgs: 0, users: 0 })
  })
})
