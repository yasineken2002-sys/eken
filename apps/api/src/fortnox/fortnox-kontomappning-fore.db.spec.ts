/**
 * TESTKUND-20261004/008 — FELREPRODUKTION före kontomappningen (KONTRAKT-008 §2, §4f, §11).
 *
 * Proven uttrycker KONTRAKTETS önskade utfall och är avsedda att vara RÖDA på #946 74ef2568:
 *  R2 en hyresbetalning (1930 D / 1510 K, riktig allokering) är READY och skickas CONFIRMED trots
 *     att hyresavins fordran aldrig exporterats → kundfordran krediteras i Fortnox utan debet.
 *  R3 ett manuellt kostnadsverifikat (5170/2440) exporteras 1:1 utan någon godkänd mappning.
 *  R4 en hyresbetalning vars avi ÄR bekräftad exporteras 1:1 utan godkänd mappning (1930/1510).
 * Fortnox-kontona är samma verkliga 1868238-svar som i fortnox-intaktsgrind.db.spec.ts.
 */
import { randomUUID } from 'node:crypto'
import { ConfigService } from '@nestjs/config'
import { PrismaClient } from '@prisma/client'
import type { PrismaService } from '../common/prisma/prisma.service'
import { FortnoxConnectionService } from './fortnox-connection.service'
import { FortnoxExportService } from './fortnox-export.service'
import { FortnoxTokenCryptoService } from './fortnox-token-crypto.service'
import { MockFortnoxAuthProvider, MockFortnoxLedgerReader } from './fortnox-providers'
import { VerifiedVoucherDraftBuilder } from './fortnox-export-builder'
import { FortnoxSendService } from './fortnox-send.service'
import { MockVoucherWriter } from './fortnox-voucher-writer'

const KEY = 'ab'.repeat(32)
const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

type FKonto = {
  Number: number
  Description: string
  Active: boolean
  VATCode: string | null
  Year: number
}
// Verkliga värden ur 1868238 (R0-REAL-001). Year = 1 (räkenskapsåret 2026).
const VERKLIGA: FKonto[] = [
  { Number: 1510, Description: 'Kundfordringar', Active: true, VATCode: null, Year: 1 },
  { Number: 1930, Description: 'Företagskonto', Active: true, VATCode: null, Year: 1 },
  { Number: 2440, Description: 'Leverantörsskulder', Active: true, VATCode: null, Year: 1 },
  {
    Number: 2611,
    Description: 'Utgående moms på försäljning inom Sverige, 25 %',
    Active: true,
    VATCode: 'U1',
    Year: 1,
  },
  {
    Number: 2890,
    Description: 'Övriga kortfristiga skulder',
    Active: true,
    VATCode: null,
    Year: 1,
  },
  { Number: 3911, Description: 'Hyresintäkter', Active: false, VATCode: 'HFS', Year: 1 },
  { Number: 3912, Description: 'Arrendeintäkter', Active: false, VATCode: 'HFS', Year: 1 },
  {
    Number: 3970,
    Description: 'Vinst vid avyttring av immateriella och materiella anläggningstillgångar',
    Active: true,
    VATCode: null,
    Year: 1,
  },
  {
    Number: 5170,
    Description: 'Reparation och underhåll av fastighet',
    Active: true,
    VATCode: null,
    Year: 1,
  },
  { Number: 5460, Description: 'Förbrukningsmaterial', Active: true, VATCode: null, Year: 1 },
  { Number: 6110, Description: 'Kontorsmateriel', Active: true, VATCode: null, Year: 1 },
]
// Evenos egna namn och typer (bas-chart.ts).
const EVENO: Record<number, [string, 'ASSET' | 'LIABILITY' | 'REVENUE' | 'EXPENSE']> = {
  1510: ['Kundfordringar', 'ASSET'],
  1930: ['Företagskonto / Bank', 'ASSET'],
  2440: ['Leverantörsskulder', 'LIABILITY'],
  2611: ['Utgående moms 25 %', 'LIABILITY'],
  2890: ['Övriga kortfristiga skulder', 'LIABILITY'],
  3911: ['Hyresintäkter, bostäder', 'REVENUE'],
  3912: ['Hyresintäkter, parkeringsplatser', 'REVENUE'],
  3970: ['Hyresgästers vattenersättning', 'REVENUE'],
  5170: ['Reparation och underhåll av fastighet', 'EXPENSE'],
  5460: ['Förbrukningsmaterial', 'EXPENSE'],
  6110: ['Kontorsmateriel', 'EXPENSE'],
}

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: riggen körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('TESTKUND-008 felreproduktion (ska vara RÖD på 74ef2568)', () => {
  let prisma: PrismaClient
  const orgs: string[] = []
  beforeAll(() => {
    prisma = new PrismaClient()
  })
  afterAll(async () => {
    for (const id of orgs) {
      await prisma.fortnoxVoucherExport.deleteMany({ where: { organizationId: id } })
      await prisma.journalEntryLine.deleteMany({ where: { journalEntry: { organizationId: id } } })
      await prisma.journalEntry.deleteMany({ where: { organizationId: id } })
      await prisma.rentNoticePayment.deleteMany({ where: { rentNotice: { organizationId: id } } })
      await prisma.rentNotice.deleteMany({ where: { organizationId: id } })
      await prisma.lease.deleteMany({ where: { organizationId: id } })
      await prisma.unit.deleteMany({ where: { property: { organizationId: id } } })
      await prisma.property.deleteMany({ where: { organizationId: id } })
      await prisma.tenant.deleteMany({ where: { organizationId: id } })
      await prisma.account.deleteMany({ where: { organizationId: id } })
      await prisma.fortnoxOAuthState.deleteMany({ where: { organizationId: id } })
      await prisma.fortnoxConnection.deleteMany({ where: { organizationId: id } })
      await prisma.organization.deleteMany({ where: { id } })
    }
    await prisma.$disconnect()
  })

  async function setup(varianter: Partial<Record<number, Partial<FKonto>>> = {}) {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `km-${sfx}`,
        email: `km-${sfx}@example.invalid`,
        street: 'a',
        city: 'b',
        postalCode: '1',
      },
    })
    orgs.push(org.id)
    const env: Record<string, string> = { FORTNOX_TOKEN_KEY: KEY }
    const config = { get: (k: string) => env[k] } as unknown as ConfigService
    const reader = new MockFortnoxLedgerReader()
    reader.accounts = VERKLIGA.map((a) => ({
      ...a,
      ...(varianter[a.Number] ?? {}),
    })) as unknown as typeof reader.accounts
    const db = prisma as unknown as PrismaService
    const connections = new FortnoxConnectionService(
      db,
      new FortnoxTokenCryptoService(config),
      config,
      new MockFortnoxAuthProvider(),
      reader,
    )
    const builder = new VerifiedVoucherDraftBuilder(db, connections, reader)
    const exports = new FortnoxExportService(db, builder)
    const writer = new MockVoucherWriter(reader)
    const sender = new FortnoxSendService(db, connections, builder, reader, writer)
    const { authUrl } = await connections.begin(org.id, 'u1')
    const state = new URL(authUrl).searchParams.get('state')!
    await connections.handleCallback(state, `mock-code-${state.slice(0, 8)}`)
    await connections.setExportVoucherSeries(org.id, 'A')
    await connections.setExportOmitDimensions(org.id, 'u1', true)
    const konto = async (n: number) =>
      (await prisma.account.findFirst({ where: { organizationId: org.id, number: n } })) ??
      prisma.account.create({
        data: { organizationId: org.id, number: n, name: EVENO[n]![0], type: EVENO[n]![1] },
      })
    let ver = 0
    const verifikat = async (
      rader: Array<[number, number | null, number | null]>,
      extra: Record<string, unknown> = {},
    ) => {
      const lines = []
      for (const [n, d, c] of rader)
        lines.push({
          accountId: (await konto(n)).id,
          ...(d !== null ? { debit: d } : {}),
          ...(c !== null ? { credit: c } : {}),
        })
      ver += 1
      return prisma.journalEntry.create({
        data: {
          organizationId: org.id,
          date: new Date('2026-10-02'),
          description: `IGR ${ver}`,
          fiscalYear: 2026,
          verNumber: ver,
          lines: { create: lines },
          ...extra,
        },
      })
    }
    // Hyresavi med riktig proveniens (enhet → avtal → avi → verifikat rent-notice:<id>).
    const avi = async (typ: 'APARTMENT' | 'PARKING' | 'OFFICE', netto: number, moms: number) => {
      const prop = await prisma.property.create({
        data: {
          organizationId: org.id,
          name: 'Syntetisk',
          propertyDesignation: `igr-${randomUUID().slice(0, 6)}`,
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
          name: 'Enhet',
          unitNumber: '1',
          type: typ,
          area: '10',
          monthlyRent: String(netto),
        },
      })
      const ten = await prisma.tenant.create({
        data: {
          organizationId: org.id,
          type: 'INDIVIDUAL',
          firstName: 'S',
          lastName: 'T',
          email: `t-${randomUUID().slice(0, 6)}@example.invalid`,
        },
      })
      const lease = await prisma.lease.create({
        data: {
          organizationId: org.id,
          unitId: unit.id,
          tenantId: ten.id,
          contractNumber: `IGR-${randomUUID().slice(0, 6)}`,
          status: 'ACTIVE',
          startDate: new Date('2026-01-01'),
          tenancyStartDate: new Date('2026-01-01'),
          monthlyRent: String(netto),
          depositAmount: '0',
        },
      })
      const n = await prisma.rentNotice.create({
        data: {
          organizationId: org.id,
          tenantId: ten.id,
          leaseId: lease.id,
          noticeNumber: `AVI-IGR-${randomUUID().slice(0, 6)}`,
          ocrNumber: '1',
          month: 10,
          year: 2026,
          amount: String(netto),
          vatAmount: String(moms),
          totalAmount: String(netto + moms),
          dueDate: new Date('2026-09-30'),
        },
      })
      const intakt = typ === 'APARTMENT' ? 3911 : typ === 'PARKING' ? 3912 : 3913
      const rader: Array<[number, number | null, number | null]> = [
        [1510, netto + moms, null],
        [intakt, null, netto],
      ]
      if (moms > 0) rader.push([2611, null, moms])
      const je = await verifikat(rader, { source: 'INVOICE', sourceId: `rent-notice:${n.id}` })
      return { je, unit, notice: n }
    }
    return { org, reader, builder, exports, sender, writer, verifikat, avi }
  }
  const skal = (o: { ok: boolean; reasons?: string[] }) =>
    o.ok ? 'OK' : (o.reasons ?? []).join(' | ')

  /** Hyresavi + riktig bankallokering (RentNoticePayment) + betalningsverifikat som i produkten. */
  async function betalning(t: Awaited<ReturnType<typeof setup>>, belopp: number) {
    const { je: aviJe, notice } = await t.avi('APARTMENT', belopp, 0)
    const alloc = await prisma.rentNoticePayment.create({
      data: {
        rentNoticeId: notice.id,
        amount: String(belopp),
        paidAt: new Date('2026-10-02'),
        source: 'MANUAL',
      },
    })
    const je = await t.verifikat(
      [
        [1930, belopp, null],
        [1510, null, belopp],
      ],
      { source: 'PAYMENT', sourceId: `rent-notice-payment:${alloc.id}` },
    )
    return { aviJe, notice, je }
  }

  it('R2 hyresbetalning utan exporterad hyresfordran blir inte READY (ORIGIN_NOT_CONFIRMED) och skickas inte', async () => {
    const t = await setup()
    const { je } = await betalning(t, 6000)
    const row = (await t.exports.dryRun(t.org.id, je.id)) as {
      id: string
      state: string
      draftHash: string | null
      blockReason: string | null
    }
    const fore = t.reader.vouchers.length
    if (row.state === 'DRY_RUN_READY' && row.draftHash) {
      // Kundeffekten i dag: 1510 krediteras i Fortnox utan motsvarande debet.
      const s = await t.sender.send(t.org.id, 'u1', row.id, row.draftHash).catch((e) => e)
      expect({ state: row.state, send: (s as { state?: string }).state }).toEqual({
        state: 'BLOCKED',
        send: undefined,
      })
    }
    expect(row.state).toBe('BLOCKED')
    expect(row.blockReason ?? '').toMatch(/^ORIGIN_NOT_CONFIRMED/)
    expect(t.reader.vouchers.length).toBe(fore)
  })

  it('R3 manuellt kostnadsverifikat 5170/2440 exporteras inte 1:1 utan godkänd mappning', async () => {
    const t = await setup()
    const je = await t.verifikat([
      [5170, 500, null],
      [2440, null, 500],
    ])
    expect(skal(await t.builder.build(t.org.id, je.id))).toMatch(/^EVENT_UNSUPPORTED/)
  })

  it('R4 hyresbetalning med bekräftad avi exporteras inte 1:1 utan godkänd mappning', async () => {
    const t = await setup()
    const { aviJe, je } = await betalning(t, 6000)
    const conn = await prisma.fortnoxConnection.findUniqueOrThrow({
      where: { organizationId: t.org.id },
    })
    await prisma.fortnoxVoucherExport.create({
      data: {
        organizationId: t.org.id,
        journalEntryId: aviJe.id,
        state: 'CONFIRMED',
        fortnoxDatabaseNumber: conn.fortnoxDatabaseNumber,
      },
    })
    expect(skal(await t.builder.build(t.org.id, je.id))).toMatch(/^ACCOUNT_MAPPING_MISSING/)
  })
})
