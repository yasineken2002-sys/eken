/**
 * F-10 — `PATCH /v1/organizations/me` kan sätta företagsadressen.
 *
 * Organisationer registrerade före 2026-09-25 har `street/city/postalCode = ''`
 * och skrivs INTE om (ingen backfill). Vägen för dem att få en adress är
 * inställningssidan, som skickar de tre fälten hit. Regeln:
 *
 *   - de tre fälten är EN grupp — alla eller inget
 *   - `null`/utelämnat betyder "ingen ändring" (samma semantik som bankgirot)
 *   - postnumret prövas mot den svenska regeln BARA när organisationens
 *     lagrade `country` är `SE`
 *   - rollgränsen är rutens: ADMIN + OWNER; org A når aldrig org B:s rad
 *
 * Riggen är samma som `bankgiro-patch-http.db.spec.ts`: riktig rutt, riktig
 * pipe, riktiga guards och PostgreSQL, och raden läses före och efter.
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
it('F10 adress-PATCH-provet kräver en uttrycklig provdatabas', () => {
  expect(hasDatabase).toBe(true)
})

const HEMLIGHET = 'f10-patch-syntetisk-provhemlighet'

withDb('F-10 · PATCH /organizations/me — företagsadressen', () => {
  let app: NestFastifyApplication
  let prisma: PrismaService
  let orgId: string
  let annanOrgId: string
  let utlandskOrgId: string
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
              throw new Error('F10: delegationspausen anropades oväntat')
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
    // Tre organisationer, alla med TOMMA adressfält — formen varje organisation
    // registrerad före 2026-09-25 har. Den tredje har ett annat land.
    const skapa = (country?: string) =>
      prisma.organization.create({
        data: {
          name: 'F10 syntetisk',
          email: `f10-patch-${randomUUID()}@example.invalid`,
          street: '',
          city: '',
          postalCode: '',
          ...(country ? { country } : {}),
        },
      })
    orgId = (await skapa()).id
    annanOrgId = (await skapa()).id
    utlandskOrgId = (await skapa('NO')).id
  }, 30_000)

  beforeEach(async () => {
    // Varje fall startar från den HISTORISKA formen: tomma strängar.
    await prisma.organization.updateMany({
      where: { id: { in: [orgId, annanOrgId, utlandskOrgId] } },
      data: { street: '', city: '', postalCode: '' },
    })
  })

  afterAll(async () => {
    if (prisma)
      await prisma.organization.deleteMany({
        where: { id: { in: [orgId, annanOrgId, utlandskOrgId].filter(Boolean) } },
      })
    if (app) await app.close()
  })

  const adress = { street: '  Storgatan 1 ', postalCode: '111 22', city: ' Stockholm ' }
  const adressfalt = async (id = orgId) => {
    const r = await rad(id)
    return [r.street, r.postalCode, r.city]
  }

  it('F10.P1 giltig adress → 200, sparad trimmad', async () => {
    const svar = await patcha(adress)
    expect(svar.statusCode).toBe(200)
    expect(await adressfalt()).toEqual(['Storgatan 1', '111 22', 'Stockholm'])
  })

  it('F10.P2 historisk org: PATCH av ANNAT fält lämnar tomma adressen orörd (ingen backfill)', async () => {
    const svar = await patcha({ paymentTermsDays: 20 })
    expect(svar.statusCode).toBe(200)
    expect(await adressfalt()).toEqual(['', '', ''])
  })

  it('F10.P3 null i alla tre = ingen ändring', async () => {
    await patcha(adress)
    const svar = await patcha({ street: null, postalCode: null, city: null })
    expect(svar.statusCode).toBe(200)
    expect(await adressfalt()).toEqual(['Storgatan 1', '111 22', 'Stockholm'])
  })

  it.each([
    ['bara orten', { city: 'Malmö' }, 'tillsammans'],
    ['gata + ort utan postnummer', { street: 'Storgatan 1', city: 'Malmö' }, 'tillsammans'],
    ['blank gata', { ...adress, street: '   ' }, 'Gatuadress krävs'],
    ['svenskt postnummer fel form', { ...adress, postalCode: '1234' }, 'fem siffror'],
    ['svenskt postnummer 0XX', { ...adress, postalCode: '012 34' }, 'fem siffror'],
    ['tom ort', { ...adress, city: '' }, 'Ort krävs'],
  ])('F10.P4 %s → 400 och raden OFÖRÄNDRAD', async (_n, kropp, text) => {
    const fore = await rad()
    const svar = await patcha(kropp)
    expect(svar.statusCode).toBe(400)
    expect(String(svar.json().error.message)).toContain(text)
    expect({ ...(await rad()), updatedAt: null }).toEqual({ ...fore, updatedAt: null })
  })

  it('F10.P5 utländsk org (country NO) får INTE den svenska postnummerregeln', async () => {
    const svar = await patcha(
      { street: 'Karl Johans gate 1', postalCode: '0154', city: 'Oslo' },
      token('OWNER', utlandskOrgId),
    )
    expect(svar.statusCode).toBe(200)
    expect(await adressfalt(utlandskOrgId)).toEqual(['Karl Johans gate 1', '0154', 'Oslo'])
  })

  it('F10.P5 negativ referens: samma postnummer avvisas för en svensk org', async () => {
    const svar = await patcha({ street: 'Karl Johans gate 1', postalCode: '0154', city: 'Oslo' })
    expect(svar.statusCode).toBe(400)
    expect(await adressfalt()).toEqual(['', '', ''])
  })

  it.each([['VIEWER'], ['ACCOUNTANT'], ['MANAGER']])(
    'F10.P6 %s nekas 403 och raden är oförändrad',
    async (roll) => {
      const fore = await rad()
      const svar = await patcha(adress, token(roll))
      expect(svar.statusCode).toBe(403)
      expect({ ...(await rad()), updatedAt: null }).toEqual({ ...fore, updatedAt: null })
    },
  )

  it.each([['ADMIN'], ['OWNER']])('F10.P6 %s får ändra adressen', async (roll) => {
    const svar = await patcha(adress, token(roll))
    expect(svar.statusCode).toBe(200)
    expect(await adressfalt()).toEqual(['Storgatan 1', '111 22', 'Stockholm'])
  })

  it('F10.P7 org A:s PATCH når aldrig org B:s rad', async () => {
    const annanFore = await rad(annanOrgId)
    const svar = await patcha(adress, token('OWNER', orgId))
    expect(svar.statusCode).toBe(200)
    expect(await rad(annanOrgId)).toEqual(annanFore)
  })

  it('F10.P7 GET /organizations/me svarar med PLATTA adressfält (webbens typ)', async () => {
    await patcha(adress)
    const svar = await app.inject({
      method: 'GET',
      url: '/v1/organizations/me',
      headers: { authorization: `Bearer ${token()}` },
    })
    expect(svar.statusCode).toBe(200)
    const data = svar.json().data
    expect([data.street, data.postalCode, data.city, data.country]).toEqual([
      'Storgatan 1',
      '111 22',
      'Stockholm',
      'SE',
    ])
    expect(data.address).toBeUndefined()
  })
})
