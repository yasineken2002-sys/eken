/**
 * KUNDSTART-001 §6, §11, §12.7–12.8 (C2 F1–F8, BYGGLEDARE-003 p1–p2): kontrollerad
 * Fortnox-skrivning till ett syntetiskt KUNDföretag. Mock-läsare och Mock-skrivare
 * (NODE_ENV=test-vägen) — inget externt anrop. Mock-företaget (databas 900001, syntetiskt
 * orgnr 556000-0001) markeras som kundföretag, så att sändningen kräver kundaktivering
 * precis som ett företag utanför testlistan i REAL.
 */
import { randomUUID } from 'node:crypto'
import { ConfigService } from '@nestjs/config'
import { ConflictException, ForbiddenException } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'
import type { PrismaService } from '../common/prisma/prisma.service'
import { FortnoxConnectionService } from './fortnox-connection.service'
import { FortnoxReadbackService } from './fortnox-readback.service'
import { FortnoxExportService } from './fortnox-export.service'
import { FortnoxTokenCryptoService } from './fortnox-token-crypto.service'
import { MockFortnoxAuthProvider, MockFortnoxLedgerReader } from './fortnox-providers'
import { VerifiedVoucherDraftBuilder } from './fortnox-export-builder'
import { FortnoxSendService } from './fortnox-send.service'
import {
  FORTNOX_TEST_WRITE_COMPANIES,
  FortnoxWriteError,
  MockVoucherWriter,
  RealFortnoxVoucherWriter,
} from './fortnox-voucher-writer'
import { FortnoxCustomerActivationService } from './fortnox-customer-activation.service'
import {
  fortnoxCustomerWritesOptIn,
  provaOchOgiltigforklara,
  skrivarensKontroll,
} from './fortnox-customer-activation'
import { FortnoxMappingService } from './fortnox-mapping.service'
import { CutoverService } from '../kundstart/cutover.service'
import { OpeningPackageService } from '../kundstart/opening-package.service'
import { OcrService } from '../common/ocr/ocr.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip
const KEY = 'cd'.repeat(32)
const HUVUD =
  'radId;typ;hyresgast;avtal;fastighet;enhet;periodAr;periodManad;forfallodag;ursprungligtBelopp;oppetBelopp;mottagetDatum'
jest.setTimeout(120_000)

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => expect(HAR_DB).toBe(true))
})

describe('driftflaggan FORTNOX_CUSTOMER_WRITES', () => {
  const cfg = (v?: string) => ({ get: () => v }) as unknown as ConfigService
  it('saknas → av; "aktiverad" → på; annat värde stoppar uppstart', () => {
    expect(fortnoxCustomerWritesOptIn(cfg(undefined))).toBe(false)
    expect(fortnoxCustomerWritesOptIn(cfg(''))).toBe(false)
    expect(fortnoxCustomerWritesOptIn(cfg('aktiverad'))).toBe(true)
    expect(() => fortnoxCustomerWritesOptIn(cfg('true'))).toThrow(/ogiltigt värde/)
  })

  it('S-2: kundflaggan gör inte testlistans väg skrivbar; kundvägen kräver bindning', async () => {
    let anrop = 0
    const w = new RealFortnoxVoucherWriter({
      transport: { request: async () => ((anrop += 1), { data: {} }) } as never,
      reader: { get: async () => ((anrop += 1), {}) } as never,
      clientId: 'syntetisk-klient',
      testWrites: false,
      customerWrites: true,
      verifyCustomer: async () => false,
    })
    const test = FORTNOX_TEST_WRITE_COMPANIES[0]!
    expect(w.allowsCompany(test)).toBe(false)
    expect(w.requiresCustomerActivation(test)).toBe(true)
    expect(w.allowsCompany(990001)).toBe(false)
    const kund = {
      organizationId: 'o',
      activationId: 'a',
      databaseNumber: 990001,
      financialYearId: 1,
      voucherSeries: 'A',
    }
    expect(w.allowsCompany(990001, kund)).toBe(true)
    // Skrivaren litar inte på anroparen: DB-kontrollen säger nej → not_sent före nätet.
    await expect(
      w.createVoucher('t', { financialyear: 1 }, {}, { databaseNumber: 990001, kund }),
    ).rejects.toMatchObject({ outcome: 'not_sent' })
    expect(anrop).toBe(0)
    // Utan uttryckliga val (äldre anropare) är det testvägen som förut.
    const gammal = new RealFortnoxVoucherWriter({
      transport: {} as never,
      reader: {} as never,
      clientId: 'syntetisk-klient',
    })
    expect(gammal.allowsCompany(test)).toBe(true)
    expect(gammal.customerWritesEnabled).toBe(false)
  })
})

medDb('KUNDSTART kundaktivering mot riktig Postgres', () => {
  let prisma: PrismaClient
  const orgs: string[] = []

  beforeAll(async () => {
    prisma = new PrismaClient()
    await prisma.$connect()
  })

  afterAll(async () => {
    for (const id of orgs) {
      await prisma.fortnoxVoucherExport.deleteMany({ where: { organizationId: id } })
      await prisma.journalEntryLine.deleteMany({ where: { journalEntry: { organizationId: id } } })
      await prisma.journalEntry.deleteMany({ where: { organizationId: id } })
      await prisma.journalEntrySequence.deleteMany({ where: { organizationId: id } })
      await prisma.fortnoxCustomerActivation.deleteMany({ where: { organizationId: id } })
      await prisma.openingExecutedSource.deleteMany({ where: { organizationId: id } })
      await prisma.openingPackage.deleteMany({ where: { organizationId: id } })
      await prisma.fortnoxDimensionMapping.deleteMany({ where: { organizationId: id } })
      await prisma.fortnoxReadRun.deleteMany({ where: { organizationId: id } })
      await prisma.fortnoxOAuthState.deleteMany({ where: { organizationId: id } })
      await prisma.fortnoxConnection.deleteMany({ where: { organizationId: id } })
      await prisma.account.deleteMany({ where: { organizationId: id } })
      await prisma.property.deleteMany({ where: { organizationId: id } })
      await prisma.user.deleteMany({ where: { organizationId: id } })
      await prisma.organization.delete({ where: { id } }).catch(() => undefined)
    }
    await prisma.$disconnect()
  })

  async function setup(flagga = true) {
    const sfx = randomUUID().slice(0, 8)
    // Syntetiskt, unikt orgnr per prov; Mock-företaget får samma.
    const orgnr = `559${String(Math.floor(Math.random() * 1e3)).padStart(3, '0')}-${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`
    const org = await prisma.organization.create({
      data: {
        name: `Syntetiskt kundbolag ${sfx}`,
        orgNumber: orgnr,
        email: `ks-akt-${sfx}@example.invalid`,
        street: 'a',
        city: 'b',
        postalCode: '1',
      },
    })
    orgs.push(org.id)
    const owner = await prisma.user.create({
      data: {
        organizationId: org.id,
        email: `ks-akt-${sfx}-o@example.invalid`,
        passwordHash: 'synthetic-test-only',
        firstName: 'Ä',
        lastName: 'S',
        role: 'OWNER',
      },
    })
    const env: Record<string, string> = { FORTNOX_TOKEN_KEY: KEY }
    if (flagga) env.FORTNOX_CUSTOMER_WRITES = 'aktiverad'
    const config = { get: (k: string) => env[k] } as unknown as ConfigService
    const crypto = new FortnoxTokenCryptoService(config)
    const auth = new MockFortnoxAuthProvider()
    const reader = new MockFortnoxLedgerReader()
    reader.company = { ...reader.company, OrganizationNumber: orgnr }
    reader.accounts.push(
      { Number: 1510, Active: true, Description: 'Kundfordringar', BalanceBroughtForward: 0 },
      { Number: 2890, Active: true, Description: 'Övriga skulder', BalanceBroughtForward: 0 },
      { Number: 3911, Active: true, Description: 'Hyresintäkter', BalanceBroughtForward: 0 },
      { Number: 2420, Active: true, Description: 'Förskott från kunder', BalanceBroughtForward: 0 },
    )
    const db = prisma as unknown as PrismaService
    const connections = new FortnoxConnectionService(db, crypto, config, auth, reader)
    const verified = new VerifiedVoucherDraftBuilder(db, connections, reader)
    const exports = new FortnoxExportService(db, verified)
    const writer = new MockVoucherWriter(reader)
    writer.customerCompanies.add(900001)
    writer.verifyCustomer = (b, d) => skrivarensKontroll(db, b, d)
    const sender = new FortnoxSendService(db, connections, verified, reader, writer)
    const readback = new FortnoxReadbackService(db, connections, reader, writer)
    const aktivering = new FortnoxCustomerActivationService(db, config)
    const paket = new OpeningPackageService(db, new OcrService(db))
    const ägare = { sub: owner.id, role: 'OWNER' as const }

    const { authUrl } = await connections.begin(org.id, owner.id)
    const state = new URL(authUrl).searchParams.get('state')!
    await connections.handleCallback(state, `mock-code-${state.slice(0, 8)}`)
    await connections.setExportVoucherSeries(org.id, 'A')
    await connections.setExportOmitDimensions(org.id, owner.id, true)
    await new CutoverService(db).set(org.id, ägare, '2026-11-01')

    // Nollöppning med verklig (Mock-)läsning: IB 0 + inga rörelser t.o.m. 2026-10-31.
    const las = () =>
      readback.read(org.id, owner.id, {
        financialYearId: 1,
        periodFrom: '2026-01-01',
        periodTo: '2026-10-31',
        costAccounts: [1510, 2890],
      })
    const pk = await paket.create(org.id, ägare, {
      sourceName: 'noll.csv',
      innehall: HUVUD,
      nollOppning: true,
    })
    await paket.validate(org.id, pk.id, ägare)
    const run = await las()
    expect(run.status).toBe('COMPLETE')
    await paket.bindFortnoxRead(org.id, pk.id, ägare, run.id)
    // KUNDSTART-009: tidigare systemets register för första perioden (syntetiskt, inga poster).
    await paket.setFirstPeriodRegister(org.id, pk.id, ägare, {
      filnamn: 'SYNTETISKT-register.csv',
      innehall: 'radId;hyresgast;avtal;periodAr;periodManad;dokument;fakturerat;betalt',
      system: 'Gamla systemet (syntetiskt)',
      ansvarig: 'Syntetisk ägare',
      tackningFran: '2026-11-01',
      tackningTill: '2026-12-31',
      intaktskonton: [3911],
      forskottskonton: [2420],
    })
    const g = await prisma.openingPackage.findUniqueOrThrow({ where: { id: pk.id } })
    await paket.approve(org.id, pk.id, ägare, { version: g.version, sourceSha256: g.sourceSha256 })
    await paket.execute(org.id, pk.id, ägare)
    // Kompletterande riskkontroll: läsning över brytdatum på 1510, intäkts- och förskottskonto.
    const riskLas = () =>
      readback.read(org.id, owner.id, {
        financialYearId: 1,
        periodFrom: '2026-01-01',
        periodTo: '2026-12-31',
        costAccounts: [1510, 3911, 2420],
      })
    expect((await riskLas()).status).toBe('COMPLETE')

    const acc = async (number: number) =>
      (await prisma.account.findFirst({ where: { organizationId: org.id, number } })) ??
      prisma.account.create({
        data: { organizationId: org.id, number, name: `Konto ${number}`, type: 'EXPENSE' },
      })
    const verifikat = async (datum = '2026-11-02') => {
      const a = await acc(5170)
      const b = await acc(2440)
      return prisma.journalEntry.create({
        data: {
          organizationId: org.id,
          date: new Date(datum),
          description: 'Syntetisk reparation',
          fiscalYear: 2026,
          verNumber: Math.floor(Math.random() * 1e6) + 1,
          lines: {
            create: [
              { accountId: a.id, debit: '100.00' },
              { accountId: b.id, credit: '100.00' },
            ],
          },
        },
      })
    }
    const ready = async () => {
      const a = await acc(5170)
      const b = await acc(2440)
      const je = await prisma.journalEntry.create({
        data: {
          organizationId: org.id,
          date: new Date('2026-11-02'),
          description: 'Syntetisk reparation',
          fiscalYear: 2026,
          verNumber: Math.floor(Math.random() * 1e6) + 1,
          lines: {
            create: [
              { accountId: a.id, debit: '100.00' },
              { accountId: b.id, credit: '100.00' },
            ],
          },
        },
      })
      const row = await exports.dryRun(org.id, je.id)
      expect(row.state).toBe('DRY_RUN_READY')
      return row as typeof row & { draftHash: string }
    }
    const godkann = async () => {
      const s = await aktivering.status(org.id, 1)
      expect(s.forslag.hinder).toEqual([])
      return aktivering.approve(org.id, ägare, {
        financialYearId: 1,
        consequencesSha256: s.forslag.textSha256!,
      })
    }
    return {
      org,
      owner,
      ägare,
      reader,
      writer,
      sender,
      readback,
      aktivering,
      paket,
      connections,
      ready,
      godkann,
      las,
      pkId: pk.id,
      verifikat,
      exports,
      riskLas,
    }
  }

  it('flaggan av: kan inte aktiveras; status visar hindret', async () => {
    const t = await setup(false)
    const s = await t.aktivering.status(t.org.id, 1)
    expect(s.flaggaPa).toBe(false)
    expect(s.forslag.hinder.join(' ')).toMatch(/FORTNOX_CUSTOMER_WRITES är av/)
    await expect(
      t.aktivering.approve(t.org.id, t.ägare, {
        financialYearId: 1,
        consequencesSha256: 'a'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(ConflictException)
  })

  it('utan aktivering skickas inget till kundföretaget (0 skrivningar, raden kvar i DRY_RUN_READY)', async () => {
    const t = await setup()
    const row = await t.ready()
    await expect(t.sender.send(t.org.id, t.owner.id, row.id, row.draftHash)).rejects.toThrow(
      /CUSTOMER_NOT_ACTIVATED/,
    )
    expect(t.writer.writes).toBe(0)
    expect(
      (await prisma.fortnoxVoucherExport.findUniqueOrThrow({ where: { id: row.id } })).state,
    ).toBe('DRY_RUN_READY')
    expect(await t.sender.sendingEnabledFor(t.org.id)).toBe(false)
  })

  it('T1-6/A4: ändrat Fortnox-saldo före brytdatum → DIFFERENS → aktivering blockerad; rättat → släpps', async () => {
    const t = await setup()
    t.reader.accounts.find((a) => a.Number === 1510)!.BalanceBroughtForward = 282.12
    const run = await t.las()
    await t.paket.bindFortnoxRead(t.org.id, t.pkId, t.ägare, run.id)
    let s = await t.aktivering.status(t.org.id, 1)
    expect(s.forslag.ok).toBe(false)
    expect(s.forslag.hinder.join(' ')).toMatch(/oförklarad DIFFERENS/)
    t.reader.accounts.find((a) => a.Number === 1510)!.BalanceBroughtForward = 0
    const run2 = await t.las()
    await t.paket.bindFortnoxRead(t.org.id, t.pkId, t.ägare, run2.id)
    s = await t.aktivering.status(t.org.id, 1)
    expect(s.forslag.ok).toBe(true)
  })

  it('godkännande: bara OWNER, bundet till den lästa konsekvenstexten; sedan skickas exakt 1 post', async () => {
    const t = await setup()
    const s = await t.aktivering.status(t.org.id, 1)
    expect(s.forslag.text).toMatch(/nollöppning/)
    expect(s.forslag.text).toMatch(/tas inte bort av en återkallelse/)
    await expect(
      t.aktivering.approve(
        t.org.id,
        { sub: t.owner.id, role: 'ADMIN' },
        { financialYearId: 1, consequencesSha256: s.forslag.textSha256! },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException)
    await expect(
      t.aktivering.approve(t.org.id, t.ägare, {
        financialYearId: 1,
        consequencesSha256: 'b'.repeat(64),
      }),
    ).rejects.toThrow(/Konsekvenstexten har ändrats/)
    const a = await t.godkann()
    expect(a.status).toBe('ACTIVE')
    expect(await t.sender.sendingEnabledFor(t.org.id)).toBe(true)
    const snap = await t.readback.aiSnapshot(t.org.id)
    expect([snap.sendingEnabled, snap.customerActivation]).toEqual([true, true])
    const row = await t.ready()
    const res = await t.sender.send(t.org.id, t.owner.id, row.id, row.draftHash)
    expect(res.state).toBe('CONFIRMED')
    expect(t.writer.writes).toBe(1)
    expect(t.writer.lastBinding?.kund?.activationId).toBe(a.id)
  })

  it('A→B→A dimensionsbeslut: aktiveringen väcks inte när samma läge återkommer', async () => {
    const t = await setup()
    const a = await t.godkann()
    await t.connections.setExportOmitDimensions(t.org.id, t.owner.id, false)
    await t.connections.setExportOmitDimensions(t.org.id, t.owner.id, true)
    const efter = await prisma.fortnoxCustomerActivation.findUniqueOrThrow({ where: { id: a.id } })
    expect(efter.status).toBe('SUPERSEDED')
    expect(efter.invalidatedReason).toMatch(/Dimensionsbeslutet/)
    const row = await t.ready()
    await expect(t.sender.send(t.org.id, t.owner.id, row.id, row.draftHash)).rejects.toThrow(
      /CUSTOMER_NOT_ACTIVATED/,
    )
    expect(t.writer.writes).toBe(0)
  })

  it('A→B→A serie: SUPERSEDED kvarstår; nytt godkännande ger en NY rad', async () => {
    const t = await setup()
    const a = await t.godkann()
    await t.connections.setExportVoucherSeries(t.org.id, 'L')
    await t.connections.setExportVoucherSeries(t.org.id, 'A')
    expect(
      (await prisma.fortnoxCustomerActivation.findUniqueOrThrow({ where: { id: a.id } })).status,
    ).toBe('SUPERSEDED')
    const b = await t.godkann()
    expect(b.id).not.toBe(a.id)
    expect(
      (await prisma.fortnoxCustomerActivation.findUniqueOrThrow({ where: { id: a.id } })).status,
    ).toBe('SUPERSEDED')
  })

  it('A→B→A mappning: ändrad och återställd mappning väcker inte aktiveringen', async () => {
    const t = await setup()
    const prop = await prisma.property.create({
      data: {
        organizationId: t.org.id,
        name: 'Syntetisk fastighet',
        propertyDesignation: `ks-${t.org.id.slice(0, 8)}-1:1`,
        type: 'RESIDENTIAL',
        street: 's',
        city: 'c',
        postalCode: '1',
        totalArea: '100',
      },
    })
    const mapp = new FortnoxMappingService(
      prisma as unknown as PrismaService,
      t.connections,
      t.reader,
    )
    const m = await mapp.upsert(t.org.id, {
      dimensionType: 'COST_CENTER',
      code: 'HUSA',
      propertyId: prop.id,
    })
    const a = await t.godkann()
    await mapp.remove(t.org.id, m.id)
    await mapp.upsert(t.org.id, { dimensionType: 'COST_CENTER', code: 'HUSA', propertyId: prop.id })
    expect(
      (await prisma.fortnoxCustomerActivation.findUniqueOrThrow({ where: { id: a.id } })).status,
    ).toBe('SUPERSEDED')
  })

  it('send()-grenen: en ändring som gått förbi krokarna upptäcks och ogiltigförklaras beständigt', async () => {
    const t = await setup()
    const a = await t.godkann()
    // Direkt DB-ändring utan krok (B): ny generation för samma bolag.
    await prisma.fortnoxConnection.update({
      where: { organizationId: t.org.id },
      data: { generation: { increment: 1 } },
    })
    // send() kör denna prövning före anspråket (fortnox-send.service.ts).
    const v = await provaOchOgiltigforklara(prisma as never, t.org.id, {
      financialYearId: 1,
      voucherSeries: 'A',
      transactionDate: '2026-11-02',
      accountingMethod: 'ACCRUAL',
    })
    expect(v.ok).toBe(false)
    // Tillbaka till A: aktiveringen förblir SUPERSEDED.
    await prisma.fortnoxConnection.update({
      where: { organizationId: t.org.id },
      data: { generation: { decrement: 1 } },
    })
    expect(
      (await prisma.fortnoxCustomerActivation.findUniqueOrThrow({ where: { id: a.id } })).status,
    ).toBe('SUPERSEDED')
    expect(await t.sender.sendingEnabledFor(t.org.id)).toBe(false)
  })

  it('återanslutning till samma bolag är en ny prövning', async () => {
    const t = await setup()
    const a = await t.godkann()
    await t.connections.disconnect(t.org.id)
    const { authUrl } = await t.connections.begin(t.org.id, t.owner.id)
    const state = new URL(authUrl).searchParams.get('state')!
    await t.connections.handleCallback(state, `mock-code-${state.slice(0, 8)}`)
    expect(
      (await prisma.fortnoxCustomerActivation.findUniqueOrThrow({ where: { id: a.id } })).status,
    ).toBe('SUPERSEDED')
  })

  it('revoke: köade DRY_RUN_READY-rader kan inte skickas; skrivaren nekar en förfalskad bindning', async () => {
    const t = await setup()
    const a = await t.godkann()
    const row = await t.ready()
    await expect(
      t.aktivering.revoke(t.org.id, { sub: t.owner.id, role: 'ADMIN' }),
    ).rejects.toBeInstanceOf(ForbiddenException)
    await t.aktivering.revoke(t.org.id, t.ägare)
    await expect(t.sender.send(t.org.id, t.owner.id, row.id, row.draftHash)).rejects.toThrow(
      /CUSTOMER_NOT_ACTIVATED/,
    )
    expect(t.writer.writes).toBe(0)
    // Försvar på djupet: skrivaren får en bindning till den återkallade aktiveringen.
    await expect(
      t.writer.createVoucher(
        't',
        { financialyear: 1 },
        { Voucher: { VoucherSeries: 'A' } },
        {
          databaseNumber: 900001,
          kund: {
            organizationId: t.org.id,
            activationId: a.id,
            databaseNumber: 900001,
            financialYearId: 1,
            voucherSeries: 'A',
          },
        },
      ),
    ).rejects.toBeInstanceOf(FortnoxWriteError)
    expect(t.writer.writes).toBe(0)
    const snap = await t.readback.aiSnapshot(t.org.id)
    expect(snap.sendingEnabled).toBe(false)
  })

  // ── K-B7: exportgräns mot brytdatum (FYND-KB7-EXPORTGRANS, HANDOFF-C2-K006) ──
  it('E-text: konsekvenstexten anger datumregeln och undantaget ordagrant', async () => {
    const t = await setup()
    const s = await t.aktivering.status(t.org.id, 1)
    expect(s.forslag.text).toMatch(/BARA verifikat daterade på eller efter brytdatum 2026-11-01/)
    expect(s.forslag.text).toMatch(
      /Exportgräns: ett verifikat daterat före 2026-11-01 .* blockeras och exporteras aldrig/,
    )
  })

  it('E-pos-1/E-pos-2: verifikat daterat = brytdatum och efter brytdatum skickas (1 POST vardera)', async () => {
    const t = await setup()
    await t.godkann()
    for (const [datum, n] of [
      ['2026-11-01', 1],
      ['2026-11-05', 2],
    ] as const) {
      const je = await t.verifikat(datum)
      const row = (await t.exports.dryRun(t.org.id, je.id)) as {
        id: string
        state: string
        draftHash: string
      }
      expect(row.state).toBe('DRY_RUN_READY')
      const res = await t.sender.send(t.org.id, t.owner.id, row.id, row.draftHash)
      expect(res.state).toBe('CONFIRMED')
      expect(t.writer.writes).toBe(n)
    }
  })

  it('E-neg-1/E-gräns: verifikat före brytdatum (t.ex. förskott dagen före) → BLOCKED med skäl, 0 POST', async () => {
    const t = await setup()
    await t.godkann()
    for (const datum of ['2026-10-31', '2026-10-15']) {
      const je = await t.verifikat(datum)
      const row = (await t.exports.dryRun(t.org.id, je.id)) as {
        state: string
        blockCode?: string
        blockReason?: string
      }
      expect(row.state).toBe('BLOCKED')
      expect(JSON.stringify(row)).toMatch(/före brytdatum 2026-11-01/)
    }
    expect(t.writer.writes).toBe(0)
  })

  it('E-neg-2: utkast skapat före aktiveringen, vars verifikat hamnar före brytdatum → send avvisas, 0 POST', async () => {
    const t = await setup()
    const row = await t.ready() // DRY_RUN_READY före aktiveringen (2026-11-02)
    await t.godkann()
    await prisma.journalEntry.update({
      where: { id: row.journalEntryId },
      data: { date: new Date('2026-10-20') },
    })
    await expect(t.sender.send(t.org.id, t.owner.id, row.id, row.draftHash)).rejects.toBeInstanceOf(
      ConflictException,
    )
    expect(t.writer.writes).toBe(0)
  })

  it('skrivaren prövar datumet ur sin EGEN payload: giltig bindning men datum före brytdatum → not_sent', async () => {
    const t = await setup()
    const a = await t.godkann()
    const kund = {
      organizationId: t.org.id,
      activationId: a.id,
      databaseNumber: 900001,
      financialYearId: 1,
      voucherSeries: 'A',
    }
    await expect(
      t.writer.createVoucher(
        't',
        { financialyear: 1 },
        { Voucher: { VoucherSeries: 'A', TransactionDate: '2026-10-31', VoucherRows: [] } },
        { databaseNumber: 900001, kund },
      ),
    ).rejects.toMatchObject({ outcome: 'not_sent' })
    expect(t.writer.writes).toBe(0)
  })

  it('E-pre: Eveno-poster före brytdatum stoppar kundaktiveringen med skäl', async () => {
    const t = await setup()
    await t.verifikat('2026-10-15')
    const s = await t.aktivering.status(t.org.id, 1)
    expect(s.forslag.ok).toBe(false)
    expect(s.forslag.hinder.join(' ')).toMatch(/egna poster före brytdatum/)
  })

  it('S-6: databasen tillåter högst en ACTIVE aktivering per organisation', async () => {
    const t = await setup()
    const a = await t.godkann()
    const rad = await prisma.fortnoxCustomerActivation.findUniqueOrThrow({ where: { id: a.id } })
    const kopia: Partial<typeof rad> = { ...rad }
    delete kopia.id
    await expect(
      prisma.fortnoxCustomerActivation.create({ data: { ...(kopia as typeof rad) } }),
    ).rejects.toMatchObject({ code: 'P2002' })
    // En SUPERSEDED/REVOKED rad bredvid en ACTIVE är tillåten (historik).
    await prisma.fortnoxCustomerActivation.create({
      data: { ...(kopia as typeof rad), status: 'REVOKED' },
    })
  })

  it('KUNDSTART-009 riskkontroll: verifikat från tidigare system efter brytdatum blockerar aktivering', async () => {
    const t = await setup()
    t.reader.vouchers.push({
      Year: 1,
      VoucherSeries: 'L',
      VoucherNumber: 77,
      TransactionDate: '2026-11-01',
      Description: 'Hyra november (tidigare system, syntetisk)',
      VoucherRows: [
        { Account: 1510, Debit: 6000, Credit: 0 },
        { Account: 3911, Debit: 0, Credit: 6000 },
      ],
    } as never)
    await t.riskLas()
    const s = await t.aktivering.status(t.org.id, 1)
    expect(s.forslag.ok).toBe(false)
    expect(s.forslag.hinder.join(' ')).toMatch(
      /verifikatrader från tidigare system på eller efter brytdatum/,
    )
  })

  it('KUNDSTART-009 riskkontroll: förskottskonto med saldo blockerar aktivering', async () => {
    const t = await setup()
    t.reader.accounts.find((a) => a.Number === 2420)!.BalanceBroughtForward = -6000
    await t.riskLas()
    const s = await t.aktivering.status(t.org.id, 1)
    expect(s.forslag.hinder.join(' ')).toMatch(/Förskottskonto 2420 har saldo/)
  })

  // ── K-B8: bokföringsmetod (FYND-KB8, HANDOFF-C2-K009). Syntetiska år med UTTRYCKLIG metod. ──
  it('M-text + M-pos: konsekvenstexten kräver ACCRUAL; ACCRUAL-år aktiveras och skickar 1 POST', async () => {
    const t = await setup()
    const s = await t.aktivering.status(t.org.id, 1)
    expect(s.forslag.text).toMatch(/förs med faktureringsmetoden \(ACCRUAL\)/)
    expect(s.forslag.text).toMatch(/stödjer inte kontantmetoden/)
    const a = await t.godkann()
    expect(
      (await prisma.fortnoxCustomerActivation.findUniqueOrThrow({ where: { id: a.id } }))
        .financialYearAccountingMethod,
    ).toBe('ACCRUAL')
    const row = await t.ready()
    expect((await t.sender.send(t.org.id, t.owner.id, row.id, row.draftHash)).state).toBe(
      'CONFIRMED',
    )
    expect(t.writer.writes).toBe(1)
  })

  it.each([
    ['M-cash', 'CASH'],
    ['M-saknas', undefined],
    ['M-okänt', 'HYBRID'],
  ])('%s: aktivering blockeras med skäl, utkast BLOCKED, 0 POST', async (_n, metod) => {
    const t = await setup()
    const ar = t.reader.financialYears[0] as Record<string, unknown>
    if (metod === undefined) delete ar.AccountingMethod
    else ar.AccountingMethod = metod
    await t.riskLas() // ny läsning av året bär metoden (eller dess frånvaro)
    const s = await t.aktivering.status(t.org.id, 1)
    expect(s.forslag.ok).toBe(false)
    expect(s.forslag.hinder.join(' ')).toMatch(/stödjer bara faktureringsmetoden \(ACCRUAL\)/)
    const je = await t.verifikat('2026-11-02')
    const row = (await t.exports.dryRun(t.org.id, je.id)) as {
      state: string
      blockReason?: string | null
    }
    expect(row.state).toBe('BLOCKED')
    expect(JSON.stringify(row)).toMatch(/faktureringsmetoden/)
    expect(t.writer.writes).toBe(0)
  })

  it('M-byte: godkänt med ACCRUAL → året blir CASH → send avvisas, SUPERSEDED, 0 POST; tillbaka till ACCRUAL väcker inte', async () => {
    const t = await setup()
    const a = await t.godkann()
    const row = await t.ready()
    t.reader.financialYears[0]!.AccountingMethod = 'CASH'
    await expect(t.sender.send(t.org.id, t.owner.id, row.id, row.draftHash)).rejects.toBeInstanceOf(
      ConflictException,
    )
    expect(t.writer.writes).toBe(0)
    const efter = await prisma.fortnoxCustomerActivation.findUniqueOrThrow({ where: { id: a.id } })
    expect(efter.status).toBe('SUPERSEDED')
    expect(efter.invalidatedReason).toMatch(/bokföringsmetod CASH/)
    t.reader.financialYears[0]!.AccountingMethod = 'ACCRUAL'
    expect(
      (await prisma.fortnoxCustomerActivation.findUniqueOrThrow({ where: { id: a.id } })).status,
    ).toBe('SUPERSEDED')
    expect(await t.sender.sendingEnabledFor(t.org.id)).toBe(false)
  })
})
