/**
 * TESTKUND-20261004/041 (C1): moms v1 + BP1 genom den SKARPA vägen (SupplierInvoiceService →
 * AccountingService → FortnoxExportService/VerifiedVoucherDraftBuilder → FortnoxSendService med
 * RealFortnoxVoucherWriter + FortnoxTransport) mot riktig Postgres. Fortnox är den syntetiska
 * HTTP-ytan (FakeFortnoxApi) med en egen huvudbok; varje påstående om Fortnox mäts i den huvudboken
 * (rader i öre per konto), inte i produktens egna räknare. Inget nätverk.
 *
 * Facit: ACCEPTANS-041 A–E; öresfacit TILLAGG-KONTRAKT-033 §2 (MJ-4 v2, tre justeringar över tre
 * mappningar) och BP1-KONTRAKT-036 §6 (fall A exakt 4 verifikat, fall B exakt 2).
 */
import { randomUUID } from 'node:crypto'
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { PrismaClient } from '@prisma/client'
import type { PrismaService } from '../common/prisma/prisma.service'
import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { SupplierInvoiceService } from '../accounting/supplier-invoice.service'
import { FortnoxConnectionService } from './fortnox-connection.service'
import { FortnoxExportService, type FortnoxVoucherDraftBuilder } from './fortnox-export.service'
import { FortnoxTokenCryptoService } from './fortnox-token-crypto.service'
import { MockFortnoxAuthProvider, MockFortnoxLedgerReader } from './fortnox-providers'
import { VerifiedVoucherDraftBuilder } from './fortnox-export-builder'
import { godkannMappning, stadaKontomappning } from './fortnox-kontomappning.testing'

// Riktiga Postgres-transaktioner och lås: ett prov får ta längre tid än jests standard på 5 s.
jest.setTimeout(120_000)
import { FortnoxSendService } from './fortnox-send.service'
import { RealFortnoxVoucherWriter } from './fortnox-voucher-writer'
import { RealFortnoxLedgerReader } from './fortnox-real-provider'
import { FortnoxTransport } from './provider/fortnox-transport'
import { FakeFortnoxApi, noopRateLimiter } from './fortnox-fake-api.testing'
import type { FortnoxAccountMappingRowInput } from '@eken/shared'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip
const KEY = 'cd'.repeat(32)
const TEST_COMPANY = 1868238

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => expect(HAR_DB).toBe(true))
})

/** Mappningar enligt 033 §2 (Eveno 5070, 2641, 2440, 1930). */
const R = (kostnad: number, moms: number): FortnoxAccountMappingRowInput[] => [
  {
    role: 'KOSTNAD',
    vatTreatment: 'EJ_TILLAMPLIG',
    sourceAccountNumber: 5070,
    targetAccountNumber: kostnad,
  },
  {
    role: 'INGAENDE_MOMS',
    vatTreatment: 'AVDRAGSGILL',
    sourceAccountNumber: 2641,
    targetAccountNumber: moms,
  },
  {
    role: 'LEVERANTORSSKULD',
    vatTreatment: 'EJ_TILLAMPLIG',
    sourceAccountNumber: 2440,
    targetAccountNumber: 2440,
  },
  {
    role: 'LIKVID',
    vatTreatment: 'EJ_TILLAMPLIG',
    sourceAccountNumber: 1930,
    targetAccountNumber: 1930,
  },
]

medDb('TESTKUND-041: moms v1 + BP1 genom skarp export mot syntetisk Fortnox', () => {
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
      await prisma.supplierInvoiceVatAdjustment.deleteMany({ where: { organizationId: id } })
      await prisma.expenseVatDecision.deleteMany({ where: { organizationId: id } })
      await prisma.journalEntryLine.deleteMany({ where: { journalEntry: { organizationId: id } } })
      await prisma.journalEntry.updateMany({
        where: { organizationId: id },
        data: { reversalOfEntryId: null },
      })
      await prisma.journalEntry.deleteMany({ where: { organizationId: id } })
      await stadaKontomappning(prisma, id)
      await prisma.user.deleteMany({ where: { organizationId: id } })
      await prisma.journalEntrySequence.deleteMany({ where: { organizationId: id } })
      await prisma.account.deleteMany({ where: { organizationId: id } })
      await prisma.organization.delete({ where: { id } }).catch(() => undefined)
    }
    await prisma.$disconnect()
  })

  async function setup() {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `moms-${sfx}`,
        email: `moms-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '1',
      },
    })
    orgs.push(org.id)
    const user = await prisma.user.create({
      data: {
        organizationId: org.id,
        email: `moms-${sfx}@example.invalid`,
        firstName: 'Moms',
        lastName: 'Prov',
        role: 'OWNER',
        passwordHash: 'ej-inloggningsbar',
      },
    })
    const env: Record<string, string> = { FORTNOX_TOKEN_KEY: KEY }
    const config = { get: (k: string) => env[k] } as unknown as ConfigService
    const crypto = new FortnoxTokenCryptoService(config)
    const ledger = new MockFortnoxLedgerReader()
    ledger.company = {
      CompanyName: 'Eveno integrationstest 2026-10-02',
      OrganizationNumber: '555555-5555',
      DatabaseNumber: TEST_COMPANY,
    }
    ledger.accounts = [
      { Number: 1930, Active: true, Description: 'Företagskonto', VATCode: null },
      { Number: 2440, Active: true, Description: 'Leverantörsskulder', VATCode: null },
      { Number: 2640, Active: true, Description: 'Ingående moms', VATCode: 'I' },
      { Number: 2641, Active: true, Description: 'Debiterad ingående moms', VATCode: 'I' },
      {
        Number: 5170,
        Active: true,
        Description: 'Reparation och underhåll av fastighet',
        VATCode: null,
      },
      { Number: 5460, Active: true, Description: 'Förbrukningsmaterial', VATCode: null },
      { Number: 6000, Active: true, Description: 'Övriga försäljningskostnader', VATCode: null },
    ]
    const api = new FakeFortnoxApi(ledger)
    const fetch = api.fetch as unknown as typeof globalThis.fetch
    const reader = new RealFortnoxLedgerReader({
      transport: new FortnoxTransport({ fetch, rateLimiter: noopRateLimiter }),
      clientId: 'syntetiskt-klient-id',
      enabled: true,
    })
    const writer = new RealFortnoxVoucherWriter({
      transport: new FortnoxTransport({
        fetch,
        rateLimiter: noopRateLimiter,
        allowVoucherWrites: true,
      }),
      reader,
      clientId: 'syntetiskt-klient-id',
    })
    const db = prisma as unknown as PrismaService
    const connections = new FortnoxConnectionService(
      db,
      crypto,
      config,
      new MockFortnoxAuthProvider(),
      reader,
    )
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
    const acc = new AccountingService(db, new VerifikationsnummerService(db))
    const lev = new SupplierInvoiceService(db, acc)
    const mappa = (kostnad: number, moms: number) =>
      godkannMappning(prisma, connections, reader, org.id, R(kostnad, moms))
    await mappa(5170, 2641) // R1
    return {
      org,
      user,
      api,
      ledger,
      exports,
      sender,
      acc,
      lev,
      mappa,
      agare: { sub: user.id, role: 'OWNER' },
      setAfterBuild: (f: (() => Promise<void>) | null) => (afterBuild = f),
    }
  }
  type T = Awaited<ReturnType<typeof setup>>

  const faktura = async (
    t: T,
    o: {
      val: 'INGEN_MOMS' | 'HELT_AVDRAG' | 'INGET_AVDRAG' | null
      brutto?: number
      datum?: string
    },
  ) => {
    const f = await t.lev.create({
      organizationId: t.org.id,
      createdById: t.user.id,
      supplierName: 'Bygg & Co AB',
      description: 'Reparation',
      invoiceDate: new Date(o.datum ?? '2026-08-10'),
      dueDate: new Date('2026-10-30'),
      expenseAccount: 5070,
      totalAmount: o.brutto ?? 1250,
      vatRate: o.val === 'INGEN_MOMS' ? 0 : 25,
      vatTreatment: o.val,
      vatTreatmentSource: 'PROV',
    })
    const je = await prisma.journalEntry.findFirstOrThrow({
      where: { organizationId: t.org.id, sourceId: `supplier-invoice:${f.id}` },
      include: { lines: { include: { account: true } } },
    })
    return { f, je }
  }
  const jeFor = (t: T, sourceId: string) =>
    prisma.journalEntry.findFirstOrThrow({ where: { organizationId: t.org.id, sourceId } })
  const skicka = async (t: T, jeId: string) => {
    const d = await t.exports.dryRun(t.org.id, jeId)
    if (d.state !== 'DRY_RUN_READY') return d
    return t.sender.send(t.org.id, 'u1', d.id, (d as { draftHash: string }).draftHash)
  }
  const evenoRader = async (jeId: string) =>
    (
      await prisma.journalEntryLine.findMany({
        where: { journalEntryId: jeId },
        include: { account: true },
      })
    )
      .map((l) => [
        l.account.number,
        Math.round(Number(l.debit ?? 0) * 100),
        Math.round(Number(l.credit ?? 0) * 100),
      ])
      .sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!)
  const fortnoxRader = (t: T, jeId: string) => {
    const v = t.ledger.vouchers.filter((x) =>
      String(x.Comments ?? '').includes(`Eveno JournalEntry ${jeId};`),
    )
    expect(v).toHaveLength(1)
    return (v[0]!.VoucherRows as Array<{ Account: number; Debit: number; Credit: number }>)
      .map((r) => [r.Account, Math.round(r.Debit * 100), Math.round(r.Credit * 100)])
      .sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!)
  }
  const saldo = (t: T) => {
    const ut: Record<number, number> = {}
    for (const v of t.ledger.vouchers)
      for (const r of v.VoucherRows as Array<{ Account: number; Debit: number; Credit: number }>)
        ut[r.Account] =
          (ut[r.Account] ?? 0) + Math.round(r.Debit * 100) - Math.round(r.Credit * 100)
    for (const k of Object.keys(ut)) if (ut[Number(k)] === 0) delete ut[Number(k)]
    return ut
  }
  const posts = (t: T) => t.api.requests.filter((r) => r.method === 'POST').length
  let nyckel = 0
  const just = (
    t: T,
    f: { id: string },
    till: 'HELT_AVDRAG' | 'INGET_AVDRAG',
    datum: string,
    extra: Partial<{ clientKey: string; reason: string; user: { sub: string; role: string } }> = {},
  ) =>
    t.lev.adjustVat({
      organizationId: t.org.id,
      invoiceId: f.id,
      user: extra.user ?? t.agare,
      till,
      date: new Date(datum),
      reason: extra.reason ?? 'Fel momsval vid registreringen',
      clientKey: extra.clientKey ?? `prov-${++nyckel}-${randomUUID().slice(0, 8)}`,
    })
  const betala = (t: T, f: { id: string }, datum: string) =>
    t.lev.markPaid({
      organizationId: t.org.id,
      invoiceId: f.id,
      paidDate: new Date(datum),
      createdById: t.user.id,
    })
  const angra = (
    t: T,
    f: { id: string },
    je: string,
    reason = 'Fel betalningsdatum registrerades',
  ) =>
    t.lev.undoPayment({
      organizationId: t.org.id,
      invoiceId: f.id,
      paymentJournalEntryId: je,
      user: t.agare,
      reason,
    })

  // ── A: momsval och radfacit ───────────────────────────────────────────────────────────────

  it('A3: tre fakturor (Ingen moms / dras av / dras inte av) → exakt rader i Eveno och i Fortnox (öre); netto/moms/brutto och valet bevarade', async () => {
    const t = await setup()
    const ingen = await faktura(t, { val: 'INGEN_MOMS', brutto: 1000 })
    const helt = await faktura(t, { val: 'HELT_AVDRAG' })
    const inget = await faktura(t, { val: 'INGET_AVDRAG' })
    expect(await evenoRader(ingen.je.id)).toEqual([
      [2440, 0, 100000],
      [5070, 100000, 0],
    ])
    expect(await evenoRader(helt.je.id)).toEqual([
      [2440, 0, 125000],
      [2641, 25000, 0],
      [5070, 100000, 0],
    ])
    expect(await evenoRader(inget.je.id)).toEqual([
      [2440, 0, 125000],
      [5070, 125000, 0],
    ])
    const rad = await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: inget.f.id } })
    expect([
      Number(rad.netAmount),
      Number(rad.vatAmount),
      Number(rad.totalAmount),
      rad.vatTreatment,
      rad.vatTreatmentCurrent,
      rad.vatTreatmentDecidedById,
    ]).toEqual([1000, 250, 1250, 'INGET_AVDRAG', 'INGET_AVDRAG', t.user.id])
    for (const x of [ingen, helt, inget]) expect((await skicka(t, x.je.id)).state).toBe('CONFIRMED')
    expect(fortnoxRader(t, ingen.je.id)).toEqual([
      [2440, 0, 100000],
      [5170, 100000, 0],
    ])
    expect(fortnoxRader(t, helt.je.id)).toEqual([
      [2440, 0, 125000],
      [2641, 25000, 0],
      [5170, 100000, 0],
    ])
    expect(fortnoxRader(t, inget.je.id)).toEqual([
      [2440, 0, 125000],
      [5170, 125000, 0],
    ])
    // B-4: momsrapporten tar bara med «dras av»; källan och beslutet syns.
    const vr = await t.acc.getVatReport(t.org.id, '2026-08-01', '2026-08-31')
    expect(vr.incoming.total).toBe(250)
    expect(vr.incoming.sources).toEqual([
      expect.objectContaining({
        kalla: 'LEVERANTORSFAKTURA',
        belopp: 250,
        momsval: 'HELT_AVDRAG',
        beslutadAv: t.user.id,
      }),
    ])
  })

  it('A2: positiv moms utan val, okänt val, Ingen moms med moms, avdrag med moms 0 → 400 och ingen effekt', async () => {
    const t = await setup()
    const fore = [
      await prisma.supplierInvoice.count({ where: { organizationId: t.org.id } }),
      await prisma.journalEntry.count({ where: { organizationId: t.org.id } }),
    ]
    const forsok = (val: unknown, vatRate: number) =>
      t.lev.create({
        organizationId: t.org.id,
        createdById: t.user.id,
        supplierName: 'X AB',
        description: 'Prov',
        invoiceDate: new Date('2026-08-10'),
        dueDate: new Date('2026-08-30'),
        expenseAccount: 5070,
        totalAmount: 1250,
        vatRate,
        vatTreatment: val as never,
      })
    for (const [val, sats] of [
      [null, 25],
      ['DELVIS', 25],
      ['INGEN_MOMS', 25],
      ['HELT_AVDRAG', 0],
      ['INGET_AVDRAG', 0],
    ] as const)
      await expect(forsok(val, sats)).rejects.toBeInstanceOf(BadRequestException)
    expect([
      await prisma.supplierInvoice.count({ where: { organizationId: t.org.id } }),
      await prisma.journalEntry.count({ where: { organizationId: t.org.id } }),
    ]).toEqual(fore)
  })

  it('A6/MJ-B1: äldre faktura med moms utan sparat val → export VAT_TREATMENT_MISSING före POST; justering 409; inget skrivs om', async () => {
    const t = await setup()
    const { f, je } = await faktura(t, { val: 'HELT_AVDRAG' })
    // Som en rad från före 041: valet saknas (ingen backfill).
    await prisma.supplierInvoice.update({
      where: { id: f.id },
      data: {
        vatTreatment: null,
        vatTreatmentCurrent: null,
        vatTreatmentDecidedById: null,
        vatTreatmentDecidedAt: null,
        vatTreatmentDecisionSource: null,
      },
    })
    const r = await t.exports.dryRun(t.org.id, je.id)
    expect([r.state, (r.blockReason ?? '').split(':')[0]]).toEqual([
      'BLOCKED',
      'VAT_TREATMENT_MISSING',
    ])
    expect(r.blockReason).toMatch(/ingen avdragsrätt antas/)
    await expect(just(t, f, 'INGET_AVDRAG', '2026-08-20')).rejects.toThrow(/saknar sparat momsval/)
    expect(posts(t)).toBe(0)
    expect(await evenoRader(je.id)).toEqual([
      [2440, 0, 125000],
      [2641, 25000, 0],
      [5070, 100000, 0],
    ])
    const vr = await t.acc.getVatReport(t.org.id, '2026-08-01', '2026-08-31')
    expect(vr.incoming.sources?.[0]).toMatchObject({
      kalla: 'LEVERANTORSFAKTURA',
      momsval: null,
      text: 'Momsbehandling ej angiven (äldre, bokförd som avdragsgill)',
    })
  })

  // ── C: momsjustering, öresfacit 033 §2 ───────────────────────────────────────────────────

  it('C4/MJ-4 v2 (033 §2): original INGET, betalt, J1/J2/J3 över mappningarna R1→R2→R3 → varje led på frysta mål; saldon exakt; fel-variantens konton förekommer aldrig', async () => {
    const t = await setup()
    const { f, je } = await faktura(t, { val: 'INGET_AVDRAG', datum: '2026-08-10' })
    expect((await skicka(t, je.id)).state).toBe('CONFIRMED')
    expect(fortnoxRader(t, je.id)).toEqual([
      [2440, 0, 125000],
      [5170, 125000, 0],
    ])
    await betala(t, f, '2026-08-15')
    const bet = await jeFor(t, `supplier-invoice-payment:${f.id}`)
    expect((await skicka(t, bet.id)).state).toBe('CONFIRMED')
    expect(fortnoxRader(t, bet.id)).toEqual([
      [1930, 0, 125000],
      [2440, 125000, 0],
    ])

    await t.mappa(5460, 2641) // R2
    const j1 = await just(t, f, 'HELT_AVDRAG', '2026-08-20')
    expect(j1.adjustment).toMatchObject({
      seq: 1,
      fran: 'INGET_AVDRAG',
      till: 'HELT_AVDRAG',
      kostnadMal: 5170,
      momsMal: 2641,
      momsMalInfortAv: 1,
    })
    expect(await evenoRader(j1.journalEntryId)).toEqual([
      [2641, 25000, 0],
      [5070, 0, 25000],
    ])
    expect((await skicka(t, j1.journalEntryId)).state).toBe('CONFIRMED')
    expect(fortnoxRader(t, j1.journalEntryId)).toEqual([
      [2641, 25000, 0],
      [5170, 0, 25000],
    ])

    await t.mappa(6000, 2640) // R3
    const j2 = await just(t, f, 'INGET_AVDRAG', '2026-09-05')
    expect(j2.adjustment).toMatchObject({
      seq: 2,
      kostnadMal: 5170,
      momsMal: 2641,
      momsMalInfortAv: 1,
    })
    expect((await skicka(t, j2.journalEntryId)).state).toBe('CONFIRMED')
    expect(fortnoxRader(t, j2.journalEntryId)).toEqual([
      [2641, 0, 25000],
      [5170, 25000, 0],
    ])
    const j3 = await just(t, f, 'HELT_AVDRAG', '2026-10-03')
    expect((await skicka(t, j3.journalEntryId)).state).toBe('CONFIRMED')
    expect(fortnoxRader(t, j3.journalEntryId)).toEqual([
      [2641, 25000, 0],
      [5170, 0, 25000],
    ])

    // Saldon efter J3 (033 §2): kostnad 100 000, moms 25 000, 2440 0, bank −125 000.
    expect(saldo(t)).toEqual({ 1930: -125000, 2641: 25000, 5170: 100000 })
    for (const fel of [5460, 6000, 2640]) expect(saldo(t)[fel]).toBeUndefined()
    // Varje led har en egen export; ingen tidigare export skrevs om.
    expect(
      await prisma.fortnoxVoucherExport.count({
        where: { organizationId: t.org.id, state: 'CONFIRMED' },
      }),
    ).toBe(5)
    // MJ-9: justeringen i justeringsdatumets period, ursprunget orört.
    const aug = await t.acc.getVatReport(t.org.id, '2026-08-01', '2026-08-31')
    const sep = await t.acc.getVatReport(t.org.id, '2026-09-01', '2026-09-30')
    const okt = await t.acc.getVatReport(t.org.id, '2026-10-01', '2026-10-31')
    expect([aug.incoming.total, sep.incoming.total, okt.incoming.total]).toEqual([250, -250, 250])
    expect(aug.incoming.sources?.map((s) => s.kalla)).toEqual(['MOMSJUSTERING'])
    const vy = await t.lev.details(f.id, t.org.id)
    expect(vy.justeringar.map((j) => [j.seq, j.fran, j.till, j.exportStatus])).toEqual([
      [1, 'INGET_AVDRAG', 'HELT_AVDRAG', 'CONFIRMED'],
      [2, 'HELT_AVDRAG', 'INGET_AVDRAG', 'CONFIRMED'],
      [3, 'INGET_AVDRAG', 'HELT_AVDRAG', 'CONFIRMED'],
    ])
    expect([vy.vatTreatment, vy.vatTreatmentCurrent]).toEqual(['INGET_AVDRAG', 'HELT_AVDRAG'])
  })

  it('C4: original HELT → J1 HELT→INGET bokas på originalets 2641-mål även efter ett mappningsbyte till 2640', async () => {
    const t = await setup()
    const { f, je } = await faktura(t, { val: 'HELT_AVDRAG' })
    expect((await skicka(t, je.id)).state).toBe('CONFIRMED')
    await t.mappa(6000, 2640)
    const j1 = await just(t, f, 'INGET_AVDRAG', '2026-08-20')
    expect(j1.adjustment).toMatchObject({ kostnadMal: 5170, momsMal: 2641, momsMalInfortAv: 0 })
    expect((await skicka(t, j1.journalEntryId)).state).toBe('CONFIRMED')
    expect(fortnoxRader(t, j1.journalEntryId)).toEqual([
      [2641, 0, 25000],
      [5170, 25000, 0],
    ])
    expect(saldo(t)).toEqual({ 2440: -125000, 5170: 125000 })
  })

  it('C3/C6: originalet inte exporterat → 409; föregående led ej exporterat/okänt → nästa led BLOCKED med rätt skäl; gammalt READY fälls färskt', async () => {
    const t = await setup()
    const { f, je } = await faktura(t, { val: 'HELT_AVDRAG' })
    await expect(just(t, f, 'INGET_AVDRAG', '2026-08-20')).rejects.toThrow(
      /inte exporterad|bekräftat/,
    )
    expect((await skicka(t, je.id)).state).toBe('CONFIRMED')
    const j1 = await just(t, f, 'INGET_AVDRAG', '2026-08-20')
    const r1 = await t.exports.dryRun(t.org.id, j1.journalEntryId)
    expect(r1.state).toBe('DRY_RUN_READY')
    const j2 = await just(t, f, 'HELT_AVDRAG', '2026-08-21')
    const r2 = await t.exports.dryRun(t.org.id, j2.journalEntryId)
    expect([r2.state, r2.blockReason]).toEqual([
      'BLOCKED',
      expect.stringMatching(
        /^ORIGIN_NOT_CONFIRMED: Föregående momsjustering \(led 1\) är inte exporterad/,
      ),
    ])
    // J1 får okänt utfall → J2 «okänt — stäm av först», aldrig «inte exporterad».
    t.api.faults.push('drop_response_after_write')
    expect(
      (await t.sender.send(t.org.id, 'u1', r1.id, (r1 as { draftHash: string }).draftHash)).state,
    ).toBe('UNKNOWN')
    const r2b = await t.exports.dryRun(t.org.id, j2.journalEntryId)
    expect(r2b.blockReason).toMatch(/led 1\) utfall är okänt — stäm av först/)
    expect(posts(t)).toBe(2)
  })

  it('C7: samma clientKey → samma justering; annat innehåll med samma nyckel → 409; fel gällande val → 409; roll VIEWER → 403', async () => {
    const t = await setup()
    const { f, je } = await faktura(t, { val: 'HELT_AVDRAG' })
    await skicka(t, je.id)
    const a = await just(t, f, 'INGET_AVDRAG', '2026-08-20', { clientKey: 'nyckel-ett-12345' })
    const b = await just(t, f, 'INGET_AVDRAG', '2026-08-20', { clientKey: 'nyckel-ett-12345' })
    expect([b.upprepad, b.adjustment.id, b.journalEntryId]).toEqual([
      true,
      a.adjustment.id,
      a.journalEntryId,
    ])
    await expect(
      just(t, f, 'INGET_AVDRAG', '2026-08-20', {
        clientKey: 'nyckel-ett-12345',
        reason: 'Annat skäl här',
      }),
    ).rejects.toThrow(/annan justering/)
    await expect(just(t, f, 'INGET_AVDRAG', '2026-08-21')).rejects.toThrow(/redan/)
    await expect(
      just(t, f, 'HELT_AVDRAG', '2026-08-21', { user: { sub: t.user.id, role: 'VIEWER' } }),
    ).rejects.toThrow(/behörighet/)
    expect(
      await prisma.supplierInvoiceVatAdjustment.count({ where: { supplierInvoiceId: f.id } }),
    ).toBe(1)
  })

  it('C2/033 §4: en manipulerad justering med en 2440-rad exporteras aldrig (EVENT_UNSUPPORTED)', async () => {
    const t = await setup()
    const { f, je } = await faktura(t, { val: 'HELT_AVDRAG' })
    await skicka(t, je.id)
    const j1 = await just(t, f, 'INGET_AVDRAG', '2026-08-20')
    const skuld = await prisma.account.findFirstOrThrow({
      where: { organizationId: t.org.id, number: 2440 },
    })
    const momsrad = await prisma.journalEntryLine.findFirstOrThrow({
      where: { journalEntryId: j1.journalEntryId, account: { number: 2641 } },
    })
    await prisma.journalEntryLine.update({
      where: { id: momsrad.id },
      data: { accountId: skuld.id },
    })
    const r = await t.exports.dryRun(t.org.id, j1.journalEntryId)
    expect([r.state, (r.blockReason ?? '').split(':')[0]]).toEqual(['BLOCKED', 'EVENT_UNSUPPORTED'])
    expect(posts(t)).toBe(1)
  })

  // ── D: makulering (MK1-036) och generell rättelse (MK-2/B-7b) ─────────────────────────────

  it('D1: original INGET + J1 + J2 CONFIRMED → makulering tillåten; Fortnox 5170 0, 2641 0, 2440 0 med exakt 4 egna poster', async () => {
    const t = await setup()
    const { f, je } = await faktura(t, { val: 'INGET_AVDRAG' })
    await skicka(t, je.id)
    const j1 = await just(t, f, 'HELT_AVDRAG', '2026-08-20')
    await skicka(t, j1.journalEntryId)
    const j2 = await just(t, f, 'INGET_AVDRAG', '2026-08-21')
    await skicka(t, j2.journalEntryId)
    await t.lev.cancel({ organizationId: t.org.id, invoiceId: f.id, createdById: t.user.id })
    const mak = await jeFor(t, `supplier-invoice-cancel:${f.id}`)
    expect((await skicka(t, mak.id)).state).toBe('CONFIRMED')
    expect(t.ledger.vouchers).toHaveLength(4)
    expect(saldo(t)).toEqual({})
  })

  it.each(['bara J1 CONFIRMED (gällande ≠ ursprung)', 'J2 DRY_RUN_READY', 'J2 UNKNOWN'] as const)(
    'D1 (MK1-036): %s → makulering 409 före effekt',
    async (fall) => {
      const t = await setup()
      const { f, je } = await faktura(t, { val: 'INGET_AVDRAG' })
      await skicka(t, je.id)
      const j1 = await just(t, f, 'HELT_AVDRAG', '2026-08-20')
      await skicka(t, j1.journalEntryId)
      if (fall !== 'bara J1 CONFIRMED (gällande ≠ ursprung)') {
        const j2 = await just(t, f, 'INGET_AVDRAG', '2026-08-21')
        if (fall === 'J2 UNKNOWN') t.api.faults.push('drop_response_after_write')
        const r = await t.exports.dryRun(t.org.id, j2.journalEntryId)
        if (fall === 'J2 UNKNOWN')
          await t.sender.send(t.org.id, 'u1', r.id, (r as { draftHash: string }).draftHash)
      }
      const fore = await prisma.journalEntry.count({ where: { organizationId: t.org.id } })
      await expect(
        t.lev.cancel({ organizationId: t.org.id, invoiceId: f.id, createdById: t.user.id }),
      ).rejects.toBeInstanceOf(ConflictException)
      expect(await prisma.journalEntry.count({ where: { organizationId: t.org.id } })).toBe(fore)
      expect(
        (await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: f.id } })).cancelledAt,
      ).toBeNull()
    },
  )

  it('D5 (MK-2/B-7b): generell rättelse av mottagning, justering, makulering, betalning och betalningsångring → 409 med kundväg; ingen effekt', async () => {
    const t = await setup()
    const { f, je } = await faktura(t, { val: 'HELT_AVDRAG' })
    await skicka(t, je.id)
    const j1 = await just(t, f, 'INGET_AVDRAG', '2026-08-20')
    await betala(t, f, '2026-08-15')
    const bet = await jeFor(t, `supplier-invoice-payment:${f.id}`)
    await angra(t, f, bet.id)
    const undo = await jeFor(t, `supplier-invoice-payment-undo:${bet.id}`)
    const andra = await faktura(t, { val: 'INGEN_MOMS', brutto: 500 })
    await t.lev.cancel({ organizationId: t.org.id, invoiceId: andra.f.id, createdById: t.user.id })
    const mak = await jeFor(t, `supplier-invoice-cancel:${andra.f.id}`)
    const fall: Array<[string, RegExp]> = [
      [je.id, /makulera fakturan.*momsjustering/],
      [j1.journalEntryId, /ny justering tillbaka/],
      [mak.id, /makulering rättas inte/],
      [bet.id, /Ångra betalning/],
      [undo.id, /Registrera betalningen på nytt/],
    ]
    const fore = await prisma.journalEntry.count({ where: { organizationId: t.org.id } })
    for (const [id, text] of fall) {
      const e = await t.acc
        .reverseJournalEntry({
          entryId: id,
          organizationId: t.org.id,
          actorRole: 'OWNER',
          actorUserId: t.user.id,
          reason: 'Försök till generell rättelse',
        })
        .catch((x: unknown) => x)
      expect(e).toBeInstanceOf(ConflictException)
      expect(String((e as Error).message)).toMatch(text)
    }
    expect(await prisma.journalEntry.count({ where: { organizationId: t.org.id } })).toBe(fore)
  })

  // ── E: BP1 (a) ───────────────────────────────────────────────────────────────────────────

  it('E7 fall A (BP1 §6): led 1 exporterat → ångra → registrera rätt → EXAKT 4 egna verifikat och 8 rader i Fortnox; saldon lika i Eveno och Fortnox', async () => {
    const t = await setup()
    const { f, je } = await faktura(t, { val: 'INGEN_MOMS', brutto: 1250 })
    await skicka(t, je.id)
    await betala(t, f, '2026-10-05')
    const led1 = await jeFor(t, `supplier-invoice-payment:${f.id}`)
    expect((await skicka(t, led1.id)).state).toBe('CONFIRMED')
    const u = await angra(t, f, led1.id)
    expect(u.invoice.paidAt).toBeNull()
    const undo = await jeFor(t, `supplier-invoice-payment-undo:${led1.id}`)
    expect(undo.reversalOfEntryId).toBe(led1.id)
    expect(await evenoRader(undo.id)).toEqual([
      [1930, 125000, 0],
      [2440, 0, 125000],
    ])
    // Lokal ny registrering direkt (P-1) — bara EXPORTEN av led 2 väntar (BP1-C1).
    await betala(t, f, '2026-10-08')
    const led2 = await jeFor(t, `supplier-invoice-payment:${f.id}:2`)
    const vantar = await t.exports.dryRun(t.org.id, led2.id)
    expect([vantar.state, vantar.blockReason]).toEqual([
      'BLOCKED',
      expect.stringMatching(/Ångringen av betalningsled 1 är inte exporterad/),
    ])
    expect((await skicka(t, undo.id)).state).toBe('CONFIRMED')
    expect((await skicka(t, led2.id)).state).toBe('CONFIRMED')
    expect(fortnoxRader(t, undo.id)).toEqual([
      [1930, 125000, 0],
      [2440, 0, 125000],
    ])
    expect(t.ledger.vouchers).toHaveLength(4)
    expect(t.ledger.vouchers.flatMap((v) => v.VoucherRows as unknown[])).toHaveLength(8)
    expect(saldo(t)).toEqual({ 1930: -125000, 5170: 125000 })
    const vy = await t.lev.details(f.id, t.org.id)
    expect(
      vy.betalningsled.map((l) => [
        l.k,
        l.gallande,
        l.exportStatus,
        l.angring?.exportStatus ?? null,
      ]),
    ).toEqual([
      [1, false, 'CONFIRMED', 'CONFIRMED'],
      [2, true, 'CONFIRMED', null],
    ])
  })

  it('E7 fall B (BP1 §6): led 1 aldrig exporterat (READY) → ångra → led 1 BLOCKED, ångringen exporteras inte → EXAKT 2 verifikat och 4 rader i Fortnox', async () => {
    const t = await setup()
    const { f, je } = await faktura(t, { val: 'INGEN_MOMS', brutto: 1250 })
    await skicka(t, je.id)
    await betala(t, f, '2026-10-05')
    const led1 = await jeFor(t, `supplier-invoice-payment:${f.id}`)
    const gammal = await t.exports.dryRun(t.org.id, led1.id)
    expect(gammal.state).toBe('DRY_RUN_READY')
    await angra(t, f, led1.id)
    const undo = await jeFor(t, `supplier-invoice-payment-undo:${led1.id}`)
    expect(
      (await prisma.fortnoxVoucherExport.findFirstOrThrow({ where: { journalEntryId: led1.id } }))
        .blockReason,
    ).toMatch(/^REVERSED_BEFORE_EXPORT/)
    // Gammalt READY fälls färskt i send(), 0 POST.
    await expect(
      t.sender.send(t.org.id, 'u1', gammal.id, (gammal as { draftHash: string }).draftHash),
    ).rejects.toThrow()
    expect((await t.exports.dryRun(t.org.id, undo.id)).state).toBe('BLOCKED')
    await betala(t, f, '2026-10-08')
    const led2 = await jeFor(t, `supplier-invoice-payment:${f.id}:2`)
    expect((await skicka(t, led2.id)).state).toBe('CONFIRMED')
    expect(t.ledger.vouchers).toHaveLength(2)
    expect(t.ledger.vouchers.flatMap((v) => v.VoucherRows as unknown[])).toHaveLength(4)
    expect(saldo(t)).toEqual({ 1930: -125000, 5170: 125000 })
    expect(posts(t)).toBe(2)
  })

  it('E3: ledet SENDING → ångra 409 utan effekt (1 POST); ledet UNKNOWN → ångra 409 «stäm av först»', async () => {
    const t = await setup()
    const { f, je } = await faktura(t, { val: 'INGEN_MOMS', brutto: 1250 })
    await skicka(t, je.id)
    await betala(t, f, '2026-10-05')
    const led1 = await jeFor(t, `supplier-invoice-payment:${f.id}`)
    let underSandning: unknown = null
    t.api.beforeWrite = async () => {
      t.api.beforeWrite = null
      underSandning = await angra(t, f, led1.id).catch((e: unknown) => e)
    }
    t.api.faults.push('drop_response_after_write')
    expect((await skicka(t, led1.id)).state).toBe('UNKNOWN')
    expect(underSandning).toBeInstanceOf(ConflictException)
    expect(String((underSandning as Error).message)).toMatch(/skickas till Fortnox just nu/)
    await expect(angra(t, f, led1.id)).rejects.toThrow(/okänt — stäm av först/)
    const rad = await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: f.id } })
    expect(rad.paidAt).not.toBeNull()
    expect(
      await prisma.journalEntry.count({
        where: {
          organizationId: t.org.id,
          sourceId: { startsWith: 'supplier-invoice-payment-undo:' },
        },
      }),
    ).toBe(0)
    expect(posts(t)).toBe(2)
  })

  it('E6/U-1: samma ångerbegäran → samma kvitto; annat skäl → 409; efter nytt led → 409; okänt led → 404; annan org → 404', async () => {
    const t = await setup()
    const { f, je } = await faktura(t, { val: 'INGEN_MOMS', brutto: 1250 })
    await skicka(t, je.id)
    await betala(t, f, '2026-10-05')
    const led1 = await jeFor(t, `supplier-invoice-payment:${f.id}`)
    const a = await angra(t, f, led1.id, 'Fel datum angavs')
    const b = await angra(t, f, led1.id, 'Fel datum angavs')
    expect([b.upprepad, b.undoJournalEntryId]).toEqual([true, a.undoJournalEntryId])
    await expect(angra(t, f, led1.id, 'Ett annat skäl')).rejects.toThrow(/annat skäl/)
    await betala(t, f, '2026-10-08')
    await expect(angra(t, f, led1.id, 'Fel datum angavs')).rejects.toThrow(
      /ny betalning har registrerats/,
    )
    await expect(angra(t, f, je.id)).rejects.toBeInstanceOf(NotFoundException)
    const annan = await setup()
    await expect(
      annan.lev.undoPayment({
        organizationId: annan.org.id,
        invoiceId: f.id,
        paymentJournalEntryId: led1.id,
        user: annan.agare,
        reason: 'Fel datum angavs',
      }),
    ).rejects.toBeInstanceOf(NotFoundException)
    expect(
      await prisma.journalEntry.count({
        where: {
          organizationId: t.org.id,
          sourceId: { startsWith: 'supplier-invoice-payment-undo:' },
        },
      }),
    ).toBe(1)
  })

  it('E4: oklar äldre proveniens (paidAt utan verifikat; betalning rättad generellt före 041) → 409 utan effekt', async () => {
    const t = await setup()
    const { f, je } = await faktura(t, { val: 'INGEN_MOMS', brutto: 1250 })
    await skicka(t, je.id)
    await prisma.supplierInvoice.update({
      where: { id: f.id },
      data: { paidAt: new Date('2026-10-05') },
    })
    await expect(
      betala(t, f, '2026-10-06').catch((e: unknown) => {
        throw e
      }),
    ).rejects.toThrow()
    await prisma.supplierInvoice.update({ where: { id: f.id }, data: { paidAt: null } })
    await betala(t, f, '2026-10-05')
    const led1 = await jeFor(t, `supplier-invoice-payment:${f.id}`)
    // Som en generell rättelse från före MK-2 (MANUAL entry-reversal), skriven direkt.
    const konton = await prisma.account.findMany({
      where: { organizationId: t.org.id, number: { in: [1930, 2440] } },
    })
    await prisma.journalEntry.create({
      data: {
        organizationId: t.org.id,
        date: new Date('2026-10-06'),
        description: 'Rättelse (före 041)',
        fiscalYear: 2026,
        verNumber: 999001,
        source: 'MANUAL',
        sourceId: `entry-reversal:${led1.id}`,
        reversalOfEntryId: led1.id,
        lines: {
          create: [
            { accountId: konton.find((k) => k.number === 1930)!.id, debit: 1250 },
            { accountId: konton.find((k) => k.number === 2440)!.id, credit: 1250 },
          ],
        },
      },
    })
    await expect(angra(t, f, led1.id)).rejects.toThrow(/rättad på annat sätt/)
    expect(
      (await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: f.id } })).paidAt,
    ).not.toBeNull()
  })

  it('C-1: makulering med ett led vars ångring inte är CONFIRMED → 409; när ångringen är exporterad → tillåten', async () => {
    const t = await setup()
    const { f, je } = await faktura(t, { val: 'INGEN_MOMS', brutto: 1250 })
    await skicka(t, je.id)
    await betala(t, f, '2026-10-05')
    const led1 = await jeFor(t, `supplier-invoice-payment:${f.id}`)
    await skicka(t, led1.id)
    await angra(t, f, led1.id)
    await expect(
      t.lev.cancel({ organizationId: t.org.id, invoiceId: f.id, createdById: t.user.id }),
    ).rejects.toThrow(/ångring inte är avslutad/)
    const undo = await jeFor(t, `supplier-invoice-payment-undo:${led1.id}`)
    await skicka(t, undo.id)
    await t.lev.cancel({ organizationId: t.org.id, invoiceId: f.id, createdById: t.user.id })
    const mak = await jeFor(t, `supplier-invoice-cancel:${f.id}`)
    expect((await skicka(t, mak.id)).state).toBe('CONFIRMED')
    expect(saldo(t)).toEqual({})
    expect(t.ledger.vouchers).toHaveLength(4)
  })

  // ── Tillägg mot C2:s KRITERIER-041 (J2, J3, J4, K3, B2, B4) ─────────────────────────────

  it.each([
    ['UNKNOWN', 'OUTCOME_UNKNOWN', /okänt/],
    ['SENDING', 'CLAIMED', /okänt|pågår/],
    ['REJECTED', 'REJECTED_429_NA', /okänt/],
    ['REJECTED', 'REJECTED_NA_NA', /okänt/],
    ['REJECTED', 'REJECTED', /okänt/],
  ] as const)(
    'J2: originalets export %s (%s) → justering 409 «okänt», ingen effekt',
    async (state, lastOutcome, text) => {
      const t = await setup()
      const { f, je } = await faktura(t, { val: 'HELT_AVDRAG' })
      const d = await t.exports.dryRun(t.org.id, je.id)
      await prisma.fortnoxVoucherExport.update({
        where: { id: d.id },
        data: {
          state,
          lastOutcome,
          fortnoxDatabaseNumber: TEST_COMPANY,
          sendAttemptId: randomUUID(),
        },
      })
      const fore = await prisma.journalEntry.count({ where: { organizationId: t.org.id } })
      const e = await just(t, f, 'INGET_AVDRAG', '2026-08-20').catch((x: unknown) => x)
      expect(e).toBeInstanceOf(ConflictException)
      expect(String((e as Error).message)).toMatch(text)
      expect(await prisma.journalEntry.count({ where: { organizationId: t.org.id } })).toBe(fore)
      expect(
        (await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: f.id } }))
          .vatTreatmentCurrent,
      ).toBe('HELT_AVDRAG')
    },
  )

  it('J2: makulerad faktura → justering 409', async () => {
    const t = await setup()
    const { f, je } = await faktura(t, { val: 'HELT_AVDRAG' })
    await skicka(t, je.id)
    await t.lev.cancel({ organizationId: t.org.id, invoiceId: f.id, createdById: t.user.id })
    await expect(just(t, f, 'INGET_AVDRAG', '2026-08-20')).rejects.toThrow(/makulerad/)
  })

  it('J3: det frysta kostnadskontot är inaktivt i Fortnox → justeringens export stoppas (ingen reserv till dagens mappning), 0 POST', async () => {
    const t = await setup()
    const { f, je } = await faktura(t, { val: 'HELT_AVDRAG' })
    await skicka(t, je.id)
    const j1 = await just(t, f, 'INGET_AVDRAG', '2026-08-20')
    t.ledger.accounts = t.ledger.accounts.map((a) =>
      a.Number === 5170 ? { ...a, Active: false } : a,
    )
    const fore = posts(t)
    const r = await t.exports.dryRun(t.org.id, j1.journalEntryId)
    expect([r.state, (r.blockReason ?? '').split(':')[0]]).toEqual([
      'BLOCKED',
      'ACCOUNT_MAPPING_DRIFT',
    ])
    expect(r.blockReason).toMatch(/frysta Fortnox-kontot 5170/)
    expect(posts(t)).toBe(fore)
  })

  it('J4/G2: gammalt READY på J2 när J1 blir UNKNOWN → send 409 (färsk build), 0 POST', async () => {
    const t = await setup()
    const { f, je } = await faktura(t, { val: 'HELT_AVDRAG' })
    await skicka(t, je.id)
    const j1 = await just(t, f, 'INGET_AVDRAG', '2026-08-20')
    await skicka(t, j1.journalEntryId)
    const j2 = await just(t, f, 'HELT_AVDRAG', '2026-08-21')
    const r2 = await t.exports.dryRun(t.org.id, j2.journalEntryId)
    expect(r2.state).toBe('DRY_RUN_READY')
    await prisma.fortnoxVoucherExport.updateMany({
      where: { organizationId: t.org.id, journalEntryId: j1.journalEntryId },
      data: { state: 'UNKNOWN', lastOutcome: 'OUTCOME_UNKNOWN' },
    })
    const fore = posts(t)
    await expect(
      t.sender.send(t.org.id, 'u1', r2.id, (r2 as { draftHash: string }).draftHash),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(posts(t)).toBe(fore)
  })

  it('K3: en vanlig rättelse av ett manuellt verifikat är fortfarande tillåten (spärren gäller bara SUPPLIER_INVOICE)', async () => {
    const t = await setup()
    await prisma.account.createMany({
      data: [{ organizationId: t.org.id, number: 6110, name: 'Kontorsmaterial', type: 'EXPENSE' }],
      skipDuplicates: true,
    })
    const man = await t.acc.createManualJournalEntry({
      organizationId: t.org.id,
      date: new Date('2026-08-20'),
      description: 'Manuell post',
      lines: [
        { accountNumber: 6110, debit: 100 },
        { accountNumber: 2440, credit: 100 },
      ],
      idempotencyKey: `man-${randomUUID()}`,
      createdById: t.user.id,
    })
    const r = await t.acc.reverseJournalEntry({
      entryId: man.id,
      organizationId: t.org.id,
      actorRole: 'OWNER',
      actorUserId: t.user.id,
      reason: 'Fel konto i manuell post',
    })
    expect(r.reversalOfEntryId).toBe(man.id)
  })

  it('B2: fel i rättelsen efter paidAt = null → hel rollback (paidAt kvar, ingen rättelse); invarianten håller', async () => {
    const t = await setup()
    const { f, je } = await faktura(t, { val: 'INGEN_MOMS', brutto: 1250 })
    await skicka(t, je.id)
    await betala(t, f, '2026-10-05')
    const led1 = await jeFor(t, `supplier-invoice-payment:${f.id}`)
    const spion = jest
      .spyOn(t.acc, 'bookSupplierInvoicePaymentUndo')
      .mockRejectedValueOnce(new Error('injicerat fel efter paidAt'))
    await expect(angra(t, f, led1.id)).rejects.toThrow(/injicerat fel/)
    spion.mockRestore()
    const rad = await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: f.id } })
    expect(rad.paidAt).not.toBeNull()
    expect(
      await prisma.journalEntry.count({
        where: { organizationId: t.org.id, reversalOfEntryId: led1.id },
      }),
    ).toBe(0)
    expect((await angra(t, f, led1.id)).invoice.paidAt).toBeNull()
  })

  it('B4: tre led → historiskt id för led 1, «:2» och «:3» för nya led; inga id skrivs om', async () => {
    const t = await setup()
    const { f, je } = await faktura(t, { val: 'INGEN_MOMS', brutto: 1250 })
    await skicka(t, je.id)
    await betala(t, f, '2026-10-01')
    const l1 = await jeFor(t, `supplier-invoice-payment:${f.id}`)
    await angra(t, f, l1.id, 'Fel datum ett')
    await betala(t, f, '2026-10-02')
    const l2 = await jeFor(t, `supplier-invoice-payment:${f.id}:2`)
    await angra(t, f, l2.id, 'Fel datum två')
    await betala(t, f, '2026-10-03')
    const l3 = await jeFor(t, `supplier-invoice-payment:${f.id}:3`)
    const alla = await prisma.journalEntry.findMany({
      where: {
        organizationId: t.org.id,
        sourceId: { startsWith: `supplier-invoice-payment:${f.id}` },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, sourceId: true },
    })
    expect(alla.map((a) => a.sourceId)).toEqual([
      `supplier-invoice-payment:${f.id}`,
      `supplier-invoice-payment:${f.id}:2`,
      `supplier-invoice-payment:${f.id}:3`,
    ])
    expect([alla[0]!.id, alla[1]!.id, alla[2]!.id]).toEqual([l1.id, l2.id, l3.id])
    expect(
      (await t.lev.details(f.id, t.org.id)).betalningsled.map((l) => [l.k, l.gallande]),
    ).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ])
  })

  it('D1 (MK1-036, «ingen exporterad» återkallad): bara J1 lokalt (aldrig exporterad) → makulering 409 före effekt', async () => {
    const t = await setup()
    const { f, je } = await faktura(t, { val: 'INGET_AVDRAG' })
    await skicka(t, je.id)
    const j1 = await just(t, f, 'HELT_AVDRAG', '2026-08-20')
    expect((await t.exports.dryRun(t.org.id, j1.journalEntryId)).state).toBe('DRY_RUN_READY')
    const fore = await prisma.journalEntry.count({ where: { organizationId: t.org.id } })
    await expect(
      t.lev.cancel({ organizationId: t.org.id, invoiceId: f.id, createdById: t.user.id }),
    ).rejects.toThrow(/inte är återställda eller avstämda/)
    expect(await prisma.journalEntry.count({ where: { organizationId: t.org.id } })).toBe(fore)
  })

  // ── Samtidighet (C7, D3, E8): deterministiska barriärer, inga sleeps ─────────────────────
  //
  // Ett yttre radlås hålls på fakturan (eller exportraden) medan båda anropen köar på det; kön
  // mäts i pg_stat_activity. När låset släpps vinner den som köade först.
  const antalVantare = async () =>
    Number(
      (
        await prisma.$queryRaw<
          Array<{ n: bigint }>
        >`SELECT count(*)::bigint AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
      )[0]!.n,
    )
  /** Väntar tills `antal` väntar på lås ELLER `klar()` (anropet avgjordes utan att köa). */
  const vantaPaKo = async (antal: number, klar: () => boolean = () => false) => {
    for (let i = 0; i < 20000; i++) {
      if (klar() || (await antalVantare()) >= antal) return
      await new Promise((res) => setImmediate(res))
    }
    throw new Error(`väntade på ${antal} låsväntare`)
  }
  type Utfall<V> = { ok: true; v: V } | { ok: false; e: unknown }
  const utfall = <V>(p: Promise<V>, klar: { v: boolean }): Promise<Utfall<V>> =>
    p.then(
      (v) => ((klar.v = true), { ok: true as const, v }),
      (e: unknown) => ((klar.v = true), { ok: false as const, e }),
    )
  /**
   * Kör a och b mot ett yttre lås: a startar först, sedan b; låset släpps; båda utfallen returneras.
   * Ett anrop som avgörs UTAN att köa (t.ex. en förkontroll utanför låset) räknas inte som väntare.
   * Låset släpps alltid (finally), så att ett fel aldrig lämnar en hängande transaktion.
   */
  const overlapp = async <A, B>(
    las: (tx: PrismaClient) => Promise<unknown>,
    a: () => Promise<A>,
    b: () => Promise<B>,
  ): Promise<[Utfall<A>, Utfall<B>]> => {
    let slapp!: () => void
    const spärr = new Promise<void>((r) => (slapp = r))
    let lastHallet!: () => void
    const hallet = new Promise<void>((r) => (lastHallet = r))
    const yttre = prisma.$transaction(
      async (tx) => {
        await las(tx as unknown as PrismaClient)
        lastHallet()
        await spärr
      },
      { timeout: 60000 },
    )
    try {
      await hallet
      const ka = { v: false }
      const kb = { v: false }
      const fa = utfall(a(), ka)
      await vantaPaKo(1, () => ka.v)
      const fb = utfall(b(), kb)
      await vantaPaKo((ka.v ? 0 : 1) + 1, () => kb.v)
      slapp()
      await yttre
      return Promise.all([fa, fb])
    } finally {
      slapp()
      await yttre.catch(() => undefined)
    }
  }
  const lasFaktura = (id: string) => (tx: PrismaClient) =>
    tx.$queryRaw`SELECT id FROM "SupplierInvoice" WHERE id = ${id} FOR UPDATE`

  it('C7 överlapp: två samtidiga justeringar från samma gällande val → exakt en; den andra 409 utan verifikat', async () => {
    const t = await setup()
    const { f, je } = await faktura(t, { val: 'HELT_AVDRAG' })
    await skicka(t, je.id)
    const fore = await prisma.journalEntry.count({ where: { organizationId: t.org.id } })
    const [a, b] = await overlapp(
      lasFaktura(f.id),
      () => just(t, f, 'INGET_AVDRAG', '2026-08-20'),
      () => just(t, f, 'INGET_AVDRAG', '2026-08-20'),
    )
    expect([a.ok, b.ok]).toEqual([true, false])
    expect(!b.ok && b.e).toBeInstanceOf(ConflictException)
    expect(
      await prisma.supplierInvoiceVatAdjustment.count({ where: { supplierInvoiceId: f.id } }),
    ).toBe(1)
    expect(await prisma.journalEntry.count({ where: { organizationId: t.org.id } })).toBe(fore + 1)
  })

  it.each(['ångra först', 'betala först'] as const)(
    'E8 överlapp ångra ↔ ny betalning medan led 1 gäller (%s startar först) → exakt en effekt: ångringen; den nya betalningen nekas utan bokning (led 1 gäller fram till ångringens commit)',
    async (ordning) => {
      const t = await setup()
      const { f, je } = await faktura(t, { val: 'INGEN_MOMS', brutto: 1250 })
      await skicka(t, je.id)
      await betala(t, f, '2026-10-05')
      const led1 = await jeFor(t, `supplier-invoice-payment:${f.id}`)
      const ang = () => angra(t, f, led1.id)
      const bet = () => betala(t, f, '2026-10-08')
      const [x, y] =
        ordning === 'ångra först'
          ? await overlapp(lasFaktura(f.id), ang, bet)
          : await overlapp(lasFaktura(f.id), bet, ang)
      const [u, b] = ordning === 'ångra först' ? [x, y] : [y, x]
      expect([u.ok, b.ok]).toEqual([true, false])
      const rad = await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: f.id } })
      const led = (await t.lev.details(f.id, t.org.id)).betalningsled
      expect(led.map((l) => [l.k, l.gallande])).toEqual([[1, false]])
      expect(rad.paidAt).toBeNull()
      // Därefter, i följd: den nya registreringen blir led 2 (BP1 §5 ordning 1).
      await bet()
      expect(
        (await t.lev.details(f.id, t.org.id)).betalningsled.map((l) => [l.k, l.gallande]),
      ).toEqual([
        [1, false],
        [2, true],
      ])
    },
  )

  it('P-1 överlapp: två samtidiga betalningsregistreringar (dubbelklick) → exakt en; den andra 409 utan bokning', async () => {
    const t = await setup()
    const { f, je } = await faktura(t, { val: 'INGEN_MOMS', brutto: 1250 })
    await skicka(t, je.id)
    const [a, b] = await overlapp(
      lasFaktura(f.id),
      () => betala(t, f, '2026-10-05'),
      () => betala(t, f, '2026-10-05'),
    )
    expect([a.ok, b.ok]).toEqual([true, false])
    expect(!b.ok && b.e).toBeInstanceOf(ConflictException)
    expect(
      await prisma.journalEntry.count({
        where: {
          organizationId: t.org.id,
          sourceId: { startsWith: `supplier-invoice-payment:${f.id}` },
        },
      }),
    ).toBe(1)
  })

  it.each(['ångra först', 'makulera först'] as const)(
    'E8 ångra ↔ makulering i följd (%s): ett utfall per ordning; C-1 och paidAt-invarianten håller',
    async (ordning) => {
      const t = await setup()
      const { f, je } = await faktura(t, { val: 'INGEN_MOMS', brutto: 1250 })
      await skicka(t, je.id)
      await betala(t, f, '2026-10-05')
      const led1 = await jeFor(t, `supplier-invoice-payment:${f.id}`)
      const mak = () =>
        t.lev.cancel({ organizationId: t.org.id, invoiceId: f.id, createdById: t.user.id })
      if (ordning === 'ångra först') {
        await angra(t, f, led1.id)
        await mak()
        expect(
          (await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: f.id } })).cancelledAt,
        ).not.toBeNull()
      } else {
        await expect(mak()).rejects.toThrow()
        await angra(t, f, led1.id)
        const rad = await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: f.id } })
        expect([rad.cancelledAt, rad.paidAt]).toEqual([null, null])
      }
    },
  )

  it('E8 överlapp ångra ↔ makulering (ångra köar först) → exakt ett konsekvent tillstånd; ingen deadlock', async () => {
    const t = await setup()
    const { f, je } = await faktura(t, { val: 'INGEN_MOMS', brutto: 1250 })
    await skicka(t, je.id)
    await betala(t, f, '2026-10-05')
    const led1 = await jeFor(t, `supplier-invoice-payment:${f.id}`)
    const [a, b] = await overlapp(
      lasFaktura(f.id),
      () => angra(t, f, led1.id),
      () => t.lev.cancel({ organizationId: t.org.id, invoiceId: f.id, createdById: t.user.id }),
    )
    expect(a.ok).toBe(true)
    const rad = await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: f.id } })
    // Makuleringens förkontroll såg fakturan betald (422) eller vann låset efter ångringen (ok).
    expect(rad.paidAt).toBeNull()
    expect(rad.cancelledAt !== null).toBe(b.ok)
    expect(
      await prisma.journalEntry.count({
        where: { organizationId: t.org.id, sourceId: `supplier-invoice-cancel:${f.id}` },
      }),
    ).toBe(b.ok ? 1 : 0)
  })

  it.each(['ångra först', 'justera först'] as const)(
    'E8/033 §4 överlapp ångra ↔ momsjustering (%s): båda lyckas (oberoende rader), samma låsordning, ingen deadlock',
    async (ordning) => {
      const t = await setup()
      const { f, je } = await faktura(t, { val: 'HELT_AVDRAG' })
      await skicka(t, je.id)
      await betala(t, f, '2026-10-05')
      const led1 = await jeFor(t, `supplier-invoice-payment:${f.id}`)
      const ang = () => angra(t, f, led1.id)
      const jus = () => just(t, f, 'INGET_AVDRAG', '2026-10-06')
      const [a, b] =
        ordning === 'ångra först'
          ? await overlapp(lasFaktura(f.id), ang, jus)
          : await overlapp(lasFaktura(f.id), jus, ang)
      expect([a.ok, b.ok]).toEqual([true, true])
      const rad = await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: f.id } })
      expect([rad.paidAt, rad.vatTreatmentCurrent]).toEqual([null, 'INGET_AVDRAG'])
    },
  )

  it('E8 överlapp ångra ↔ exportanspråk på samma led → exakt ett av utfallen (ångrat + 0 POST, eller skickat + ångra 409)', async () => {
    const t = await setup()
    const { f, je } = await faktura(t, { val: 'INGEN_MOMS', brutto: 1250 })
    await skicka(t, je.id)
    await betala(t, f, '2026-10-05')
    const led1 = await jeFor(t, `supplier-invoice-payment:${f.id}`)
    const d = await t.exports.dryRun(t.org.id, led1.id)
    const fore = posts(t)
    const [a, b] = await overlapp(
      (tx) => tx.$queryRaw`SELECT id FROM "FortnoxVoucherExport" WHERE id = ${d.id} FOR UPDATE`,
      () => t.sender.send(t.org.id, 'u1', d.id, (d as { draftHash: string }).draftHash),
      () => angra(t, f, led1.id),
    )
    const ex = await prisma.fortnoxVoucherExport.findUniqueOrThrow({ where: { id: d.id } })
    const angrad =
      (await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: f.id } })).paidAt === null
    if (a.ok) {
      expect([ex.state, angrad, b.ok, posts(t) - fore]).toEqual(['CONFIRMED', false, false, 1])
    } else {
      expect([ex.state, angrad, b.ok, posts(t) - fore]).toEqual(['BLOCKED', true, true, 0])
    }
  })

  it('E6 överlapp: samma ångerbegäran två gånger samtidigt → samma ångringsverifikat (ett), båda 200', async () => {
    const t = await setup()
    const { f, je } = await faktura(t, { val: 'INGEN_MOMS', brutto: 1250 })
    await skicka(t, je.id)
    await betala(t, f, '2026-10-05')
    const led1 = await jeFor(t, `supplier-invoice-payment:${f.id}`)
    const [a, b] = await overlapp(
      lasFaktura(f.id),
      () => angra(t, f, led1.id, 'Samma skäl två gånger'),
      () => angra(t, f, led1.id, 'Samma skäl två gånger'),
    )
    expect([a.ok, b.ok]).toEqual([true, true])
    expect(a.ok && b.ok && a.v.undoJournalEntryId === b.v.undoJournalEntryId).toBe(true)
    expect(
      await prisma.journalEntry.count({
        where: { organizationId: t.org.id, sourceId: `supplier-invoice-payment-undo:${led1.id}` },
      }),
    ).toBe(1)
  })
})
