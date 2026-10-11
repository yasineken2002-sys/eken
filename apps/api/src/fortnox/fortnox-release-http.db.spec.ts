/**
 * TESTKUND-027 (C1): C2:s 022-rigg intagen PERMANENT i produktsviten (KRITERIER-P2-024 K4.3 S-021-3,
 * T17) — innehållet nedan är C2:s fil oförändrad (sha cb89532b…) utom detta huvud och de nya
 * P2-027-proven sist (F-022-1/F-022-2 över riktig HTTP och ValidationPipe).
 *
 * C2-022 (CLAUDE2, granskningsrigg — INTE produktkod). Kandidat 93423649 (träd dbe642ab).
 *
 * Oberoende HTTP-prov för POST /v1/integrations/fortnox/exports/:id/release-rejected genom den
 * VERKLIGA FortnoxController, de globala guards som auth.module.ts registrerar (JwtAuthGuard,
 * RolesGuard), JwtStrategy, ValidationPipe(VALIDATION_PIPE_OPTIONS) och TransformInterceptor.
 * Bakom ligger produktens riktiga FortnoxSendService/FortnoxExportService mot riktig Postgres
 * och den skarpa skrivvägen (RealFortnoxVoucherWriter + FortnoxTransport) mot lokal
 * FakeFortnoxApi. Inget nätverk. Varje fall läser DB-effekten (state, lastOutcome, draftHash,
 * sentPayloadHash, attemptHistory, updatedAt) och räknar POST/GET mot fejken.
 *
 * Plus T17 (kundeffekt): det gamla avvisade draftHash kan inte skickas efter frisläppning eller
 * efter ny dry-run (0 extra POST); det nya hashet fungerar exakt en gång.
 * Setup är kopierad från fortnox-real-send.db.spec.ts (93423649) utan ändring i semantiken.
 */
import { randomUUID } from 'node:crypto'
import { ValidationPipe, VersioningType } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import { JwtStrategy } from '../auth/strategies/jwt.strategy'
import { VALIDATION_PIPE_OPTIONS } from '../common/contract/validation-pipe-options'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { TransformInterceptor } from '../common/interceptors/transform.interceptor'
import type { PrismaService } from '../common/prisma/prisma.service'
import { FortnoxConnectionService } from './fortnox-connection.service'
import { FortnoxExportService } from './fortnox-export.service'
import { FortnoxReadbackService } from './fortnox-readback.service'
import { FortnoxTokenCryptoService } from './fortnox-token-crypto.service'
import { MockFortnoxAuthProvider, MockFortnoxLedgerReader } from './fortnox-providers'
import { VerifiedVoucherDraftBuilder } from './fortnox-export-builder'
import {
  godkannMappning,
  leverantorsfaktura,
  stadaKontomappning,
} from './fortnox-kontomappning.testing'
import { FortnoxSendService } from './fortnox-send.service'
import { FortnoxMappingService } from './fortnox-mapping.service'
import { FortnoxKontomappningService } from './fortnox-kontomappning.service'
import { RealFortnoxVoucherWriter } from './fortnox-voucher-writer'
import { RealFortnoxLedgerReader } from './fortnox-real-provider'
import { FortnoxTransport } from './provider/fortnox-transport'
import { FakeFortnoxApi, noopRateLimiter } from './fortnox-fake-api.testing'
import { FortnoxController } from './fortnox.controller'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const KEY = 'cd'.repeat(32)
const TEST_COMPANY = 1868238
const HEMLIGHET = 'c2-022-syntetisk-provhemlighet'

describe('C2-022 förutsättningar', () => {
  it('C2-022 KANARIE: riktig databas', () => expect(HAR_DB).toBe(true))
})
;(HAR_DB ? describe : describe.skip)('C2-022 HTTP release-rejected och T17', () => {
  let prisma: PrismaClient
  let app: NestFastifyApplication
  let t: Awaited<ReturnType<typeof setup>>
  const orgs: string[] = []
  const logg: Array<Record<string, unknown>> = []

  async function setup() {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `c2-022-${sfx}`,
        email: `c2-022-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '1',
      },
    })
    orgs.push(org.id)
    const env: Record<string, string> = { FORTNOX_TOKEN_KEY: KEY }
    const config = { get: (k: string) => env[k] } as unknown as ConfigService
    const crypto = new FortnoxTokenCryptoService(config)
    const ledger = new MockFortnoxLedgerReader()
    ledger.company = {
      CompanyName: 'Eveno integrationstest 2026-10-02',
      OrganizationNumber: '555555-5555',
      DatabaseNumber: TEST_COMPANY,
    }
    const api = new FakeFortnoxApi(ledger)
    const fetch = api.fetch as unknown as typeof globalThis.fetch
    const readTransport = new FortnoxTransport({ fetch, rateLimiter: noopRateLimiter })
    const writeTransport = new FortnoxTransport({
      fetch,
      rateLimiter: noopRateLimiter,
      allowVoucherWrites: true,
    })
    const reader = new RealFortnoxLedgerReader({
      transport: readTransport,
      clientId: 'syntetiskt-klient-id',
      enabled: true,
    })
    const writer = new RealFortnoxVoucherWriter({
      transport: writeTransport,
      reader,
      clientId: 'syntetiskt-klient-id',
    })
    const db = prisma as unknown as PrismaService
    const auth = new MockFortnoxAuthProvider()
    const connections = new FortnoxConnectionService(db, crypto, config, auth, reader)
    const builder = new VerifiedVoucherDraftBuilder(db, connections, reader)
    const exports = new FortnoxExportService(db, builder)
    const sender = new FortnoxSendService(db, connections, builder, reader, writer)
    const { authUrl } = await connections.begin(org.id, 'u1')
    const state = new URL(authUrl).searchParams.get('state')!
    await connections.handleCallback(state, `mock-code-${state.slice(0, 8)}`)
    await connections.setExportVoucherSeries(org.id, 'A')
    await connections.setExportOmitDimensions(org.id, 'u1', true)
    await godkannMappning(prisma, connections, reader, org.id)
    return { org, api, ledger, sender, exports, connections }
  }

  const posts = () => t.api.requests.filter((r) => r.method === 'POST').length
  const anrop = () => t.api.requests.length
  const rad = (id: string) => prisma.fortnoxVoucherExport.findUniqueOrThrow({ where: { id } })
  const bild = async (id: string) => {
    const r = await rad(id)
    return JSON.stringify({
      state: r.state,
      lastOutcome: r.lastOutcome,
      draftHash: r.draftHash,
      sentPayloadHash: r.sentPayloadHash,
      sendAttemptId: r.sendAttemptId,
      attemptHistory: r.attemptHistory,
      updatedAt: r.updatedAt,
      blockReason: r.blockReason,
    })
  }
  const token = (role: string, organizationId = t.org.id, secret = HEMLIGHET, sub = `u-${role}`) =>
    new JwtService({ secret }).sign({ sub, organizationId, role })
  const http = async (url: string, auth: string | null, payload?: unknown) => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/integrations/fortnox/${url}`,
      headers: auth === null ? {} : { authorization: `Bearer ${auth}` },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    })
    logg.push({ url: url.replace(/[0-9a-f-]{36}/g, '<id>'), status: res.statusCode })
    return res
  }
  /** En avvisad export via det OBSERVERADE svaret (400/2000359), skickad genom HTTP. */
  const avvisad = async (text = `EVENO TEST C2-022 ${randomUUID().slice(0, 6)}`) => {
    const je = await leverantorsfaktura(prisma, t.org.id, {
      belopp: '125.00',
      beskrivning: text,
      radtext: [null, null],
    })
    const dr = await http('exports/dry-run', token('OWNER'), { journalEntryId: je.id })
    expect(dr.statusCode).toBe(201)
    const row = (dr.json() as { data: { id: string; state: string; draftHash: string } }).data
    expect(row.state).toBe('DRY_RUN_READY')
    t.api.faults.push('observerad_2000359_h3h4_real_002')
    const s = await http(`exports/${row.id}/send`, token('OWNER'), {
      draftHash: row.draftHash,
      confirm: true,
    })
    expect(s.statusCode).toBe(201)
    const r = await rad(row.id)
    expect([r.state, r.lastOutcome]).toEqual(['REJECTED', 'REJECTED_400_2000359'])
    return { je, id: row.id, draftHash: row.draftHash }
  }
  /** Nekat anrop: status som väntat, raden bit för bit oförändrad, inga Fortnox-anrop. */
  const nekas = async (
    id: string,
    status: number,
    url: string,
    auth: string | null,
    payload?: unknown,
  ) => {
    const fore = await bild(id)
    const n = anrop()
    const res = await http(url, auth, payload)
    expect({ url, status: res.statusCode }).toEqual({ url, status })
    expect(await bild(id)).toBe(fore)
    return { res, fortnoxAnrop: anrop() - n }
  }

  beforeAll(async () => {
    const u = new URL(process.env.DATABASE_URL!)
    u.searchParams.set('connection_limit', '8')
    prisma = new PrismaClient({ datasources: { db: { url: u.toString() } } })
    await prisma.$connect()
    t = await setup()
    const orort = (namn: string) =>
      new Proxy(
        {},
        {
          get: (_m, p) =>
            typeof p === 'symbol' ||
            [
              'then',
              'onModuleInit',
              'onModuleDestroy',
              'onApplicationBootstrap',
              'onApplicationShutdown',
              'beforeApplicationShutdown',
            ].includes(p)
              ? undefined
              : () => {
                  throw new Error(`${namn} orört`)
                },
        },
      )
    const module = await Test.createTestingModule({
      controllers: [FortnoxController],
      providers: [
        JwtStrategy,
        { provide: ConfigService, useValue: { getOrThrow: () => HEMLIGHET, get: () => undefined } },
        { provide: FortnoxConnectionService, useValue: t.connections },
        { provide: FortnoxReadbackService, useValue: orort('FortnoxReadbackService') },
        { provide: FortnoxExportService, useValue: t.exports },
        { provide: FortnoxMappingService, useValue: orort('FortnoxMappingService') },
        { provide: FortnoxSendService, useValue: t.sender },
        { provide: FortnoxKontomappningService, useValue: orort('FortnoxKontomappningService') },
      ],
    }).compile()
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    })
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS))
    // Samma två globala guards och ordning som auth.module.ts (APP_GUARD JwtAuthGuard, RolesGuard).
    app.useGlobalGuards(new JwtAuthGuard(new Reflector()), new RolesGuard(new Reflector()))
    app.useGlobalInterceptors(new TransformInterceptor())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  }, 60_000)

  afterAll(async () => {
    await app?.close()
    // eslint-disable-next-line no-console
    console.log('C2-022 HTTP-LOGG ' + JSON.stringify(logg))
    for (const id of orgs) {
      await prisma.fortnoxVoucherExport.deleteMany({ where: { organizationId: id } })
      await prisma.fortnoxReadRun.deleteMany({ where: { organizationId: id } })
      await prisma.journalEntryLine.deleteMany({ where: { journalEntry: { organizationId: id } } })
      await prisma.journalEntry.deleteMany({ where: { organizationId: id } })
      await stadaKontomappning(prisma, id)
      await prisma.account.deleteMany({ where: { organizationId: id } })
      await prisma.organization.delete({ where: { id } }).catch(() => undefined)
    }
    await prisma.$disconnect()
  })

  const REL = (id: string) => `exports/${id}/release-rejected`
  const giltigtSkal = { reason: 'Fortnox avvisade texten (C2-022)' }

  it('C2-022 H1 lagrad 400/2000359: saknad/ogiltig token 401, MANAGER/VIEWER/ACCOUNTANT/TENANT 403, annan org 404, okänt id 404 — raden oförändrad och 0 Fortnox-anrop; därefter OWNER 201 över HTTP', async () => {
    const { id, draftHash } = await avvisad()
    const annan = randomUUID()
    const nekade = [
      await nekas(id, 401, REL(id), null, giltigtSkal),
      await nekas(id, 401, REL(id), 'inte-en-jwt', giltigtSkal),
      await nekas(
        id,
        401,
        REL(id),
        token('OWNER', t.org.id, 'hyresgastportalens-hemlighet'),
        giltigtSkal,
      ),
      await nekas(id, 401, REL(id), token('OWNER', t.org.id, HEMLIGHET, ''), giltigtSkal),
    ]
    for (const roll of ['MANAGER', 'VIEWER', 'ACCOUNTANT', 'TENANT'])
      nekade.push(await nekas(id, 403, REL(id), token(roll), giltigtSkal))
    nekade.push(await nekas(id, 404, REL(id), token('OWNER', annan), giltigtSkal))
    nekade.push(await nekas(id, 404, REL(randomUUID()), token('OWNER'), giltigtSkal))
    expect(nekade.map((x) => x.fortnoxAnrop)).toEqual(nekade.map(() => 0))

    const p0 = posts()
    const ok = await http(REL(id), token('OWNER', t.org.id, HEMLIGHET, 'u-owner-1'), giltigtSkal)
    expect(ok.statusCode).toBe(201)
    const data = (ok.json() as { data: Record<string, unknown> }).data
    expect([data.state, data.lastOutcome]).toEqual(['BLOCKED', 'RELEASED_AFTER_REJECTION'])
    expect(JSON.stringify(ok.json())).not.toMatch(/access_?token|refresh_?token|Bearer/i)
    expect(posts()).toBe(p0) // frisläppningen läser bara
    const r = await rad(id)
    expect([r.state, r.lastOutcome, r.draftHash, r.sentPayloadHash]).toEqual([
      'BLOCKED',
      'RELEASED_AFTER_REJECTION',
      draftHash,
      draftHash,
    ])
    const h = r.attemptHistory as Array<Record<string, unknown>>
    expect(h.map((x) => x.typ)).toEqual(['AVVISAD', 'FRISLAPPT'])
    expect(h[1]).toEqual(
      expect.objectContaining({
        av: 'u-owner-1',
        roll: 'OWNER',
        avvisning: { kalla: 'LAGRAD_AV_PRODUKTEN', http: 400, code: 2000359 },
      }),
    )
    // Upprepad frisläppning → 409, oförändrad.
    await nekas(id, 409, REL(id), token('OWNER'), giltigtSkal)
  })

  it('C2-022 H2 lagrad väg: ADMIN 201 över HTTP; historiken bär ADMIN', async () => {
    const { id } = await avvisad()
    const ok = await http(REL(id), token('ADMIN', t.org.id, HEMLIGHET, 'u-admin-1'), giltigtSkal)
    expect(ok.statusCode).toBe(201)
    const h = (await rad(id)).attemptHistory as Array<Record<string, unknown>>
    expect(h.map((x) => x.typ)).toEqual(['AVVISAD', 'FRISLAPPT'])
    expect(h[1]).toEqual(expect.objectContaining({ av: 'u-admin-1', roll: 'ADMIN' }))
  })

  it('C2-022 H3 kontrakt (ValidationPipe): saknat/kort/för långt skäl, okänt fält, fel typer och ofullständigt kvitto → 400, raden oförändrad, 0 Fortnox-anrop', async () => {
    const { id, draftHash } = await avvisad()
    const bevis = {
      http: 400,
      code: 2000359,
      rakvittoSha256: 'b'.repeat(64),
      manifestSha256: 'c'.repeat(64),
      sentPayloadHash: draftHash,
    }
    const fall: Array<[string, unknown]> = [
      ['tom kropp', {}],
      ['skäl 4 tecken', { reason: 'abcd' }],
      ['skäl 501 tecken', { reason: 'x'.repeat(501) }],
      ['skäl som tal', { reason: 12345 }],
      ['okänt fält organizationId', { ...giltigtSkal, organizationId: randomUUID() }],
      ['okänt fält state', { ...giltigtSkal, state: 'DRY_RUN_READY' }],
      // Försök 1: http/code som sträng gav 201 (enableImplicitConversion) — karakteriseras i H5.
      ['kvitto http 399', { ...giltigtSkal, avvisningsbevis: { ...bevis, http: 399 } }],
      ['kvitto http 500', { ...giltigtSkal, avvisningsbevis: { ...bevis, http: 500 } }],
      ['kvitto http decimal', { ...giltigtSkal, avvisningsbevis: { ...bevis, http: 400.5 } }],
      ['kvitto code 0', { ...giltigtSkal, avvisningsbevis: { ...bevis, code: 0 } }],
      [
        'kvitto utan manifestSha256',
        { ...giltigtSkal, avvisningsbevis: { ...bevis, manifestSha256: undefined } },
      ],
      [
        'kvitto utan rakvittoSha256',
        { ...giltigtSkal, avvisningsbevis: { ...bevis, rakvittoSha256: undefined } },
      ],
      [
        'kvitto utan sentPayloadHash',
        { ...giltigtSkal, avvisningsbevis: { ...bevis, sentPayloadHash: undefined } },
      ],
      [
        'kvitto sha versaler',
        { ...giltigtSkal, avvisningsbevis: { ...bevis, rakvittoSha256: 'B'.repeat(64) } },
      ],
      [
        'kvitto sha 63 tecken',
        { ...giltigtSkal, avvisningsbevis: { ...bevis, manifestSha256: 'c'.repeat(63) } },
      ],
      [
        'kvitto okänt fält',
        { ...giltigtSkal, avvisningsbevis: { ...bevis, kalla: 'LAGRAD_AV_PRODUKTEN' } },
      ],
      ['kvitto som sträng', { ...giltigtSkal, avvisningsbevis: 'bdf57baa' }],
    ]
    const ut: Array<[string, number, number]> = []
    for (const [namn, kropp] of fall) {
      const { res, fortnoxAnrop } = await nekas(id, 400, REL(id), token('OWNER'), kropp).catch(
        (e) => {
          throw new Error(`${namn}: ${String(e)}`)
        },
      )
      ut.push([namn, res.statusCode, fortnoxAnrop])
    }
    expect(ut.filter(([, , n]) => n !== 0)).toEqual([])
    logg.push({ H3: ut })
  })

  it('C2-022 H4 äldre väg (lastOutcome REJECTED, ingen historik): ADMIN med kvitto 403; OWNER utan kvitto 409; OWNER med fel sentPayloadHash 409; ej belagt par 409; ofullständigt 400 — oförändrad. OWNER med fullständigt kvitto 201, ANGIVET_I_EFTERHAND', async () => {
    const { id, draftHash } = await avvisad()
    await prisma.fortnoxVoucherExport.update({
      where: { id },
      data: { lastOutcome: 'REJECTED', attemptHistory: [] },
    })
    const bevis = {
      http: 400,
      code: 2000359,
      rakvittoSha256: 'b'.repeat(64),
      manifestSha256: 'c'.repeat(64),
      sentPayloadHash: draftHash,
    }
    const n = [
      await nekas(id, 403, REL(id), token('ADMIN'), { ...giltigtSkal, avvisningsbevis: bevis }),
      await nekas(id, 403, REL(id), token('ADMIN'), giltigtSkal),
      await nekas(id, 409, REL(id), token('OWNER'), giltigtSkal),
      await nekas(id, 409, REL(id), token('OWNER'), {
        ...giltigtSkal,
        avvisningsbevis: { ...bevis, sentPayloadHash: 'd'.repeat(64) },
      }),
      await nekas(id, 409, REL(id), token('OWNER'), {
        ...giltigtSkal,
        avvisningsbevis: { ...bevis, http: 429 },
      }),
      await nekas(id, 409, REL(id), token('OWNER'), {
        ...giltigtSkal,
        avvisningsbevis: { ...bevis, code: 1000003 },
      }),
      await nekas(id, 409, REL(id), token('OWNER'), {
        ...giltigtSkal,
        avvisningsbevis: { ...bevis, http: 403 },
      }),
      await nekas(id, 400, REL(id), token('OWNER'), {
        ...giltigtSkal,
        avvisningsbevis: { ...bevis, manifestSha256: undefined },
      }),
      await nekas(id, 403, REL(id), token('VIEWER'), { ...giltigtSkal, avvisningsbevis: bevis }),
      await nekas(id, 404, REL(id), token('OWNER', randomUUID()), {
        ...giltigtSkal,
        avvisningsbevis: bevis,
      }),
    ]
    expect(n.map((x) => x.fortnoxAnrop)).toEqual(n.map(() => 0))
    expect((await rad(id)).attemptHistory).toEqual([])
    const ok = await http(REL(id), token('OWNER', t.org.id, HEMLIGHET, 'u-owner-2'), {
      ...giltigtSkal,
      avvisningsbevis: bevis,
    })
    expect(ok.statusCode).toBe(201)
    const h = (await rad(id)).attemptHistory as Array<Record<string, unknown>>
    expect(h).toHaveLength(1)
    expect(h[0]!.avvisning).toEqual(
      expect.objectContaining({
        kalla: 'ANGIVET_I_EFTERHAND',
        http: 400,
        code: 2000359,
        sentPayloadHash: draftHash,
        angivetAv: 'u-owner-2',
        roll: 'OWNER',
      }),
    )
  })

  it('C2-022 H5 KARAKTERISERING typtvång (enableImplicitConversion): numeriska kvittofält som sträng — utfall och DB-effekt registreras', async () => {
    const ut: Array<Record<string, unknown>> = []
    // Lagrad väg: kvittot ignoreras av tjänsten; avvisningen tas ur den lagrade koden.
    {
      const { id, draftHash } = await avvisad()
      const res = await http(REL(id), token('ADMIN'), {
        ...giltigtSkal,
        avvisningsbevis: {
          http: '403',
          code: '1',
          rakvittoSha256: 'b'.repeat(64),
          manifestSha256: 'c'.repeat(64),
          sentPayloadHash: draftHash,
        },
      })
      const h = (await rad(id)).attemptHistory as Array<Record<string, unknown>>
      ut.push({
        fall: 'lagrad väg, ADMIN, kvitto {http:"403",code:"1"}',
        status: res.statusCode,
        historik: h.map((x) => x.typ),
        avvisning: h.at(-1)?.avvisning,
      })
      expect(res.statusCode).toBeLessThan(500)
    }
    for (const [namn, f] of [
      ['äldre väg, OWNER, {http:"400",code:"2000359"}', { http: '400', code: '2000359' }],
      ['äldre väg, OWNER, {http:"0x190",code:"2000359"}', { http: '0x190', code: '2000359' }],
      ['äldre väg, OWNER, {http:" 400 ",code:2000359}', { http: ' 400 ', code: 2000359 }],
      ['äldre väg, OWNER, {http:"403",code:"2000359"}', { http: '403', code: '2000359' }],
    ] as const) {
      const { id, draftHash } = await avvisad()
      await prisma.fortnoxVoucherExport.update({
        where: { id },
        data: { lastOutcome: 'REJECTED', attemptHistory: [] },
      })
      const fore = await bild(id)
      const res = await http(REL(id), token('OWNER'), {
        ...giltigtSkal,
        avvisningsbevis: {
          ...f,
          rakvittoSha256: 'b'.repeat(64),
          manifestSha256: 'c'.repeat(64),
          sentPayloadHash: draftHash,
        },
      })
      const r = await rad(id)
      const h = r.attemptHistory as Array<Record<string, unknown>>
      const a = h.at(-1)?.avvisning as Record<string, unknown> | undefined
      ut.push({
        fall: namn,
        status: res.statusCode,
        state: r.state,
        oforandrad: (await bild(id)) === fore,
        lagratHttp: a?.http,
        lagratHttpTyp: typeof a?.http,
        lagradCode: a?.code,
        lagradCodeTyp: typeof a?.code,
      })
      expect(res.statusCode).toBeLessThan(500)
      // Oavsett utfall: frisläpps raden är det lagrade paret exakt numeriskt (400, 2000359).
      if (r.state === 'BLOCKED') expect([a?.http, a?.code]).toEqual([400, 2000359])
      else expect((await bild(id)) === fore).toBe(true)
    }
    logg.push({ H5: ut })
    // eslint-disable-next-line no-console
    console.log('C2-022 H5 ' + JSON.stringify(ut))
  })

  it('C2-022 T17a lagrad väg: gammalt hash efter frisläppning 409 / 0 POST; efter ny dry-run 0 extra POST utöver EN lyckad sändning; omspelning efter CONFIRMED 0 POST', async () => {
    const { id, je, draftHash: gammal } = await avvisad()
    expect((await http(REL(id), token('OWNER'), giltigtSkal)).statusCode).toBe(201)
    const p0 = posts()
    await nekas(id, 409, `exports/${id}/send`, token('OWNER'), { draftHash: gammal, confirm: true })
    expect(posts()).toBe(p0)
    const dr = await http('exports/dry-run', token('OWNER'), { journalEntryId: je.id })
    const ny = (dr.json() as { data: { draftHash: string; state: string } }).data
    expect(ny.state).toBe('DRY_RUN_READY')
    logg.push({ T17a: { nyttHashLikaGammalt: ny.draftHash === gammal } })
    const s1 = await http(`exports/${id}/send`, token('OWNER'), {
      draftHash: ny.draftHash,
      confirm: true,
    })
    expect(s1.statusCode).toBe(201)
    expect((await rad(id)).state).toBe('CONFIRMED')
    expect(posts() - p0).toBe(1)
    for (const h of [ny.draftHash, gammal])
      await nekas(id, 409, `exports/${id}/send`, token('OWNER'), { draftHash: h, confirm: true })
    expect(posts() - p0).toBe(1)
    const egna = t.ledger.vouchers.filter((v) =>
      String(v.Comments ?? '').includes(`Eveno JournalEntry ${je.id}`),
    )
    expect(egna).toHaveLength(1)
  })

  it('C2-022 T17b H4-formen: äldre REJECTED med hash från FÖRE teckenregeln (U+2014) → OWNER-kvitto → gammalt hash 409 före och efter ny dry-run, 0 POST; nytt hash (U+2013) exakt 1 POST; sedan inget mer', async () => {
    const text = 'EVENO TEST leverantör — EVENO TEST C2-022 RAW kostnad'
    const { id, je, draftHash: nuvarande } = await avvisad(text)
    // Den äldre produktversionen hashade U+2014-payloaden: sätt ett annat, äldre hash på raden
    // (som 064d223a… i H3H4-REAL-002) och ta bort koden/historiken, precis som den äldre raden ser ut.
    const aldre = 'e'.repeat(64)
    await prisma.fortnoxVoucherExport.update({
      where: { id },
      data: {
        lastOutcome: 'REJECTED',
        attemptHistory: [],
        draftHash: aldre,
        sentPayloadHash: aldre,
      },
    })
    const bevis = {
      http: 400,
      code: 2000359,
      rakvittoSha256: 'b'.repeat(64),
      manifestSha256: 'c'.repeat(64),
      sentPayloadHash: aldre,
    }
    expect(
      (await http(REL(id), token('OWNER'), { ...giltigtSkal, avvisningsbevis: bevis })).statusCode,
    ).toBe(201)
    const p0 = posts()
    await nekas(id, 409, `exports/${id}/send`, token('OWNER'), { draftHash: aldre, confirm: true })
    const dr = await http('exports/dry-run', token('OWNER'), { journalEntryId: je.id })
    const ny = (dr.json() as { data: { draftHash: string; state: string } }).data
    expect(ny.state).toBe('DRY_RUN_READY')
    expect(ny.draftHash).not.toBe(aldre)
    expect(ny.draftHash).toBe(nuvarande)
    await nekas(id, 409, `exports/${id}/send`, token('OWNER'), { draftHash: aldre, confirm: true })
    expect(posts()).toBe(p0)
    // Fel roll kan inte heller skicka det nya hashet.
    await nekas(id, 403, `exports/${id}/send`, token('ACCOUNTANT'), {
      draftHash: ny.draftHash,
      confirm: true,
    })
    const s1 = await http(`exports/${id}/send`, token('OWNER'), {
      draftHash: ny.draftHash,
      confirm: true,
    })
    expect(s1.statusCode).toBe(201)
    expect(posts() - p0).toBe(1)
    for (const h of [ny.draftHash, aldre])
      await nekas(id, 409, `exports/${id}/send`, token('OWNER'), { draftHash: h, confirm: true })
    expect(posts() - p0).toBe(1)
    const egna = t.ledger.vouchers.filter((v) =>
      String(v.Comments ?? '').includes(`Eveno JournalEntry ${je.id}`),
    )
    expect(egna).toHaveLength(1)
    expect(String(egna[0]!.Description)).toContain('–')
    expect(String(egna[0]!.Description)).not.toContain('—')
    const h = (await rad(id)).attemptHistory as Array<Record<string, unknown>>
    expect(h.map((x) => x.typ)).toEqual(['FRISLAPPT'])
    expect(h[0]!.tidigareForsok).toEqual(
      expect.objectContaining({
        sentPayloadHash: aldre,
        draftHash: aldre,
        lastOutcome: 'REJECTED',
      }),
    )
  })

  // ── P2-027 K4.1 (F-022-1): kvittots http/code är JSON-heltal — inget implicit typtvång ──────────
  it.each([
    ['http "400"', { http: '400', code: 2000359 }],
    ['http "0x190"', { http: '0x190', code: 2000359 }],
    ['http " 400 "', { http: ' 400 ', code: 2000359 }],
    ['http true', { http: true, code: 2000359 }],
    ['http null', { http: null, code: 2000359 }],
    ['http []', { http: [], code: 2000359 }],
    ['http {}', { http: {}, code: 2000359 }],
    ['http 400.5', { http: 400.5, code: 2000359 }],
    ['code "2000359"', { http: 400, code: '2000359' }],
    ['code "0x1E7A27"', { http: 400, code: '0x1E7A27' }],
  ] as const)(
    'P2-027 K4.1 äldre väg, OWNER, %s → 400 över HTTP, raden bit för bit oförändrad, 0 Fortnox-anrop',
    async (_namn, f) => {
      const { id, draftHash } = await avvisad()
      await prisma.fortnoxVoucherExport.update({
        where: { id },
        data: { lastOutcome: 'REJECTED', attemptHistory: [] },
      })
      const fore = await bild(id)
      const a0 = anrop()
      const res = await http(REL(id), token('OWNER'), {
        ...giltigtSkal,
        avvisningsbevis: {
          ...f,
          rakvittoSha256: 'b'.repeat(64),
          manifestSha256: 'c'.repeat(64),
          sentPayloadHash: draftHash,
        },
      })
      expect(res.statusCode).toBe(400)
      expect(await bild(id)).toBe(fore)
      expect(anrop()).toBe(a0)
    },
  )

  it('P2-027 K4.1 positiv kontroll: äldre väg, OWNER, JSON-heltal {400, 2000359} → 201 och lagrat paret numeriskt', async () => {
    const { id, draftHash } = await avvisad()
    await prisma.fortnoxVoucherExport.update({
      where: { id },
      data: { lastOutcome: 'REJECTED', attemptHistory: [] },
    })
    const res = await http(REL(id), token('OWNER'), {
      ...giltigtSkal,
      avvisningsbevis: {
        http: 400,
        code: 2000359,
        rakvittoSha256: 'b'.repeat(64),
        manifestSha256: 'c'.repeat(64),
        sentPayloadHash: draftHash,
      },
    })
    expect(res.statusCode).toBe(201)
    const h = (await rad(id)).attemptHistory as Array<Record<string, unknown>>
    expect(h.at(-1)!.avvisning).toEqual(
      expect.objectContaining({ http: 400, code: 2000359, kalla: 'ANGIVET_I_EFTERHAND' }),
    )
  })

  // ── P2-027 K4.2 (F-022-2): medskickat kvitto när lagrat bevis används → 400, ingen effekt ──────
  it('P2-027 K4.2 lagrad väg (REJECTED_400_2000359), ADMIN/OWNER med avvisningsbevis → 400, raden oförändrad, 0 Fortnox-anrop; utan kvitto → 201', async () => {
    for (const roll of ['ADMIN', 'OWNER']) {
      const { id, draftHash } = await avvisad()
      const fore = await bild(id)
      const a0 = anrop()
      const res = await http(REL(id), token(roll), {
        ...giltigtSkal,
        avvisningsbevis: {
          http: 400,
          code: 2000359,
          rakvittoSha256: 'b'.repeat(64),
          manifestSha256: 'c'.repeat(64),
          sentPayloadHash: draftHash,
        },
      })
      expect([roll, res.statusCode]).toEqual([roll, 400])
      expect(await bild(id)).toBe(fore)
      expect(anrop()).toBe(a0)
      expect((await http(REL(id), token(roll), giltigtSkal)).statusCode).toBe(201)
    }
  })
})
