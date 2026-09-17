/**
 * F057 · OBJEKTETS FASTIGHETSTILLHÖRIGHET MOT EN RIKTIG DATABAS
 *
 * ── VARFÖR DEN HÄR FILEN FINNS VID SIDAN AV DEN ANDRA ───────────────────────
 *
 * `unit-property-move.integration.spec.ts` mäter HTTP-gränsen, DTO:n, pipen och
 * tjänstens mappning — men den ersätter `PrismaService` med en attrapp. Den
 * avgränsningen står i filens egen rubrik och är korrekt, men den kan inte visa
 * att en rad i PostgreSQL faktiskt står kvar: en attrapp bevisar bara att
 * attrappen inte anropades.
 *
 * Den här filen kör samma rutter mot en RIKTIG `PrismaService` och en riktig
 * PostgreSQL med syntetiska rader, och läser tillbaka raden efter varje anrop.
 * Båda filerna behålls: den ena är snabb och mäter kontraktet, den här mäter
 * lagringen.
 *
 * ── VAD SOM ÄR ÄKTA HÄR, OCH VAD SOM INTE ÄR DET ────────────────────────────
 *
 * ÄKTA: `UnitsController`, `UnitsService`, `PrismaService` (med sina två
 * extensions), PostgreSQL, produktionens `VALIDATION_PIPE_OPTIONS`-objekt,
 * URI-versioneringen `/v1`, `TransformInterceptor`, och BÅDA de riktiga
 * vakterna — `JwtAuthGuard` med den riktiga `JwtStrategy` (signerade tokens,
 * alltså mäts 401 på riktigt) och den riktiga `RolesGuard`.
 *
 * INTE ÄKTA: inloggningsflödet som utfärdar en token. Proven signerar sina egna
 * tokens med en provhemlighet. Det som mäts är alltså att en signerad token
 * verifieras och att dess `organizationId`/`role` styr utfallet — inte att
 * `/auth/login` delar ut rätt token.
 *
 * INTE MÄTT HÄR: webbklientens formulär. Det ägs av webbens egna prov.
 */

import { randomUUID } from 'node:crypto'
import { ValidationPipe, VersioningType } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { PassportModule } from '@nestjs/passport'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { JwtStrategy } from '../auth/strategies/jwt.strategy'
import { VALIDATION_PIPE_OPTIONS } from '../common/contract/validation-pipe-options'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { TransformInterceptor } from '../common/interceptors/transform.interceptor'
import { PrismaService } from '../common/prisma/prisma.service'
import { UnitsController } from './units.controller'
import { UnitsService } from './units.service'

// Villkorlig överhoppning + ALLTID körd förutsättningskontroll, enligt
// `check-skip-preconditions.mjs` R1/R2. Utan raden nedan hade en saknad databas
// gjort sviten grön genom att inte köras.
const harDatabas = Boolean(process.env.DATABASE_URL)
const medDb = harDatabas ? describe : describe.skip
it('F057:s databasprov kräver en uttrycklig provdatabas', () => {
  expect(harDatabas).toBe(true)
})

const HEMLIGHET = 'f057-syntetisk-provhemlighet'

medDb('PATCH /v1/units/:id · fastighetstillhörighet mot riktig PostgreSQL (F057)', () => {
  let app: NestFastifyApplication
  let prisma: PrismaService
  const jwt = new JwtService({ secret: HEMLIGHET })

  let orgA = ''
  let orgB = ''
  let fastighetA1 = ''
  let fastighetA2 = ''
  let fastighetB1 = ''
  let objekt = ''

  const token = (role = 'MANAGER', organizationId = orgA) =>
    jwt.sign({ sub: randomUUID(), email: 'provare@example.invalid', organizationId, role })

  const patcha = (kropp: unknown, auth: string = token()) =>
    app.inject({
      method: 'PATCH',
      url: `/v1/units/${objekt}`,
      headers: { authorization: `Bearer ${auth}` },
      payload: kropp as object,
    })

  const las = () => prisma.unit.findUniqueOrThrow({ where: { id: objekt } })

  /** Kroppen webbens redigeringsformulär faktiskt skickar (`UnitForm.tsx:88-98`). */
  const formularetsKropp = (over: Record<string, unknown> = {}) => ({
    propertyId: fastighetA1,
    name: 'Lägenhet 3A',
    unitNumber: '301',
    type: 'APARTMENT',
    status: 'VACANT',
    area: 72,
    floor: 3,
    rooms: 3,
    monthlyRent: 9500,
    ...over,
  })

  beforeAll(async () => {
    const modul = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [UnitsController],
      providers: [
        UnitsService,
        PrismaService,
        JwtStrategy,
        // Ingen .env läses i ett prov: strategin ska verifiera mot exakt den
        // hemlighet proven signerar med.
        { provide: ConfigService, useValue: { getOrThrow: () => HEMLIGHET } },
      ],
    }).compile()

    app = modul.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    })
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
    // SAMMA objekt som main.ts:155, inte en kopia av inställningarna.
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS))
    // Samma ordning som auth.module.ts:34-35 — JWT först, roll sedan.
    app.useGlobalGuards(new JwtAuthGuard(new Reflector()), new RolesGuard(new Reflector()))
    app.useGlobalInterceptors(new TransformInterceptor())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    prisma = modul.get(PrismaService)

    const orgs = await Promise.all(
      ['F057 org A', 'F057 org B'].map((name) =>
        prisma.organization.create({
          data: {
            name,
            email: `f057-${randomUUID()}@example.invalid`,
            street: 'Provgatan 1',
            city: 'Provstad',
            postalCode: '11122',
          },
        }),
      ),
    )
    orgA = orgs[0]!.id
    orgB = orgs[1]!.id

    const fastighet = (organizationId: string, namn: string) =>
      prisma.property.create({
        data: {
          organizationId,
          name: namn,
          propertyDesignation: `F057 ${randomUUID()}`,
          type: 'RESIDENTIAL',
          street: 'Provgatan 1',
          city: 'Provstad',
          postalCode: '11122',
          country: 'SE',
          totalArea: 1000,
        },
      })
    fastighetA1 = (await fastighet(orgA, 'Ekens Gård 1')).id
    fastighetA2 = (await fastighet(orgA, 'Ekens Gård 2')).id
    fastighetB1 = (await fastighet(orgB, 'Annan ägares hus')).id
  }, 60_000)

  beforeEach(async () => {
    await prisma.unit.deleteMany({ where: { property: { organizationId: { in: [orgA, orgB] } } } })
    const skapad = await prisma.unit.create({
      data: {
        propertyId: fastighetA1,
        name: 'Lägenhet 3A',
        unitNumber: '301',
        type: 'APARTMENT',
        status: 'VACANT',
        area: 72,
        floor: 3,
        rooms: 3,
        monthlyRent: 9500,
      },
    })
    objekt = skapad.id
  })

  afterAll(async () => {
    if (prisma) {
      await prisma.unit.deleteMany({
        where: { property: { organizationId: { in: [orgA, orgB] } } },
      })
      await prisma.property.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
      await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB].filter(Boolean) } } })
    }
    if (app) await app.close()
  })

  // ── Det nya fallet: uttryckligt null ──────────────────────────────────────

  it('propertyId: null avvisas — ett uttryckligt null är inte ett utelämnat fält', async () => {
    const fore = await las()
    const res = await patcha({ propertyId: null })

    expect(res.statusCode).toBe(400)
    const efter = await las()
    expect(efter).toEqual(fore)
  })

  it('propertyId: null tillsammans med ett ändrat vanligt fält skriver ingen deländring', async () => {
    const fore = await las()
    const res = await patcha({ propertyId: null, name: 'Nytt namn' })

    expect(res.statusCode).toBe(400)
    const efter = await las()
    expect(efter.name).toBe(fore.name)
    expect(efter).toEqual(fore)
  })

  it('GRÄNS: status/floor/rooms bär eget @IsOptional och behåller sin null-tolerans', async () => {
    // Detta är INTE ett önskemål utan en mätning av var rättningen slutar.
    // `skipNullProperties: false` ger `ValidateIf(v !== undefined)`, men
    // class-validator OCH-ar villkoren, och de tre fälten har ett eget
    // `@IsOptional()` i CreateUnitDto som säger "null = frånvarande". Ett null
    // där förblir därför en tyst no-op. Att ändra det hade också ändrat POST.
    const fore = await las()
    const res = await patcha({ status: null })

    expect(res.statusCode).toBe(200)
    const efter = await las()
    expect(efter.status).toBe(fore.status)
  })

  // ── Det som INTE får gå sönder ────────────────────────────────────────────

  it('utelämnat propertyId sparar övriga fält och lämnar tillhörigheten orörd', async () => {
    const res = await patcha({ name: 'Bara namnet' })

    expect(res.statusCode).toBe(200)
    const rad = await las()
    expect(rad.name).toBe('Bara namnet')
    expect(rad.propertyId).toBe(fastighetA1)
  })

  it('oförändrat propertyId från befintlig klient sparas, och omläsningen visar det', async () => {
    const res = await patcha(formularetsKropp({ name: 'Lägenhet 3A (renoverad)' }))
    expect(res.statusCode).toBe(200)

    const rad = await las()
    expect(rad.name).toBe('Lägenhet 3A (renoverad)')
    expect(rad.propertyId).toBe(fastighetA1)

    // Egen omläsning över HTTP — svaret från skrivningen räknas inte som bevis
    // för vad som ligger i databasen.
    const get = await app.inject({
      method: 'GET',
      url: `/v1/units/${objekt}`,
      headers: { authorization: `Bearer ${token()}` },
    })
    expect(get.statusCode).toBe(200)
    const kropp = get.json().data
    expect(kropp.propertyId).toBe(fastighetA1)
    expect(kropp.name).toBe('Lägenhet 3A (renoverad)')
    expect(kropp.property.id).toBe(fastighetA1)
  })

  // ── Gränser ───────────────────────────────────────────────────────────────

  it('ett annat giltigt propertyId i samma organisation avvisas och flyttar ingenting', async () => {
    const fore = await las()
    const res = await patcha(formularetsKropp({ propertyId: fastighetA2, name: 'Omdöpt' }))

    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('fastighet')
    expect(await las()).toEqual(fore)
  })

  it('ett propertyId som pekar på en ANNAN organisations fastighet avvisas', async () => {
    const fore = await las()
    const res = await patcha(formularetsKropp({ propertyId: fastighetB1 }))

    expect(res.statusCode).toBe(400)
    expect(await las()).toEqual(fore)
  })

  it('en aktör från en annan organisation når inte objektet alls (404)', async () => {
    const fore = await las()
    const res = await patcha(formularetsKropp({ propertyId: fastighetA2 }), token('MANAGER', orgB))

    expect(res.statusCode).toBe(404)
    expect(await las()).toEqual(fore)
  })

  it('en VIEWER stoppas av den riktiga rollgrinden (403) och skriver ingenting', async () => {
    const fore = await las()
    const res = await patcha(formularetsKropp({ name: 'Otillåten' }), token('VIEWER'))

    expect(res.statusCode).toBe(403)
    expect(await las()).toEqual(fore)
  })

  it('en osignerad/ogiltig token avvisas av den riktiga JWT-vakten (401)', async () => {
    const fore = await las()
    const res = await patcha(formularetsKropp({ name: 'Otillåten' }), 'inte-en-token')

    expect(res.statusCode).toBe(401)
    expect(await las()).toEqual(fore)
  })
})
