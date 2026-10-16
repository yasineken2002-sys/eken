import { BadRequestException, ValidationPipe, VersioningType } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { JournalEntrySource } from '@prisma/client'

import { FORTNOX_EXPORT_SOURCES, JOURNAL_SOURCES, journalPageQuerySchema } from '@eken/shared'
import { JwtStrategy } from '../auth/strategies/jwt.strategy'
import { VALIDATION_PIPE_OPTIONS } from '../common/contract/validation-pipe-options'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { TransformInterceptor } from '../common/interceptors/transform.interceptor'
import { AccountingPeriodService } from './accounting-period.service'
import { AccountingController } from './accounting.controller'
import { AccountingService } from './accounting.service'
import { JournalPageQueryDto } from './dto/journal-page-query.dto'
import { SupplierInvoiceService } from './supplier-invoice.service'

const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS)
const transform = (query: Record<string, unknown>): Promise<unknown> =>
  pipe.transform(query, { type: 'query', metatype: JournalPageQueryDto })

async function expectAccepted(query: Record<string, unknown>): Promise<void> {
  const parsed = journalPageQuerySchema.parse(query)
  const actual = await transform(query)
  expect(actual).toBeInstanceOf(JournalPageQueryDto)
  expect(actual).toEqual(parsed)
}

async function expectRejected(query: Record<string, unknown>): Promise<void> {
  expect(journalPageQuerySchema.safeParse(query).success).toBe(false)
  await expect(transform(query)).rejects.toBeInstanceOf(BadRequestException)
}

describe('Journalens querykontrakt genom produktionspipen', () => {
  it('mäter implicit koercion och låter saknade fält förbli saknade', async () => {
    expect(VALIDATION_PIPE_OPTIONS.transformOptions?.enableImplicitConversion).toBe(true)
    await expectAccepted({})
    expect(journalPageQuerySchema.parse({})).toStrictEqual({})
    expect(await transform({})).toEqual({})
  })

  it.each([
    { offset: 0, limit: 1 },
    { offset: 2147483647, limit: 200 },
    { offset: '0', limit: '100' },
    { offset: '2147483647', limit: '200' },
    { from: '2024-02-29', to: '2024-02-29' },
    { from: '2000-02-29', to: '2000-03-01' },
    { from: '2025-12-31', to: '2026-01-01' },
    { from: '2026-01-01' },
    { to: '2026-12-31' },
  ])('godtar gränsen %p med samma resultat i schema och DTO', expectAccepted)

  it('konverterar kanoniska querysträngar och bevarar samtliga filter', async () => {
    const query = {
      offset: '50',
      limit: '25',
      from: '2026-03-29',
      to: '2026-10-25',
      source: 'RENT_NOTICE',
    }
    const expected = { ...query, offset: 50, limit: 25 }
    expect(journalPageQuerySchema.parse(query)).toStrictEqual(expected)
    expect(await transform(query)).toEqual(expected)
  })

  it('delar hela källmängden med Fortnox och den verkliga Prisma-enumen', async () => {
    expect(JOURNAL_SOURCES).toBe(FORTNOX_EXPORT_SOURCES)
    expect([...JOURNAL_SOURCES].sort()).toEqual(Object.values(JournalEntrySource).sort())
    for (const source of JOURNAL_SOURCES) await expectAccepted({ source })
  })

  it.each(['offset', 'limit', 'from', 'to', 'source'])(
    '%s är valfritt men avvisar null, array, objekt och boolean',
    async (field) => {
      for (const value of [null, [], ['1'], {}, true, false]) {
        await expectRejected({ [field]: value })
      }
    },
  )

  it.each(['offset', 'limit'])(
    '%s avvisar numeriska prefix och implicit talnormalisering',
    async (field) => {
      for (const value of [
        '',
        ' ',
        '01',
        '+1',
        '-0',
        '-1',
        '1.0',
        '1e2',
        '0x10',
        '12abc',
        'Infinity',
        'NaN',
        ' 12',
        '12 ',
        '12\n',
        '12\r\n',
        1.5,
        -1,
        Infinity,
        -Infinity,
        NaN,
      ]) {
        await expectRejected({ [field]: value })
      }
    },
  )

  it.each([
    { offset: 2147483648 },
    { offset: '2147483648' },
    { offset: '999999999999999999999999' },
    { limit: 0 },
    { limit: '0' },
    { limit: 201 },
    { limit: '201' },
    { source: 'CUSTOMER_CREDIT' },
    { source: 'manual' },
    { source: '' },
    { source: 1 },
    { from: '2026-03-01', to: '2026-02-28' },
    { offset: '1', extra: 'ignored?' },
    { organizationId: 'annan-organisation' },
    { group: 'ALL' },
    { __journalPageContract: true },
  ])('avvisar %p i både schemat och DTO:n', expectRejected)

  it.each(['from', 'to'])(
    '%s kräver ett verkligt kalenderdatum utan tidsstämpel eller normalisering',
    async (field) => {
      for (const value of [
        '',
        '2026-02-29',
        '1900-02-29',
        '2024-02-30',
        '2026-04-31',
        '2026-13-01',
        '2026-00-01',
        '2026-01-00',
        '2026-1-01',
        '2026-01-1',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01 ',
        20260101,
      ]) {
        await expectRejected({ [field]: value })
      }
    },
  )
})

/** Riktig befintlig route, JWT, rollgrind och pipe. Bara tjänsteläsningen är en attrapp. */
describe('Journalens sidkontrakt genom HTTP', () => {
  const secret = 'syntetisk-journal-page-http-hemlighet'
  let app: NestFastifyApplication
  const getJournalEntriesPage = jest.fn()
  const token = (role: string, organizationId = 'org-A') =>
    new JwtService({ secret }).sign({ sub: 'syntetisk-user', organizationId, role })
  const get = (query = '', auth: string | null = token('OWNER')) =>
    app.inject({
      method: 'GET',
      url: `/v1/accounting/journal-page${query ? `?${query}` : ''}`,
      headers: auth === null ? {} : { authorization: `Bearer ${auth}` },
    })

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AccountingController],
      providers: [
        JwtStrategy,
        { provide: ConfigService, useValue: { getOrThrow: () => secret } },
        { provide: AccountingService, useValue: { getJournalEntriesPage } },
        { provide: SupplierInvoiceService, useValue: {} },
        { provide: AccountingPeriodService, useValue: {} },
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
  })

  beforeEach(() => {
    getJournalEntriesPage
      .mockReset()
      .mockImplementation(
        async (
          _organizationId: string,
          _filters: Record<string, unknown>,
          page: { offset: number; limit: number },
        ) => ({ entries: [], total: 0, ...page }),
      )
  })

  afterAll(async () => app?.close())

  it.each(['ACCOUNTANT', 'MANAGER', 'ADMIN', 'OWNER'])(
    '%s behåller tillgång till huvudbokens standard 0/100 utan datumgräns',
    async (role) => {
      const response = await get('', token(role, 'org-B'))
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        success: true,
        data: { entries: [], total: 0, offset: 0, limit: 100 },
      })
      expect(getJournalEntriesPage).toHaveBeenCalledWith('org-B', {}, { offset: 0, limit: 100 })
    },
  )

  it('förmedlar alla fem queryfält med datum oförändrade och organisation enbart ur JWT', async () => {
    const response = await get(
      'offset=50&limit=25&from=2026-03-29&to=2026-10-25&source=RENT_NOTICE',
      token('MANAGER', 'org-B'),
    )
    expect(response.statusCode).toBe(200)
    expect(getJournalEntriesPage).toHaveBeenCalledWith(
      'org-B',
      { from: '2026-03-29', to: '2026-10-25', source: 'RENT_NOTICE' },
      { offset: 50, limit: 25 },
    )
  })

  it('bevarar fullständiga verifikationsrader med konton och rättelsekopplingar i svaret', async () => {
    const entry = {
      id: 'journal-1',
      organizationId: 'org-A',
      date: '2024-02-29T00:00:00.000Z',
      description: 'Syntetiskt verifikat',
      reference: 'referens',
      source: 'MANUAL',
      sourceId: null,
      createdById: 'syntetisk-user',
      createdAt: '2024-02-29T10:00:00.000Z',
      series: 'A',
      verNumber: 7,
      fiscalYear: 2024,
      reversalOfEntryId: 'journal-original',
      reversalOf: { id: 'journal-original', series: 'A', verNumber: 6 },
      reversedBy: null,
      lines: [
        {
          id: 'line-1',
          accountId: 'account-1',
          debit: '10',
          credit: '0',
          account: { id: 'account-1', number: 1930, name: 'Syntetiskt konto' },
        },
      ],
    }
    const page = { entries: [entry], total: 1, offset: 0, limit: 100 }
    getJournalEntriesPage.mockResolvedValueOnce(page)
    const response = await get()
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ success: true, data: page })
  })

  it.each(JOURNAL_SOURCES)('förmedlar även källan %s oförändrad', async (source) => {
    expect((await get(`source=${source}`)).statusCode).toBe(200)
    expect(getJournalEntriesPage).toHaveBeenCalledWith(
      'org-A',
      { source },
      { offset: 0, limit: 100 },
    )
  })

  it.each([
    'organizationId=org-B',
    '__journalPageContract=true',
    'group=ALL',
    'offset=12abc',
    'offset=01',
    'offset=1.5',
    'offset=2147483648',
    'limit=0',
    'limit=201',
    'limit=5&limit=6',
    'from=2026-02-29',
    'from=2026-03-01&to=2026-02-28',
    'from=2026-03-29T00%3A00%3A00.000Z',
    'source=OKAND',
    'source=MANUAL&source=PAYMENT',
  ])('ogiltig query %s når inte tjänsteläsningen', async (query) => {
    expect((await get(query)).statusCode).toBe(400)
    expect(getJournalEntriesPage).not.toHaveBeenCalled()
  })

  it.each([null, 'felaktig-token'])('utan giltig JWT %s nekas läsningen', async (auth) => {
    expect((await get('', auth)).statusCode).toBe(401)
    expect(getJournalEntriesPage).not.toHaveBeenCalled()
  })

  it.each(['VIEWER', 'TENANT', 'OKAND'])('rollen %s får fortfarande inte läsa', async (role) => {
    expect((await get('', token(role))).statusCode).toBe(403)
    expect(getJournalEntriesPage).not.toHaveBeenCalled()
  })
})
