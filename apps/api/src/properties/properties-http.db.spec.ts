import { randomUUID } from 'node:crypto'
import { ValidationPipe, VersioningType } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { CreatePropertySchema, UpdatePropertySchema } from '@eken/shared'
import { JwtStrategy } from '../auth/strategies/jwt.strategy'
import { VALIDATION_PIPE_OPTIONS } from '../common/contract/validation-pipe-options'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { TransformInterceptor } from '../common/interceptors/transform.interceptor'
import { PrismaService } from '../common/prisma/prisma.service'
import { PropertiesController } from './properties.controller'
import { PropertiesService } from './properties.service'

// Actual HTTP routing, DTO metadata, production pipe, JWT/role guards, service
// and PostgreSQL. No direct service writes, except explicit historical fixtures.
// CI's Tests job supplies DATABASE_URL and applies the committed migrations.
const hasDatabase = Boolean(process.env.DATABASE_URL)
const withDb = hasDatabase ? describe : describe.skip
it('F056 HTTP tests require an explicit test database', () => {
  expect(hasDatabase).toBe(true)
})
const address = { street: 'Testgatan 1', city: 'Teststad', postalCode: '111 22', country: 'SE' }
const year = new Date().getFullYear()
const body = () => ({
  name: 'F056',
  propertyDesignation: `F056 ${randomUUID()}`,
  type: 'RESIDENTIAL',
  address,
  totalArea: 100,
  yearBuilt: 2000,
})
const cases: [string, Record<string, unknown>, boolean][] = [
  ['name 199', { name: 'N'.repeat(199) }, true],
  ['name 200', { name: 'N'.repeat(200) }, true],
  ['name 201', { name: 'N'.repeat(201) }, false],
  ['empty name', { name: '' }, false],
  ['null name', { name: null }, false],
  ['empty designation', { propertyDesignation: '' }, false],
  ['blank designation after existing trim', { propertyDesignation: '   ' }, false],
  ['null designation', { propertyDesignation: null }, false],
  ['bad postal code', { address: { ...address, postalCode: 'abc' } }, false],
  ['postal lower boundary', { address: { ...address, postalCode: '10000' } }, true],
  ['postal upper boundary', { address: { ...address, postalCode: '984 99' } }, true],
  ['postal outside range', { address: { ...address, postalCode: '98500' } }, false],
  ['empty street', { address: { ...address, street: '' } }, false],
  ['empty city', { address: { ...address, city: '' } }, false],
  ['null address', { address: null }, false],
  ['partial nested address', { address: { city: 'Ny stad' } }, false],
  ['default country', { address: { street: 'Test', city: 'Test', postalCode: '11122' } }, true],
  ['empty country remains allowed', { address: { ...address, country: '' } }, true],
  ['null country', { address: { ...address, country: null } }, false],
  ['zero area', { totalArea: 0 }, false],
  ['fraction below existing API minimum', { totalArea: 0.5 }, false],
  ['minimum area', { totalArea: 1 }, true],
  ['null area', { totalArea: null }, false],
  ['string area', { totalArea: '100' }, false],
  ['lower year', { yearBuilt: 1800 }, true],
  ['current year', { yearBuilt: year }, true],
  ['year below minimum', { yearBuilt: 1799 }, false],
  ['future year', { yearBuilt: year + 1 }, false],
  ['fractional year', { yearBuilt: 2000.5 }, false],
  ['null year', { yearBuilt: null }, false],
  ['empty year', { yearBuilt: '' }, false],
  ['null type', { type: null }, false],
]

withDb('F056 property HTTP contract', () => {
  let app: NestFastifyApplication
  let prisma: PrismaService
  let orgId: string
  let otherOrgId: string
  const jwt = new JwtService({ secret: 'f056-synthetic-test-secret' })
  const token = (role = 'OWNER', organizationId = orgId) =>
    jwt.sign({ sub: randomUUID(), organizationId, role })
  const request = (
    method: 'POST' | 'PATCH' | 'GET',
    path: string,
    payload?: object,
    auth = token(),
  ) =>
    app.inject({
      method,
      url: `/v1/properties${path}`,
      headers: { authorization: `Bearer ${auth}` },
      ...(payload ? { payload } : {}),
    })
  const create = async () => {
    const response = await request('POST', '', body())
    expect(response.statusCode).toBe(201)
    return response.json().data.id as string
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [PropertiesController],
      providers: [
        PropertiesService,
        PrismaService,
        JwtStrategy,
        {
          provide: ConfigService,
          // Do not consult inherited JWT_SECRET or any .env in a test.
          useValue: { getOrThrow: () => 'f056-synthetic-test-secret' },
        },
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
    prisma = module.get(PrismaService)
    for (const other of [false, true]) {
      const org = await prisma.organization.create({
        data: {
          name: 'F056 synthetic',
          email: `f056-${randomUUID()}@example.invalid`,
          street: 'Test',
          city: 'Test',
          postalCode: '11122',
        },
      })
      if (other) otherOrgId = org.id
      else orgId = org.id
    }
  }, 30_000)

  afterEach(async () => {
    await prisma.property.deleteMany({ where: { organizationId: { in: [orgId, otherOrgId] } } })
  })
  afterAll(async () => {
    if (prisma)
      await prisma.organization.deleteMany({
        where: { id: { in: [orgId, otherOrgId].filter(Boolean) } },
      })
    if (app) await app.close()
  })

  it.each(cases)(
    '%s: POST/PATCH and shared schemas agree, rejected writes preserve DB',
    async (_label, fields, valid) => {
      const input = { ...body(), ...fields }
      expect(CreatePropertySchema.safeParse(input).success).toBe(valid)
      expect(UpdatePropertySchema.safeParse(fields).success).toBe(valid)
      const id = await create()
      const before = await prisma.property.findUniqueOrThrow({ where: { id } })
      const post = await request('POST', '', input)
      expect(post.statusCode).toBe(valid ? 201 : 400)
      const patch = await request('PATCH', `/${id}`, fields)
      expect(patch.statusCode).toBe(valid ? 200 : 400)
      expect(await prisma.property.count({ where: { organizationId: orgId } })).toBe(valid ? 2 : 1)
      const stored = await prisma.property.findUniqueOrThrow({ where: { id } })
      if (!valid) expect(stored).toEqual(before)
      else {
        const get = await request('GET', `/${id}`)
        expect(get.statusCode).toBe(200)
        expect(get.json().data).toMatchObject(patch.json().data)
        if (fields.address) {
          // ERSÄTTER `?? 'SE'`. Den gamla raden asserterade att ett UTELÄMNAT
          // land blir `SE`, och gjorde därmed en oavsiktlig återställning till
          // avsedd produkt. Beslutet: ett explicit land följer det delade
          // schemat, ett utelämnat land BEVARAR det lagrade. Fixturen här är
          // skapad med `SE`, så den skillnaden syns först i de namngivna proven
          // nedan — därför finns de.
          const skickatLand = (fields.address as Partial<typeof address>).country
          expect(stored.country).toBe(skickatLand ?? before.country)
        }
      }
    },
  )

  it('F056 rejects a 201-character create before it can trap a later form edit', async () => {
    const response = await request('POST', '', { ...body(), name: 'N'.repeat(201) })
    expect(response.statusCode).toBe(400)
    expect(await prisma.property.count({ where: { organizationId: orgId } })).toBe(0)
  })

  it('200-character name survives full edit and reload unchanged', async () => {
    const input = { ...body(), name: 'N'.repeat(200) }
    const post = await request('POST', '', input)
    expect(post.statusCode).toBe(201)
    const id = post.json().data.id
    const patch = await request('PATCH', `/${id}`, {
      ...input,
      address: { ...address, city: 'Ny stad' },
    })
    expect(patch.statusCode).toBe(200)
    const row = await prisma.property.findUniqueOrThrow({ where: { id } })
    expect(row.name).toBe(input.name)
    expect(row.city).toBe('Ny stad')
    expect((await request('GET', `/${id}`)).json().data.address.city).toBe('Ny stad')
  })

  it('partial and empty PATCH preserve omitted fields, including building year', async () => {
    const id = await create()
    const before = await prisma.property.findUniqueOrThrow({ where: { id } })
    expect((await request('PATCH', `/${id}`, { name: 'Nytt namn' })).statusCode).toBe(200)
    expect((await request('PATCH', `/${id}`, {})).statusCode).toBe(200)
    const row = await prisma.property.findUniqueOrThrow({ where: { id } })
    expect(row).toEqual({ ...before, name: 'Nytt namn', updatedAt: row.updatedAt })
    const withoutYear: Partial<ReturnType<typeof body>> = body()
    delete withoutYear.yearBuilt
    const post = await request('POST', '', withoutYear)
    expect(post.statusCode).toBe(201)
    expect(
      (await prisma.property.findUniqueOrThrow({ where: { id: post.json().data.id } })).yearBuilt,
    ).toBeNull()
  })

  it('missing address and unknown top-level/nested keys are rejected', async () => {
    const withoutAddress: Partial<ReturnType<typeof body>> = body()
    delete withoutAddress.address
    for (const input of [
      withoutAddress,
      { ...body(), unexpected: true },
      { ...body(), address: { ...address, unexpected: true } },
    ]) {
      expect((await request('POST', '', input)).statusCode).toBe(400)
    }
    expect(await prisma.property.count({ where: { organizationId: orgId } })).toBe(0)
  })

  it('historical invalid values stay intact in partial PATCH; explicit correction enables full edit', async () => {
    const id = await create()
    // Historical fixture only; this is NOT proof of the creation contract.
    await prisma.property.update({
      where: { id },
      data: { name: 'N'.repeat(201), postalCode: 'abc' },
    })
    expect((await request('PATCH', `/${id}`, { totalArea: 101 })).statusCode).toBe(200)
    const row = await prisma.property.findUniqueOrThrow({ where: { id } })
    expect(row.name).toHaveLength(201)
    expect(row.postalCode).toBe('abc')
    expect(Number(row.totalArea)).toBe(101)
    const loaded = (await request('GET', `/${id}`)).json().data
    const input = {
      name: loaded.name,
      propertyDesignation: loaded.propertyDesignation,
      type: loaded.type,
      address: loaded.address,
      totalArea: loaded.totalArea,
    }
    expect((await request('PATCH', `/${id}`, { ...input, totalArea: 102 })).statusCode).toBe(400)
    const corrected = {
      ...input,
      name: 'Rättat av användaren',
      address: { ...address, city: 'Ny stad' },
    }
    expect((await request('PATCH', `/${id}`, corrected)).statusCode).toBe(200)
    expect((await request('GET', `/${id}`)).json().data).toMatchObject(corrected)
  })

  it('F056 address PATCH without country preserves a stored non-SE country', async () => {
    const post = await request('POST', '', { ...body(), address: { ...address, country: 'NO' } })
    expect(post.statusCode).toBe(201)
    const id = post.json().data.id as string
    expect((await prisma.property.findUniqueOrThrow({ where: { id } })).country).toBe('NO')

    const patch = await request('PATCH', `/${id}`, {
      address: { street: 'Nygatan 2', city: 'Nystad', postalCode: '11122' },
    })
    expect(patch.statusCode).toBe(200)
    const row = await prisma.property.findUniqueOrThrow({ where: { id } })
    expect(row.country).toBe('NO')
    expect(row.street).toBe('Nygatan 2')
    expect(row.city).toBe('Nystad')
    expect((await request('GET', `/${id}`)).json().data.address.country).toBe('NO')
  })

  it('F056 an explicit country follows the shared schema, empty string included', async () => {
    const id = await create()
    const stored = async () => (await prisma.property.findUniqueOrThrow({ where: { id } })).country
    for (const land of ['NO', '', 'SE', '']) {
      expect(
        (await request('PATCH', `/${id}`, { address: { ...address, country: land } })).statusCode,
      ).toBe(200)
      expect(await stored()).toBe(land)
    }
    // Den accepterade tomsträngen är INTE frånvaro: ett utelämnat land efter
    // den lämnar den tomma strängen kvar i stället för att fylla på `SE`.
    expect(
      (
        await request('PATCH', `/${id}`, {
          address: { street: address.street, city: address.city, postalCode: address.postalCode },
        })
      ).statusCode,
    ).toBe(200)
    expect(await stored()).toBe('')
    // `null` är fortsatt inte frånvaro, och avvisas före lagring.
    expect(
      (await request('PATCH', `/${id}`, { address: { ...address, country: null } })).statusCode,
    ).toBe(400)
    expect(await stored()).toBe('')
  })

  it('F056 POST without country keeps the existing SE default', async () => {
    const post = await request('POST', '', {
      ...body(),
      address: { street: 'Test 1', city: 'Teststad', postalCode: '11122' },
    })
    expect(post.statusCode).toBe(201)
    const row = await prisma.property.findUniqueOrThrow({ where: { id: post.json().data.id } })
    expect(row.country).toBe('SE')
    expect(post.json().data.address.country).toBe('SE')
  })

  it('F056 a historical country value stays untouched when no PATCH mentions it', async () => {
    const id = await create()
    // Historical fixture only; this is NOT proof of the creation contract.
    await prisma.property.update({ where: { id }, data: { country: 'Landet som var' } })
    expect((await request('PATCH', `/${id}`, { totalArea: 101 })).statusCode).toBe(200)
    expect((await prisma.property.findUniqueOrThrow({ where: { id } })).country).toBe(
      'Landet som var',
    )
    expect(
      (
        await request('PATCH', `/${id}`, {
          address: { street: 'Nygatan 3', city: 'Nystad', postalCode: '11122' },
        })
      ).statusCode,
    ).toBe(200)
    const row = await prisma.property.findUniqueOrThrow({ where: { id } })
    expect(row.country).toBe('Landet som var')
    expect(row.street).toBe('Nygatan 3')
  })

  it.each(['OWNER', 'ADMIN', 'MANAGER'])('%s can create and edit', async (role) => {
    const post = await request('POST', '', body(), token(role))
    expect(post.statusCode).toBe(201)
    expect(
      (await request('PATCH', `/${post.json().data.id}`, { name: 'Tillåten' }, token(role)))
        .statusCode,
    ).toBe(200)
  })

  it('unauthenticated/forbidden/foreign-tenant writes do not change the row', async () => {
    const id = await create()
    const before = await prisma.property.findUniqueOrThrow({ where: { id } })
    for (const [auth, status] of [
      ['invalid', 401],
      [token('VIEWER'), 403],
      [token('ACCOUNTANT'), 403],
    ] as const) {
      expect((await request('POST', '', body(), auth)).statusCode).toBe(status)
      expect((await request('PATCH', `/${id}`, { name: 'Otillåten' }, auth)).statusCode).toBe(
        status,
      )
    }
    for (const method of ['PATCH', 'GET'] as const) {
      expect(
        (
          await request(
            method,
            `/${id}`,
            method === 'PATCH' ? { name: 'Grannen' } : undefined,
            token('OWNER', otherOrgId),
          )
        ).statusCode,
      ).toBe(404)
    }
    expect(await prisma.property.findUniqueOrThrow({ where: { id } })).toEqual(before)
    expect(await prisma.property.count({ where: { organizationId: orgId } })).toBe(1)
  })
})
