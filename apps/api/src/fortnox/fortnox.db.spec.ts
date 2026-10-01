/**
 * Fortnox A — mot riktig Postgres (syntetiska organisationer, ingen extern tjänst).
 *
 * Mäter det en attrapp inte kan: atomisk engångs-claim av state, unika villkor
 * (en anslutning per org, en exportrad per verifikat), CAS-förnyelse under
 * samtidighet, att tokens lagras krypterade och aldrig lämnar säkra urval, samt
 * kundeffekten — vad statuskontraktet faktiskt visar efter varje utfall.
 */
import { randomUUID } from 'node:crypto'
import { ConfigService } from '@nestjs/config'
import { PrismaClient } from '@prisma/client'
import type { PrismaService } from '../common/prisma/prisma.service'
import { FortnoxConnectionService, FortnoxNotConnectedError } from './fortnox-connection.service'
import { FortnoxReadbackService } from './fortnox-readback.service'
import {
  FortnoxExportService,
  PendingVoucherDraftBuilder,
  type FortnoxVoucherDraftBuilder,
} from './fortnox-export.service'
import { FortnoxMappingService } from './fortnox-mapping.service'
import { FortnoxTokenCryptoService } from './fortnox-token-crypto.service'
import { MockFortnoxAuthProvider, MockFortnoxLedgerReader } from './fortnox-providers'
import { toStatusResponse } from './fortnox-status'
import { FortnoxReadError } from './fortnox.types'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

const KEY = 'ab'.repeat(32)

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('Fortnox A mot riktig Postgres', () => {
  let prisma: PrismaClient
  const orgs: string[] = []

  beforeAll(async () => {
    const u = new URL(process.env.DATABASE_URL!)
    u.searchParams.set('connection_limit', '12')
    prisma = new PrismaClient({ datasources: { db: { url: u.toString() } } })
    await prisma.$connect()
  })

  afterAll(async () => {
    for (const id of orgs) {
      await prisma.fortnoxVoucherExport.deleteMany({ where: { organizationId: id } })
      await prisma.journalEntry.deleteMany({ where: { organizationId: id } })
      await prisma.organization.delete({ where: { id } }).catch(() => undefined)
    }
    await prisma.$disconnect()
  })

  async function org(orgNumber: string | null = null) {
    const sfx = randomUUID().slice(0, 8)
    const o = await prisma.organization.create({
      data: {
        name: `fnx-${sfx}`,
        email: `fnx-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
        ...(orgNumber
          ? { orgNumber: `${orgNumber.slice(0, 6)}-${sfx.replace(/\D/g, '0').slice(0, 4)}` }
          : {}),
      },
    })
    orgs.push(o.id)
    return o
  }

  async function property(organizationId: string, name: string) {
    return prisma.property.create({
      data: {
        organizationId,
        name,
        propertyDesignation: `${name}-1:1`,
        type: 'RESIDENTIAL',
        street: 'g',
        city: 'c',
        postalCode: '11111',
        totalArea: '100.00',
      },
    })
  }

  function rig(opts: { env?: Record<string, string> } = {}) {
    const env: Record<string, string> = { FORTNOX_TOKEN_KEY: KEY, ...opts.env }
    const config = { get: (k: string) => env[k] } as unknown as ConfigService
    const crypto = new FortnoxTokenCryptoService(config)
    const auth = new MockFortnoxAuthProvider()
    const reader = new MockFortnoxLedgerReader()
    const db = prisma as unknown as PrismaService
    const connections = new FortnoxConnectionService(db, crypto, config, auth, reader)
    const readback = new FortnoxReadbackService(db, connections, reader)
    const mappings = new FortnoxMappingService(db, connections, reader)
    return { crypto, auth, reader, connections, readback, mappings, db }
  }

  async function connect(r: ReturnType<typeof rig>, organizationId: string, userId = 'u1') {
    const { authUrl } = await r.connections.begin(organizationId, userId)
    const state = new URL(authUrl).searchParams.get('state')!
    await r.connections.handleCallback(state, `mock-code-${state.slice(0, 8)}`)
    return state
  }

  // ── Anslutning ────────────────────────────────────────────────────────────

  it('lyckad anslutning: tokens krypterade, säkert urval utan tokens, rätt företag', async () => {
    const o = await org()
    const r = rig()
    await connect(r, o.id)
    const raw = await prisma.fortnoxConnection.findUniqueOrThrow({
      where: { organizationId: o.id },
    })
    expect(raw.status).toBe('ACTIVE')
    expect(raw.fortnoxDatabaseNumber).toBe(900001)
    expect(raw.accessTokenEnc).not.toContain('mock-access')
    expect(r.crypto.decrypt(raw.accessTokenEnc)).toBe('mock-access-1')
    const safe = await r.connections.status(o.id)
    expect(JSON.stringify(safe)).not.toMatch(/mock-|TokenEnc|tokenVersion/)
  })

  it('state är engångs: replay och parallell callback ger exakt en växling', async () => {
    const o = await org()
    const r = rig()
    const { authUrl } = await r.connections.begin(o.id, 'u1')
    const state = new URL(authUrl).searchParams.get('state')!
    const code = `mock-code-${state.slice(0, 8)}`
    const res = await Promise.allSettled([
      r.connections.handleCallback(state, code),
      r.connections.handleCallback(state, code),
    ])
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    expect(r.auth.calls.exchange).toBe(1)
    await expect(r.connections.handleCallback(state, code)).rejects.toThrow(/förbrukad|utgången/)
  })

  it('utgången state avvisas utan växling', async () => {
    const o = await org()
    const r = rig()
    const { authUrl } = await r.connections.begin(o.id, 'u1')
    const state = new URL(authUrl).searchParams.get('state')!
    await prisma.fortnoxOAuthState.update({
      where: { state },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    await expect(
      r.connections.handleCallback(state, `mock-code-${state.slice(0, 8)}`),
    ).rejects.toThrow()
    expect(r.auth.calls.exchange).toBe(0)
  })

  it('PKCE: verifier bunden till state; fel verifier avvisas av providern', async () => {
    const o = await org()
    const r = rig()
    const { authUrl } = await r.connections.begin(o.id, 'u1')
    const u = new URL(authUrl)
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    const state = u.searchParams.get('state')!
    const row = await prisma.fortnoxOAuthState.findUniqueOrThrow({ where: { state } })
    expect(row.codeVerifierEnc).not.toMatch(/^[A-Za-z0-9_-]{43,128}$/) // krypterad, inte klartext
    await prisma.fortnoxOAuthState.update({
      where: { state },
      data: { codeVerifierEnc: r.crypto.encrypt('x'.repeat(64)) },
    })
    await expect(
      r.connections.handleCallback(state, `mock-code-${state.slice(0, 8)}`),
    ).rejects.toThrow()
    expect(
      await prisma.fortnoxConnection.findUnique({ where: { organizationId: o.id } }),
    ).toBeNull()
  })

  it('byte till ANNAT Fortnox-företag stoppas; tokens för det nya sparas inte', async () => {
    const o = await org()
    const r = rig()
    await connect(r, o.id)
    r.reader.company = { ...r.reader.company, DatabaseNumber: 900777 }
    await expect(connect(r, o.id)).rejects.toThrow(/matchar inte/)
    const raw = await prisma.fortnoxConnection.findUniqueOrThrow({
      where: { organizationId: o.id },
    })
    expect(raw.fortnoxDatabaseNumber).toBe(900001)
    expect(r.crypto.decrypt(raw.accessTokenEnc)).toBe('mock-access-1')
    expect(raw.lastErrorClass).toBe('COMPANY_MISMATCH')
    expect(r.auth.calls.revoke).toBe(1)
  })

  it('orgnr som inte matchar Evenos organisation stoppar anslutningen', async () => {
    const o = await prisma.organization.create({
      data: {
        name: 'fnx-orgnr',
        email: `fnx-${randomUUID().slice(0, 6)}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '1',
        orgNumber: `559${randomUUID().replace(/\D/g, '').slice(0, 7).padEnd(7, '1')}`,
      },
    })
    orgs.push(o.id)
    const r = rig()
    await expect(connect(r, o.id)).rejects.toThrow(/matchar inte/)
    expect(
      await prisma.fortnoxConnection.findUnique({ where: { organizationId: o.id } }),
    ).toBeNull()
  })

  // ── Förnyelse ─────────────────────────────────────────────────────────────

  it('samtidig förnyelse: exakt ett refresh-anrop, ingen dubbel rotation', async () => {
    const o = await org()
    const r = rig()
    await connect(r, o.id)
    await prisma.fortnoxConnection.update({
      where: { organizationId: o.id },
      data: { accessTokenExpiresAt: new Date(Date.now() - 1) },
    })
    const res = await Promise.allSettled(
      Array.from({ length: 5 }, () => r.connections.accessToken(o.id)),
    )
    expect(r.auth.calls.refresh).toBe(1)
    const ok = res.flatMap((x) => (x.status === 'fulfilled' ? [x.value] : []))
    expect(ok.length).toBeGreaterThanOrEqual(1)
    for (const x of ok) expect(x.token).toBe('mock-access-2')
    for (const x of res)
      if (x.status === 'rejected')
        expect((x.reason as FortnoxNotConnectedError).reason).toBe('REFRESH_IN_PROGRESS')
    const raw = await prisma.fortnoxConnection.findUniqueOrThrow({
      where: { organizationId: o.id },
    })
    expect(raw.tokenVersion).toBe(1)
    expect(raw.refreshLeaseUntil).toBeNull()
  })

  it.each([
    ['rejected', 'AUTH_REJECTED'],
    ['unknown', 'REFRESH_OUTCOME_UNKNOWN'],
  ] as const)('förnyelse %s → AUTH_LOST, tokens nollade, ingen ny förnyelse', async (kind, cls) => {
    const o = await org()
    const r = rig()
    await connect(r, o.id)
    await prisma.fortnoxConnection.update({
      where: { organizationId: o.id },
      data: { accessTokenExpiresAt: new Date(0) },
    })
    r.auth.failRefresh = kind
    await expect(r.connections.accessToken(o.id)).rejects.toMatchObject({ reason: 'AUTH_LOST' })
    await expect(r.connections.accessToken(o.id)).rejects.toMatchObject({ reason: 'AUTH_LOST' })
    expect(r.auth.calls.refresh).toBe(1)
    const raw = await prisma.fortnoxConnection.findUniqueOrThrow({
      where: { organizationId: o.id },
    })
    expect([raw.status, raw.accessTokenEnc, raw.refreshTokenEnc, raw.lastErrorClass]).toEqual([
      'AUTH_LOST',
      '',
      null,
      cls,
    ])
  })

  it('förnyelse 429 (rate_limited): tokens bevaras, uppskjutning utan nya anrop, därefter kontrollerat nytt försök', async () => {
    const o = await org()
    const r = rig()
    await connect(r, o.id)
    await prisma.fortnoxConnection.update({
      where: { organizationId: o.id },
      data: { accessTokenExpiresAt: new Date(0) },
    })
    const before = await prisma.fortnoxConnection.findUniqueOrThrow({
      where: { organizationId: o.id },
    })
    r.auth.failRefresh = 'rate_limited'
    await expect(r.connections.accessToken(o.id)).rejects.toMatchObject({
      reason: 'REFRESH_RATE_LIMITED',
    })
    const after = await prisma.fortnoxConnection.findUniqueOrThrow({
      where: { organizationId: o.id },
    })
    // Skiljer sig från rejected/unknown: ACTIVE, samma krypterade tokens, samma version.
    expect([
      after.status,
      after.accessTokenEnc,
      after.refreshTokenEnc,
      after.tokenVersion,
      after.lastErrorClass,
    ]).toEqual([
      'ACTIVE',
      before.accessTokenEnc,
      before.refreshTokenEnc,
      before.tokenVersion,
      'REFRESH_RATE_LIMITED',
    ])
    expect(after.refreshLeaseUntil!.getTime()).toBeGreaterThan(Date.now() + 30_000)
    // Inom uppskjutningen: inget nytt refresh-anrop (ingen blind retry).
    r.auth.failRefresh = null
    await expect(r.connections.accessToken(o.id)).rejects.toMatchObject({
      reason: 'REFRESH_RATE_LIMITED',
    })
    expect(r.auth.calls.refresh).toBe(1)
    // Efter uppskjutningen: ett kontrollerat nytt försök med den bevarade refresh-token.
    await prisma.fortnoxConnection.update({
      where: { organizationId: o.id },
      data: { refreshLeaseUntil: new Date(Date.now() - 1) },
    })
    expect((await r.connections.accessToken(o.id)).token).toBe('mock-access-2')
    expect(r.auth.calls.refresh).toBe(2)
  })

  it('förnyelse not_sent → låset släpps, anslutningen består', async () => {
    const o = await org()
    const r = rig()
    await connect(r, o.id)
    await prisma.fortnoxConnection.update({
      where: { organizationId: o.id },
      data: { accessTokenExpiresAt: new Date(0) },
    })
    r.auth.failRefresh = 'not_sent'
    await expect(r.connections.accessToken(o.id)).rejects.toMatchObject({
      reason: 'REFRESH_IN_PROGRESS',
    })
    r.auth.failRefresh = null
    expect((await r.connections.accessToken(o.id)).token).toBe('mock-access-2')
  })

  it('frånkoppling nollar tokens; läsning därefter nekas', async () => {
    const o = await org()
    const r = rig()
    await connect(r, o.id)
    await r.connections.disconnect(o.id)
    const raw = await prisma.fortnoxConnection.findUniqueOrThrow({
      where: { organizationId: o.id },
    })
    expect([raw.status, raw.accessTokenEnc, raw.refreshTokenEnc]).toEqual([
      'DISCONNECTED',
      '',
      null,
    ])
    await expect(
      r.readback.read(o.id, 'u1', {
        financialYearId: 1,
        periodFrom: '2026-01-01',
        periodTo: '2026-12-31',
        costAccounts: [5170],
      }),
    ).rejects.toThrow(/frånkopplad/)
  })

  // ── Återläsning och kundeffekt ───────────────────────────────────────────

  const V = (n: number, rows: unknown[]) => ({
    Year: 1,
    VoucherSeries: 'L',
    VoucherNumber: n,
    TransactionDate: '2026-10-02',
    VoucherRows: rows,
  })
  const READ = {
    financialYearId: 1,
    periodFrom: '2026-01-01',
    periodTo: '2026-12-31',
    costAccounts: [5170],
  }

  it('läsning sparas med fastighetsfördelning via mappning; statusen visar den', async () => {
    const o = await org()
    const r = rig()
    await connect(r, o.id)
    const a = await property(o.id, 'HUS-A')
    await r.mappings.upsert(o.id, { dimensionType: 'COST_CENTER', code: 'HUSA', propertyId: a.id })
    r.reader.vouchers = [
      V(1, [
        { Account: 5170, Debit: 12000, Credit: 0, CostCenter: 'HUSA' },
        { Account: 2440, Debit: 0, Credit: 12000 },
      ]),
      V(2, [
        { Account: 5170, Debit: 2000, Credit: 0 },
        { Account: 2440, Debit: 0, Credit: 2000 },
      ]),
      V(3, [
        { Account: 5170, Debit: 500, Credit: 0, CostCenter: 'HUSB' },
        { Account: 2440, Debit: 0, Credit: 500 },
      ]),
    ]
    const run = await r.readback.read(o.id, 'u1', READ)
    expect(run.status).toBe('COMPLETE')
    expect(run.financialYearStart?.toISOString().slice(0, 10)).toBe('2026-01-01')
    const s = run.summary as {
      totalOre: number
      byProperty: Array<{ amountOre: number }>
      unallocatedOre: number
      unmappedDimensions: unknown[]
    }
    expect([s.totalOre, s.byProperty[0]?.amountOre, s.unallocatedOre]).toEqual([
      1450000, 1200000, 200000,
    ])
    expect(s.unmappedDimensions).toEqual([
      { dimensionType: 'COST_CENTER', code: 'HUSB', amountOre: 50000 },
    ])
    const latest = await r.readback.latest(o.id)
    const view = toStatusResponse({
      enabled: true,
      connection: await r.connections.status(o.id),
      mappings: await r.mappings.list(o.id),
      ...latest,
      exports: {
        counts: { DRY_RUN_READY: 0, BLOCKED: 0, UNKNOWN: 0, CONFIRMED: 0 },
        needsReconciliation: 0,
        sendingEnabled: false,
        sendingDisabledReason: 'IDEMPOTENCY_UNRESOLVED',
      },
    })
    expect(view.latestCompleteRead?.id).toBe(run.id)
    expect(view.latestCompleteRead?.ageSeconds).not.toBeNull()
    expect(JSON.stringify(view)).not.toMatch(/mock-access|mock-refresh|TokenEnc/)
  })

  it('avbrott ger PARTIAL med summa null; senaste lyckade läsning står kvar', async () => {
    const o = await org()
    const r = rig()
    await connect(r, o.id)
    r.reader.vouchers = [
      V(1, [
        { Account: 5170, Debit: 100, Credit: 0 },
        { Account: 2440, Debit: 0, Credit: 100 },
      ]),
    ]
    const ok = await r.readback.read(o.id, 'u1', READ)
    r.reader.calls = []
    r.reader.failOnCall = { n: 5, error: new FortnoxReadError('transient', 429) }
    const bad = await r.readback.read(o.id, 'u1', READ)
    expect(bad.status).toBe('PARTIAL')
    expect(bad.summary).toBeNull()
    const latest = await r.readback.latest(o.id)
    expect(latest.latestRead?.id).toBe(bad.id)
    expect(latest.latestCompleteRead?.id).toBe(ok.id)
  })

  it('401 som består efter förnyelse → körningen AUTH_LOST och anslutningen stoppas', async () => {
    const o = await org()
    const r = rig()
    await connect(r, o.id)
    r.reader.calls = []
    r.reader.validTokens = () => false
    const run = await r.readback.read(o.id, 'u1', READ)
    expect(run.status).toBe('AUTH_LOST')
    const raw = await prisma.fortnoxConnection.findUniqueOrThrow({
      where: { organizationId: o.id },
    })
    expect([raw.status, raw.accessTokenEnc]).toEqual(['AUTH_LOST', ''])
  })

  it('P-F1: token som går ut mitt i läsningen → en förnyelse, ett omförsök, COMPLETE, anslutningen består', async () => {
    const o = await org()
    const r = rig()
    await connect(r, o.id)
    r.reader.vouchers = [
      V(1, [
        { Account: 5170, Debit: 100, Credit: 0 },
        { Account: 2440, Debit: 0, Credit: 100 },
      ]),
    ]
    r.reader.calls = []
    // Från anrop 4 (kostnadsställen) gäller inte längre den första access-token.
    r.reader.hooks.set(4, () => {
      r.reader.validTokens = (t) => t !== 'mock-access-1'
    })
    const run = await r.readback.read(o.id, 'u1', READ)
    expect(run.status).toBe('COMPLETE')
    expect(r.auth.calls.refresh).toBe(1)
    const raw = await prisma.fortnoxConnection.findUniqueOrThrow({
      where: { organizationId: o.id },
    })
    expect([raw.status, raw.tokenVersion]).toEqual(['ACTIVE', 1])
    expect(r.crypto.decrypt(raw.accessTokenEnc)).toBe('mock-access-2')
  })

  it('P-F1: verkligt återkallad åtkomst (401 även efter förnyelse) → AUTH_LOST, exakt en förnyelse', async () => {
    const o = await org()
    const r = rig()
    await connect(r, o.id)
    r.reader.calls = []
    r.reader.hooks.set(2, () => {
      r.reader.validTokens = () => false
    })
    const run = await r.readback.read(o.id, 'u1', READ)
    expect(run.status).toBe('AUTH_LOST')
    expect(r.auth.calls.refresh).toBe(1)
    expect(
      (await prisma.fortnoxConnection.findUniqueOrThrow({ where: { organizationId: o.id } }))
        .status,
    ).toBe('AUTH_LOST')
  })

  it('P-F1: förnyelse begränsad (429) efter 401 → PARTIAL utan AUTH_LOST, tokens kvar', async () => {
    const o = await org()
    const r = rig()
    await connect(r, o.id)
    r.reader.calls = []
    r.reader.hooks.set(2, () => {
      r.reader.validTokens = (t) => t !== 'mock-access-1'
    })
    r.auth.failRefresh = 'rate_limited'
    const run = await r.readback.read(o.id, 'u1', READ)
    expect([run.status, run.summary]).toEqual(['PARTIAL', null])
    const raw = await prisma.fortnoxConnection.findUniqueOrThrow({
      where: { organizationId: o.id },
    })
    expect([raw.status, raw.lastErrorClass]).toEqual(['ACTIVE', 'REFRESH_RATE_LIMITED'])
    expect(r.crypto.decrypt(raw.accessTokenEnc)).toBe('mock-access-1')
  })

  it('fastighet från annan organisation kan inte mappas', async () => {
    const o1 = await org()
    const o2 = await org()
    const r = rig()
    const p2 = await property(o2.id, 'FRÄMMANDE')
    await expect(
      r.mappings.upsert(o1.id, { dimensionType: 'COST_CENTER', code: 'X', propertyId: p2.id }),
    ).rejects.toThrow(/hittades inte/)
  })

  it('Eveno-export märks bara vid exakt (företag, år, serie, nummer)', async () => {
    const o = await org()
    const r = rig()
    await connect(r, o.id)
    const je = await prisma.journalEntry.create({
      data: {
        organizationId: o.id,
        date: new Date('2026-10-02'),
        description: 'x',
        fiscalYear: 2026,
        verNumber: 1,
      },
    })
    const je2 = await prisma.journalEntry.create({
      data: {
        organizationId: o.id,
        date: new Date('2026-10-02'),
        description: 'y',
        fiscalYear: 2026,
        verNumber: 2,
      },
    })
    await prisma.fortnoxVoucherExport.createMany({
      data: [
        {
          organizationId: o.id,
          journalEntryId: je.id,
          state: 'CONFIRMED',
          fortnoxDatabaseNumber: 900001,
          externalYear: 1,
          externalSeries: 'L',
          externalNumber: 1,
        },
        // samma serie och nummer men ANNAT företag → får inte märka
        {
          organizationId: o.id,
          journalEntryId: je2.id,
          state: 'CONFIRMED',
          fortnoxDatabaseNumber: 900002,
          externalYear: 1,
          externalSeries: 'L',
          externalNumber: 2,
        },
      ],
    })
    r.reader.vouchers = [
      V(1, [
        { Account: 5170, Debit: 100, Credit: 0 },
        { Account: 2440, Debit: 0, Credit: 100 },
      ]),
      V(2, [
        { Account: 5170, Debit: 300, Credit: 0 },
        { Account: 2440, Debit: 0, Credit: 300 },
      ]),
      V(3, [
        { Account: 5170, Debit: 50, Credit: 0 },
        { Account: 2440, Debit: 0, Credit: 50 },
      ]),
    ]
    const run = await r.readback.read(o.id, 'u1', READ)
    expect((run.summary as { evenoExportOre: number }).evenoExportOre).toBe(10000)
  })

  // ── Katalog och kundval ───────────────────────────────────────────────────

  it('katalog utan år: år och dimensioner, inga konton; med år: verifierade konton', async () => {
    const o = await org()
    const r = rig()
    await connect(r, o.id)
    r.reader.financialYears = [
      { Id: 1, FromDate: '2026-01-01', ToDate: '2026-12-31' },
      { Id: 2, FromDate: '2025-01-01', ToDate: '2025-12-31' },
      { Id: 3, FromDate: '2024-01-01', ToDate: '2024-12-31' },
    ]
    r.reader.accounts = [
      { Number: 5170, Active: true, Description: 'Reparation' },
      { Number: 5180, Active: false, Description: 'Gammalt' },
      { Number: 2440, Active: true, Description: 'Leverantörsskulder' },
    ]
    const a = await r.readback.catalog(o.id, null)
    expect([a.ready, a.complete, a.selectedFinancialYearId, a.costAccounts.length]).toEqual([
      true,
      true,
      null,
      0,
    ])
    expect(a.financialYears.map((y) => y.id)).toEqual([1, 2, 3])
    expect(a.dimensions.map((d) => d.code)).toEqual(['HUSA', 'HUSB'])
    expect(a.company.databaseNumber).toBe(900001)
    const b = await r.readback.catalog(o.id, 1)
    expect(b.costAccounts).toEqual([
      { number: 2440, name: 'Leverantörsskulder', selectable: true, reason: null },
      { number: 5170, name: 'Reparation', selectable: true, reason: null },
      { number: 5180, name: 'Gammalt', selectable: false, reason: 'Kontot är inaktivt i Fortnox' },
    ])
    expect(JSON.stringify(b)).not.toMatch(/mock-access|TokenEnc/)
  })

  it('katalog: bruten paginering ger ready=false, aldrig lyckad tom lista', async () => {
    const o = await org()
    const r = rig()
    await connect(r, o.id)
    r.reader.costCenters = ['A', 'B', 'C']
    const orig = r.reader.get.bind(r.reader)
    r.reader.get = (async (t: string, p: string, q?: Record<string, string | number>) => {
      const body = (await orig(t, p, q)) as Record<string, unknown>
      if (p === '/3/costcenters' && q?.page === 2)
        (body.MetaInformation as Record<string, number>)['@TotalResources'] = 9
      return body
    }) as typeof r.reader.get
    const c = await r.readback.catalog(o.id, null)
    expect([c.ready, c.complete, c.dimensions]).toEqual([false, false, []])
    expect(c.reason).toMatch(/ändrades/)
  })

  it('katalog: fel företag och okänt år ger ready=false', async () => {
    const o = await org()
    const r = rig()
    await connect(r, o.id)
    expect((await r.readback.catalog(o.id, 99)).reason).toMatch(/finns inte/)
    r.reader.company = { ...r.reader.company, DatabaseNumber: 1 }
    const c = await r.readback.catalog(o.id, null)
    expect([c.ready, c.financialYears]).toEqual([false, []])
  })

  it('katalog: 401 som består efter förnyelse → AUTH_LOST på anslutningen', async () => {
    const o = await org()
    const r = rig()
    await connect(r, o.id)
    r.reader.calls = []
    r.reader.validTokens = () => false
    expect((await r.readback.catalog(o.id, null)).ready).toBe(false)
    expect(
      (await prisma.fortnoxConnection.findUniqueOrThrow({ where: { organizationId: o.id } }))
        .status,
    ).toBe('AUTH_LOST')
  })

  it('katalog utan anslutning nekas', async () => {
    const o = await org()
    await expect(rig().readback.catalog(o.id, null)).rejects.toThrow(/Ingen Fortnox-anslutning/)
  })

  it('mappning: dimension som inte finns i Fortnox avvisas; giltig sparas', async () => {
    const o = await org()
    const r = rig()
    await connect(r, o.id)
    const p = await property(o.id, 'HUS-A')
    await expect(
      r.mappings.upsert(o.id, { dimensionType: 'COST_CENTER', code: 'FINNSEJ', propertyId: p.id }),
    ).rejects.toThrow(/finns inte i Fortnox/)
    await r.mappings.upsert(o.id, { dimensionType: 'COST_CENTER', code: 'HUSA', propertyId: p.id })
    expect(await r.mappings.list(o.id)).toEqual([
      expect.objectContaining({ code: 'HUSA', propertyName: 'HUS-A' }),
    ])
  })

  it('läsvyn bär sparat kontourval och måttnamn', async () => {
    const o = await org()
    const r = rig()
    await connect(r, o.id)
    r.reader.vouchers = [
      V(1, [
        { Account: 5170, Debit: 100, Credit: 0 },
        { Account: 2440, Debit: 0, Credit: 100 },
      ]),
    ]
    await r.readback.read(o.id, 'u1', READ)
    const latest = await r.readback.latest(o.id)
    const view = toStatusResponse({
      enabled: true,
      connection: null,
      mappings: [],
      ...latest,
      exports: {
        counts: { DRY_RUN_READY: 0, BLOCKED: 0, UNKNOWN: 0, CONFIRMED: 0 },
        needsReconciliation: 0,
        sendingEnabled: false,
        sendingDisabledReason: 'IDEMPOTENCY_UNRESOLVED',
      },
    })
    expect(view.latestCompleteRead?.selectedAccounts).toEqual([5170])
    expect(view.latestCompleteRead?.measure).toBe('NET_AMOUNT_SELECTED_ACCOUNTS')
  })

  // ── Export-utkorg ─────────────────────────────────────────────────────────

  it('parallella dry-run för samma verifikat ger exakt en rad', async () => {
    const o = await org()
    const je = await prisma.journalEntry.create({
      data: {
        organizationId: o.id,
        date: new Date('2026-10-02'),
        description: 'x',
        fiscalYear: 2026,
        verNumber: 1,
      },
    })
    const builder: FortnoxVoucherDraftBuilder = {
      build: async () => ({ ok: true, draft: { a: 1 }, draftHash: 'h1' }),
    }
    const svc = new FortnoxExportService(prisma as unknown as PrismaService, builder)
    const res = await Promise.all(Array.from({ length: 6 }, () => svc.dryRun(o.id, je.id)))
    expect(new Set(res.map((x) => x.id)).size).toBe(1)
    expect(await prisma.fortnoxVoucherExport.count({ where: { journalEntryId: je.id } })).toBe(1)
    expect(svc.send()).toEqual({ sent: false, reason: 'IDEMPOTENCY_UNRESOLVED' })
  })

  it('UNKNOWN rörs aldrig av ny förhandskontroll (ingen blind omsändning)', async () => {
    const o = await org()
    const je = await prisma.journalEntry.create({
      data: {
        organizationId: o.id,
        date: new Date('2026-10-02'),
        description: 'x',
        fiscalYear: 2026,
        verNumber: 1,
      },
    })
    await prisma.fortnoxVoucherExport.create({
      data: { organizationId: o.id, journalEntryId: je.id, state: 'UNKNOWN' },
    })
    let built = 0
    const svc = new FortnoxExportService(prisma as unknown as PrismaService, {
      build: async () => (built++, { ok: true, draft: {}, draftHash: 'h' }),
    })
    expect((await svc.dryRun(o.id, je.id)).state).toBe('UNKNOWN')
    expect(built).toBe(0)
    expect((await svc.counts(o.id)).needsReconciliation).toBe(1)
  })

  it('standard: transformern är inte inkopplad → BLOCKED med uttrycklig orsak', async () => {
    const o = await org()
    const je = await prisma.journalEntry.create({
      data: {
        organizationId: o.id,
        date: new Date('2026-10-02'),
        description: 'x',
        fiscalYear: 2026,
        verNumber: 1,
      },
    })
    const svc = new FortnoxExportService(
      prisma as unknown as PrismaService,
      new PendingVoucherDraftBuilder(),
    )
    const row = await svc.dryRun(o.id, je.id)
    expect([row.state, row.blockReason]).toEqual(['BLOCKED', 'TRANSFORMER_NOT_INTEGRATED'])
  })

  it('annan organisations verifikat kan inte köas', async () => {
    const o1 = await org()
    const o2 = await org()
    const je = await prisma.journalEntry.create({
      data: {
        organizationId: o2.id,
        date: new Date('2026-10-02'),
        description: 'x',
        fiscalYear: 2026,
        verNumber: 1,
      },
    })
    const svc = new FortnoxExportService(
      prisma as unknown as PrismaService,
      new PendingVoucherDraftBuilder(),
    )
    await expect(svc.dryRun(o1.id, je.id)).rejects.toThrow(/hittades inte/)
  })

  it('org-radering tar anslutning, state, mappning och läsningar (tokens försvinner)', async () => {
    const o = await org()
    const r = rig()
    await connect(r, o.id)
    await r.connections.begin(o.id, 'u1')
    await prisma.fortnoxReadRun.create({
      data: {
        organizationId: o.id,
        connectionId: 'c',
        fortnoxDatabaseNumber: 1,
        financialYearId: 1,
        periodFrom: new Date('2026-01-01'),
        periodTo: new Date('2026-01-31'),
      },
    })
    await prisma.organization.delete({ where: { id: o.id } })
    expect(await prisma.fortnoxConnection.count({ where: { organizationId: o.id } })).toBe(0)
    expect(await prisma.fortnoxOAuthState.count({ where: { organizationId: o.id } })).toBe(0)
    expect(await prisma.fortnoxReadRun.count({ where: { organizationId: o.id } })).toBe(0)
  })
})
