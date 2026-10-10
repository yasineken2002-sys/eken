/**
 * TESTKUND-20261004/041 (C1) P-4 (TILLAGG-BESLUT-032 §4): avi med saknat avtal → lokal fallback 3914
 * märkt «intäktskonto okänt: avtal saknas»; Fortnox-export nekas; rapport och AI påstår aldrig momsfri.
 * En vanlig belagd APARTMENT påverkas inte. Ursprunglig harness: fortnox-moms-bp1.db.spec.ts.
 *
 * Harnessen (syntetisk Fortnox, riktig export) är densamma som i fortnox-moms-bp1.db.spec.ts.
 */
import { randomUUID } from 'node:crypto'
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

const INTAKTSMAPPNING: FortnoxAccountMappingRowInput[] = [
  {
    role: 'KUNDFORDRAN',
    vatTreatment: 'EJ_TILLAMPLIG',
    sourceAccountNumber: 1510,
    targetAccountNumber: 1510,
  },
  {
    role: 'HYRESINTAKT',
    vatTreatment: 'MOMSFRI',
    sourceAccountNumber: 3911,
    targetAccountNumber: 3915,
  },
]

medDb('TESTKUND-041 P-4: fallback 3914 vid saknat avtal', () => {
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
      await prisma.journalEntryLine.deleteMany({ where: { journalEntry: { organizationId: id } } })
      await prisma.journalEntry.deleteMany({ where: { organizationId: id } })
      await prisma.rentNotice.deleteMany({ where: { organizationId: id } })
      await prisma.lease.deleteMany({ where: { organizationId: id } })
      await prisma.tenant.deleteMany({ where: { organizationId: id } })
      await prisma.unit.deleteMany({ where: { property: { organizationId: id } } })
      await prisma.property.deleteMany({ where: { organizationId: id } })
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
      { Number: 1510, Active: true, Description: 'Kundfordringar', VATCode: null },
      {
        Number: 3915,
        Active: true,
        Description: 'Bostadshyror momsfria (syntetiskt)',
        VATCode: 'MF',
      },
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
    const mappaRader = (rows: FortnoxAccountMappingRowInput[]) =>
      godkannMappning(prisma, connections, reader, org.id, rows)
    return {
      org,
      user,
      api,
      ledger,
      exports,
      sender,
      acc,
      lev,
      mappaRader,
      agare: { sub: user.id, role: 'OWNER' },
      setAfterBuild: (f: (() => Promise<void>) | null) => (afterBuild = f),
    }
  }

  /** Bostad → hyresgäst → avtal → avi; verifikatet bokas av produktens AccountingService. */
  const avi = async (
    t: Awaited<ReturnType<typeof setup>>,
    o: { avtalOrg: string; netto: number },
  ) => {
    const sfx = randomUUID().slice(0, 8)
    const prop = await prisma.property.create({
      data: {
        organizationId: o.avtalOrg,
        name: 'Syntetisk',
        propertyDesignation: `p4-${sfx}`,
        type: 'RESIDENTIAL',
        street: 's',
        city: 'c',
        postalCode: '1',
        totalArea: '100',
      },
    })
    const unit = await prisma.unit.create({
      data: {
        propertyId: prop.id,
        name: 'Lgh 1',
        unitNumber: '1',
        type: 'APARTMENT',
        area: '50',
        monthlyRent: String(o.netto),
      },
    })
    const ten = await prisma.tenant.create({
      data: {
        organizationId: o.avtalOrg,
        type: 'INDIVIDUAL',
        firstName: 'S',
        lastName: 'T',
        email: `p4-${sfx}@example.invalid`,
      },
    })
    const lease = await prisma.lease.create({
      data: {
        organizationId: o.avtalOrg,
        unitId: unit.id,
        tenantId: ten.id,
        contractNumber: `P4-${sfx}`,
        status: 'ACTIVE',
        startDate: new Date('2026-01-01'),
        tenancyStartDate: new Date('2026-01-01'),
        monthlyRent: String(o.netto),
        depositAmount: '0',
      },
    })
    // Avin i VÅR organisation; avtalet kan ligga i en annan (eller vara borttaget) → fallback.
    const ownTen =
      o.avtalOrg === t.org.id
        ? ten
        : await prisma.tenant.create({
            data: {
              organizationId: t.org.id,
              type: 'INDIVIDUAL',
              firstName: 'S',
              lastName: 'U',
              email: `p4u-${sfx}@example.invalid`,
            },
          })
    const notice = await prisma.rentNotice.create({
      data: {
        organizationId: t.org.id,
        tenantId: ownTen.id,
        leaseId: lease.id,
        noticeNumber: `AVI-P4-${sfx}`,
        ocrNumber: '1',
        month: 9,
        year: 2026,
        amount: String(o.netto),
        vatAmount: '0',
        totalAmount: String(o.netto),
        dueDate: new Date('2026-08-31'),
      },
    })
    const je = await t.acc.createJournalEntryForRentNotice(
      {
        id: notice.id,
        noticeNumber: notice.noticeNumber,
        leaseId: lease.id,
        type: notice.type,
        amount: notice.amount,
        vatAmount: notice.vatAmount,
        totalAmount: notice.totalAmount,
        year: 2026,
        month: 9,
      },
      t.org.id,
      t.user.id,
    )
    return je!
  }
  const rader = async (id: string) =>
    (
      await prisma.journalEntryLine.findMany({
        where: { journalEntryId: id },
        include: { account: true },
      })
    )
      .map((l) => [l.account.number, Math.round(Number(l.credit ?? 0) * 100), l.description])
      .filter((r) => r[1] !== 0)

  it('F1–F4: avtal i annan org → 3914 märkt lokalt; export nekas; rapporten redovisar «intäktskonto okänt», aldrig momsfri; belagd APARTMENT oförändrad (3911 → 3915 CONFIRMED)', async () => {
    const t = await setup()
    await prisma.account.createMany({
      data: [
        { organizationId: t.org.id, number: 1510, name: 'Kundfordringar', type: 'ASSET' },
        { organizationId: t.org.id, number: 3911, name: 'Hyresintäkter bostäder', type: 'REVENUE' },
        { organizationId: t.org.id, number: 3914, name: 'Hyresintäkter övriga', type: 'REVENUE' },
      ],
      skipDuplicates: true,
    })
    await t.mappaRader(INTAKTSMAPPNING)
    const annan = await prisma.organization.create({
      data: {
        name: `p4-annan-${randomUUID().slice(0, 6)}`,
        email: `p4a-${randomUUID().slice(0, 6)}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '1',
      },
    })
    orgs.push(annan.id)
    const vanlig = await avi(t, { avtalOrg: t.org.id, netto: 6000 })
    const fallback = await avi(t, { avtalOrg: annan.id, netto: 4000 })
    expect(await rader(vanlig.id)).toEqual([[3911, 600000, 'Hyresintäkt 9/2026']])
    expect(await rader(fallback.id)).toEqual([
      [3914, 400000, 'Hyresintäkt 9/2026 – intäktskonto okänt: avtal saknas'],
    ])
    const okExp = await t.exports.dryRun(t.org.id, vanlig.id)
    expect(okExp.state).toBe('DRY_RUN_READY')
    expect(
      (await t.sender.send(t.org.id, 'u1', okExp.id, (okExp as { draftHash: string }).draftHash))
        .state,
    ).toBe('CONFIRMED')
    const stopp = await t.exports.dryRun(t.org.id, fallback.id)
    expect(stopp.state).toBe('BLOCKED')
    // Första grinden är intäktsgrinden: avin saknar eget avtal → behandlingen är obevisad.
    expect(stopp.blockReason).toMatch(
      /^ACCOUNT_UNVERIFIED: .*obevisad: avins avtal eller enhetstyp saknas/,
    )
    expect(t.api.requests.filter((r) => r.method === 'POST')).toHaveLength(1)
    const pl = await t.acc.getProfitLossReport(t.org.id, '2026-09-01', '2026-09-30')
    expect(pl.okantIntaktskonto).toMatchObject({ konto: 3914, belopp: 4000, antalVerifikat: 1 })
    expect(pl.okantIntaktskonto!.text).toMatch(/intäktskonto okänt: avtal saknas/)
    expect(pl.okantIntaktskonto!.text).toMatch(/inte belagd som momsfri/)
    expect(pl.revenue.total).toBe(10000)
  })
})
