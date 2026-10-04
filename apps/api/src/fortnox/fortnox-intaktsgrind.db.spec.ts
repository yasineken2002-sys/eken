/**
 * TESTKUND-20261004/006 (F-TK-5, F-TK-6, G-1, G-2, G-3): intäktsrader får inte exporteras till
 * Fortnox på en gissad kontoinnebörd. Fryst acceptans: CLAUDE1/AKCEPTANS-006.md.
 *
 * Fortnox-kontona nedan är de VERKLIGA svaren ur testföretaget 1868238 (Bas 2026), uttagna ur
 * R0-REAL-001 (`svar-0011…0024-GET-accounts.json`, identiska med R0-REAL-002; sha256 över de 14
 * filernas sha256-rader i ordning: e621532a97135a8034a8f922945761ef58b57c8fc3b2be47a40252ad335b86b6). Varianterna
 * ("aktiverat 3911" m.m.) är uttryckliga provfall, inte observerade värden.
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
import * as grind from './fortnox-intaktsgrind'
import { basChartFor } from '../accounting/bas-chart'

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

medDb('TESTKUND-006: intäktsgrind före Fortnox-export', () => {
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
        name: `igr-${sfx}`,
        email: `igr-${sfx}@example.invalid`,
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
      const je = await verifikat(rader, { source: 'RENT_NOTICE', sourceId: `rent-notice:${n.id}` })
      return { je, unit, notice: n }
    }
    return { org, reader, builder, exports, sender, writer, verifikat, avi }
  }
  const skal = (o: { ok: boolean; reasons?: string[] }) =>
    o.ok ? 'OK' : (o.reasons ?? []).join(' | ')

  it('A1 verkligt 3911 (inaktivt, HFS): ACCOUNT_UNVERIFIED med båda namnen, aktivitet och momskod', async () => {
    const t = await setup()
    const { je } = await t.avi('APARTMENT', 6000, 0)
    const o = await t.builder.build(t.org.id, je.id)
    expect(o.ok).toBe(false)
    expect(skal(o)).toMatch(/^ACCOUNT_UNVERIFIED/)
    expect(skal(o)).toMatch(/3911/)
    expect(skal(o)).toMatch(/Hyresintäkter, bostäder/)
    expect(skal(o)).toMatch(/«Hyresintäkter»/)
    expect(skal(o)).toMatch(/inaktivt/)
    expect(skal(o)).toMatch(/HFS/)
  })

  it('A2 3911 aktiverat men HFS kvar: ACCOUNT_VAT_MISMATCH (momsfri rad på HFS)', async () => {
    const t = await setup({ 3911: { Active: true } })
    const { je } = await t.avi('APARTMENT', 6000, 0)
    expect(skal(await t.builder.build(t.org.id, je.id))).toMatch(
      /^ACCOUNT_VAT_MISMATCH.*3911.*HFS.*momsfri/,
    )
  })

  it('A3/A4/C-4 3911 aktivt med null, okänd kod eller MF: ACCOUNT_MEANING_UNRECONCILED; bara MF kallas förenlig (policy B-2)', async () => {
    for (const kod of [null, 'XYZ', 'MF']) {
      const t = await setup({ 3911: { Active: true, VATCode: kod } })
      const { je } = await t.avi('APARTMENT', 6000, 0)
      const s = skal(await t.builder.build(t.org.id, je.id))
      expect(s).toMatch(/^ACCOUNT_MEANING_UNRECONCILED.*3911.*ingen godkänd kontomappning/)
      if (kod === 'MF') expect(s).toMatch(/förenlig \(policy B-2\)/)
      else expect(s).not.toMatch(/förenlig/)
    }
  })

  it('B-3 rättelse ärver originalradens behandling: original (bekräftat före grinden) momsfri på HFS → rättelsen ACCOUNT_VAT_MISMATCH', async () => {
    const t = await setup({ 3911: { Active: true } })
    const { je } = await t.avi('APARTMENT', 6000, 0)
    const conn = await prisma.fortnoxConnection.findUniqueOrThrow({
      where: { organizationId: t.org.id },
    })
    await prisma.fortnoxVoucherExport.create({
      data: {
        organizationId: t.org.id,
        journalEntryId: je.id,
        state: 'CONFIRMED',
        fortnoxDatabaseNumber: conn.fortnoxDatabaseNumber,
      },
    })
    const r = await t.verifikat(
      [
        [3911, 6000, null],
        [1510, null, 6000],
      ],
      { reversalOfEntryId: je.id },
    )
    const s = skal(await t.builder.build(t.org.id, r.id))
    expect(s).toMatch(/^ACCOUNT_VAT_MISMATCH.*3911.*rättelse av hyresavi/)
  })

  it('B-5 avvikande avtal: avins avtal tillhör en annan organisation → obevisad, stopp', async () => {
    const t = await setup({ 3911: { Active: true, VATCode: 'MF' } })
    const annan = await setup()
    const { je, notice } = await t.avi('APARTMENT', 6000, 0)
    await prisma.lease.update({
      where: { id: notice.leaseId },
      data: { organizationId: annan.org.id },
    })
    const s = skal(await t.builder.build(t.org.id, je.id))
    expect(s).toMatch(/^ACCOUNT_MEANING_UNRECONCILED.*3911[^|]*obevisad: avins avtal/)
    await prisma.lease.update({ where: { id: notice.leaseId }, data: { organizationId: t.org.id } })
  })

  it('A5/A6 G-1: momspliktig parkeringsrad på MF eller null ger ACCOUNT_VAT_MISMATCH', async () => {
    for (const kod of ['MF', null]) {
      const t = await setup({ 3912: { Active: true, VATCode: kod } })
      const { je } = await t.avi('PARKING', 6000, 1500)
      expect(skal(await t.builder.build(t.org.id, je.id))).toMatch(
        /^ACCOUNT_VAT_MISMATCH.*3912.*momspliktig/,
      )
    }
  })

  it('A7 parkering på HFS: inte godkänt (B-5 öppen) → ACCOUNT_MEANING_UNRECONCILED', async () => {
    const t = await setup({ 3912: { Active: true } })
    const { je } = await t.avi('PARKING', 6000, 1500)
    expect(skal(await t.builder.build(t.org.id, je.id))).toMatch(
      /^ACCOUNT_MEANING_UNRECONCILED.*3912/,
    )
  })

  it('A8 G-2 blandat manuellt verifikat: båda intäktsraderna obevisade; 2611 gör inte 3911-raden momspliktig', async () => {
    const t = await setup({ 3911: { Active: true }, 3912: { Active: true } })
    const je = await t.verifikat([
      [1510, 13500, null],
      [3911, null, 6000],
      [3912, null, 6000],
      [2611, null, 1500],
    ])
    const s = skal(await t.builder.build(t.org.id, je.id))
    expect(s).toMatch(/^ACCOUNT_MEANING_UNRECONCILED/)
    expect(s).toMatch(/3911[^|]*obevisad/i)
    expect(s).toMatch(/3912[^|]*obevisad/i)
    expect(s).not.toMatch(/3911[^;]*momspliktig/)
    // Exportvyn: blockReason bär BÅDA kontona (ingen avklippning av konto nummer två).
    const row = (await t.exports.dryRun(t.org.id, je.id)) as {
      state: string
      blockReason?: string | null
    }
    expect(row.state).toBe('BLOCKED')
    expect(String(row.blockReason)).toMatch(
      /3911 Eveno «Hyresintäkter, bostäder».*3912 Eveno «Hyresintäkter, parkeringsplatser»/,
    )
    expect(String(row.blockReason)).toMatch(/Stäm av med redovisningsansvarig\.$/)
  })

  it('A9 G-3: vattenersättning på Fortnox 3970 (vinst vid avyttring, aktivt, null) passerar inte', async () => {
    const t = await setup()
    const je = await t.verifikat([
      [1510, 300, null],
      [3970, null, 300],
    ])
    const s = skal(await t.builder.build(t.org.id, je.id))
    expect(s).toMatch(/^ACCOUNT_MEANING_UNRECONCILED/)
    expect(s).toMatch(/Hyresgästers vattenersättning/)
    expect(s).toMatch(/Vinst vid avyttring/)
  })

  it('A10 ändrad enhet: avi bokad på 3911 men enheten är nu OFFICE → obevisad, inget tyst grönt', async () => {
    const t = await setup({ 3911: { Active: true, VATCode: 'MF' } })
    const { je, unit } = await t.avi('APARTMENT', 6000, 0)
    await prisma.unit.update({ where: { id: unit.id }, data: { type: 'OFFICE' } })
    const s = skal(await t.builder.build(t.org.id, je.id))
    expect(s).toMatch(/^ACCOUNT_MEANING_UNRECONCILED.*3911[^|]*obevisad/i)
  })

  it('A11 rättelse av hyresverifikat: inget tyst grönt', async () => {
    const t = await setup({ 3911: { Active: true, VATCode: 'MF' } })
    const { je } = await t.avi('APARTMENT', 6000, 0)
    const rattelse = await t.verifikat(
      [
        [3911, 6000, null],
        [1510, null, 6000],
      ],
      { reversalOfEntryId: je.id },
    )
    expect((await t.builder.build(t.org.id, rattelse.id)).ok).toBe(false)
  })

  it('P1–P3 positiv kontroll i samma körning: betalning, depositionsöverföring och kostnad går igenom; betalningen skickas CONFIRMED en gång (R1 replay)', async () => {
    const t = await setup()
    const bet = await t.verifikat([
      [1930, 6000, null],
      [1510, null, 6000],
    ])
    const dep = await t.verifikat([
      [1930, 12000, null],
      [2890, null, 12000],
    ])
    const kost = await t.verifikat([
      [5170, 500, null],
      [2440, null, 500],
    ])
    const kost2 = await t.verifikat([
      [6110, 200, null],
      [5460, 100, null],
      [2440, null, 300],
    ])
    for (const je of [bet, dep, kost, kost2])
      expect(skal(await t.builder.build(t.org.id, je.id))).toBe('OK')
    const row = (await t.exports.dryRun(t.org.id, bet.id)) as {
      id: string
      state: string
      draftHash: string
    }
    expect(row.state).toBe('DRY_RUN_READY')
    const fore = t.reader.vouchers.length
    expect((await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).state).toBe('CONFIRMED')
    expect(t.reader.vouchers.length).toBe(fore + 1)
    await expect(t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).rejects.toThrow()
    expect(t.reader.vouchers.length).toBe(fore + 1)
  })

  it('stopp ger 0 POST och oförändrad bokföring; exportraden är BLOCKED med skäl', async () => {
    const t = await setup({ 3911: { Active: true } })
    const { je } = await t.avi('APARTMENT', 6000, 0)
    const fore = {
      v: t.reader.vouchers.length,
      rader: await prisma.journalEntryLine.count({ where: { journalEntryId: je.id } }),
    }
    const row = (await t.exports.dryRun(t.org.id, je.id)) as {
      state: string
      blockReason?: string | null
    }
    expect(row.state).toBe('BLOCKED')
    expect(String(row.blockReason ?? '')).toMatch(/ACCOUNT_VAT_MISMATCH/)
    expect(t.reader.vouchers.length).toBe(fore.v)
    expect(await prisma.journalEntryLine.count({ where: { journalEntryId: je.id } })).toBe(
      fore.rader,
    )
  })

  it('S1 inaktuellt utkast: betalning READY, 1930 blir inaktivt i Fortnox → send 409, 0 POST', async () => {
    const t = await setup()
    const bet = await t.verifikat([
      [1930, 6000, null],
      [1510, null, 6000],
    ])
    const row = (await t.exports.dryRun(t.org.id, bet.id)) as { id: string; draftHash: string }
    t.reader.accounts.find((a) => a.Number === 1930)!.Active = false
    const fore = t.reader.vouchers.length
    await expect(t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).rejects.toThrow()
    expect(t.reader.vouchers.length).toBe(fore)
  })

  // S2 (F-006-1): ett VERKLIGT giltigt READY-utkast från före grinden. Tidigare version använde en
  // påhittad hash och passerade även med grinden borttagen (C2 N1) — den var tom.
  // Utkastet byggs med grinden urkopplad (spion: arIntaktskonto → false, alltså bygget så som det
  // var före grinden, jfr C2:s N1) så att raden får exakt den draftHash som bygget utan grind ger;
  // därefter skickas det med grinden PÅ.
  const readyUtanGrind = async (t: Awaited<ReturnType<typeof setup>>) => {
    const { je } = await t.avi('APARTMENT', 6000, 0)
    const spion = jest.spyOn(grind, 'arIntaktskonto').mockReturnValue(false)
    try {
      const row = (await t.exports.dryRun(t.org.id, je.id)) as {
        id: string
        state: string
        draftHash: string | null
      }
      expect(row.state).toBe('DRY_RUN_READY')
      expect(row.draftHash).toMatch(/^[0-9a-f]{64}$/)
      return row as { id: string; state: string; draftHash: string }
    } finally {
      spion.mockRestore()
    }
  }

  it('S2 kontroll: samma underlag och hash skickas CONFIRMED när grinden är av även vid send (utesluter hashkonflikt)', async () => {
    const t = await setup({ 3911: { Active: true } })
    const row = await readyUtanGrind(t)
    const spion = jest.spyOn(grind, 'arIntaktskonto').mockReturnValue(false)
    try {
      const fore = t.reader.vouchers.length
      expect((await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).state).toBe('CONFIRMED')
      expect(t.reader.vouchers.length).toBe(fore + 1)
    } finally {
      spion.mockRestore()
    }
  })

  it('S2 skydd: ett giltigt READY-utkast från före grinden kan inte skickas när grinden är på (409, 0 POST)', async () => {
    const t = await setup({ 3911: { Active: true } })
    const row = await readyUtanGrind(t)
    const fore = t.reader.vouchers.length
    await expect(t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).rejects.toThrow(
      /^Underlaget är inte längre aktuellt; gör en ny förhandskontroll$/,
    )
    expect(t.reader.vouchers.length).toBe(fore)
    const efter = await prisma.fortnoxVoucherExport.findUniqueOrThrow({
      where: { id: row.id },
      select: { state: true },
    })
    expect(efter.state).not.toBe('CONFIRMED')
  })

  // F-006-4 (K-F3): VARJE REVENUE-konto i Evenos kontoplan (bas-chart), med ett AKTIVT syntetiskt
  // Fortnox-svar och momskod MF respektive null, når aldrig DRY_RUN_READY — oavsett nummerklass
  // (även 8xxx). Positiv kontroll i samma prov: betalning och kostnad blir READY.
  it('F-006-4: alla REVENUE-konton i bas-chart stoppas (aktivt, MF/null); betalning och kostnad READY', async () => {
    const intakter = basChartFor('AB').filter((k) => k.type === 'REVENUE')
    expect(intakter.length).toBeGreaterThanOrEqual(11)
    for (const kod of ['MF', null] as const) {
      const t = await setup()
      t.reader.accounts = t.reader.accounts.filter(
        (a) => !intakter.some((k) => k.number === a.Number),
      )
      for (const k of intakter) {
        t.reader.accounts.push({
          Number: k.number,
          Description: `Syntetiskt aktivt ${k.number}`,
          Active: true,
          VATCode: kod,
          Year: 1,
        } as unknown as (typeof t.reader.accounts)[number])
        await prisma.account.create({
          data: { organizationId: t.org.id, number: k.number, name: k.name, type: 'REVENUE' },
        })
      }
      const utfall: Record<number, string> = {}
      for (const k of intakter) {
        const je = await t.verifikat([
          [1930, 100, null],
          [k.number, null, 100],
        ])
        const row = (await t.exports.dryRun(t.org.id, je.id)) as {
          state: string
          blockReason?: string | null
        }
        utfall[k.number] = `${row.state} ${String(row.blockReason ?? '').split(':')[0]}`
      }
      expect(Object.entries(utfall).filter(([, u]) => !u.startsWith('BLOCKED ACCOUNT_'))).toEqual(
        [],
      )
      const bet = await t.verifikat([
        [1930, 6000, null],
        [1510, null, 6000],
      ])
      const kost = await t.verifikat([
        [5170, 500, null],
        [2440, null, 500],
      ])
      for (const je of [bet, kost])
        expect(((await t.exports.dryRun(t.org.id, je.id)) as { state: string }).state).toBe(
          'DRY_RUN_READY',
        )
    }
  })

  it('O1 annan organisations verifikat: NOT_FOUND', async () => {
    const a = await setup()
    const b = await setup()
    const je = await b.verifikat([
      [1930, 1, null],
      [1510, null, 1],
    ])
    expect(skal(await a.builder.build(a.org.id, je.id))).toMatch(/^NOT_FOUND/)
  })
})
