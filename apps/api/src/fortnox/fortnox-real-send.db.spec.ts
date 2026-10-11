/**
 * FORTNOX-NATT-20261003 (C1): den SKARPA skrivvägen (RealFortnoxVoucherWriter +
 * FortnoxTransport + RealFortnoxLedgerReader) genom den genuina sändkedjan mot
 * riktig Postgres. Fortnox ersätts av en syntetisk HTTP-yta (`FakeFortnoxApi`,
 * riktiga Response-objekt) — inget nätverk. Acceptansmatris: INVENTERING-001 A02–A16.
 */
import { randomUUID } from 'node:crypto'
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { PrismaClient } from '@prisma/client'
import type { PrismaService } from '../common/prisma/prisma.service'
import { FortnoxConnectionService } from './fortnox-connection.service'
import { FortnoxExportService, type FortnoxVoucherDraftBuilder } from './fortnox-export.service'
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
import { RealFortnoxVoucherWriter } from './fortnox-voucher-writer'
import { RealFortnoxLedgerReader } from './fortnox-real-provider'
import { FortnoxTransport } from './provider/fortnox-transport'
import { FakeFortnoxApi, noopRateLimiter } from './fortnox-fake-api.testing'
import { formatFortnoxShadowForAi } from './fortnox-ai-context'
import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { SupplierInvoiceService } from '../accounting/supplier-invoice.service'

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
      await prisma.supplierInvoice.deleteMany({ where: { organizationId: id } })
      await prisma.user.deleteMany({ where: { organizationId: id } })
      await prisma.journalEntrySequence.deleteMany({ where: { organizationId: id } })
      await stadaKontomappning(prisma, id)
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
    // TESTKUND-008: export kräver belagd källa och godkänd kontomappning.
    await godkannMappning(prisma, connections, reader, org.id)
    const entry = async (
      amount = '1234.50',
      description = `EVENO TEST 20261003 ${sfx}`,
      radtext: [string | null, string | null] = [null, null],
    ) => leverantorsfaktura(prisma, org.id, { belopp: amount, beskrivning: description, radtext })
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
      reader,
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
    // TESTKUND-035 P3-B3: 429 på POST är okänt utfall (tidigare REJECTED).
    ['status_429', 'UNKNOWN', 0],
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

  // ── TESTKUND-016: verkligt H4-stopp (H3H4-REAL-002 svar-0112, 400/2000359) ─────────────────────
  // Röda reproduktioner före rättning: produktens egen leverantörsfakturamall skickas oförändrad som
  // Voucher.Description och avvisas; en avvisad export har ingen behörig väg ut.
  const leverantorsfakturaViaProdukten = async (t: Awaited<ReturnType<typeof setup>>) => {
    const accounting = new AccountingService(
      prisma as unknown as PrismaService,
      new VerifikationsnummerService(prisma as unknown as PrismaService),
    )
    const f = await prisma.supplierInvoice.create({
      data: {
        organizationId: t.org.id,
        supplierName: 'EVENO TEST leverantör',
        description: 'EVENO TEST kostnad',
        invoiceDate: new Date('2026-10-02'),
        dueDate: new Date('2026-10-02'),
        expenseAccount: 5170,
        netAmount: '125',
        vatRate: 0,
        vatAmount: '0',
        totalAmount: '125',
      },
    })
    await accounting.bookSupplierInvoiceReceipt({
      organizationId: t.org.id,
      invoiceId: f.id,
      date: new Date('2026-10-02'),
      supplierName: f.supplierName,
      description: f.description,
      expenseAccount: 5170,
      totalAmount: 125,
      vatAmount: 0,
    })
    return prisma.journalEntry.findFirstOrThrow({
      where: { organizationId: t.org.id, sourceId: `supplier-invoice:${f.id}` },
    })
  }

  it('H4-016 R1: produktens leverantörsfakturamall exporteras med deterministisk exporttext; den råa texten bevaras', async () => {
    const t = await setup()
    const je = await leverantorsfakturaViaProdukten(t)
    expect(je.description).toBe('Leverantörsfaktura: EVENO TEST leverantör — EVENO TEST kostnad')
    const row = (await t.exports.dryRun(t.org.id, je.id)) as {
      id: string
      state: string
      draftHash: string
      blockReason: string | null
    }
    expect([row.state, row.blockReason]).toEqual(['DRY_RUN_READY', null])
    expect((row as unknown as { exportText: unknown }).exportText).toEqual([
      {
        falt: 'Description',
        rad: null,
        originaltext: 'Leverantörsfaktura: EVENO TEST leverantör — EVENO TEST kostnad',
        exporttext: 'Leverantörsfaktura: EVENO TEST leverantör – EVENO TEST kostnad',
      },
    ])
    const db = await t.dbRow(row.id)
    expect((db.draft as { provenance: { text: unknown } }).provenance.text).toEqual({
      regelVersion: 'fortnox-valid-characters/2026-10-09+U2014-U2013',
      falt: [
        {
          falt: 'Description',
          rad: null,
          ra: 'Leverantörsfaktura: EVENO TEST leverantör — EVENO TEST kostnad',
          export: 'Leverantörsfaktura: EVENO TEST leverantör – EVENO TEST kostnad',
          mappningar: [{ fran: 'U+2014', till: 'U+2013', antal: 1 }],
        },
      ],
    })
    const res = await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    expect(res.state).toBe('CONFIRMED')
    expect(t.ledger.vouchers.at(-1)?.Description).toBe(
      'Leverantörsfaktura: EVENO TEST leverantör – EVENO TEST kostnad',
    )
    // K2.2(b): ingen Description med U+2014 nådde POST.
    expect(t.ledger.vouchers.every((v) => !String(v.Description).includes('—'))).toBe(true)
    const efter = await prisma.journalEntry.findUniqueOrThrow({ where: { id: je.id } })
    expect(efter.description).toBe('Leverantörsfaktura: EVENO TEST leverantör — EVENO TEST kostnad')
  })

  const OWNER = { sub: 'u1', role: 'OWNER' }
  const ADMIN = { sub: 'u2', role: 'ADMIN' }
  const historik = async (id: string) =>
    (await prisma.fortnoxVoucherExport.findUniqueOrThrow({ where: { id } }))
      .attemptHistory as Array<Record<string, unknown>>
  /** Avvisa via exakt det observerade svaret [O] och returnera raden. */
  const avvisad = async (
    t: Awaited<ReturnType<typeof setup>>,
    text = 'EVENO TEST avvisad 2000359',
  ) => {
    const { je, row } = await t.ready('125.00', text)
    t.api.faults.push('observerad_2000359_h3h4_real_002')
    const res = await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    expect([res.state, res.lastOutcome]).toEqual(['REJECTED', 'REJECTED_400_2000359'])
    return { je, row }
  }

  it('H4-016 R2/T10: REJECTED_400_2000359 → release (OWNER) → ny förhandskontroll → send → CONFIRMED; exakt 1 ny POST; historiken bevarar beviset', async () => {
    const t = await setup()
    const { row } = await avvisad(t)
    const h1 = await historik(row.id)
    expect(h1).toEqual([
      expect.objectContaining({
        typ: 'AVVISAD',
        http: 400,
        code: 2000359,
        kalla: 'LAGRAD_AV_PRODUKTEN',
        sentPayloadHash: row.draftHash,
        utfall: 'REJECTED_400_2000359',
        meddelande: 'Värdet innehåller ej tillåtna tecken. (EVENO TEST avvisad 2000359)',
      }),
    ])
    const rel = await t.sender.releaseRejected(t.org.id, OWNER, row.id, {
      reason: 'Fortnox avvisade texten',
    })
    expect([rel.state, rel.lastOutcome]).toEqual(['BLOCKED', 'RELEASED_AFTER_REJECTION'])
    const h2 = await historik(row.id)
    expect(h2).toHaveLength(2)
    expect(h2[0]).toEqual(h1[0])
    expect(h2[1]).toEqual(
      expect.objectContaining({
        typ: 'FRISLAPPT',
        av: 'u1',
        roll: 'OWNER',
        skal: 'Fortnox avvisade texten',
        avvisning: { kalla: 'LAGRAD_AV_PRODUKTEN', http: 400, code: 2000359 },
        tidigareForsok: expect.objectContaining({
          sentPayloadHash: row.draftHash,
          lastOutcome: 'REJECTED_400_2000359',
        }),
        skanning: expect.objectContaining({ databaseNumber: TEST_COMPANY, financialYear: 1 }),
      }),
    )
    const postsFore = posts(t)
    // T17: gammal hash efter frisläppning → 409, 0 POST.
    await expect(t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).rejects.toThrow(
      ConflictException,
    )
    const ny = (await t.exports.dryRun(t.org.id, row.journalEntryId)) as {
      state: string
      draftHash: string
    }
    expect(ny.state).toBe('DRY_RUN_READY')
    const res = await t.sender.send(t.org.id, 'u1', row.id, ny.draftHash)
    expect(res.state).toBe('CONFIRMED')
    expect(posts(t) - postsFore).toBe(1)
    expect(t.api.writes).toBe(1)
    expect(await historik(row.id)).toHaveLength(2)
  })

  it('H4-016 K3.5: två avvisningar i rad → historiken har båda bevisen och frisläppningen, inget skrivs över', async () => {
    const t = await setup()
    const { row } = await avvisad(t)
    await t.sender.releaseRejected(t.org.id, ADMIN, row.id, { reason: 'första frisläppningen' })
    const ny = (await t.exports.dryRun(t.org.id, row.journalEntryId)) as { draftHash: string }
    t.api.faults.push('observerad_2000359_h3h4_real_002')
    const res = await t.sender.send(t.org.id, 'u1', row.id, ny.draftHash)
    expect(res.lastOutcome).toBe('REJECTED_400_2000359')
    const h = await historik(row.id)
    expect(h.map((x) => x.typ)).toEqual(['AVVISAD', 'FRISLAPPT', 'AVVISAD'])
    expect(h[0]!.sendAttemptId).not.toBe(h[2]!.sendAttemptId)
  })

  it('H4-016 T11/K3.4: äldre REJECTED utan lagrad kod kräver OWNER och externt kvitto med samma sentPayloadHash', async () => {
    const t = await setup()
    const { row } = await avvisad(t)
    // Äldre produktversion: bara 'REJECTED', ingen kod och ingen historik.
    await prisma.fortnoxVoucherExport.update({
      where: { id: row.id },
      data: { lastOutcome: 'REJECTED', attemptHistory: [] },
    })
    const bevis = {
      http: 400,
      code: 2000359,
      rakvittoSha256: 'b'.repeat(64),
      manifestSha256: 'c'.repeat(64),
      sentPayloadHash: row.draftHash,
    }
    await expect(
      t.sender.releaseRejected(t.org.id, OWNER, row.id, { reason: 'äldre avvisning' }),
    ).rejects.toThrow(ConflictException)
    await expect(
      t.sender.releaseRejected(t.org.id, ADMIN, row.id, {
        reason: 'äldre avvisning',
        avvisningsbevis: bevis,
      }),
    ).rejects.toThrow(ForbiddenException)
    await expect(
      t.sender.releaseRejected(t.org.id, OWNER, row.id, {
        reason: 'äldre avvisning',
        avvisningsbevis: { ...bevis, sentPayloadHash: 'd'.repeat(64) },
      }),
    ).rejects.toThrow(ConflictException)
    await expect(
      t.sender.releaseRejected(t.org.id, OWNER, row.id, {
        reason: 'äldre avvisning',
        avvisningsbevis: { ...bevis, http: 429 },
      }),
    ).rejects.toThrow(ConflictException)
    expect((await t.dbRow(row.id)).state).toBe('REJECTED')
    expect(await historik(row.id)).toEqual([])
    const rel = await t.sender.releaseRejected(t.org.id, OWNER, row.id, {
      reason: 'äldre avvisning',
      avvisningsbevis: bevis,
    })
    expect(rel.state).toBe('BLOCKED')
    const h = await historik(row.id)
    expect(h).toHaveLength(1)
    expect(h[0]!.avvisning).toEqual(
      expect.objectContaining({
        kalla: 'ANGIVET_I_EFTERHAND',
        beskrivning: 'Externt belagt, ej lagrat av produkten',
        http: 400,
        code: 2000359,
        rakvittoSha256: 'b'.repeat(64),
        angivetAv: 'u1',
        roll: 'OWNER',
      }),
    )
  })

  // ── TESTKUND-020 (KODPAR-BESKED-H4-020 K-KP-5): bara det belagda paret (400, 2000359) frisläpps,
  // både på den lagrade vägen och med OWNER:s kvitto i efterhand. Övriga avvisningar ger 409 utan
  // tillståndsbyte och utan någon historikpost. Den lagrade koden sätts här direkt i raden efter en
  // verklig avvisning (samma format som send() skriver), eftersom dubbeln bara bär det observerade svaret.
  const EJ_BELAGDA = [
    [400, 1000003],
    [400, 9999999],
    [403, 2000359],
    [401, 2000359],
    [404, 2000359],
    [409, 2000359],
    [422, 2000359],
  ] as const
  it.each(EJ_BELAGDA)(
    'K-KP-5 lagrad väg: REJECTED_%i_%i → 409 «inte en belagd innehållsavvisning», inget byte, ingen ny historik',
    async (http, code) => {
      const t = await setup()
      const { row } = await avvisad(t)
      await prisma.fortnoxVoucherExport.update({
        where: { id: row.id },
        data: { lastOutcome: `REJECTED_${http}_${code}` },
      })
      await expect(
        t.sender.releaseRejected(t.org.id, OWNER, row.id, { reason: 'prov kodpar' }),
      ).rejects.toThrow(
        `Avvisningen är inte en belagd innehållsavvisning (http ${http}, kod ${code})`,
      )
      const r = await t.dbRow(row.id)
      expect([r.state, r.lastOutcome]).toEqual(['REJECTED', `REJECTED_${http}_${code}`])
      expect((await historik(row.id)).map((x) => x.typ)).toEqual(['AVVISAD'])
    },
  )
  it.each(EJ_BELAGDA)(
    'K-KP-5 äldre väg: OWNER-kvitto {http:%i, code:%i} → 409, inget byte, ingen historik',
    async (http, code) => {
      const t = await setup()
      const { row } = await avvisad(t)
      await prisma.fortnoxVoucherExport.update({
        where: { id: row.id },
        data: { lastOutcome: 'REJECTED', attemptHistory: [] },
      })
      const bevis = {
        http,
        code,
        rakvittoSha256: 'b'.repeat(64),
        manifestSha256: 'c'.repeat(64),
        sentPayloadHash: row.draftHash,
      }
      await expect(
        t.sender.releaseRejected(t.org.id, OWNER, row.id, {
          reason: 'prov kodpar',
          avvisningsbevis: bevis,
        }),
      ).rejects.toThrow(
        `Avvisningen är inte en belagd innehållsavvisning (http ${http}, kod ${code})`,
      )
      expect((await t.dbRow(row.id)).state).toBe('REJECTED')
      expect(await historik(row.id)).toEqual([])
    },
  )
  it('K-KP-5 lagrad väg utan kod (REJECTED_400_NA) → 409 med sann formulering', async () => {
    const t = await setup()
    const c = await t.ready('12.00')
    t.api.faults.push('status_400')
    await t.sender.send(t.org.id, 'u1', c.row.id, c.row.draftHash)
    await expect(
      t.sender.releaseRejected(t.org.id, OWNER, c.row.id, { reason: 'utan kod' }),
    ).rejects.toThrow('Avvisningen är inte en belagd innehållsavvisning (http 400, kod okänd)')
  })

  it('H4-016 T12: en post med verifikatets proveniens finns i Fortnox → 409, oförändrat (vägen är reconcile)', async () => {
    const t = await setup()
    const { row } = await avvisad(t)
    t.ledger.vouchers.push({
      Year: 1,
      VoucherSeries: 'A',
      VoucherNumber: 7,
      TransactionDate: '2026-10-02',
      Description: 'x',
      Comments: `Eveno JournalEntry ${row.journalEntryId}; local A/2026/1; eventDate 2026-10-02`,
      VoucherRows: [],
    })
    await expect(
      t.sender.releaseRejected(t.org.id, OWNER, row.id, { reason: 'prov proveniens' }),
    ).rejects.toThrow(/reconcile/)
    expect([(await t.dbRow(row.id)).state, (await historik(row.id)).length]).toEqual([
      'REJECTED',
      1,
    ])
  })

  it.each([
    [
      'ofullständig sida (TotalResources större än listan)',
      (b: Record<string, unknown>) => ({
        ...b,
        MetaInformation: { ...(b.MetaInformation as object), '@TotalResources': 99 },
      }),
    ],
    ['sidinformation saknas', (b: Record<string, unknown>) => ({ Vouchers: b.Vouchers })],
    [
      'listan saknar Comments',
      (b: Record<string, unknown>) => ({
        ...b,
        Vouchers: (b.Vouchers as Array<Record<string, unknown>>).map(({ Comments: _c, ...v }) => v),
      }),
    ],
    [
      'verifikat i fel år',
      (b: Record<string, unknown>) => ({
        ...b,
        Vouchers: (b.Vouchers as Array<Record<string, unknown>>).map((v) => ({ ...v, Year: 2 })),
      }),
    ],
  ] as const)('H4-016 T13: %s → 409, inget tillståndsbyte', async (_namn, tamper) => {
    const t = await setup()
    const { row } = await avvisad(t)
    // Fler poster än en sida (pageSize 2) så att sidläsningen provas.
    for (let n = 2; n <= 4; n++)
      t.ledger.vouchers.push({
        Year: 1,
        VoucherSeries: 'A',
        VoucherNumber: n,
        TransactionDate: '2026-10-02',
        Description: 'främmande',
        Comments: null,
        VoucherRows: [],
      })
    t.api.listTamper = tamper as (b: Record<string, unknown>) => unknown
    await expect(
      t.sender.releaseRejected(t.org.id, OWNER, row.id, { reason: 'prov läsning' }),
    ).rejects.toThrow(ConflictException)
    expect([(await t.dbRow(row.id)).state, (await historik(row.id)).length]).toEqual([
      'REJECTED',
      1,
    ])
    t.api.listTamper = null
    const ok = await t.sender.releaseRejected(t.org.id, OWNER, row.id, { reason: 'prov läsning' })
    expect(ok.state).toBe('BLOCKED')
    expect((await historik(row.id))[1]!.skanning).toEqual(
      expect.objectContaining({ verifikatLasta: 3, sidor: 2 }),
    )
  })

  it('H4-016 T13: fel företag i den färska läsningen → 409, inget tillståndsbyte', async () => {
    const t = await setup()
    const { row } = await avvisad(t)
    t.api.companyOverride.set(t.api.companyCalls + 1, 999)
    await expect(
      t.sender.releaseRejected(t.org.id, OWNER, row.id, { reason: 'prov företag' }),
    ).rejects.toThrow(/företaget/)
    expect((await t.dbRow(row.id)).state).toBe('REJECTED')
  })

  it('H4-016 T14 (ändrad i TESTKUND-035): 429 vid POST → UNKNOWN_429 och kan aldrig frisläppas; en äldre REJECTED_429_NA kan inte heller frisläppas; UNKNOWN kan inte frisläppas', async () => {
    const t = await setup()
    const a = await t.ready('10.00')
    t.api.faults.push('status_429')
    const a1 = await t.sender.send(t.org.id, 'u1', a.row.id, a.row.draftHash)
    expect([a1.state, a1.lastOutcome]).toEqual(['UNKNOWN', 'UNKNOWN_429'])
    await expect(
      t.sender.releaseRejected(t.org.id, OWNER, a.row.id, { reason: 'rate limit' }),
    ).rejects.toThrow(/reconcile/)
    // Äldre rad skriven före TESTKUND-035: REJECTED med lagrad 429.
    await prisma.fortnoxVoucherExport.update({
      where: { id: a.row.id },
      data: { state: 'REJECTED', lastOutcome: 'REJECTED_429_NA' },
    })
    await expect(
      t.sender.releaseRejected(t.org.id, OWNER, a.row.id, { reason: 'rate limit' }),
    ).rejects.toThrow(/429/)
    const b = await t.ready('11.00')
    t.api.faults.push('drop_response_after_write')
    expect((await t.sender.send(t.org.id, 'u1', b.row.id, b.row.draftHash)).state).toBe('UNKNOWN')
    await expect(
      t.sender.releaseRejected(t.org.id, OWNER, b.row.id, { reason: 'okänt utfall' }),
    ).rejects.toThrow(/reconcile/)
    expect((await historik(b.row.id)).map((x) => x.typ)).toEqual(['OKANT_UTFALL'])
    // En 400 utan Fortnox-kod är ingen belagd innehållsavvisning.
    const c = await t.ready('12.00')
    t.api.faults.push('status_400')
    expect((await t.sender.send(t.org.id, 'u1', c.row.id, c.row.draftHash)).lastOutcome).toBe(
      'REJECTED_400_NA',
    )
    await expect(
      t.sender.releaseRejected(t.org.id, OWNER, c.row.id, { reason: 'utan kod' }),
    ).rejects.toThrow(/belagd/)
  })

  it('H4-016 T15: VIEWER/ACCOUNTANT → 403 i tjänsten; annan organisation → 404; CONFIRMED → 409', async () => {
    const t = await setup()
    const { row } = await avvisad(t)
    for (const role of ['VIEWER', 'ACCOUNTANT', 'TENANT'])
      await expect(
        t.sender.releaseRejected(t.org.id, { sub: 'x', role }, row.id, { reason: 'fel roll' }),
      ).rejects.toThrow(ForbiddenException)
    const t2 = await setup()
    await expect(
      t2.sender.releaseRejected(t2.org.id, OWNER, row.id, { reason: 'annan org' }),
    ).rejects.toThrow(NotFoundException)
    const k = await t.ready('13.00')
    await t.sender.send(t.org.id, 'u1', k.row.id, k.row.draftHash)
    await expect(
      t.sender.releaseRejected(t.org.id, OWNER, k.row.id, { reason: 'bekräftad' }),
    ).rejects.toThrow(ConflictException)
    expect((await t.dbRow(row.id)).state).toBe('REJECTED')
  })

  it('H4-016 T16: två samtidiga frisläppningar → exakt en lyckas; historiken får exakt en FRISLAPPT', async () => {
    const t = await setup()
    const { row } = await avvisad(t)
    const r = await Promise.allSettled([
      t.sender.releaseRejected(t.org.id, OWNER, row.id, { reason: 'samtidig ett' }),
      t.sender.releaseRejected(t.org.id, ADMIN, row.id, { reason: 'samtidig två' }),
    ])
    expect(r.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(
      ConflictException,
    )
    expect((await historik(row.id)).filter((x) => x.typ === 'FRISLAPPT')).toHaveLength(1)
  })

  it.each([
    ['é ü & , . : ’', 'Inbetalning hyresavi X (José Müller) & Co, fakt. 12: rad 3 – O’Brien'],
    ['kolon utan mappning', 'Betald leverantörsfaktura: EVENO TEST leverantör'],
  ])('H4-016 T2–T4 (K2.2c): %s → oförändrad text, CONFIRMED, ingen mappning', async (_n, text) => {
    const t = await setup()
    const { row } = await t.ready('14.00', text)
    expect(row.exportText).toEqual([])
    const res = await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    expect(res.state).toBe('CONFIRMED')
    expect(t.ledger.vouchers.at(-1)?.Description).toBe(text)
  })

  it.each([
    ['"', 'Faktura "april"', 'U+0022'],
    ["'", "O'Brien", 'U+0027'],
    ['TAB', 'a\tb', 'U+0009'],
    ['NFD-é (U+0301)', 'José', 'U+0301'],
    ['emoji', 'Hyra 🏠', 'U+1F3E0'],
  ])(
    'H4-016 T5/T6: %s i Description → BLOCKED TEXT_NOT_EXPORTABLE med kodpunkt, 0 POST',
    async (_n, text, kp) => {
      const t = await setup()
      const e2 = await leverantorsfaktura(prisma, t.org.id, {
        belopp: '16.00',
        beskrivning: text,
        radtext: [null, null],
      })
      const row = (await t.exports.dryRun(t.org.id, e2.id)) as {
        state: string
        blockReason: string | null
      }
      expect(row.state).toBe('BLOCKED')
      expect(row.blockReason).toContain('TEXT_NOT_EXPORTABLE')
      expect(row.blockReason).toContain(kp)
      expect(row.blockReason).toContain('Description')
      expect(posts(t)).toBe(0)
    },
  )

  it('H4-016 T7: radtext med U+2014 → U+2013 i TransactionInformation; proveniensen visar rad och original', async () => {
    const t = await setup()
    const { row } = await t.ready('17.00', 'EVENO TEST radtext', ['Kostnad — april', null])
    expect(row.exportText).toEqual([
      {
        falt: 'TransactionInformation',
        rad: 1,
        originaltext: 'Kostnad — april',
        exporttext: 'Kostnad – april',
      },
    ])
    const res = await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    expect(res.state).toBe('CONFIRMED')
    expect(
      (t.ledger.vouchers.at(-1)?.VoucherRows as Array<{ TransactionInformation: string }>)[0]!
        .TransactionInformation,
    ).toBe('Kostnad – april')
  })

  // ══ TESTKUND-027 L3 / V-7 / V-8 / V-9 (KONTRAKTSBESKED-P2-028) — produktens tjänster, skarp skrivväg ══
  const tjanster = () => {
    const acc = new AccountingService(
      prisma as unknown as PrismaService,
      new VerifikationsnummerService(prisma as unknown as PrismaService),
    )
    return { acc, lev: new SupplierInvoiceService(prisma as unknown as PrismaService, acc) }
  }
  const anvandare = new Map<string, string>()
  const uid = async (orgId: string) => {
    if (!anvandare.has(orgId)) {
      const u = await prisma.user.create({
        data: {
          organizationId: orgId,
          email: `p2-${randomUUID().slice(0, 8)}@example.invalid`,
          firstName: 'P2',
          lastName: 'Prov',
          role: 'OWNER',
          passwordHash: 'ej-inloggningsbar',
        },
      })
      anvandare.set(orgId, u.id)
    }
    return anvandare.get(orgId)!
  }
  const levFaktura = async (t: Awaited<ReturnType<typeof setup>>, belopp = 125) => {
    const { lev } = tjanster()
    if (!(await prisma.account.findFirst({ where: { organizationId: t.org.id, number: 1930 } })))
      await prisma.account.create({
        data: { organizationId: t.org.id, number: 1930, name: 'Företagskonto', type: 'ASSET' },
      })
    const f = await lev.create({
      organizationId: t.org.id,
      createdById: await uid(t.org.id),
      supplierName: 'Bygg & Co AB',
      description: 'Reparation',
      invoiceDate: new Date('2026-10-02'),
      dueDate: new Date('2026-10-30'),
      expenseAccount: 5170,
      totalAmount: belopp,
      vatRate: 0,
    })
    const je = await prisma.journalEntry.findFirstOrThrow({
      where: { organizationId: t.org.id, sourceId: `supplier-invoice:${f.id}` },
    })
    return { f, je }
  }
  const makulera = async (t: Awaited<ReturnType<typeof setup>>, id: string) =>
    tjanster().lev.cancel({
      organizationId: t.org.id,
      invoiceId: id,
      createdById: await uid(t.org.id),
    })
  const makJe = (t: Awaited<ReturnType<typeof setup>>, id: string) =>
    prisma.journalEntry.findFirst({
      where: { organizationId: t.org.id, sourceId: `supplier-invoice-cancel:${id}` },
    })
  const radlista = (v: { VoucherRows?: unknown }) =>
    (v.VoucherRows as Array<{ Account: number; Debit: number; Credit: number }>)
      .map((r) => [r.Account, Math.round(r.Debit * 100), Math.round(r.Credit * 100)])
      .sort((a, b) => a[0]! - b[0]!)
  const saldoPerKonto = (t: { ledger: MockFortnoxLedgerReader }) => {
    const ut: Record<number, number> = {}
    for (const v of t.ledger.vouchers)
      for (const [k, d, c] of radlista(v)) ut[k!] = (ut[k!] ?? 0) + d! - c!
    return ut
  }

  it('P2-027 L3.1/L3.5: makulering efter CONFIRMED (produktens cancel) → exakt en omvänd post med originalets konton; text «–»; 5170 och 2440 netto 0 över två egna poster', async () => {
    const t = await setup()
    const { f, je } = await levFaktura(t)
    const o = await t.exports.dryRun(t.org.id, je.id)
    await t.sender.send(t.org.id, 'u1', o.id, o.draftHash!)
    await makulera(t, f.id)
    const mak = (await makJe(t, f.id))!
    expect(mak.description).toBe('Makulerad leverantörsfaktura: Bygg & Co AB — Reparation')
    const r = await t.exports.dryRun(t.org.id, mak.id)
    expect([r.state, r.blockReason]).toEqual(['DRY_RUN_READY', null])
    expect((await t.sender.send(t.org.id, 'u1', r.id, r.draftHash!)).state).toBe('CONFIRMED')
    expect(t.ledger.vouchers).toHaveLength(2)
    const v = t.ledger.vouchers[1]!
    expect(radlista(v)).toEqual([
      [2440, 12500, 0],
      [5170, 0, 12500],
    ])
    expect(v.Description).toBe('Makulerad leverantörsfaktura: Bygg & Co AB – Reparation')
    expect(String(v.Comments)).toContain(`Eveno JournalEntry ${mak.id}`)
    expect(saldoPerKonto(t)).toEqual({ 2440: 0, 5170: 0 })
    // L3.4: upprepad makulering → ingen ny post, inget nytt verifikat.
    await expect(makulera(t, f.id)).rejects.toThrow()
    expect(
      await prisma.journalEntry.count({
        where: { organizationId: t.org.id, sourceId: `supplier-invoice-cancel:${f.id}` },
      }),
    ).toBe(1)
  })

  it('P2-027 L3.2 / V-8(4): original CONFIRMED, mappningen ändras (ny revision 5170→5460), sedan makulering → omvänd post på 5170 med originalets revision i proveniensen', async () => {
    const t = await setup()
    const { f, je } = await levFaktura(t)
    const o = await t.exports.dryRun(t.org.id, je.id)
    await t.sender.send(t.org.id, 'u1', o.id, o.draftHash!)
    t.ledger.accounts.push({
      Number: 5460,
      Active: true,
      Description: 'Förbrukningsmaterial',
      VATCode: null,
    })
    await godkannMappning(prisma, t.connections, t.reader, t.org.id, [
      {
        role: 'KOSTNAD',
        vatTreatment: 'EJ_TILLAMPLIG',
        sourceAccountNumber: 5170,
        targetAccountNumber: 5460,
      },
      {
        role: 'LEVERANTORSSKULD',
        vatTreatment: 'EJ_TILLAMPLIG',
        sourceAccountNumber: 2440,
        targetAccountNumber: 2440,
      },
    ])
    await makulera(t, f.id)
    const mak = (await makJe(t, f.id))!
    const r = await t.exports.dryRun(t.org.id, mak.id)
    expect([r.state, r.blockReason]).toEqual(['DRY_RUN_READY', null])
    await t.sender.send(t.org.id, 'u1', r.id, r.draftHash!)
    expect(radlista(t.ledger.vouchers.at(-1)!)).toEqual([
      [2440, 12500, 0],
      [5170, 0, 12500],
    ])
    const d = (await t.dbRow(r.id)).draft as { kontomappning: Record<string, unknown> }
    const origRad = await t.dbRow(o.id)
    expect(d.kontomappning).toEqual(
      expect.objectContaining({
        revision: (origRad.draft as { kontomappning: { revision: number } }).kontomappning.revision,
        kalla: 'ORIGINALETS_EXPORT',
        originalExportId: o.id,
        originalJournalEntryId: je.id,
        originalFortnoxNyckel: `${origRad.externalYear}|${origRad.externalSeries}|${origRad.externalNumber}`,
      }),
    )
    // En NY leverantörsfaktura går på dagens mappning (5460) — rättelsen är inte omkonterad.
    const ny = await levFaktura(t, 50)
    const n = await t.exports.dryRun(t.org.id, ny.je.id)
    await t.sender.send(t.org.id, 'u1', n.id, n.draftHash!)
    expect(radlista(t.ledger.vouchers.at(-1)!)).toEqual([
      [2440, 0, 5000],
      [5460, 5000, 0],
    ])
  })

  it('P2-027 L3.3 / V-7(b,c) / V-8(1): makulering FÖRE send → originalets READY blir BLOCKED i makuleringens transaktion; gammalt hash 409, 0 POST; makuleringen och originalet stoppas', async () => {
    const t = await setup()
    const { f, je } = await levFaktura(t)
    const o = await t.exports.dryRun(t.org.id, je.id)
    expect(o.state).toBe('DRY_RUN_READY')
    await makulera(t, f.id)
    const rad = await t.dbRow(o.id)
    expect([rad.state, rad.draftHash, (rad.blockReason ?? '').split(':')[0]]).toEqual([
      'BLOCKED',
      null,
      'REVERSED_BEFORE_EXPORT',
    ])
    await expect(t.sender.send(t.org.id, 'u1', o.id, o.draftHash!)).rejects.toThrow()
    expect((await t.exports.dryRun(t.org.id, je.id)).blockReason).toMatch(/^REVERSED_BEFORE_EXPORT/)
    const mak = (await makJe(t, f.id))!
    expect((await t.exports.dryRun(t.org.id, mak.id)).blockReason).toMatch(
      /^ORIGIN_NOT_CONFIRMED: Leverantörsfakturan är inte exporterad/,
    )
    expect(posts(t)).toBe(0)
  })

  it.each(['makulering', 'rättelse'] as const)(
    'P2-027 V-8(2) %s injicerad MELLAN send():s färska build och anspråket → anspråket misslyckas, raden BLOCKED, 0 POST',
    async (vag) => {
      const t = await setup()
      const { f, je } = await levFaktura(t)
      const o = await t.exports.dryRun(t.org.id, je.id)
      // TESTKUND-041 (B-7b/MK-2): en GENERELL rättelse av leverantörsfakturans verifikat är nu
      // spärrad i tjänsten (409, ingen effekt). Varianten «rättelse» mäter därför spärren: inget
      // injiceras, och originalet går ut som vanligt (1 POST).
      let spärrad: unknown = null
      t.setAfterBuild(async () => {
        t.setAfterBuild(null)
        if (vag === 'makulering') await makulera(t, f.id)
        else
          spärrad = await tjanster()
            .acc.reverseJournalEntry({
              entryId: je.id,
              organizationId: t.org.id,
              actorRole: 'OWNER',
              actorUserId: await uid(t.org.id),
              reason: 'Fel leverantör angavs',
            })
            .catch((e: unknown) => e)
      })
      if (vag === 'makulering') {
        await expect(t.sender.send(t.org.id, 'u1', o.id, o.draftHash!)).rejects.toThrow()
        expect((await t.dbRow(o.id)).state).toBe('BLOCKED')
        expect(posts(t)).toBe(0)
      } else {
        const res = await t.sender.send(t.org.id, 'u1', o.id, o.draftHash!)
        expect(spärrad).toBeInstanceOf(ConflictException)
        expect(String((spärrad as Error).message)).toMatch(/kan inte rättas här/)
        expect(
          await prisma.journalEntry.count({
            where: { organizationId: t.org.id, reversalOfEntryId: je.id },
          }),
        ).toBe(0)
        expect([res.state, posts(t)]).toEqual(['CONFIRMED', 1])
      }
    },
  )

  it.each([
    ['makulering', 'ok'],
    ['rättelse', 'ok'],
    ['makulering', 'okänt'],
    ['rättelse', 'okänt'],
  ] as const)(
    'P2-027 V-8(3) %s medan originalet är SENDING (%s utfall) → originalet går ut EN gång; rättelsen väntar och blir READY med exakt 1 POST bara efter CONFIRMED',
    async (vag, utfall) => {
      const t = await setup()
      const { f, je } = await levFaktura(t)
      const o = await t.exports.dryRun(t.org.id, je.id)
      if (utfall === 'okänt') t.api.faults.push('drop_response_after_write')
      // TESTKUND-041 (B-7b/MK-2): «rättelse» = generell rättelse, som nu ger 409 utan effekt.
      let spärrad: unknown = null
      t.api.beforeWrite = async () => {
        t.api.beforeWrite = null
        expect((await t.dbRow(o.id)).state).toBe('SENDING')
        if (vag === 'makulering') await makulera(t, f.id)
        else
          spärrad = await tjanster()
            .acc.reverseJournalEntry({
              entryId: je.id,
              organizationId: t.org.id,
              actorRole: 'OWNER',
              actorUserId: await uid(t.org.id),
              reason: 'Fel leverantör angavs',
            })
            .catch((e: unknown) => e)
      }
      const res = await t.sender.send(t.org.id, 'u1', o.id, o.draftHash!)
      expect(posts(t)).toBe(1)
      if (vag === 'rättelse') {
        expect(spärrad).toBeInstanceOf(ConflictException)
        expect(
          await prisma.journalEntry.count({
            where: { organizationId: t.org.id, reversalOfEntryId: je.id },
          }),
        ).toBe(0)
        expect(res.state).toBe(utfall === 'okänt' ? 'UNKNOWN' : 'CONFIRMED')
        return
      }
      const rattelse =
        vag === 'makulering'
          ? (await makJe(t, f.id))!
          : await prisma.journalEntry.findFirstOrThrow({
              where: { organizationId: t.org.id, reversalOfEntryId: je.id },
            })
      const r = await t.exports.dryRun(t.org.id, rattelse.id)
      if (utfall === 'okänt') {
        expect(res.state).toBe('UNKNOWN')
        expect(r.state).toBe('BLOCKED')
        expect(r.blockReason).toMatch(/okänt\/pågår/)
        expect(r.blockReason).not.toMatch(/inte exporterad/)
        expect(posts(t)).toBe(1)
      } else {
        expect(res.state).toBe('CONFIRMED')
        expect([r.state, r.blockReason]).toEqual(['DRY_RUN_READY', null])
        await t.sender.send(t.org.id, 'u1', r.id, r.draftHash!)
        expect(posts(t)).toBe(2)
        expect(saldoPerKonto(t)).toEqual({ 2440: 0, 5170: 0 })
      }
    },
  )

  // V-9: äkta överlappande transaktioner. Ett yttre radlås på fakturan hålls medan BÅDA anropen passerat
  // sin olåsta förkontroll och köat på radlåset (mätt i pg_stat_activity, ingen sleep). Släpps låset vinner
  // den som köade först; den andra får count 0 → 409 och ingen bokning.
  const vantaPaLasKo = async (antal: number) => {
    for (let i = 0; i < 2000; i++) {
      const r = await prisma.$queryRaw<
        Array<{ n: bigint }>
      >`SELECT count(*)::bigint AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
      if (Number(r[0]!.n) >= antal) return
      await new Promise((res) => setImmediate(res))
    }
    throw new Error(`väntade på ${antal} låsväntare`)
  }
  it.each(['makulering först', 'betalning först'] as const)(
    'P2-027 V-9 överlappande makulering och betalning (%s köar först) → exakt ett utfall; den andra 409 utan bokning; fakturan och huvudboken konsekventa',
    async (ordning) => {
      const t = await setup()
      const { f } = await levFaktura(t)
      const { lev } = tjanster()
      let slapp!: () => void
      const spärr = new Promise<void>((r) => (slapp = r))
      const yttre = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "SupplierInvoice" WHERE id = ${f.id} FOR UPDATE`
          await spärr
        },
        { timeout: 60000 },
      )
      const forstaVag = ordning === 'makulering först' ? 'makulering' : 'betalning'
      const u = await uid(t.org.id)
      const anrop = (vag: string) =>
        vag === 'makulering'
          ? lev.cancel({ organizationId: t.org.id, invoiceId: f.id, createdById: u })
          : lev.markPaid({
              organizationId: t.org.id,
              invoiceId: f.id,
              paidDate: new Date('2026-10-05'),
              createdById: u,
            })
      const forsta = anrop(forstaVag).then(
        (v) => ({ ok: true as const, v }),
        (e) => ({ ok: false as const, e }),
      )
      await vantaPaLasKo(1)
      const andra = anrop(forstaVag === 'makulering' ? 'betalning' : 'makulering').then(
        (v) => ({ ok: true as const, v }),
        (e) => ({ ok: false as const, e }),
      )
      await vantaPaLasKo(2)
      slapp()
      await yttre
      const [a, b] = await Promise.all([forsta, andra])
      expect([a.ok, b.ok, a.ok ? null : String((a as { e: Error }).e.message)]).toEqual([
        true,
        false,
        null,
      ])
      expect(b.ok === false && b.e.constructor.name).toBe('ConflictException')
      const fakt = await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: f.id } })
      const betJe = await prisma.journalEntry.count({
        where: { organizationId: t.org.id, sourceId: `supplier-invoice-payment:${f.id}` },
      })
      const makCount = await prisma.journalEntry.count({
        where: { organizationId: t.org.id, sourceId: `supplier-invoice-cancel:${f.id}` },
      })
      if (forstaVag === 'makulering')
        expect([!!fakt.cancelledAt, fakt.paidAt, makCount, betJe]).toEqual([true, null, 1, 0])
      else expect([fakt.cancelledAt, !!fakt.paidAt, makCount, betJe]).toEqual([null, true, 0, 1])
    },
  )
})
