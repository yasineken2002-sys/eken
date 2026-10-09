/**
 * TESTKUND-20261004/008 — KONTOMAPPNING mot riktig Postgres och riktiga tjänster
 * (KONTRAKT-008, KONTRAKTSBESKED-008 V1–V9, KRITERIER-008, FACIT-008).
 *
 * Fortnox är den lokala fejken (MockFortnoxLedgerReader + MockVoucherWriter); POST räknas på
 * fejkens verifikatlista. Målkontona är 1868238:s verkliga svar (R0-REAL-001) där sådana finns,
 * plus två uttryckligt SYNTETISKA mål:
 *   3915 «Bostadshyror momsfria» aktivt MF  — ett annat målnummer än källan 3911 (A-5-mönstret)
 *   1940 «Övriga bankkonton» aktivt, ingen momskod (verkligt namn i 1868238) — bankens mål ≠ 1930
 * Inget av detta påstår något om testföretagets eller en kunds kontoplan.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { createHash, randomUUID } from 'node:crypto'
import { ValidationPipe, VersioningType } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import type { FortnoxAccountMappingRowInput } from '@eken/shared'
import { JwtStrategy } from '../auth/strategies/jwt.strategy'
import { VALIDATION_PIPE_OPTIONS } from '../common/contract/validation-pipe-options'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { TransformInterceptor } from '../common/interceptors/transform.interceptor'
import type { PrismaService } from '../common/prisma/prisma.service'
import { formatFortnoxShadowForAi } from './fortnox-ai-context'
import { FortnoxConnectionService } from './fortnox-connection.service'
import { VerifiedVoucherDraftBuilder } from './fortnox-export-builder'
import { FortnoxExportService } from './fortnox-export.service'
import { FortnoxKontomappningService } from './fortnox-kontomappning.service'
import { stadaKontomappning } from './fortnox-kontomappning.testing'
import { FortnoxMappingService } from './fortnox-mapping.service'
import { MockFortnoxAuthProvider, MockFortnoxLedgerReader } from './fortnox-providers'
import { FortnoxReadbackService } from './fortnox-readback.service'
import { FortnoxSendService } from './fortnox-send.service'
import { FortnoxTokenCryptoService } from './fortnox-token-crypto.service'
import { MockVoucherWriter } from './fortnox-voucher-writer'
import { FortnoxController } from './fortnox.controller'
import type { LedgerRowProvenance } from './fortnox-ledger'

const KEY = 'cd'.repeat(32)
const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: riggen körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

type FKonto = {
  Number: number
  Description: string
  Active: boolean
  VATCode: string | null
  BalanceBroughtForward?: number
}
const FORTNOX: FKonto[] = [
  // Verkliga 1868238-svar (R0-REAL-001).
  { Number: 1510, Description: 'Kundfordringar', Active: true, VATCode: null },
  { Number: 1930, Description: 'Företagskonto', Active: true, VATCode: null },
  { Number: 1940, Description: 'Övriga bankkonton', Active: true, VATCode: null },
  {
    Number: 2350,
    Description: 'Andra långfristiga skulder till kreditinstitut',
    Active: true,
    VATCode: null,
  },
  { Number: 2440, Description: 'Leverantörsskulder', Active: true, VATCode: null },
  {
    Number: 2611,
    Description: 'Utgående moms på försäljning inom Sverige, 25 %',
    Active: true,
    VATCode: 'U1',
  },
  { Number: 2641, Description: 'Debiterad ingående moms', Active: true, VATCode: 'I' },
  { Number: 2890, Description: 'Övriga kortfristiga skulder', Active: true, VATCode: null },
  { Number: 3911, Description: 'Hyresintäkter', Active: false, VATCode: 'HFS' },
  {
    Number: 3970,
    Description: 'Vinst vid avyttring av immateriella och materiella anläggningstillgångar',
    Active: true,
    VATCode: null,
  },
  {
    Number: 3990,
    Description: 'Övriga ersättningar, bidrag och intäkter',
    Active: true,
    VATCode: 'MF',
  },
  {
    Number: 5170,
    Description: 'Reparation och underhåll av fastighet',
    Active: true,
    VATCode: null,
  },
  { Number: 5460, Description: 'Förbrukningsmaterial', Active: true, VATCode: null },
  // SYNTETISKT mål (annat nummer än källan).
  { Number: 3915, Description: 'Bostadshyror momsfria (syntetiskt)', Active: true, VATCode: 'MF' },
]
const EVENO: Record<number, [string, 'ASSET' | 'LIABILITY' | 'REVENUE' | 'EXPENSE']> = {
  1510: ['Kundfordringar', 'ASSET'],
  1930: ['Företagskonto / Bank', 'ASSET'],
  2440: ['Leverantörsskulder', 'LIABILITY'],
  2641: ['Ingående moms', 'LIABILITY'],
  2890: ['Mottagna depositioner (hyresgäster)', 'LIABILITY'],
  3911: ['Hyresintäkter, bostäder', 'REVENUE'],
  3970: ['Hyresgästers vattenersättning', 'REVENUE'],
  5170: ['Reparation och underhåll av fastighet', 'EXPENSE'],
}

const R = (
  role: FortnoxAccountMappingRowInput['role'],
  sourceAccountNumber: number,
  targetAccountNumber: number,
): FortnoxAccountMappingRowInput => ({
  role,
  vatTreatment:
    role === 'HYRESINTAKT' ? 'MOMSFRI' : role === 'INGAENDE_MOMS' ? 'AVDRAGSGILL' : 'EJ_TILLAMPLIG',
  sourceAccountNumber,
  targetAccountNumber,
})
/** Hela den syntetiska kundens mappning: 3911→3915 och 1930→1940 är ANDRA målnummer. */
const FULL = [
  R('KUNDFORDRAN', 1510, 1510),
  R('HYRESINTAKT', 3911, 3915),
  R('LIKVID', 1930, 1940),
  R('DEPOSITIONSSKULD', 2890, 2890),
  R('KOSTNAD', 5170, 5170),
  R('INGAENDE_MOMS', 2641, 2641),
  R('LEVERANTORSSKULD', 2440, 2440),
]
const AGARE = { sub: 'u-agare', role: 'OWNER' }

medDb('TESTKUND-008: kontomappning för Fortnox-export', () => {
  let prisma: PrismaClient
  const orgs: string[] = []
  beforeAll(() => {
    prisma = new PrismaClient()
  })
  afterAll(async () => {
    for (const id of orgs) {
      await prisma.fortnoxVoucherExport.deleteMany({ where: { organizationId: id } })
      await prisma.fortnoxReadRun.deleteMany({ where: { organizationId: id } })
      await prisma.journalEntryLine.deleteMany({ where: { journalEntry: { organizationId: id } } })
      await prisma.journalEntry.deleteMany({ where: { organizationId: id } })
      await stadaKontomappning(prisma, id)
      await prisma.rentNoticePayment.deleteMany({ where: { rentNotice: { organizationId: id } } })
      await prisma.deposit.deleteMany({ where: { organizationId: id } })
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

  async function setup() {
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
    reader.accounts = FORTNOX.map((a) => ({ ...a })) as unknown as typeof reader.accounts
    reader.financialYears = [
      { Id: 1, FromDate: '2026-01-01', ToDate: '2026-12-31', AccountingMethod: 'ACCRUAL' },
      { Id: 2, FromDate: '2025-01-01', ToDate: '2025-12-31', AccountingMethod: 'ACCRUAL' },
    ]
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
    const readback = new FortnoxReadbackService(db, connections, reader, writer)
    const km = new FortnoxKontomappningService(db, connections, reader)
    const { authUrl } = await connections.begin(org.id, 'u1')
    const state = new URL(authUrl).searchParams.get('state')!
    await connections.handleCallback(state, `mock-code-${state.slice(0, 8)}`)
    await connections.setExportVoucherSeries(org.id, 'A')
    await connections.setExportOmitDimensions(org.id, 'u1', true)
    for (const [n, [name, type]] of Object.entries(EVENO))
      await prisma.account.create({
        data: { organizationId: org.id, number: Number(n), name, type },
      })

    const mappa = async (rows = FULL, financialYearId = 1) => {
      const u = await km.skapaUtkast(org.id, AGARE, { financialYearId, rows })
      return km.godkann(org.id, AGARE, u.id, u.contentSha256)
    }
    let ver = 0
    const verifikat = async (
      rader: Array<[number, number | null, number | null]>,
      extra: Record<string, unknown> = {},
      datum = '2026-10-02',
    ) => {
      const lines = []
      for (const [n, d, c] of rader) {
        const acc =
          (await prisma.account.findFirst({ where: { organizationId: org.id, number: n } })) ??
          (await prisma.account.create({
            data: { organizationId: org.id, number: n, name: `Konto ${n}`, type: 'EXPENSE' },
          }))
        lines.push({
          accountId: acc.id,
          ...(d !== null ? { debit: d } : {}),
          ...(c !== null ? { credit: c } : {}),
        })
      }
      ver += 1
      return prisma.journalEntry.create({
        data: {
          organizationId: org.id,
          date: new Date(datum),
          description: `KM ${ver}`,
          fiscalYear: Number(datum.slice(0, 4)),
          verNumber: ver,
          lines: { create: lines },
          ...extra,
        },
      })
    }
    const prop = await prisma.property.create({
      data: {
        organizationId: org.id,
        name: 'Syntetisk',
        propertyDesignation: `km-${sfx}`,
        type: 'RESIDENTIAL',
        street: 's',
        city: 'c',
        postalCode: '1',
        totalArea: '100',
      },
    })
    let lgh = 0
    /** Bostadsenhet → hyresgäst → avtal (utan verifikat). */
    const avtal = async (netto = 6000) => {
      lgh += 1
      const unit = await prisma.unit.create({
        data: {
          propertyId: prop.id,
          name: `Lgh ${lgh}`,
          unitNumber: String(lgh),
          type: 'APARTMENT',
          area: '50',
          monthlyRent: String(netto),
        },
      })
      const ten = await prisma.tenant.create({
        data: {
          organizationId: org.id,
          type: 'INDIVIDUAL',
          firstName: 'S',
          lastName: `T${lgh}`,
          email: `t-${sfx}-${lgh}@example.invalid`,
        },
      })
      const lease = await prisma.lease.create({
        data: {
          organizationId: org.id,
          unitId: unit.id,
          tenantId: ten.id,
          contractNumber: `KM-${sfx}-${lgh}`,
          status: 'ACTIVE',
          startDate: new Date('2026-01-01'),
          tenancyStartDate: new Date('2026-01-01'),
          monthlyRent: String(netto),
          depositAmount: '0',
        },
      })
      return { unit, ten, lease }
    }
    /** H1: hyresavi för bostad (riktig enhet → avtal → avi → verifikat rent-notice:<id>). */
    const avi = async (netto = 6000) => {
      const { unit, ten, lease } = await avtal(netto)
      const notice = await prisma.rentNotice.create({
        data: {
          organizationId: org.id,
          tenantId: ten.id,
          leaseId: lease.id,
          noticeNumber: `AVI-KM-${sfx}-${lgh}`,
          ocrNumber: '1',
          month: 10,
          year: 2026,
          amount: String(netto),
          vatAmount: '0',
          totalAmount: String(netto),
          dueDate: new Date('2026-09-30'),
        },
      })
      const je = await verifikat(
        [
          [1510, netto, null],
          [3911, null, netto],
        ],
        { source: 'RENT_NOTICE', sourceId: `rent-notice:${notice.id}` },
      )
      return { je, notice, unit, lease, ten }
    }
    /** H2: hyresbetalning med riktig allokering. */
    const betalning = async (noticeId: string, belopp: number) => {
      const alloc = await prisma.rentNoticePayment.create({
        data: {
          rentNoticeId: noticeId,
          amount: String(belopp),
          paidAt: new Date('2026-10-02'),
          source: 'MANUAL',
        },
      })
      return verifikat(
        [
          [1930, belopp, null],
          [1510, null, belopp],
        ],
        { source: 'PAYMENT', sourceId: `rent-notice-payment:${alloc.id}` },
      )
    }
    /** H3: deposition (faktura, betalning, återbetalning utan avdrag). */
    const deposition = async (belopp: number) => {
      const { lease, ten } = await avtal()
      const dep = await prisma.deposit.create({
        data: {
          organizationId: org.id,
          leaseId: lease.id,
          tenantId: ten.id,
          amount: String(belopp),
        },
      })
      return {
        dep,
        faktura: () =>
          verifikat(
            [
              [1510, belopp, null],
              [2890, null, belopp],
            ],
            { source: 'INVOICE', sourceId: `deposit-invoice:${dep.id}` },
          ),
        betalning: () =>
          verifikat(
            [
              [1930, belopp, null],
              [1510, null, belopp],
            ],
            { source: 'PAYMENT', sourceId: `deposit-manual-payment:${dep.id}` },
          ),
        aterbetalning: () =>
          verifikat(
            [
              [2890, belopp, null],
              [1930, null, belopp],
            ],
            { source: 'PAYMENT', sourceId: `deposit-refund:${dep.id}` },
          ),
      }
    }
    /** H4: leverantörsfaktura med 25 % ingående moms, och betalning. */
    const leverantor = async (netto: number, kostnadskonto = 5170) => {
      const moms = Math.round(netto * 25) / 100
      const f = await prisma.supplierInvoice.create({
        data: {
          organizationId: org.id,
          supplierName: 'Syntetisk leverantör',
          description: 'Reparation',
          invoiceDate: new Date('2026-10-02'),
          dueDate: new Date('2026-10-30'),
          expenseAccount: kostnadskonto,
          netAmount: String(netto),
          vatRate: 25,
          vatAmount: String(moms),
          totalAmount: String(netto + moms),
        },
      })
      return {
        mottagande: () =>
          verifikat(
            [
              [kostnadskonto, netto, null],
              [2641, moms, null],
              [2440, null, netto + moms],
            ],
            { source: 'SUPPLIER_INVOICE', sourceId: `supplier-invoice:${f.id}` },
          ),
        betalning: () =>
          verifikat(
            [
              [2440, netto + moms, null],
              [1930, null, netto + moms],
            ],
            { source: 'SUPPLIER_INVOICE', sourceId: `supplier-invoice-payment:${f.id}` },
          ),
      }
    }
    const dry = async (jeId: string) =>
      (await exports.dryRun(org.id, jeId)) as {
        id: string
        state: string
        draftHash: string | null
        blockReason: string | null
      }
    const skicka = async (jeId: string) => {
      const row = await dry(jeId)
      expect([row.state, row.blockReason]).toEqual(['DRY_RUN_READY', null])
      const res = await sender.send(org.id, 'u1', row.id, row.draftHash!)
      expect(res.state).toBe('CONFIRMED')
      return row
    }
    return {
      org,
      reader,
      writer,
      connections,
      builder,
      exports,
      sender,
      readback,
      km,
      mappa,
      verifikat,
      avi,
      betalning,
      deposition,
      leverantor,
      dry,
      skicka,
    }
  }
  type T = Awaited<ReturnType<typeof setup>>
  const rader = (t: T) =>
    t.reader.vouchers.map((v) =>
      (v.VoucherRows as Array<{ Account: number; Debit?: number; Credit?: number }>).map((r) => [
        r.Account,
        r.Debit ?? 0,
        r.Credit ?? 0,
      ]),
    )

  // ── Positiv kedja och återläsning (K7.4, K11.4, V7) ─────────────────────────────────────

  it('K11.4/V7: H1→H2→H3→H4 CONFIRMED lokalt med mappade konton (3911→3915, 1930→1940); återläsningen stämmer saldo för 1510, bank och 2890 mot Eveno + IB, en gång, med båda etiketterna', async () => {
    const t = await setup()
    // IB i Fortnox (öppningen före brytdatum) — samma belopp som Evenos öppningskomponent.
    const ib: Record<number, number> = { 1510: 150000, 1940: 0, 2890: -300000 }
    for (const [n, v] of Object.entries(ib))
      t.reader.accounts.find((a) => a.Number === Number(n))!.BalanceBroughtForward = v / 100
    const rev = await t.mappa()
    expect(rev.status).toBe('APPROVED')
    const h1a = await t.avi(6000)
    const h1b = await t.avi(6000) // obetald: lämnar 6 000 på 1510
    await t.skicka(h1a.je.id)
    await t.skicka(h1b.je.id)
    await t.skicka((await t.betalning(h1a.notice.id, 6000)).id)
    const dA = await t.deposition(12000)
    const dB = await t.deposition(8000)
    for (const d of [dA, dB]) {
      await t.skicka((await d.faktura()).id)
      await t.skicka((await d.betalning()).id)
    }
    await t.skicka((await dB.aterbetalning()).id)
    const lev = await t.leverantor(400)
    await t.skicka((await lev.mottagande()).id)
    await t.skicka((await lev.betalning()).id)
    // Fejken har exakt de skickade verifikaten, med MÅLkonton: 3915 och 1940, aldrig 3911/1930.
    const alla = rader(t).flat()
    expect(alla.some(([a]) => a === 3911 || a === 1930)).toBe(false)
    expect(rader(t)[0]).toEqual([
      [1510, 6000, 0],
      [3915, 0, 6000],
    ])
    expect(t.writer.writes).toBe(t.reader.vouchers.length)

    const run = await t.readback.read(t.org.id, 'u1', {
      financialYearId: 1,
      periodFrom: '2026-01-01',
      periodTo: '2026-12-31',
      costAccounts: [1510, 1940, 2890, 3915],
    })
    expect(run.status).toBe('COMPLETE')
    const sparad = await prisma.fortnoxReadRun.findUniqueOrThrow({ where: { id: run.id } })
    const lasta = (sparad.rows as unknown as { rows: LedgerRowProvenance[] }).rows
    const sum = sparad.summary as unknown as { totalOre: number; evenoExportOre: number }
    // Ingen dubbelräkning: alla återlästa rader är Evenos egna, och de räknas en gång.
    expect(lasta.every((r) => r.evenoExport)).toBe(true)
    expect(sum.evenoExportOre).toBe(sum.totalOre)
    expect(new Set(lasta.map((r) => `${r.voucher}#${r.row}`)).size).toBe(lasta.length)
    // Proveniens: Fortnox-konto ↔ Eveno-källkonto ↔ revision.
    expect(
      new Set(lasta.filter((r) => r.account === 1940).map((r) => r.evenoSource?.sourceAccount)),
    ).toEqual(new Set([1930]))
    expect(
      new Set(lasta.filter((r) => r.account === 3915).map((r) => r.evenoSource?.sourceAccount)),
    ).toEqual(new Set([3911]))
    expect(new Set(lasta.map((r) => r.evenoSource?.mappingRevision))).toEqual(
      new Set([rev.revision]),
    )

    // Saldo per mappat konto: Fortnox (IB + återlästa rader) = Eveno (öppning = IB + egna verifikat).
    const evenoRorelse = async (n: number) => {
      const l = await prisma.journalEntryLine.findMany({
        where: { journalEntry: { organizationId: t.org.id }, account: { number: n } },
        select: { debit: true, credit: true },
      })
      return l.reduce(
        (s, x) =>
          s + Math.round(Number(x.debit ?? 0) * 100) - Math.round(Number(x.credit ?? 0) * 100),
        0,
      )
    }
    const tabell: Array<[string, number, number, number]> = []
    for (const [fortnox, eveno, namn] of [
      [1510, 1510, 'Kundfordringar ↔ Kundfordringar'],
      [1940, 1930, 'Övriga bankkonton ↔ Företagskonto / Bank'],
      [2890, 2890, 'Övriga kortfristiga skulder ↔ Mottagna depositioner (hyresgäster)'],
    ] as const) {
      const fx =
        ib[fortnox]! +
        lasta.filter((r) => r.account === fortnox).reduce((s, r) => s + r.amountOre, 0)
      const ev = ib[fortnox]! + (await evenoRorelse(eveno))
      tabell.push([namn, fortnox, fx, ev])
      expect([fortnox, fx]).toEqual([fortnox, ev])
    }
    // Uträknat för hand: 1510 = IB 1 500 + 6 000 + 6 000 − 6 000 + 12 000 − 12 000 + 8 000 − 8 000;
    // bank = 6 000 + 12 000 + 8 000 − 8 000 − 500; 2890 = IB −3 000 − 12 000 − 8 000 + 8 000.
    expect(tabell.map(([, n, fx]) => [n, fx])).toEqual([
      [1510, 750000],
      [1940, 1750000],
      [2890, -1500000],
    ])
    console.warn('[K7.4 saldotabell]', JSON.stringify(tabell))
  })

  // ── Godkännbarhet: teknik skild från innebörd (K3) och V4 ──────────────────────────────

  it('K3.1/V4: KONFLIKT och EJ_BELAGD kan aldrig godkännas; V4 kräver 1510/2890; teknik ≠ innebörd (3990 MF är tekniskt förenligt)', async () => {
    const t = await setup()
    const fall: Array<[FortnoxAccountMappingRowInput, string, RegExp | null]> = [
      [R('HYRESINTAKT', 3911, 3911), 'KONFLIKT', /inaktivt/],
      [R('HYRESINTAKT', 3911, 3970), 'EJ_BELAGD', /saknar momskod/],
      [R('KUNDFORDRAN', 1510, 2611), 'KONFLIKT', /momskod U1/],
      [R('INGAENDE_MOMS', 2641, 2440), 'EJ_BELAGD', /saknar momskod/],
      [R('KOSTNAD', 5170, 2641), 'KONFLIKT', /momskod I/],
      [R('KUNDFORDRAN', 1510, 1930), 'FORENLIG', /måste mappas till Fortnox 1510/],
      [R('DEPOSITIONSSKULD', 2890, 2350), 'FORENLIG', /måste mappas till Fortnox 2890/],
      [R('HYRESINTAKT', 3911, 3990), 'FORENLIG', null],
      [R('LIKVID', 1930, 1940), 'FORENLIG', null],
    ]
    for (const [rad, teknik, hinder] of fall) {
      const u = await t.km.skapaUtkast(t.org.id, AGARE, { financialYearId: 1, rows: [rad] })
      const r = await prisma.fortnoxAccountMappingRow.findFirstOrThrow({
        where: { revisionId: u.id },
      })
      expect([rad.targetAccountNumber, r.technical]).toEqual([rad.targetAccountNumber, teknik])
      const g = t.km.godkann(t.org.id, AGARE, u.id, u.contentSha256)
      if (hinder) await expect(g).rejects.toThrow(hinder)
      else expect((await g).status).toBe('APPROVED')
    }
    // Översikten visar 3990:s Fortnox-namn bredvid Evenos — innebörden är kundens ansvar.
    const o = await t.km.oversikt(t.org.id)
    const r3990 = o.revisioner.flatMap((r) => r.rows).find((x) => x.targetAccountNumber === 3990)!
    expect([r3990.sourceAccountName, r3990.targetName, r3990.technical]).toEqual([
      'Hyresintäkter, bostäder',
      'Övriga ersättningar, bidrag och intäkter',
      'FORENLIG',
    ])
  })

  it('V2/F7/F8: godkännande läser målen färskt; gammal sha, äldre utkast och drift före godkännande ger 409', async () => {
    const t = await setup()
    const u1 = await t.km.skapaUtkast(t.org.id, AGARE, { financialYearId: 1, rows: FULL })
    await expect(t.km.godkann(t.org.id, AGARE, u1.id, 'f'.repeat(64))).rejects.toThrow(
      /ändrats sedan du läste/,
    )
    t.reader.accounts.find((a) => a.Number === 3915)!.VATCode = 'HFS'
    await expect(t.km.godkann(t.org.id, AGARE, u1.id, u1.contentSha256)).rejects.toThrow(
      /3915 \(momskod\)/,
    )
    t.reader.accounts.find((a) => a.Number === 3915)!.VATCode = 'MF'
    const u2 = await t.km.skapaUtkast(t.org.id, AGARE, { financialYearId: 1, rows: FULL })
    await expect(t.km.godkann(t.org.id, AGARE, u1.id, u1.contentSha256)).rejects.toThrow(
      /nyare revision/,
    )
    expect((await t.km.godkann(t.org.id, AGARE, u2.id, u2.contentSha256)).status).toBe('APPROVED')
    expect(
      await prisma.fortnoxAccountMappingRevision.count({
        where: { organizationId: t.org.id, status: 'APPROVED' },
      }),
    ).toBe(1)
  })

  it('V6: två samtidiga godkännanden ger EN APPROVED; databasen avvisar en andra APPROVED för samma år', async () => {
    const t = await setup()
    const u = await t.km.skapaUtkast(t.org.id, AGARE, { financialYearId: 1, rows: FULL })
    const res = await Promise.allSettled([
      t.km.godkann(t.org.id, AGARE, u.id, u.contentSha256),
      t.km.godkann(t.org.id, AGARE, u.id, u.contentSha256),
    ])
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const u2 = await t.km.skapaUtkast(t.org.id, AGARE, { financialYearId: 1, rows: FULL })
    await expect(
      prisma.fortnoxAccountMappingRevision.update({
        where: { id: u2.id },
        data: { status: 'APPROVED' },
      }),
    ).rejects.toThrow(/Unique constraint/)
    // Annat år får en egen APPROVED (V5a).
    const u3 = await t.km.skapaUtkast(t.org.id, AGARE, { financialYearId: 2, rows: FULL })
    expect((await t.km.godkann(t.org.id, AGARE, u3.id, u3.contentSha256)).status).toBe('APPROVED')
  })

  // ── Export: härkomst, nyckel och ursprung ─────────────────────────────────────────────

  it('K2.2/(j): en obevisad (manuell) intäktsrad på 3911 blir inte exporterbar trots godkänd rad 3911→3915', async () => {
    const t = await setup()
    await t.mappa()
    const je = await t.verifikat([
      [1510, 6000, null],
      [3911, null, 6000],
    ])
    expect((await t.dry(je.id)).blockReason).toMatch(
      /^ACCOUNT_UNVERIFIED.*3911.*obevisad: momsbehandling kan inte beläggas \(källa MANUAL\)/,
    )
    const kost = await t.verifikat([
      [5170, 100, null],
      [2440, null, 100],
    ])
    expect((await t.dry(kost.id)).blockReason).toMatch(/^EVENT_UNSUPPORTED: manuellt verifikat/)
  })

  it('K2.1/(i): nyckeln är (roll, källkonto, behandling) — en kostnadsrad på 2641 får inte ingående moms-radens mappning', async () => {
    const t = await setup()
    await t.mappa()
    const lev = await t.leverantor(400, 2641)
    expect((await t.dry((await lev.mottagande()).id)).blockReason).toMatch(
      /^ACCOUNT_MAPPING_MISSING: Konto 2641 .* som kostnad/,
    )
    // Positiv kontroll: samma faktura på 5170 går igenom.
    const ok = await t.leverantor(400)
    expect((await t.dry((await ok.mottagande()).id)).state).toBe('DRY_RUN_READY')
  })

  it('(b): en annan organisations godkända revision gäller aldrig — utan egen revision blir det MISSING', async () => {
    const a = await setup()
    const b = await setup()
    await b.mappa()
    const lev = await a.leverantor(100)
    expect((await a.dry((await lev.mottagande()).id)).blockReason).toMatch(
      /^ACCOUNT_MAPPING_MISSING: Ingen godkänd kontomappning/,
    )
    // Och B:s revision kan inte godkännas eller läsas från A.
    const u = await b.km.skapaUtkast(b.org.id, AGARE, { financialYearId: 1, rows: FULL })
    await expect(a.km.godkann(a.org.id, AGARE, u.id, u.contentSha256)).rejects.toThrow(
      /hittades inte/,
    )
    expect((await a.km.oversikt(a.org.id)).revisioner).toEqual([])
  })

  it('K8.2/V3: betalning före fordran stoppas i ordningen; UNKNOWN/DRY_RUN_READY/annat företag/öppningsavi utan verkställt paket räcker inte', async () => {
    const t = await setup()
    await t.mappa()
    const h1 = await t.avi(6000)
    const bet = await t.betalning(h1.notice.id, 6000)
    expect((await t.dry(bet.id)).blockReason).toMatch(/^ORIGIN_NOT_CONFIRMED: Hyresavins fordran/)
    // Avin är DRY_RUN_READY, sedan UNKNOWN, sedan CONFIRMED i ANNAT företag — inget räcker.
    const aviRow = await t.dry(h1.je.id)
    expect(aviRow.state).toBe('DRY_RUN_READY')
    expect((await t.dry(bet.id)).blockReason).toMatch(/^ORIGIN_NOT_CONFIRMED/)
    for (const data of [
      { state: 'UNKNOWN' as const },
      { state: 'CONFIRMED' as const, fortnoxDatabaseNumber: 1 },
    ]) {
      await prisma.fortnoxVoucherExport.update({ where: { id: aviRow.id }, data })
      expect((await t.dry(bet.id)).blockReason).toMatch(/^ORIGIN_NOT_CONFIRMED/)
    }
    await prisma.fortnoxVoucherExport.update({
      where: { id: aviRow.id },
      data: { state: 'DRY_RUN_READY', fortnoxDatabaseNumber: null },
    })
    await t.skicka(h1.je.id)
    expect((await t.dry(bet.id)).state).toBe('DRY_RUN_READY')
    // Öppningsavi utan verkställt paket (V3b): ursprunget är inte belagt.
    const h1o = await t.avi(3000)
    await prisma.rentNotice.update({
      where: { id: h1o.notice.id },
      data: { origin: 'OPENING_PACKAGE' },
    })
    expect((await t.dry((await t.betalning(h1o.notice.id, 3000)).id)).blockReason).toMatch(
      /^ORIGIN_NOT_CONFIRMED: Fordran ingår inte i ett verkställt öppningspaket/,
    )
    // H3 och H4 följer samma regel.
    const d = await t.deposition(5000)
    const dBet = await d.betalning()
    expect((await t.dry(dBet.id)).blockReason).toMatch(/^ORIGIN_NOT_CONFIRMED: Depositionsfakturan/)
    const lev = await t.leverantor(100)
    const levBet = await lev.betalning()
    expect((await t.dry(levBet.id)).blockReason).toMatch(
      /^ORIGIN_NOT_CONFIRMED: Leverantörsfakturan/,
    )
    await t.skicka((await d.faktura()).id)
    await t.skicka((await lev.mottagande()).id)
    expect((await t.dry(dBet.id)).state).toBe('DRY_RUN_READY')
    expect((await t.dry(levBet.id)).state).toBe('DRY_RUN_READY')
  })

  // ── Färskhet, bindning och replay (K6) ───────────────────────────────────────────────

  it('F1/(a): ny revision mellan förhandskontroll och sändning → 409, 0 POST', async () => {
    const t = await setup()
    await t.mappa()
    const lev = await t.leverantor(100)
    const row = await t.dry((await lev.mottagande()).id)
    expect(row.state).toBe('DRY_RUN_READY')
    // Samma innehåll, ny revision (annat godkännande).
    await t.mappa()
    const fore = t.reader.vouchers.length
    await expect(t.sender.send(t.org.id, 'u1', row.id, row.draftHash!)).rejects.toThrow(
      /^Underlaget är inte längre aktuellt; gör en ny förhandskontroll$/,
    )
    expect(t.reader.vouchers.length).toBe(fore)
  })

  it('F2/(d): drift i målets metadata efter förhandskontroll → 409, 0 POST; ny förhandskontroll ger ACCOUNT_MAPPING_DRIFT även om koden vore "förenlig"', async () => {
    const t = await setup()
    await t.mappa()
    const { je } = await t.avi(6000)
    const row = await t.dry(je.id)
    expect(row.state).toBe('DRY_RUN_READY')
    t.reader.accounts.find((a) => a.Number === 3915)!.Description = 'Bostadshyror (omdöpt)'
    const fore = t.reader.vouchers.length
    await expect(t.sender.send(t.org.id, 'u1', row.id, row.draftHash!)).rejects.toThrow(
      /inte längre aktuellt/,
    )
    expect(t.reader.vouchers.length).toBe(fore)
    expect((await t.dry(je.id)).blockReason).toMatch(
      /^ACCOUNT_MAPPING_DRIFT: Fortnox-konto 3915 .*\(namn\)/,
    )
  })

  it('F3/F4 (V5a): återanslutning ger STALE; verifikat i ett år utan godkänd revision ger MISSING och blir READY först med årets egen revision', async () => {
    const t = await setup()
    await t.mappa()
    const lev = await t.leverantor(100)
    const mott = await lev.mottagande()
    expect((await t.dry(mott.id)).state).toBe('DRY_RUN_READY')
    // F4: 2025-verifikat (år 2) — revisionen för år 1 gäller inte.
    const f25 = await prisma.supplierInvoice.create({
      data: {
        organizationId: t.org.id,
        supplierName: 'S',
        description: 'R',
        invoiceDate: new Date('2025-11-02'),
        dueDate: new Date('2025-11-30'),
        expenseAccount: 5170,
        netAmount: '100',
        vatRate: 0,
        vatAmount: '0',
        totalAmount: '100',
      },
    })
    const je25 = await t.verifikat(
      [
        [5170, 100, null],
        [2440, null, 100],
      ],
      { source: 'SUPPLIER_INVOICE', sourceId: `supplier-invoice:${f25.id}` },
      '2025-11-02',
    )
    expect((await t.dry(je25.id)).blockReason).toMatch(
      /^ACCOUNT_MAPPING_MISSING: Ingen godkänd kontomappning för räkenskapsår 2/,
    )
    await t.mappa(FULL, 2)
    expect((await t.dry(je25.id)).state).toBe('DRY_RUN_READY')
    // F3: ny anslutningsgeneration.
    await prisma.fortnoxConnection.update({
      where: { organizationId: t.org.id },
      data: { generation: { increment: 1 } },
    })
    expect((await t.dry(mott.id)).blockReason).toMatch(/^ACCOUNT_MAPPING_STALE/)
  })

  it('F5/F6/(e): CONFIRMED skickas aldrig om; UNKNOWN förblir låst även efter ny revision', async () => {
    const t = await setup()
    await t.mappa()
    const lev = await t.leverantor(100)
    const row = await t.skicka((await lev.mottagande()).id)
    const fore = t.reader.vouchers.length
    await expect(t.sender.send(t.org.id, 'u1', row.id, row.draftHash!)).rejects.toThrow()
    expect(
      (
        await t.dry(
          (await prisma.fortnoxVoucherExport.findUniqueOrThrow({ where: { id: row.id } }))
            .journalEntryId,
        )
      ).state,
    ).toBe('CONFIRMED')
    const lev2 = await t.leverantor(200)
    const je2 = await lev2.mottagande()
    const r2 = await t.dry(je2.id)
    await prisma.fortnoxVoucherExport.update({ where: { id: r2.id }, data: { state: 'UNKNOWN' } })
    await t.mappa()
    expect((await t.dry(je2.id)).state).toBe('UNKNOWN')
    await expect(t.sender.send(t.org.id, 'u1', r2.id, r2.draftHash!)).rejects.toThrow()
    expect(t.reader.vouchers.length).toBe(fore)
  })

  it('V1/K2.3: rättelse bokas på originalets exporterade mål; annan revision för raden → REVERSAL_TARGET_CHANGED, ingen tyst omkontering', async () => {
    const t = await setup()
    await t.mappa()
    const lev = await t.leverantor(100)
    const mott = await lev.mottagande()
    await t.skicka(mott.id)
    const rattelse = await t.verifikat(
      [
        [2440, 125, null],
        [2641, null, 25],
        [5170, null, 100],
      ],
      { reversalOfEntryId: mott.id },
    )
    expect((await t.dry(rattelse.id)).state).toBe('DRY_RUN_READY')
    await t.mappa(FULL.map((r) => (r.role === 'KOSTNAD' ? R('KOSTNAD', 5170, 5460) : r)))
    expect((await t.dry(rattelse.id)).blockReason).toMatch(
      /^REVERSAL_TARGET_CHANGED: .*5170 → 5170; revision 2 mappar till 5460/,
    )
  })

  // ── Historiken ändras aldrig (K5.1) ──────────────────────────────────────────────────

  it('K5.1: mappning, export och ny revision ändrar inga Eveno-verifikat eller belopp', async () => {
    const t = await setup()
    const h1 = await t.avi(6000)
    const lev = await t.leverantor(100)
    const mott = await lev.mottagande()
    const avtryck = async () =>
      createHash('sha256')
        .update(
          JSON.stringify(
            await prisma.journalEntry.findMany({
              where: { organizationId: t.org.id },
              orderBy: { id: 'asc' },
              select: {
                id: true,
                date: true,
                description: true,
                sourceId: true,
                lines: {
                  orderBy: { id: 'asc' },
                  select: { id: true, accountId: true, debit: true, credit: true },
                },
              },
            }),
          ),
        )
        .digest('hex')
    const fore = await avtryck()
    await t.mappa()
    await t.skicka(h1.je.id)
    await t.skicka(mott.id)
    await t.mappa(FULL.map((r) => (r.role === 'LIKVID' ? R('LIKVID', 1930, 1930) : r)))
    expect(await avtryck()).toBe(fore)
  })

  // ── AI (K7.3) ─────────────────────────────────────────────────────────────────────────

  it('K7.3: AI-texten namnger Fortnox-kontot och dess Eveno-källa, utan Fortnox-fritext', async () => {
    const t = await setup()
    await t.mappa()
    const text = formatFortnoxShadowForAi(await t.readback.aiSnapshot(t.org.id)).join('\n')
    expect(text).toMatch(/Fortnox 3915 ← Eveno 3911 \(hyresintäkt\)/)
    expect(text).toMatch(/Fortnox 1940 ← Eveno 1930 \(bank\)/)
    expect(text).not.toMatch(/syntetiskt|Övriga bankkonton/)
  })

  // ── Roller och organisation över HTTP (K9) ───────────────────────────────────────────

  describe('HTTP: roller, organisation och kontrakt', () => {
    const HEMLIGHET = 'km-008-syntetisk-provhemlighet'
    let app: NestFastifyApplication
    let t: T
    let annan: T
    const jwt = new JwtService({ secret: HEMLIGHET })
    const token = (role: string, organizationId = t.org.id, secret = HEMLIGHET) =>
      new JwtService({ secret }).sign({ sub: `u-${role}`, organizationId, role })
    const anrop = (method: 'GET' | 'POST', url: string, auth: string, payload?: unknown) =>
      app.inject({
        method,
        url: `/v1/integrations/fortnox/${url}`,
        headers: { authorization: `Bearer ${auth}` },
        ...(payload !== undefined ? { payload: payload as object } : {}),
      })
    void jwt

    beforeAll(async () => {
      t = await setup()
      annan = await setup()
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
          {
            provide: ConfigService,
            useValue: { getOrThrow: () => HEMLIGHET, get: () => undefined },
          },
          { provide: FortnoxConnectionService, useValue: t.connections },
          { provide: FortnoxReadbackService, useValue: orort('FortnoxReadbackService') },
          { provide: FortnoxExportService, useValue: orort('FortnoxExportService') },
          { provide: FortnoxMappingService, useValue: orort('FortnoxMappingService') },
          { provide: FortnoxSendService, useValue: orort('FortnoxSendService') },
          { provide: FortnoxKontomappningService, useValue: t.km },
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
    }, 60_000)
    afterAll(async () => {
      await app?.close()
    })

    it('G1–G5: OWNER/ADMIN skapar och godkänner; ACCOUNTANT läser men får 403 på skrivning; MANAGER/VIEWER 403; hyresgästportalens token 401; annan organisation 404', async () => {
      const kropp = { financialYearId: 1, rows: FULL }
      for (const roll of ['MANAGER', 'VIEWER', 'ACCOUNTANT'])
        expect(
          (await anrop('POST', 'account-mapping/revisions', token(roll), kropp)).statusCode,
        ).toBe(403)
      for (const roll of ['MANAGER', 'VIEWER'])
        expect((await anrop('GET', 'account-mapping', token(roll))).statusCode).toBe(403)
      expect((await anrop('GET', 'account-mapping', token('ACCOUNTANT'))).statusCode).toBe(200)
      expect(
        (
          await anrop(
            'GET',
            'account-mapping',
            token('OWNER', t.org.id, 'hyresgastportalens-hemlighet'),
          )
        ).statusCode,
      ).toBe(401)
      const skapad = await anrop('POST', 'account-mapping/revisions', token('ADMIN'), {
        ...kropp,
        organizationId: annan.org.id,
      })
      // Okänt fält (organizationId) avvisas av kontraktet — organisationen tas ur JWT.
      expect(skapad.statusCode).toBe(400)
      const ok = await anrop('POST', 'account-mapping/revisions', token('ADMIN'), kropp)
      expect(ok.statusCode).toBe(201)
      const rev = (ok.json() as { data: { id: string; contentSha256: string } }).data
      expect(
        (await prisma.fortnoxAccountMappingRevision.findUniqueOrThrow({ where: { id: rev.id } }))
          .organizationId,
      ).toBe(t.org.id)
      expect(
        (
          await anrop('POST', `account-mapping/revisions/${rev.id}/approve`, token('ACCOUNTANT'), {
            contentSha256: rev.contentSha256,
          })
        ).statusCode,
      ).toBe(403)
      // Annan organisation kan inte godkänna (404, ingen ändring).
      const fran = await anrop(
        'POST',
        `account-mapping/revisions/${rev.id}/approve`,
        token('OWNER', annan.org.id),
        { contentSha256: rev.contentSha256 },
      )
      expect(fran.statusCode).toBe(404)
      expect(
        (
          await anrop('POST', `account-mapping/revisions/${randomUUID()}/approve`, token('OWNER'), {
            contentSha256: rev.contentSha256,
          })
        ).statusCode,
      ).toBe(404)
      expect(
        (await prisma.fortnoxAccountMappingRevision.findUniqueOrThrow({ where: { id: rev.id } }))
          .status,
      ).toBe('DRAFT')
      const g = await anrop('POST', `account-mapping/revisions/${rev.id}/approve`, token('ADMIN'), {
        contentSha256: rev.contentSha256,
      })
      expect(g.statusCode).toBe(201)
      const sparad = await prisma.fortnoxAccountMappingRevision.findUniqueOrThrow({
        where: { id: rev.id },
      })
      expect([sparad.status, sparad.approvedById, sparad.approvedByRole]).toEqual([
        'APPROVED',
        'u-ADMIN',
        'ADMIN',
      ])
    })

    it('G6: samma validering som det delade schemat (fel behandling, konto utanför 1000–9999, dubbla nycklar, sträng som tal)', async () => {
      const rad = R('HYRESINTAKT', 3911, 3915)
      for (const fel of [
        { financialYearId: 1, rows: [{ ...rad, vatTreatment: 'EJ_TILLAMPLIG' }] },
        { financialYearId: 1, rows: [{ ...rad, targetAccountNumber: 10000 }] },
        { financialYearId: 1, rows: [rad, rad] },
        { financialYearId: 1, rows: [{ ...rad, sourceAccountNumber: '3911' }] },
        { financialYearId: 1, rows: [] },
      ])
        expect(
          (await anrop('POST', 'account-mapping/revisions', token('OWNER'), fel)).statusCode,
        ).toBe(400)
      expect(
        (
          await anrop('POST', `account-mapping/revisions/${randomUUID()}/approve`, token('OWNER'), {
            contentSha256: 'A'.repeat(64),
          })
        ).statusCode,
      ).toBe(400)
    })
  })
})
