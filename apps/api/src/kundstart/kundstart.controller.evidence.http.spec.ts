import { ValidationPipe } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { ConfigService } from '@nestjs/config'
import { Test } from '@nestjs/testing'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { PassportModule } from '@nestjs/passport'
import { JwtService } from '@nestjs/jwt'
import { JwtStrategy } from '../auth/strategies/jwt.strategy'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { KundstartController } from './kundstart.controller'
import { OpeningEvidenceService } from './opening-evidence.service'
import { OpeningPackageService } from './opening-package.service'

/**
 * KUNDSTART-205: rollytan för kundavstämningen genom riktig HTTP-kedja (JWT, RolesGuard,
 * ValidationPipe). Tjänsterna är spioner här: deras DB-lästa rollkontroll, organisations-
 * bindning och jämförelse provas mot riktig Postgres i opening-evidence.db.spec.ts.
 */
describe('KUNDSTART-205 HTTP: kundavstämningens rollyta', () => {
  let app: NestFastifyApplication
  const secret = 'kundstart-205-test-secret-not-a-production-key'
  const jwt = new JwtService({ secret })
  const evidens = {
    list: jest
      .fn()
      .mockResolvedValue({ packageId: 'p', packageVersion: 1, aktuell: null, tidigare: [] }),
    create: jest.fn().mockResolvedValue({ id: 'e' }),
    review: jest.fn().mockResolvedValue({ id: 'e' }),
  }
  const paket = { approve: jest.fn().mockResolvedValue({ id: 'p', status: 'APPROVED' }) }
  const P = '11111111-2222-4333-8444-555555555555'
  const E = '66666666-7777-4888-8999-aaaaaaaaaaaa'
  const SHA = 'a'.repeat(64)
  const giltigEvidens = {
    sourceSystemProduct: 'SYNTETISK',
    sourceCompanyKey: 'GAMMALT-AB',
    scopeDeclaration: 'Hela kundreskontran',
    sourceOrgNumber: '556677-8899',
    sourceAsOfDate: '2026-10-31',
    sourceExportedAt: '2026-11-01T08:00:00Z',
    scopeResponsible: 'Ekonomichef',
    sourceName: 'reskontra.csv',
    sourceContent: 'kallforetag;kund',
    mappingName: 'mappning.csv',
    mappingContent: 'kallforetag;kund',
  }

  beforeAll(async () => {
    const deps = Reflect.getMetadata('design:paramtypes', KundstartController) as Array<
      new (...args: never[]) => unknown
    >
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [KundstartController],
      providers: [
        ...deps.map((provide) => ({
          provide,
          useValue:
            provide === OpeningEvidenceService
              ? evidens
              : provide === OpeningPackageService
                ? paket
                : {},
        })),
        JwtStrategy,
        { provide: ConfigService, useValue: new ConfigService({ JWT_SECRET: secret }) },
      ],
    }).compile()
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    app.useGlobalGuards(new JwtAuthGuard(new Reflector()), new RolesGuard(new Reflector()))
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    )
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })
  afterAll(async () => app?.close())
  beforeEach(() => jest.clearAllMocks())

  const anrop = (method: 'GET' | 'POST', url: string, role?: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload: payload as object }),
      headers: role
        ? {
            authorization: `Bearer ${jwt.sign({ sub: 'u-1', organizationId: 'egen-org', role })}`,
          }
        : {},
    })

  describe('GET /kundstart/opening-packages/:id/evidence', () => {
    it.each(['OWNER', 'ADMIN', 'ACCOUNTANT'])('%s får läsa', async (role) => {
      expect(
        (await anrop('GET', `/kundstart/opening-packages/${P}/evidence`, role)).statusCode,
      ).toBe(200)
      expect(evidens.list).toHaveBeenCalledWith('egen-org', P)
    })
    it.each(['MANAGER', 'VIEWER'])('%s nekas', async (role) => {
      expect(
        (await anrop('GET', `/kundstart/opening-packages/${P}/evidence`, role)).statusCode,
      ).toBe(403)
      expect(evidens.list).not.toHaveBeenCalled()
    })
  })

  describe('POST …/evidence (uppladdning)', () => {
    it.each(['OWNER', 'ADMIN'])('%s får skapa; organisationen kommer ur JWT', async (role) => {
      const r = await anrop(
        'POST',
        `/kundstart/opening-packages/${P}/evidence`,
        role,
        giltigEvidens,
      )
      expect(r.statusCode).toBe(201)
      expect(evidens.create).toHaveBeenCalledWith(
        'egen-org',
        P,
        { sub: 'u-1', role },
        giltigEvidens,
      )
    })
    it.each(['ACCOUNTANT', 'MANAGER', 'VIEWER'])('E11: %s får inte ladda upp', async (role) => {
      const r = await anrop(
        'POST',
        `/kundstart/opening-packages/${P}/evidence`,
        role,
        giltigEvidens,
      )
      expect(r.statusCode).toBe(403)
      expect(evidens.create).not.toHaveBeenCalled()
    })
    it.each([
      ['extern URL som artefakt', { ...giltigEvidens, sourceUrl: 'https://example.invalid/x.csv' }],
      ['klientens status', { ...giltigEvidens, comparisonStatus: 'OK' }],
      ['klientens granskare', { ...giltigEvidens, reviewerId: 'u-2' }],
      ['annan organisation i kroppen', { ...giltigEvidens, organizationId: 'annan-org' }],
      ['saknad deklaration', { ...giltigEvidens, scopeResponsible: undefined }],
      ['fel orgnr-format', { ...giltigEvidens, sourceOrgNumber: '5566778899' }],
      ['exporttid utan tid', { ...giltigEvidens, sourceExportedAt: '2026-11-01' }],
    ])('E20/E22: %s avvisas med 400 före tjänsten', async (_n, body) => {
      const r = await anrop('POST', `/kundstart/opening-packages/${P}/evidence`, 'OWNER', body)
      expect(r.statusCode).toBe(400)
      expect(evidens.create).not.toHaveBeenCalled()
    })
  })

  describe('POST …/evidence/:evidenceId/review (granskning)', () => {
    it('ACCOUNTANT får granska exakt evidenshash', async () => {
      const r = await anrop(
        'POST',
        `/kundstart/opening-packages/${P}/evidence/${E}/review`,
        'ACCOUNTANT',
        {
          evidenceSha256: SHA,
        },
      )
      expect(r.statusCode).toBe(200)
      expect(evidens.review).toHaveBeenCalledWith(
        'egen-org',
        P,
        E,
        { sub: 'u-1', role: 'ACCOUNTANT' },
        { evidenceSha256: SHA },
      )
    })
    it.each(['OWNER', 'ADMIN', 'MANAGER', 'VIEWER'])(
      'E10/E11: %s kan inte granska (bara den nya ACCOUNTANT-handlingen)',
      async (role) => {
        const r = await anrop(
          'POST',
          `/kundstart/opening-packages/${P}/evidence/${E}/review`,
          role,
          {
            evidenceSha256: SHA,
          },
        )
        expect(r.statusCode).toBe(403)
        expect(evidens.review).not.toHaveBeenCalled()
      },
    )
    it('klientens reviewerId avvisas; servern tar granskaren ur JWT/DB', async () => {
      const r = await anrop(
        'POST',
        `/kundstart/opening-packages/${P}/evidence/${E}/review`,
        'ACCOUNTANT',
        {
          evidenceSha256: SHA,
          reviewerId: 'u-annan',
        },
      )
      expect(r.statusCode).toBe(400)
      expect(evidens.review).not.toHaveBeenCalled()
    })
    it('ogiltigt id avvisas före tjänsten', async () => {
      const r = await anrop(
        'POST',
        `/kundstart/opening-packages/${P}/evidence/inte-uuid/review`,
        'ACCOUNTANT',
        {
          evidenceSha256: SHA,
        },
      )
      expect(r.statusCode).toBe(400)
      expect(evidens.review).not.toHaveBeenCalled()
    })
    it('kräver inloggning', async () => {
      const r = await anrop(
        'POST',
        `/kundstart/opening-packages/${P}/evidence/${E}/review`,
        undefined,
        {
          evidenceSha256: SHA,
        },
      )
      expect(r.statusCode).toBe(401)
    })
  })

  describe('POST …/approve', () => {
    it('OWNER: evidenceSha256 krävs och skickas vidare', async () => {
      const utan = await anrop('POST', `/kundstart/opening-packages/${P}/approve`, 'OWNER', {
        version: 1,
        sourceSha256: SHA,
      })
      expect(utan.statusCode).toBe(400)
      expect(paket.approve).not.toHaveBeenCalled()
      const med = await anrop('POST', `/kundstart/opening-packages/${P}/approve`, 'OWNER', {
        version: 1,
        sourceSha256: SHA,
        evidenceSha256: SHA,
      })
      expect(med.statusCode).toBe(200)
      expect(paket.approve).toHaveBeenCalledWith(
        'egen-org',
        P,
        { sub: 'u-1', role: 'OWNER' },
        { version: 1, sourceSha256: SHA, evidenceSha256: SHA },
      )
    })
    it.each(['ADMIN', 'ACCOUNTANT', 'MANAGER', 'VIEWER'])(
      'E11: %s kan inte godkänna',
      async (role) => {
        const r = await anrop('POST', `/kundstart/opening-packages/${P}/approve`, role, {
          version: 1,
          sourceSha256: SHA,
          evidenceSha256: SHA,
        })
        expect(r.statusCode).toBe(403)
        expect(paket.approve).not.toHaveBeenCalled()
      },
    )
  })
})
