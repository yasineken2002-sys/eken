/**
 * FORTNOX-NATT-20261003 (C1): den SKARPA skrivvägen (RealFortnoxVoucherWriter +
 * FortnoxTransport + RealFortnoxLedgerReader) genom den genuina sändkedjan mot
 * riktig Postgres. Fortnox ersätts av en syntetisk HTTP-yta (`FakeFortnoxApi`,
 * riktiga Response-objekt) — inget nätverk. Acceptansmatris: INVENTERING-001 A02–A16.
 */
import { randomUUID } from 'node:crypto'
import { ConflictException } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { PrismaClient } from '@prisma/client'
import type { PrismaService } from '../common/prisma/prisma.service'
import { FortnoxConnectionService } from './fortnox-connection.service'
import { FortnoxExportService, type FortnoxVoucherDraftBuilder } from './fortnox-export.service'
import { FortnoxReadbackService } from './fortnox-readback.service'
import { FortnoxTokenCryptoService } from './fortnox-token-crypto.service'
import { MockFortnoxAuthProvider, MockFortnoxLedgerReader } from './fortnox-providers'
import { VerifiedVoucherDraftBuilder } from './fortnox-export-builder'
import { FortnoxSendService } from './fortnox-send.service'
import { RealFortnoxVoucherWriter } from './fortnox-voucher-writer'
import { RealFortnoxLedgerReader } from './fortnox-real-provider'
import { FortnoxTransport } from './provider/fortnox-transport'
import { FakeFortnoxApi, noopRateLimiter } from './fortnox-fake-api.testing'
import { formatFortnoxShadowForAi } from './fortnox-ai-context'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip
const KEY = 'cd'.repeat(32)
const TEST_COMPANY = 1868238

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => expect(HAR_DB).toBe(true))
})

medDb('FORTNOX-NATT: skarp skrivväg mot syntetisk HTTP och riktig Postgres', () => {
  let prisma: PrismaClient
  const orgs: string[] = []

  beforeAll(async () => {
    const u = new URL(process.env.DATABASE_URL!)
    u.searchParams.set('connection_limit', '16')
    prisma = new PrismaClient({ datasources: { db: { url: u.toString() } } })
    await prisma.$connect()
  })

  afterAll(async () => {
    for (const id of orgs) {
      await prisma.fortnoxVoucherExport.deleteMany({ where: { organizationId: id } })
      await prisma.fortnoxReadRun.deleteMany({ where: { organizationId: id } })
      await prisma.journalEntryLine.deleteMany({ where: { journalEntry: { organizationId: id } } })
      await prisma.journalEntry.deleteMany({ where: { organizationId: id } })
      await prisma.account.deleteMany({ where: { organizationId: id } })
      await prisma.organization.delete({ where: { id } }).catch(() => undefined)
    }
    await prisma.$disconnect()
  })

  async function setup(opts: { company?: number } = {}) {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `natt-${sfx}`,
        email: `natt-${sfx}@example.se`,
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
      DatabaseNumber: opts.company ?? TEST_COMPANY,
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
    const readback = new FortnoxReadbackService(db, connections, reader, writer)
    const verified = new VerifiedVoucherDraftBuilder(db, connections, reader)
    let afterBuild: (() => Promise<void>) | null = null
    const builder: FortnoxVoucherDraftBuilder = {
      build: async (o, j) => {
        const res = await verified.build(o, j)
        if (afterBuild) await afterBuild()
        return res
      },
    }
    const exports = new FortnoxExportService(db, builder)
    const sender = new FortnoxSendService(db, connections, builder, reader, writer)
    const { authUrl } = await connections.begin(org.id, 'u1')
    const state = new URL(authUrl).searchParams.get('state')!
    await connections.handleCallback(state, `mock-code-${state.slice(0, 8)}`)
    await connections.setExportVoucherSeries(org.id, 'A')
    await connections.setExportOmitDimensions(org.id, 'u1', true)
    const acc = async (number: number) =>
      (await prisma.account.findFirst({ where: { organizationId: org.id, number } })) ??
      prisma.account.create({
        data: { organizationId: org.id, number, name: `Konto ${number}`, type: 'EXPENSE' },
      })
    const entry = async (
      amount = '1234.50',
      description = `EVENO TEST 20261003 ${sfx}`,
      radtext: [string | null, string | null] = [null, null],
    ) => {
      const a = await acc(5170)
      const b = await acc(2440)
      return prisma.journalEntry.create({
        data: {
          organizationId: org.id,
          date: new Date('2026-10-02'),
          description,
          fiscalYear: 2026,
          verNumber: Math.floor(Math.random() * 1e6) + 1,
          lines: {
            create: [
              { accountId: a.id, debit: amount, description: radtext[0] },
              { accountId: b.id, credit: amount, description: radtext[1] },
            ],
          },
        },
      })
    }
    const ready = async (
      amount?: string,
      description?: string,
      radtext?: [string | null, string | null],
    ) => {
      const je = await entry(amount, description, radtext)
      const row = await exports.dryRun(org.id, je.id)
      expect(row.state).toBe('DRY_RUN_READY')
      return { je, row: row as typeof row & { draftHash: string } }
    }
    const dbRow = (id: string) => prisma.fortnoxVoucherExport.findUniqueOrThrow({ where: { id } })
    const setAfterBuild = (f: (() => Promise<void>) | null) => (afterBuild = f)
    return {
      org,
      api,
      ledger,
      sender,
      exports,
      readback,
      connections,
      ready,
      dbRow,
      setAfterBuild,
    }
  }

  const posts = (t: { api: FakeFortnoxApi }) =>
    t.api.requests.filter((r) => r.method === 'POST').length

  it('A06: skarp väg → live-företagskontroll direkt före EN POST, exakt identitet, CONFIRMED; readback och AI räknar en gång', async () => {
    const t = await setup()
    expect(await t.sender.sendingEnabledFor(t.org.id)).toBe(true)
    const { row } = await t.ready('1234.50')
    const before = t.api.requests.length
    const res = await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    expect(res.state).toBe('CONFIRMED')
    expect([res.externalYear, res.externalSeries, res.externalNumber]).toEqual([1, 'A', 1])
    const during = t.api.requests.slice(before)
    const postAt = during.findIndex((r) => r.method === 'POST')
    expect(during.filter((r) => r.method === 'POST')).toEqual([
      { method: 'POST', path: '/3/vouchers', query: { financialyear: '1' } },
    ])
    expect(during[postAt - 1]).toEqual({
      method: 'GET',
      path: '/3/companyinformation',
      query: {},
    })
    // Read-after-write: exakt identitet efter POST.
    expect(during.slice(postAt + 1).map((r) => `${r.method} ${r.path}`)).toContain(
      'GET /3/vouchers/A/1',
    )
    expect(t.api.writes).toBe(1)
    const raw = await t.dbRow(row.id)
    expect(raw.fortnoxDatabaseNumber).toBe(TEST_COMPANY)

    const run = await t.readback.read(t.org.id, 'u1', {
      financialYearId: 1,
      periodFrom: '2026-01-01',
      periodTo: '2026-12-31',
      costAccounts: [5170],
    })
    const summary = run.summary as { totalOre: number; evenoExportOre: number }
    expect(summary.totalOre).toBe(123450)
    expect(summary.evenoExportOre).toBe(123450)
    // A16: AI-texten bär företag, källa, period och täckning; Eveno-exporterat särredovisas.
    const lines = formatFortnoxShadowForAi(await t.readback.aiSnapshot(t.org.id))
    const text = lines.join('\n')
    expect(text).toContain('1 234,50')
    expect(text).toMatch(/Varav verifikat som Eveno själv exporterat: 1\s234,50/)
    expect(text).toContain('lägg aldrig ihop')
    expect(text).toContain('sändning är aktiverad endast för detta testföretag')
    expect(text).toContain('1 bekräftade.')
    expect(text).toContain('Eveno integrationstest 2026-10-02')
    expect(text).toMatch(/2026-01-01/)
    expect(text).toMatch(/Täckning/)
    expect(text).not.toMatch(/2\s469,00/)
  })

  it('A02: anslutet företag utanför den hårdkodade listan → sendingEnabled false, 409 SENDING_DISABLED, inget anspråk, 0 POST', async () => {
    const t = await setup({ company: 900001 })
    expect(await t.sender.sendingEnabledFor(t.org.id)).toBe(false)
    const { row } = await t.ready()
    await expect(t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).rejects.toThrow(
      /SENDING_DISABLED/,
    )
    const raw = await t.dbRow(row.id)
    expect([raw.state, raw.sendAttemptId]).toEqual(['DRY_RUN_READY', null])
    expect(posts(t)).toBe(0)
    const ai = formatFortnoxShadowForAi(await t.readback.aiSnapshot(t.org.id)).join('\n')
    expect(ai).toContain('sändning är avstängd')
  })

  it('A04: live-kontrollen före POST svarar annat företag → not_sent, tillbaka till READY, 0 POST', async () => {
    const t = await setup()
    const { row } = await t.ready()
    // send: färsk förkontroll läser companyinformation (n+1), skrivarens live-kontroll (n+2).
    t.api.companyOverride.set(t.api.companyCalls + 2, 900001)
    const res = await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    expect(res.state).toBe('DRY_RUN_READY')
    expect(res.lastOutcome).toBe('NOT_SENT')
    expect(posts(t)).toBe(0)
    // Nytt försök är tillåtet och lyckas.
    const again = await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    expect(again.state).toBe('CONFIRMED')
    expect(posts(t)).toBe(1)
  })

  it('A05: live-kontrollen misslyckas (401) → not_sent, 0 POST', async () => {
    const t = await setup()
    const { row } = await t.ready()
    t.api.companyStatus.set(t.api.companyCalls + 2, 401)
    const res = await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    expect([res.state, res.lastOutcome]).toEqual(['DRY_RUN_READY', 'NOT_SENT'])
    expect(posts(t)).toBe(0)
  })

  it('A07: svaret tappas efter POST → UNKNOWN; ny send/dry-run ger ingen ny POST; reconcile med exakt identitet → CONFIRMED', async () => {
    const t = await setup()
    const { je, row } = await t.ready()
    t.api.faults.push('drop_response_after_write')
    const res = await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    expect(res.state).toBe('UNKNOWN')
    expect([posts(t), t.api.writes]).toEqual([1, 1])
    await expect(t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).rejects.toThrow(
      ConflictException,
    )
    const dry = await t.exports.dryRun(t.org.id, je.id)
    expect(dry.state).toBe('UNKNOWN')
    expect(posts(t)).toBe(1)
    const rec = await t.sender.reconcile(t.org.id, 'u1', row.id, {
      year: 1,
      series: 'A',
      number: 1,
    })
    expect(rec.state).toBe('CONFIRMED')
    expect(posts(t)).toBe(1)
  })

  it.each([
    ['status_400', 'REJECTED', 0],
    ['status_429', 'REJECTED', 0],
    ['status_500_after_write', 'UNKNOWN', 1],
    ['network_error_before_write', 'UNKNOWN', 0],
    ['wrong_year_after_write', 'UNKNOWN', 1],
    ['no_number_after_write', 'UNKNOWN', 1],
  ] as const)('A08–A10: %s → %s, exakt 1 POST, ingen omsändning', async (fault, state, writes) => {
    const t = await setup()
    const { row } = await t.ready()
    t.api.faults.push(fault)
    const res = await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    expect(res.state).toBe(state)
    expect([posts(t), t.api.writes]).toEqual([1, writes])
    await expect(t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).rejects.toThrow(
      ConflictException,
    )
    expect(posts(t)).toBe(1)
  })

  it('A11 (K-S5): främmande post med identiska rader men annan beskrivning kan inte stämmas av; rätt identitet kan', async () => {
    const t = await setup()
    const { row } = await t.ready('500.00', 'EVENO TEST 20261003 intent-a')
    t.api.faults.push('drop_response_after_write')
    expect((await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).state).toBe('UNKNOWN')
    const ours = t.ledger.vouchers[0]!
    t.ledger.vouchers.push({
      ...structuredClone(ours),
      VoucherNumber: 2,
      Description: 'Annan post',
    })
    await expect(
      t.sender.reconcile(t.org.id, 'u1', row.id, { year: 1, series: 'A', number: 2 }),
    ).rejects.toThrow(/stämmer inte/)
    expect((await t.dbRow(row.id)).state).toBe('UNKNOWN')
    const ok = await t.sender.reconcile(t.org.id, 'u1', row.id, { year: 1, series: 'A', number: 1 })
    expect(ok.state).toBe('CONFIRMED')
  })

  it('A12 (T-N1): ny anslutningsgeneration efter färsk förkontroll → 409 utan anspråk, 0 POST', async () => {
    const t = await setup()
    const { row } = await t.ready()
    t.setAfterBuild(async () => {
      await prisma.fortnoxConnection.update({
        where: { organizationId: t.org.id },
        data: { generation: { increment: 1 } },
      })
      t.setAfterBuild(null)
    })
    await expect(t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).rejects.toThrow(
      /inte längre aktuellt/,
    )
    const raw = await t.dbRow(row.id)
    expect([raw.state, raw.sendAttemptId]).toEqual(['DRY_RUN_READY', null])
    expect(posts(t)).toBe(0)
  })

  it('A13: två samtidiga send med skarp skrivare → exakt 1 POST, 200 + 409', async () => {
    const t = await setup()
    const { row } = await t.ready()
    let arrived = 0
    let release!: () => void
    const both = new Promise<void>((r) => (release = r))
    t.setAfterBuild(async () => {
      arrived += 1
      if (arrived === 2) release()
      await both
    })
    const results = await Promise.allSettled([
      t.sender.send(t.org.id, 'u1', row.id, row.draftHash),
      t.sender.send(t.org.id, 'u1', row.id, row.draftHash),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect([posts(t), t.api.writes]).toEqual([1, 1])
  })

  it('A21 (FINAL-003 EX-2b): radtext når Fortnox som TransactionInformation, återläses exakt och ingår i bekräftelsen', async () => {
    const t = await setup()
    const text = 'Takläcka trapphus B – faktura 4711'
    const { row } = await t.ready('250.00', 'EVENO TEST 20261003 radtext', [text, null])
    const res = await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    expect(res.state).toBe('CONFIRMED')
    const v = t.ledger.vouchers.find((x) => x.Description === 'EVENO TEST 20261003 radtext')!
    const rows = v.VoucherRows as Array<Record<string, unknown>>
    // Texten tappas inte: den finns i Fortnox i det dokumenterade fältet.
    expect(rows.find((r) => r.Account === 5170)?.TransactionInformation).toBe(text)
    // Radens Description är kontots benämning i Fortnox, aldrig vår text.
    expect(rows.find((r) => r.Account === 5170)?.Description).toBe(
      'Reparation och underhåll av fastighet',
    )
    // Rad utan text: Fortnox ger '' (mätt live, execute-002).
    expect(rows.find((r) => r.Account === 2440)?.TransactionInformation).toBe('')
  })

  it('A22 (FINAL-003 EX-2b): avviker återläst radtext → aldrig CONFIRMED', async () => {
    const t = await setup()
    const { row } = await t.ready('260.00', 'EVENO TEST 20261003 radtext-avvik', ['Rad A', null])
    t.api.beforeWrite = async () => {
      t.api.beforeWrite = null
    }
    const orig = t.ledger.vouchers.push.bind(t.ledger.vouchers)
    t.ledger.vouchers.push = (...v) => {
      for (const x of v)
        for (const r of x.VoucherRows as Array<Record<string, unknown>>)
          if (r.TransactionInformation === 'Rad A') r.TransactionInformation = 'Rad A '
      return orig(...v)
    }
    const res = await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    expect(res.state).toBe('RECEIPT_MISMATCH')
  })
})
