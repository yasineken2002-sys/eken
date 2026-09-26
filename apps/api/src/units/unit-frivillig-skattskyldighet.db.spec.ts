/**
 * I2 · SKRIVVÄGEN FÖR `Unit.voluntaryTaxLiability` MOT RIKTIG POSTGRESQL
 *
 * ── FYNDET ──────────────────────────────────────────────────────────────────
 *
 * Fältet fanns i schemat (default false) och lästes av momsregeln
 * (`vatRateForRent`) i fakturor, avier och förbrukning — men ingen DTO bar det.
 * `forbidNonWhitelisted` avvisade därför varje försök att sätta det, och en
 * hyresvärd med en momspliktig lokal kunde inte markera den. Flaggan var
 * `false` för alla objekt utan ett DB-ingrepp.
 *
 * ── KONTRAKTET SOM PRÖVAS ───────────────────────────────────────────────────
 *
 *   utelämnat   POST → false (DB-default) · PATCH → oförändrat
 *   true/false  sparas som de är — ett giltigt `false` är ett värde, inte "inget"
 *   null        400, ingen skrivning (samma regel som `propertyId`)
 *   fel typ     400 — `"ja"`, `"0"`, `""`, 1 och objekt koerceras inte
 *               (`@StrictBoolean`). Strängformerna `"true"`/`"false"` godtas
 *               med flit — husets dokumenterade kontrakt i
 *               strict-boolean.decorator.ts — och sparas som booleaner.
 *   typgräns    `true` avvisas (400) på en typ där flaggan INTE påverkar
 *               regelns sats — härlett ur `vatRateForRent` själv, inte ur en
 *               egen lista. Bostad och parkering kan alltså inte bli
 *               "frivilligt skattskyldiga" via reglaget, och deras moms är
 *               oförändrad.
 *   behörighet  samma som övriga objektfält: MANAGER+ skriver, VIEWER/
 *               ACCOUNTANT 403, annan organisation 404, ingen token 401.
 *
 * ── VAD PROVET INTE KAN SE ─────────────────────────────────────────────────
 *
 * Att en ny faktura på objektet får 25 % mäts i webbläsarriggen (CLAUDE2
 * 4L, raw/) och i `InvoiceForm.moms.test.tsx`; att portalen inte visar fältet
 * bärs av `SAFE_PORTAL_UNIT_SELECT` och `tenant-portal.leak.spec.ts`.
 */

import { randomUUID } from 'node:crypto'
import { ValidationPipe, VersioningType } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { PassportModule } from '@nestjs/passport'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { vatRateForRent } from '@eken/shared'
import { JwtStrategy } from '../auth/strategies/jwt.strategy'
import { VALIDATION_PIPE_OPTIONS } from '../common/contract/validation-pipe-options'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { TransformInterceptor } from '../common/interceptors/transform.interceptor'
import { PrismaService } from '../common/prisma/prisma.service'
import { UnitsController } from './units.controller'
import { UnitsService } from './units.service'

const harDatabas = Boolean(process.env.DATABASE_URL)
const medDb = harDatabas ? describe : describe.skip
it('I2:s databasprov kräver en uttrycklig provdatabas', () => {
  expect(harDatabas).toBe(true)
})

const HEMLIGHET = 'i2-syntetisk-provhemlighet'

medDb('Unit.voluntaryTaxLiability — skrivväg mot riktig PostgreSQL (I2)', () => {
  let app: NestFastifyApplication
  let prisma: PrismaService
  const jwt = new JwtService({ secret: HEMLIGHET })

  let orgA = ''
  let orgB = ''
  let fastighet = ''
  let lokal = ''

  const token = (role = 'MANAGER', organizationId = orgA) =>
    jwt.sign({ sub: randomUUID(), email: 'provare@example.invalid', organizationId, role })

  const anrop = (
    metod: 'POST' | 'PATCH',
    url: string,
    kropp: unknown,
    auth: string | null = token(),
  ) =>
    app.inject({
      method: metod,
      url,
      headers: auth ? { authorization: `Bearer ${auth}` } : {},
      payload: kropp as object,
    })
  const patcha = (kropp: unknown, auth?: string | null) =>
    anrop('PATCH', `/v1/units/${lokal}`, kropp, auth === undefined ? token() : auth)
  const las = (id = lokal) => prisma.unit.findUniqueOrThrow({ where: { id } })

  /** Kroppen webbens formulär skickar vid skapande. */
  const nytt = (over: Record<string, unknown> = {}) => ({
    propertyId: fastighet,
    name: 'Objekt',
    unitNumber: `N-${randomUUID().slice(0, 8)}`,
    type: 'OFFICE',
    status: 'VACANT',
    area: 40,
    monthlyRent: 12000,
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
        { provide: ConfigService, useValue: { getOrThrow: () => HEMLIGHET } },
      ],
    }).compile()
    app = modul.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    })
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS))
    app.useGlobalGuards(new JwtAuthGuard(new Reflector()), new RolesGuard(new Reflector()))
    app.useGlobalInterceptors(new TransformInterceptor())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    prisma = modul.get(PrismaService)

    const orgs = await Promise.all(
      ['I2 org A', 'I2 org B'].map((name) =>
        prisma.organization.create({
          data: {
            name,
            email: `i2-${randomUUID()}@example.invalid`,
            street: 'Provgatan 1',
            city: 'Provstad',
            postalCode: '11122',
          },
        }),
      ),
    )
    orgA = orgs[0]!.id
    orgB = orgs[1]!.id
    fastighet = (
      await prisma.property.create({
        data: {
          organizationId: orgA,
          name: 'Ekens Gård 1',
          propertyDesignation: `I2 ${randomUUID()}`,
          type: 'COMMERCIAL',
          street: 'Provgatan 1',
          city: 'Provstad',
          postalCode: '11122',
          country: 'SE',
          totalArea: 1000,
        },
      })
    ).id
  }, 60_000)

  beforeEach(async () => {
    await prisma.unit.deleteMany({ where: { property: { organizationId: { in: [orgA, orgB] } } } })
    lokal = (
      await prisma.unit.create({
        data: {
          propertyId: fastighet,
          name: 'Kontor 0101',
          unitNumber: '0101',
          type: 'OFFICE',
          status: 'VACANT',
          area: 40,
          monthlyRent: 12000,
        },
      })
    ).id
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

  // ── Skrivvägen ────────────────────────────────────────────────────────────

  it('PATCH av → på → av: varje värde når databasen, och ett giltigt false sparas', async () => {
    expect((await las()).voluntaryTaxLiability).toBe(false)

    const pa = await patcha({ voluntaryTaxLiability: true })
    expect(pa.statusCode).toBe(200)
    expect(pa.json().data.voluntaryTaxLiability).toBe(true)
    expect((await las()).voluntaryTaxLiability).toBe(true)
    // Regelns sats för objektet följer — samma funktion som fakturan läser.
    const u = await las()
    expect(vatRateForRent(u.type, u.voluntaryTaxLiability)).toBe(25)

    const av = await patcha({ voluntaryTaxLiability: false })
    expect(av.statusCode).toBe(200)
    expect((await las()).voluntaryTaxLiability).toBe(false)
    const u2 = await las()
    expect(vatRateForRent(u2.type, u2.voluntaryTaxLiability)).toBe(0)
  })

  it('utelämnat i PATCH lämnar flaggan orörd', async () => {
    await patcha({ voluntaryTaxLiability: true })
    const res = await patcha({ name: 'Kontor 0101 (nytt namn)' })
    expect(res.statusCode).toBe(200)
    const efter = await las()
    expect(efter.name).toBe('Kontor 0101 (nytt namn)')
    expect(efter.voluntaryTaxLiability).toBe(true)
  })

  it('POST: true sparas på en lokal, utelämnat ger false', async () => {
    const med = await anrop('POST', '/v1/units', nytt({ voluntaryTaxLiability: true }))
    expect(med.statusCode).toBe(201)
    expect((await las(med.json().data.id)).voluntaryTaxLiability).toBe(true)

    const utan = await anrop('POST', '/v1/units', nytt())
    expect(utan.statusCode).toBe(201)
    expect((await las(utan.json().data.id)).voluntaryTaxLiability).toBe(false)
  })

  it.each(['RETAIL', 'STORAGE', 'OTHER'])('POST %s med true sparas', async (type) => {
    const res = await anrop('POST', '/v1/units', nytt({ type, voluntaryTaxLiability: true }))
    expect(res.statusCode).toBe(201)
    expect((await las(res.json().data.id)).voluntaryTaxLiability).toBe(true)
  })

  // ── Kontraktet: null och fel typ ─────────────────────────────────────────

  it.each([
    ['null', null],
    ['strängen "ja"', 'ja'],
    ['strängen "0"', '0'],
    ['tomma strängen', ''],
    ['talet 1', 1],
    ['ett objekt', { varde: true }],
  ])('PATCH med %s avvisas med 400 och skriver ingenting', async (_n, varde) => {
    await patcha({ voluntaryTaxLiability: true })
    const fore = await las()
    const res = await patcha({ voluntaryTaxLiability: varde, name: 'Ska inte sparas' })
    expect(res.statusCode).toBe(400)
    expect(await las()).toEqual(fore)
  })

  it.each([
    ['null', null],
    ['strängen "nej"', 'nej'],
  ])('POST med %s avvisas med 400 och skapar inget objekt', async (_n, varde) => {
    const fore = await prisma.unit.count({ where: { propertyId: fastighet } })
    const res = await anrop('POST', '/v1/units', nytt({ voluntaryTaxLiability: varde }))
    expect(res.statusCode).toBe(400)
    expect(await prisma.unit.count({ where: { propertyId: fastighet } })).toBe(fore)
  })

  it('strängformerna "true"/"false" (husets kontrakt) sparas som booleaner', async () => {
    expect((await patcha({ voluntaryTaxLiability: 'true' })).statusCode).toBe(200)
    expect((await las()).voluntaryTaxLiability).toBe(true)
    expect((await patcha({ voluntaryTaxLiability: 'false' })).statusCode).toBe(200)
    expect((await las()).voluntaryTaxLiability).toBe(false)
  })

  // ── Typgränsen: bostad och parkering ─────────────────────────────────────

  it.each(['APARTMENT', 'PARKING'])(
    'POST %s med true avvisas med svensk text; false går igenom',
    async (type) => {
      const fore = await prisma.unit.count({ where: { propertyId: fastighet } })
      const res = await anrop('POST', '/v1/units', nytt({ type, voluntaryTaxLiability: true }))
      expect(res.statusCode).toBe(400)
      // Provappen saknar det globala felfiltret, så kroppen är Nests
      // standardform; meddelandet söks i hela svaret.
      expect(JSON.stringify(res.json())).toMatch(/Frivillig skattskyldighet/)
      expect(await prisma.unit.count({ where: { propertyId: fastighet } })).toBe(fore)

      const ok = await anrop('POST', '/v1/units', nytt({ type, voluntaryTaxLiability: false }))
      expect(ok.statusCode).toBe(201)
      const u = await las(ok.json().data.id)
      expect(u.voluntaryTaxLiability).toBe(false)
      // Satsen är densamma som före ändringen: bostad 0, parkering 25.
      expect(vatRateForRent(u.type, u.voluntaryTaxLiability)).toBe(type === 'APARTMENT' ? 0 : 25)
    },
  )

  it('lokal med flaggan → byte till bostad utan att ta bort flaggan avvisas; med false går det', async () => {
    await patcha({ voluntaryTaxLiability: true })
    const fore = await las()
    const res = await patcha({ type: 'APARTMENT' })
    expect(res.statusCode).toBe(400)
    expect(await las()).toEqual(fore)

    const ok = await patcha({ type: 'APARTMENT', voluntaryTaxLiability: false })
    expect(ok.statusCode).toBe(200)
    const efter = await las()
    expect([efter.type, efter.voluntaryTaxLiability]).toEqual(['APARTMENT', false])
  })

  it('bostad: PATCH true avvisas, bostadens moms är fortsatt 0 %', async () => {
    await prisma.unit.update({ where: { id: lokal }, data: { type: 'APARTMENT' } })
    const fore = await las()
    const res = await patcha({ voluntaryTaxLiability: true })
    expect(res.statusCode).toBe(400)
    expect(await las()).toEqual(fore)
    expect(vatRateForRent(fore.type, fore.voluntaryTaxLiability)).toBe(0)
  })

  it('en äldre bostadsrad med flaggan satt kan fortfarande redigeras i andra fält', async () => {
    // Äldre data som bara kan ha uppstått genom ett DB-ingrepp. Den ska inte
    // låsa objektet — regeln ignorerar flaggan för bostad ändå.
    await prisma.unit.update({
      where: { id: lokal },
      data: { type: 'APARTMENT', voluntaryTaxLiability: true },
    })
    const res = await patcha({ name: 'Lägenhet 0101' })
    expect(res.statusCode).toBe(200)
    expect((await las()).name).toBe('Lägenhet 0101')
  })

  // ── Behörighet och organisationsgräns ─────────────────────────────────────

  it.each(['VIEWER', 'ACCOUNTANT'])(
    '%s får inte skriva flaggan (403), ingen ändring',
    async (roll) => {
      const fore = await las()
      const res = await patcha({ voluntaryTaxLiability: true }, token(roll))
      expect(res.statusCode).toBe(403)
      expect(await las()).toEqual(fore)
    },
  )

  it('en MANAGER i en annan organisation når inte objektet (404), ingen ändring', async () => {
    const fore = await las()
    const res = await patcha({ voluntaryTaxLiability: true }, token('MANAGER', orgB))
    expect(res.statusCode).toBe(404)
    expect(await las()).toEqual(fore)
  })

  it('utan inloggning 401, ingen ändring', async () => {
    const fore = await las()
    const res = await patcha({ voluntaryTaxLiability: true }, null)
    expect(res.statusCode).toBe(401)
    expect(await las()).toEqual(fore)
  })

  it('GET /units/:id visar flaggan för organisationens egen läsare', async () => {
    await patcha({ voluntaryTaxLiability: true })
    const res = await app.inject({
      method: 'GET',
      url: `/v1/units/${lokal}`,
      headers: { authorization: `Bearer ${token('VIEWER')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.voluntaryTaxLiability).toBe(true)
  })
})
