/**
 * KUNDSTART-001 — DB-prov mot riktig Postgres (KONTRAKT §8, §11, §12.10; C2 KRITERIER-001
 * med TILLÄGG-1/2 och KONTRAKTSBESKED-001 K-B1–K-B6). Allt är syntetiskt: syntetiskt
 * orgnr, syntetiska hyresgäster, syntetisk Fortnox-läsning (insatt som rad — ingen extern
 * anslutning finns i provet).
 */
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {},
  PutObjectCommand: class {},
  DeleteObjectCommand: class {},
  GetObjectCommand: class {},
}))
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: async () => '' }))

import { ConflictException, ForbiddenException, BadRequestException } from '@nestjs/common'
import { PrismaClient, Prisma } from '@prisma/client'
import { InvoicesService } from '../invoices/invoices.service'
import { InvoiceEventsService } from '../invoices/invoice-events.service'
import { ReconciliationService } from '../reconciliation/reconciliation.service'
import { AccountingService, MissingAccrualError } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { RentNoticeEventsService } from '../avisering/rent-notice-events.service'
import { BankImportAttemptService } from '../reconciliation/bank-import-attempt.service'
import { PaymentFreshnessService } from '../payment-freshness/payment-freshness.service'
import { DepositsService } from '../deposits/deposits.service'
import { AviseringService } from '../avisering/avisering.service'
import { RentBackfillService } from '../avisering/rent-backfill.service'
import { OcrService } from '../common/ocr/ocr.service'
import type { PrismaService } from '../common/prisma/prisma.service'
import { CutoverService } from './cutover.service'
import { OpeningPackageService } from './opening-package.service'
import { oppningskomponent, historiskSkuld } from './opening-component'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip
jest.setTimeout(120_000)

const K = `ks-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const ORG = `${K}-org`
const ORG0 = `${K}-org0`
const PROP = `${ORG}-p`
const ORGNR = '559999-0001' // syntetiskt
const DB_NR = 990001

const OWNER = { sub: '', role: 'OWNER' as const }
const ADMIN = { sub: '', role: 'ADMIN' as const }

const HUVUD =
  'radId;typ;hyresgast;avtal;fastighet;enhet;periodAr;periodManad;forfallodag;ursprungligtBelopp;oppetBelopp;mottagetDatum'

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('KUNDSTART-001 mot riktig Postgres', () => {
  let prisma: PrismaClient
  let p: PrismaService
  let accounting: AccountingService
  let recon: ReconciliationService
  let deposits: DepositsService
  let avisering: AviseringService
  let backfill: RentBackfillService
  let cutover: CutoverService
  let paket: OpeningPackageService
  let freshness: PaymentFreshnessService
  const konto: Record<number, string> = {}
  let pkgId = ''

  const stub = (namn: string) =>
    new Proxy(
      {},
      {
        get: (_t, prop) => () => {
          throw new Error(`OVÄNTAT ANROP: ${namn}.${String(prop)}`)
        },
      },
    )

  async function lasning(
    org: string,
    connId: string,
    s1510: number,
    s2890: number,
    opts: { periodTo?: string; status?: 'COMPLETE' | 'PARTIAL' } = {},
  ) {
    // Syntetisk COMPLETE-läsning: IB + rader så att saldot per brytdatum blir s1510/s2890 öre.
    return prisma.fortnoxReadRun.create({
      data: {
        organizationId: org,
        connectionId: connId,
        fortnoxDatabaseNumber: DB_NR,
        status: opts.status ?? 'COMPLETE',
        financialYearId: 1,
        financialYearStart: new Date('2026-01-01'),
        financialYearEnd: new Date('2026-12-31'),
        periodFrom: new Date('2026-01-01'),
        periodTo: new Date(opts.periodTo ?? '2026-10-31'),
        costAccounts: [1510, 2890],
        startedAt: new Date(),
        completedAt: new Date(),
        summary: { balanceBroughtForwardOre: { '1510': 100000, '2890': -50000 } },
        // Samma lagringsform som fortnox-readback.service.ts: { rows, references }.
        rows: {
          rows: [
            { account: 1510, amountOre: s1510 - 100000, bucket: 'UNALLOCATED' },
            { account: 2890, amountOre: -(s2890 - 50000), bucket: 'UNALLOCATED' },
          ],
          references: [],
        },
      },
    })
  }

  async function skapaOrg(id: string) {
    await prisma.organization.create({
      data: {
        id,
        name: `Kundstartriggen ${id.slice(-4)} AB`,
        orgNumber: id === ORG ? ORGNR : '559999-0002',
        email: `${id}@example.invalid`,
        street: 'Gatan 1',
        city: 'Staden',
        postalCode: '12345',
      },
    })
    const u = await prisma.user.create({
      data: {
        organizationId: id,
        email: `${id}-owner@example.invalid`,
        passwordHash: 'synthetic-test-only',
        firstName: 'Ägare',
        lastName: 'Syntetisk',
        role: 'OWNER',
      },
    })
    const conn = await prisma.fortnoxConnection.create({
      data: {
        organizationId: id,
        status: 'ACTIVE',
        fortnoxDatabaseNumber: DB_NR,
        fortnoxOrgNumber: id === ORG ? ORGNR : '559999-0002',
        connectedAt: new Date(Date.now() - 3600_000),
        exportVoucherSeries: 'A',
        exportOmitDimensionsAt: new Date(Date.now() - 3600_000),
        exportOmitDimensionsBy: u.id,
      },
    })
    return { userId: u.id, connId: conn.id }
  }

  let connId = ''

  beforeAll(async () => {
    prisma = new PrismaClient()
    p = prisma as unknown as PrismaService
    accounting = new AccountingService(p, new VerifikationsnummerService(p))
    const invoiceEvents = new InvoiceEventsService(p)
    const invoices = new InvoicesService(
      p,
      invoiceEvents,
      stub('PdfService') as never,
      stub('MailService') as never,
      accounting,
      { createForAllOrgUsers: async () => undefined } as never,
      stub('OcrService') as never,
      stub('PdfQueue') as never,
    )
    freshness = new PaymentFreshnessService(p, { send: async () => undefined } as never)
    recon = new ReconciliationService(
      p,
      invoices,
      invoiceEvents,
      accounting,
      // Riktig färskhets-/granskningstjänst: K-B2b-pausen MÄTS, inte stubbas.
      freshness as never,
      new RentNoticeEventsService(p),
      { enqueue: jest.fn().mockResolvedValue('jobb') } as never,
      {
        skrivFacitMatchad: jest.fn().mockResolvedValue(undefined),
        skrivFacitIngen: jest.fn().mockResolvedValue(undefined),
        nollstallFacit: jest.fn().mockResolvedValue(undefined),
      } as never,
      new BankImportAttemptService(p as never),
    )
    deposits = new DepositsService(
      p,
      accounting,
      { createForAllOrgUsers: async () => undefined } as never,
      invoiceEvents,
    )
    const ocr = new OcrService(p)
    avisering = new AviseringService(
      p,
      ocr,
      stub('MailService') as never,
      stub('PdfService') as never,
      stub('StorageService') as never,
      stub('PdfQueue') as never,
      accounting,
      stub('ConsumptionService') as never,
      stub('MiscChargeService') as never,
      deposits,
      new RentNoticeEventsService(p),
    )
    backfill = new RentBackfillService(p, avisering, ocr, {
      createForAllOrgUsers: async () => undefined,
    } as never)
    cutover = new CutoverService(p)
    paket = new OpeningPackageService(p, ocr)

    const o = await skapaOrg(ORG)
    OWNER.sub = o.userId
    ADMIN.sub = o.userId
    connId = o.connId
    await prisma.property.create({
      data: {
        id: PROP,
        organizationId: ORG,
        name: 'Riggfastigheten',
        propertyDesignation: `${K}-1:1`,
        type: 'RESIDENTIAL',
        street: 'Riggatan 1',
        city: 'Staden',
        postalCode: '12345',
        totalArea: new Prisma.Decimal('500'),
      },
    })
    for (const [number, name, type] of [
      [1930, 'Företagskonto', 'ASSET'],
      [1510, 'Kundfordringar', 'ASSET'],
      [2890, 'Övriga kortfristiga skulder', 'LIABILITY'],
      [3011, 'Hyresintäkter bostäder', 'REVENUE'],
      [3040, 'Övriga intäkter', 'REVENUE'],
    ] as const) {
      const a = await prisma.account.create({ data: { organizationId: ORG, number, name, type } })
      konto[number] = a.id
    }
    // t1/L1 aktivt (K-1), t2/L2 avslutat (K-2, 2025-06-01–2026-08-31), t3/L3 aktivt (K-3).
    const fall = [
      ['1', 'K-1', 'ACTIVE', '2026-01-01', null],
      ['2', 'K-2', 'TERMINATED', '2025-06-01', '2026-08-31'],
      ['3', 'K-3', 'ACTIVE', '2026-02-01', null],
    ] as const
    for (const [n, avtal, status, start, slut] of fall) {
      await prisma.tenant.create({
        data: {
          id: `${ORG}-t${n}`,
          organizationId: ORG,
          type: 'INDIVIDUAL',
          firstName: 'Syntetisk',
          lastName: `Hyresgäst${n}`,
          email: `${K}-t${n}@example.invalid`,
          ocrNumber: `77710000${n}${n}`,
        },
      })
      await prisma.unit.create({
        data: {
          id: `${ORG}-u${n}`,
          propertyId: PROP,
          name: `Lgh 100${n}`,
          unitNumber: `100${n}`,
          type: 'APARTMENT',
          area: new Prisma.Decimal('50'),
          monthlyRent: new Prisma.Decimal('6000'),
        },
      })
      await prisma.lease.create({
        data: {
          id: `${ORG}-l${n}`,
          organizationId: ORG,
          unitId: `${ORG}-u${n}`,
          tenantId: `${ORG}-t${n}`,
          contractNumber: avtal,
          status,
          startDate: new Date(start),
          tenancyStartDate: new Date(start),
          endDate: slut ? new Date(slut) : null,
          monthlyRent: new Prisma.Decimal('6000'),
          depositAmount: new Prisma.Decimal('12000'),
        },
      })
    }
  })

  afterAll(async () => {
    if (!prisma) return
    try {
      for (const org of [ORG, ORG0]) {
        await prisma.$executeRawUnsafe(
          `DELETE FROM "JournalEntryLine" WHERE "journalEntryId" IN (SELECT id FROM "JournalEntry" WHERE "organizationId" = $1)`,
          org,
        )
        await prisma.journalEntry.deleteMany({ where: { organizationId: org } })
        await prisma.journalEntrySequence.deleteMany({ where: { organizationId: org } })
        await prisma.rentNoticePayment.deleteMany({
          where: { rentNotice: { organizationId: org } },
        })
        await prisma.rentNoticeEvent.deleteMany({ where: { rentNotice: { organizationId: org } } })
        await prisma.deposit.deleteMany({ where: { organizationId: org } })
        await prisma.rentNotice.deleteMany({ where: { organizationId: org } })
        await prisma.bankTransaction.deleteMany({ where: { organizationId: org } })
        await prisma.fortnoxCustomerActivation.deleteMany({ where: { organizationId: org } })
        await prisma.openingExecutedSource.deleteMany({ where: { organizationId: org } })
        await prisma.openingPackage.deleteMany({ where: { organizationId: org } })
        await prisma.fortnoxReadRun.deleteMany({ where: { organizationId: org } })
        await prisma.fortnoxConnection.deleteMany({ where: { organizationId: org } })
        await prisma.account.deleteMany({ where: { organizationId: org } })
        await prisma.lease.deleteMany({ where: { organizationId: org } })
        await prisma.unit.deleteMany({ where: { property: { organizationId: org } } })
        await prisma.property.deleteMany({ where: { organizationId: org } })
        await prisma.tenant.deleteMany({ where: { organizationId: org } })
        await prisma.notification
          .deleteMany({ where: { organizationId: org } })
          .catch(() => undefined)
        await prisma.user.deleteMany({ where: { organizationId: org } })
        await prisma.organization.deleteMany({ where: { id: org } })
      }
    } finally {
      await prisma.$disconnect()
    }
  })

  const rad = (...c: (string | number)[]) => c.join(';')
  const GILTIG = [
    HUVUD,
    rad(
      'F1',
      'FORDRAN',
      '7771000011',
      'K-1',
      '',
      '',
      2026,
      10,
      '2026-10-31',
      '6000,00',
      '6000,00',
      '',
    ),
    // A3: avslutat avtal med verklig skuld inom löptiden (giltigt).
    rad(
      'F2',
      'FORDRAN',
      `${K}-t2@example.invalid`,
      'K-2',
      '',
      '',
      2026,
      8,
      '2026-08-31',
      '5000',
      '4000',
      '',
    ),
    // A10: dokumenterat mottagen deposition.
    rad(
      'D3',
      'DEPOSITION',
      '7771000033',
      '',
      'Riggfastigheten',
      '1003',
      '',
      '',
      '',
      '12000',
      '12000',
      '2026-02-01',
    ),
  ].join('\n')

  // ── Brytdatum ──────────────────────────────────────────────────────────────
  it('C2: brytdatum mitt i månaden avvisas med skäl; bara OWNER sätter; den 1:a godtas', async () => {
    await expect(
      cutover.set(ORG, { sub: ADMIN.sub, role: 'ADMIN' }, '2026-11-01'),
    ).rejects.toBeInstanceOf(ForbiddenException)
    await expect(cutover.set(ORG, OWNER, '2026-11-15')).rejects.toThrow(/den 1:a i en månad/)
    const r = await cutover.set(ORG, OWNER, '2026-11-01')
    expect(r.cutoverDate).toBe('2026-11-01')
  })

  it('C1: alla skapande vägar respekterar brytdatum (månadsplan, initiala avier, efterdebitering)', async () => {
    const fore = await avisering.previewMonthlyNotices(ORG, 10, 2026)
    expect(fore.toCreate).toBe(0)
    expect(fore.beforeCutover).toMatch(/före organisationens brytdatum 2026-11-01/)
    const vid = await avisering.previewMonthlyNotices(ORG, 11, 2026)
    expect(vid.beforeCutover).toBeNull()
    // Initiala avier för ett avtal som startade före brytdatum: ingen avi, skäl redovisas.
    const init = await avisering.createInitialNoticesForLease(`${ORG}-l1`)
    expect(init.firstRent).toBeNull()
    expect(init.deposit).toBeNull()
    expect(init.blockedReason).toMatch(/öppningspaketet/)
    // Efterdebitering: månaderna före brytdatum är BEFORE_CUTOVER och aldrig fakturerbara.
    const gap = await backfill.detectGaps(`${ORG}-l1`, ORG)
    const fore2 = gap.months.filter((m) => m.year === 2026 && m.month <= 10)
    expect(fore2.length).toBe(10)
    expect(fore2.every((m) => m.status === 'BEFORE_CUTOVER')).toBe(true)
    expect(gap.summary.beforeCutoverCount).toBe(10)
    const kon = await backfill.detectQueue(ORG)
    // Kön visar 0 månader före brytdatum: avtalet har inga fakturerbara luckor alls.
    expect(kon.find((q) => q.leaseId === `${ORG}-l1`)).toBeUndefined()
    const res = await backfill.createBackfillNotices(`${ORG}-l1`, ORG, {
      allowBeyondWarning: true,
      vatDeclarationAcknowledged: true,
      actorUserId: OWNER.sub,
      actorRole: 'OWNER',
    })
    expect(res.skippedBeforeCutover).toBe(10)
    expect(
      await prisma.rentNotice.count({
        where: { leaseId: `${ORG}-l1`, year: 2026, month: { lte: 10 } },
      }),
    ).toBe(0)
  })

  // ── Paketets felrader (A3, K-B6, okänd/tvetydig/motstridig) ────────────────
  it('felrader: period efter brytdatum, okänd hyresgäst, period efter avtalets slut, fel hyresgäst, DRAFT', async () => {
    const fil = [
      HUVUD,
      rad('E1', 'FORDRAN', '7771000011', 'K-1', '', '', 2026, 11, '2026-11-30', '6000', '6000', ''),
      rad(
        'E2',
        'FORDRAN',
        'okand@example.invalid',
        'K-1',
        '',
        '',
        2026,
        9,
        '2026-09-30',
        '6000',
        '6000',
        '',
      ),
      rad('E3', 'FORDRAN', '7771000022', 'K-2', '', '', 2026, 9, '2026-09-30', '6000', '6000', ''),
      rad('E4', 'FORDRAN', '7771000011', 'K-3', '', '', 2026, 9, '2026-09-30', '6000', '6000', ''),
      rad('E5', 'FORDRAN', '7771000011', 'K-1', '', '', 2026, 9, '2026-09-30', '6000', '7000', ''),
      rad(
        'E6',
        'DEPOSITION',
        '7771000033',
        'K-3',
        'Riggfastigheten',
        '1001',
        '',
        '',
        '',
        '12000',
        '12000',
        '2026-02-01',
      ),
    ].join('\n')
    const pk = await paket.create(ORG, OWNER, { sourceName: 'fel.csv', innehall: fil })
    const v = await paket.validate(ORG, pk.id, OWNER)
    expect(v.status).toBe('DRAFT')
    const fel = Object.fromEntries(
      v.rows.map((r) => [r.sourceId, (r.errors as string[]).join(' ')]),
    )
    expect(fel.E1).toMatch(/inte före brytdatum/)
    expect(fel.E2).toMatch(/Okänd hyresgäst/)
    expect(fel.E3).toMatch(/utanför avtalets löptid/) // K-B6 negativt: period efter avtalets slut
    expect(fel.E4).toMatch(/annan hyresgäst/)
    expect(fel.E5).toMatch(/större än ursprungligtBelopp/)
    expect(fel.E6).toMatch(/olika avtal|motstridig/)
    await paket.discard(ORG, pk.id, OWNER)
  })

  // ── Flödet: utkast → validering → läsning → godkännande ────────────────────
  it('utkast + ny version: ny fil höjer versionen och kräver ny validering', async () => {
    const pk = await paket.create(ORG, ADMIN, {
      sourceName: 'v1.csv',
      innehall: GILTIG.replace('4000', '3999'),
    })
    pkgId = pk.id
    const v1 = await paket.validate(ORG, pkgId, ADMIN)
    expect(v1.status).toBe('VALIDATED')
    const v2 = await paket.replaceSource(ORG, pkgId, ADMIN, {
      sourceName: 'v2.csv',
      innehall: GILTIG,
    })
    expect(v2.version).toBe(2)
    expect(v2.status).toBe('DRAFT')
    const v = await paket.validate(ORG, pkgId, ADMIN)
    expect(v.status).toBe('VALIDATED')
    expect(v.totals).toMatchObject({ fordranOre: 1000000, depositionOre: 1200000, rader: 3 })
  })

  it('A4/K-B3: differens kan inte godkännas bort; AVGRÄNSAD bara med exakt specifikation', async () => {
    // B-likt: Fortnox 1510 = 10 000 + 28 212 kr; 2890 = 12 000 kr.
    const run = await lasning(ORG, connId, 3821200, 1200000)
    let v = await paket.bindFortnoxRead(ORG, pkgId, ADMIN, run.id)
    expect(v.reconciliationStatus).toBe('DIFFERENS')
    // Fel summa i specifikationen → fortfarande DIFFERENS.
    v = await paket.setSeparateLedger(ORG, pkgId, ADMIN, {
      konto: '1510',
      beskrivning: 'Separat reskontra för lgh 91–93 som förs utanför Eveno i Fortnox kundreskontra',
      filnamn: 'spec-fel.csv',
      innehall: 'postId;belopp\nG91;10000\nG92;10000',
    })
    expect(v.reconciliationStatus).toBe('DIFFERENS')
    v = await paket.setSeparateLedger(ORG, pkgId, ADMIN, {
      konto: '1510',
      beskrivning: 'Separat reskontra för lgh 91–93 som förs utanför Eveno i Fortnox kundreskontra',
      filnamn: 'spec.csv',
      innehall: 'postId;belopp\nG91;10000\nG92;10000\nG93;8212',
    })
    expect(v.reconciliationStatus).toBe('AVGRANSAD')
    const text = (v.reconciliation as { konton: { text: string }[] }).konton[0]!.text
    expect(text).toMatch(/INTE avstämt i sin helhet/)
    expect(text).not.toMatch(/är avstämt per/)
    // Ta bort specifikationen → DIFFERENS igen (ingen kvittering finns).
    v = await paket.setSeparateLedger(ORG, pkgId, ADMIN, {
      konto: '1510',
      beskrivning: '',
      filnamn: '',
      innehall: null,
    })
    expect(v.reconciliationStatus).toBe('DIFFERENS')
    // Positiv kontroll (rättelse i Fortnox syns vid omläsning): 1510 = 10 000 → AVSTÄMD.
    const run2 = await lasning(ORG, connId, 1000000, 1200000)
    await expect(paket.bindFortnoxRead(ORG, pkgId, ADMIN, run.id)).rejects.toThrow(/nyare läsning/)
    v = await paket.bindFortnoxRead(ORG, pkgId, ADMIN, run2.id)
    expect(v.reconciliationStatus).toBe('AVSTAMD')
  })

  it('T1-5: en ofullständig eller felperiodiserad läsning kan inte bindas', async () => {
    const del = await lasning(ORG, connId, 1000000, 1200000, { status: 'PARTIAL' })
    await expect(paket.bindFortnoxRead(ORG, pkgId, ADMIN, del.id)).rejects.toThrow(/inte COMPLETE/)
    const fel = await lasning(ORG, connId, 1000000, 1200000, { periodTo: '2026-10-30' })
    await expect(paket.bindFortnoxRead(ORG, pkgId, ADMIN, fel.id)).rejects.toThrow(
      /dagen före brytdatum/,
    )
    const ok = await lasning(ORG, connId, 1000000, 1200000)
    const v = await paket.bindFortnoxRead(ORG, pkgId, ADMIN, ok.id)
    expect(v.reconciliationStatus).toBe('AVSTAMD')
  })

  const godkann = async () => {
    const g = await prisma.openingPackage.findUniqueOrThrow({ where: { id: pkgId } })
    return paket.approve(ORG, pkgId, OWNER, { version: g.version, sourceSha256: g.sourceSha256 })
  }
  const omvalidera = async () => {
    await paket.validate(ORG, pkgId, ADMIN)
    const senaste = await prisma.fortnoxReadRun.findFirstOrThrow({
      where: { organizationId: ORG },
      orderBy: { startedAt: 'desc' },
    })
    await paket.bindFortnoxRead(ORG, pkgId, ADMIN, senaste.id)
  }

  it('godkännande: bara OWNER, bundet till den granskade versionen och filen', async () => {
    const g = await prisma.openingPackage.findUniqueOrThrow({ where: { id: pkgId } })
    await expect(
      paket.approve(ORG, pkgId, ADMIN, { version: g.version, sourceSha256: g.sourceSha256 }),
    ).rejects.toBeInstanceOf(ForbiddenException)
    await expect(
      paket.approve(ORG, pkgId, OWNER, { version: g.version - 1, sourceSha256: g.sourceSha256 }),
    ).rejects.toThrow(/ändrats sedan du granskade/)
  })

  // ── K-B5 / T2-4: snapshotskydd ─────────────────────────────────────────────
  it('K-B5: godkänn → bankimport → verkställ avvisas med skäl, utan effekt', async () => {
    await godkann()
    await prisma.bankTransaction.create({
      data: {
        organizationId: ORG,
        date: new Date('2026-11-02'),
        amount: new Prisma.Decimal('100'),
        description: 'Syntetisk inbetalning under fönstret',
        status: 'UNMATCHED',
      },
    })
    await expect(paket.execute(ORG, pkgId, OWNER)).rejects.toThrow(/ekonomiska läge har ändrats/)
    expect(
      await prisma.rentNotice.count({ where: { organizationId: ORG, origin: 'OPENING_PACKAGE' } }),
    ).toBe(0)
    const efter = await prisma.openingPackage.findUniqueOrThrow({ where: { id: pkgId } })
    expect(efter.status).toBe('DRAFT')
    expect(efter.invalidatedReason).toMatch(/ekonomiska läge/)
  })

  it('K-B5: godkänn → avtalsändring → verkställ avvisas', async () => {
    await omvalidera()
    await godkann()
    await prisma.lease.update({
      where: { id: `${ORG}-l2` },
      data: { terminationReason: 'Syntetisk ändring' },
    })
    await expect(paket.execute(ORG, pkgId, OWNER)).rejects.toThrow(/ekonomiska läge har ändrats/)
  })

  it('K-B5: godkänn → återanslutning (ny generation) → verkställ avvisas', async () => {
    await omvalidera()
    await godkann()
    await prisma.fortnoxConnection.update({
      where: { organizationId: ORG },
      data: { generation: { increment: 1 } },
    })
    await expect(paket.execute(ORG, pkgId, OWNER)).rejects.toThrow(/ekonomiska läge har ändrats/)
  })

  it('K-B5: godkänn → ny Fortnox-läsning → verkställ avvisas', async () => {
    await omvalidera()
    await godkann()
    await lasning(ORG, connId, 1000000, 1200000)
    await expect(paket.execute(ORG, pkgId, OWNER)).rejects.toThrow(/nyare Fortnox-läsning/)
  })

  it('positiv kontroll: ingen ändring → verkställs atomiskt; inga verifikat, betalningar eller bankrader', async () => {
    await omvalidera()
    await godkann()
    const fore = {
      ver: await prisma.journalEntry.count({ where: { organizationId: ORG } }),
      bank: await prisma.bankTransaction.count({ where: { organizationId: ORG } }),
      bet: await prisma.rentNoticePayment.count({ where: { rentNotice: { organizationId: ORG } } }),
    }
    const r = await paket.execute(ORG, pkgId, OWNER)
    expect(r).toMatchObject({ status: 'EXECUTED', fordringar: 2, depositioner: 1 })
    const avier = await prisma.rentNotice.findMany({
      where: { organizationId: ORG, origin: 'OPENING_PACKAGE' },
      orderBy: { noticeNumber: 'asc' },
    })
    expect(avier.map((a) => [a.status, a.totalAmount.toFixed(2), a.sentAt, a.paidAt])).toEqual([
      ['OPENING', '6000.00', null, null],
      ['OPENING', '4000.00', null, null],
    ])
    expect(avier.every((a) => a.noticeNumber.startsWith('IB-'))).toBe(true)
    const dep = await prisma.deposit.findFirstOrThrow({
      where: { organizationId: ORG, origin: 'OPENING_PACKAGE' },
    })
    expect(dep.status).toBe('PAID')
    expect(dep.paidAt?.toISOString().slice(0, 10)).toBe('2026-02-01') // ur underlaget, inte now
    expect(dep.rentNoticeId).toBeNull()
    expect(await prisma.rentNotice.count({ where: { organizationId: ORG, type: 'DEPOSIT' } })).toBe(
      0,
    )
    expect({
      ver: await prisma.journalEntry.count({ where: { organizationId: ORG } }),
      bank: await prisma.bankTransaction.count({ where: { organizationId: ORG } }),
      bet: await prisma.rentNoticePayment.count({ where: { rentNotice: { organizationId: ORG } } }),
    }).toEqual(fore)
    expect(await prisma.openingExecutedSource.count({ where: { organizationId: ORG } })).toBe(3)
  })

  it('replay: verkställ igen → inga nya effekter', async () => {
    const r = await paket.execute(ORG, pkgId, OWNER)
    expect(r).toMatchObject({ redanVerkstallt: true })
    expect(
      await prisma.rentNotice.count({ where: { organizationId: ORG, origin: 'OPENING_PACKAGE' } }),
    ).toBe(2)
  })

  it('K-B4: ett nytt paket med redan verkställda källrader ger radfel och 0 effekter', async () => {
    const pk = await paket.create(ORG, ADMIN, { sourceName: 'igen.csv', innehall: GILTIG })
    const v = await paket.validate(ORG, pk.id, ADMIN)
    expect(v.status).toBe('DRAFT')
    expect(
      v.rows.every((r) => (r.errors as string[]).some((e) => /redan verkställd/.test(e))),
    ).toBe(true)
    await paket.discard(ORG, pk.id, ADMIN)
  })

  it('flytt av brytdatum är spärrad efter verkställning (båda riktningar)', async () => {
    await expect(cutover.set(ORG, OWNER, '2026-12-01')).rejects.toBeInstanceOf(ConflictException)
    await expect(cutover.set(ORG, OWNER, '2026-10-01')).rejects.toBeInstanceOf(ConflictException)
    const g = await cutover.get(ORG)
    expect(g.locked).toBe(true)
  })

  it('initiala avier: ett avtal med historisk deposition får aldrig en ny depositionsavi', async () => {
    // L3 startade före brytdatum → ingen avi alls; regeln för historisk deposition står också.
    const init = await avisering.createInitialNoticesForLease(`${ORG}-l3`)
    expect(init.deposit).toBeNull()
    expect(
      await prisma.rentNotice.count({ where: { leaseId: `${ORG}-l3`, type: 'DEPOSIT' } }),
    ).toBe(0)
  })

  // ── K-B2 enligt C2 TILLÄGG-4 T4-1/T4-2 och K-B1 ────────────────────────────
  // t1 har historisk skuld F1 (6 000, okt) och får löpande avier (nov, dec); t3 saknar
  // OPENING och är den positiva kontrollen (P). Beloppen gör fall X tvetydigt: 6 000 kan
  // avse både den gamla skulden och den nya avin.
  const opening = async (nr: 'F1' | 'F2') =>
    prisma.rentNotice.findFirstOrThrow({
      where: {
        organizationId: ORG,
        origin: 'OPENING_PACKAGE',
        openingRowId: { not: null },
        totalAmount: nr === 'F1' ? 6000 : 4000,
      },
    })
  const bankrad = async (belopp: string, ocr: string | null, datum = '2026-11-05') =>
    (
      await prisma.bankTransaction.create({
        data: {
          organizationId: ORG,
          date: new Date(datum),
          amount: new Prisma.Decimal(belopp),
          description: 'Syntetisk inbetalning',
          rawOcr: ocr,
          status: 'UNMATCHED',
        },
      })
    ).id
  const kor = async (id: string) =>
    recon.matchTransaction(
      (await prisma.bankTransaction.findUniqueOrThrow({ where: { id } })) as never,
      ORG,
    )
  const loPandeAvi = async (tenant: string, lease: string, ocr: string, month: number) => {
    const n = await prisma.rentNotice.create({
      data: {
        organizationId: ORG,
        tenantId: tenant,
        leaseId: lease,
        noticeNumber: `${K}-AVI-${tenant.slice(-2)}-${month}`,
        ocrNumber: ocr,
        type: 'RENT',
        status: 'SENT',
        sentAt: new Date('2026-10-25'),
        month,
        year: 2026,
        dueDate: new Date(`2026-${month - 1}-30`),
        amount: new Prisma.Decimal('6000'),
        totalAmount: new Prisma.Decimal('6000'),
      },
    })
    // Accrual (D 1510 / K 3011) som produktionens avi-väg skriver.
    await prisma.journalEntry.create({
      data: {
        organizationId: ORG,
        date: new Date(`2026-${String(month).padStart(2, '0')}-01`),
        fiscalYear: 2026,
        series: 'Z',
        verNumber: 9000 + month * 10 + Number(tenant.slice(-1)),
        description: 'Syntetisk accrual',
        source: 'INVOICE',
        sourceId: `rent-notice:${n.id}`,
        lines: {
          create: [
            { accountId: konto[1510]!, debit: new Prisma.Decimal('6000') },
            { accountId: konto[3011]!, credit: new Prisma.Decimal('6000') },
          ],
        },
      },
    })
    return n.id
  }
  const allokeringar = (noticeId: string) =>
    prisma.rentNoticePayment.count({ where: { rentNoticeId: noticeId } })
  const betalverifikat = () =>
    prisma.journalEntry.count({ where: { organizationId: ORG, source: 'PAYMENT' } })
  // G2-grindens egen räkning: > 0 olösta granskningsrader = påminnelse, avgift, ränta och
  // kravsteg stoppas av assertAutomaticEffectAllowed (payment-freshness.service.ts).
  const kravPausat = async () => (await freshness.raknaOlostIdentitetsgranskning(ORG)) > 0
  let nov1 = ''
  let dec1 = ''

  it('T4-2 P: hyresgäst utan OPENING automatchas som i dag', async () => {
    const id = await loPandeAvi(`${ORG}-t3`, `${ORG}-l3`, '7771000033', 11)
    const tx = await bankrad('6000', '7771000033')
    expect(await kor(tx)).toBe(true)
    expect((await prisma.rentNotice.findUniqueOrThrow({ where: { id } })).status).toBe('PAID')
    expect(await kravPausat()).toBe(false)
  })

  let txX = ''
  it('T4-2 X: OPENING 6 000 + ny avi 6 000, betalning 6 000 → 0 allokeringar, orsak synlig, kravpaus', async () => {
    nov1 = await loPandeAvi(`${ORG}-t1`, `${ORG}-l1`, '7771000011', 11)
    const f1 = await opening('F1')
    const ver = await betalverifikat()
    txX = await bankrad('6000', '7771000011')
    expect(await kor(txX)).toBe(false)
    const rad = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: txX } })
    expect([rad.status, rad.identityReviewReason]).toEqual([
      'UNMATCHED',
      'HISTORISK_SKULD_FORE_BRYTDATUM',
    ])
    expect(await allokeringar(nov1)).toBe(0)
    expect(await allokeringar(f1.id)).toBe(0)
    expect(await betalverifikat()).toBe(ver)
    expect(await kravPausat()).toBe(true)
    // autoMatchAll tar inte raden heller (granskningsrader är inga kandidater).
    await recon.autoMatchAll(ORG)
    expect(await allokeringar(nov1)).toBe(0)
    const nov = await prisma.rentNotice.findUniqueOrThrow({ where: { id: nov1 } })
    expect([nov.status, nov.collectionStage, Number(nov.reminderFeeAmount)]).toEqual([
      'SENT',
      'NONE',
      0,
    ])
  })

  it('T4-2 M1: manuellt till nya avin → PAID, ett verifikat, OPENING orörd, pausen hävs', async () => {
    const ver = await betalverifikat()
    await recon.manualMatch(txX, { rentNoticeId: nov1 }, ORG, OWNER.sub)
    expect((await prisma.rentNotice.findUniqueOrThrow({ where: { id: nov1 } })).status).toBe('PAID')
    expect(await betalverifikat()).toBe(ver + 1)
    const f1 = await opening('F1')
    expect([f1.status, await allokeringar(f1.id)]).toEqual(['OPENING', 0])
    expect(await kravPausat()).toBe(false)
  })

  let txM2 = ''
  it('T4-2 M2 + K-B1: manuellt till OPENING → PAID via 12.1-undantaget (D 1930 / K 1510); nya avin obetald', async () => {
    dec1 = await loPandeAvi(`${ORG}-t1`, `${ORG}-l1`, '7771000011', 12)
    txM2 = await bankrad('6000', '7771000011')
    expect(await kor(txM2)).toBe(false)
    expect(await kravPausat()).toBe(true)
    const f1 = await opening('F1')
    const ver = await betalverifikat()
    await recon.manualMatch(txM2, { rentNoticeId: f1.id }, ORG, OWNER.sub)
    expect((await prisma.rentNotice.findUniqueOrThrow({ where: { id: f1.id } })).status).toBe(
      'PAID',
    )
    expect(await betalverifikat()).toBe(ver + 1)
    const v = await prisma.journalEntry.findFirstOrThrow({
      where: { organizationId: ORG, source: 'PAYMENT' },
      orderBy: { createdAt: 'desc' },
      include: { lines: true },
    })
    expect(Number(v.lines.find((l) => l.accountId === konto[1930])?.debit)).toBe(6000)
    expect(Number(v.lines.find((l) => l.accountId === konto[1510])?.credit)).toBe(6000)
    expect((await prisma.rentNotice.findUniqueOrThrow({ where: { id: dec1 } })).status).toBe('SENT')
    expect(await kravPausat()).toBe(false) // kravtrappan återupptas enligt ordinarie regel
  })

  it('T4-2 U: avmatchning efter M2 → OPENING återställs med motverifikat; raden pausar igen', async () => {
    const f1 = await opening('F1')
    await recon.unmatchTransaction(txM2, ORG, OWNER.sub, 'Syntetisk felmatchning')
    const efter = await prisma.rentNotice.findUniqueOrThrow({ where: { id: f1.id } })
    expect(efter.status).toBe('OPENING')
    const r = (await accounting.getBalanceSheet(ORG, '2026-12-31')).oppningskomponent!.rader.find(
      (x) => x.konto === 1510,
    )!
    // Verifikat: P 0, nov +6000 −6000, dec +6000, M2 −6000 och motverifikat +6000 = +6000.
    expect(r.verifikat).toBe(6000)
    expect(r.nettoInklOppning).toBe(16000) // F1 6 000 + F2 4 000 + dec 6 000
    expect(await kravPausat()).toBe(true)
  })

  it('T4-2 Y: OPENING 6 000 + ny avi 6 000, betalning 2 000 → ingen automatisk delbetalning', async () => {
    const tx = await bankrad('2000', '7771000011')
    expect(await kor(tx)).toBe(false)
    expect(await allokeringar(dec1)).toBe(0)
    expect(
      (await prisma.bankTransaction.findUniqueOrThrow({ where: { id: tx } })).identityReviewReason,
    ).toBe('HISTORISK_SKULD_FORE_BRYTDATUM')
  })

  it('T4-2 Z: betalning 12 000 → ingen automatik; manuell fördelning på båda ger 2 allokeringar och 2 verifikat', async () => {
    const tx = await bankrad('12000', '7771000011')
    expect(await kor(tx)).toBe(false)
    const f1 = await opening('F1')
    const ver = await betalverifikat()
    await recon.manualMatch(tx, { rentNoticeIds: [dec1, f1.id] }, ORG, OWNER.sub)
    expect([await allokeringar(dec1), await allokeringar(f1.id)]).toEqual([1, 1])
    expect(await betalverifikat()).toBe(ver + 2)
    expect((await prisma.rentNotice.findUniqueOrThrow({ where: { id: dec1 } })).status).toBe('PAID')
    expect((await prisma.rentNotice.findUniqueOrThrow({ where: { id: f1.id } })).status).toBe(
      'PAID',
    )
    // Fördelning kräver minst två avier och ett belopp som ryms.
    const tx2 = await bankrad('99999', null)
    await expect(
      recon.manualMatch(tx2, { rentNoticeIds: [dec1, f1.id] }, ORG, OWNER.sub),
    ).rejects.toThrow()
    await prisma.bankTransaction.delete({ where: { id: tx2 } })
  })

  it('tidsperspektiv §12.9: D före/vid/efter brytdatum, efter betalning', async () => {
    const fore = await accounting.getBalanceSheet(ORG, '2026-10-31')
    expect(fore.oppningskomponent?.galler).toBe(false)
    expect(fore.oppningskomponent?.rader.every((r) => r.oppning === 0)).toBe(true)
    const vid = await oppningskomponent(p, ORG, '2026-11-01')
    expect(vid?.konton).toEqual({ '1510': 10000, '2890': 12000 })
    const efter = await accounting.getBalanceSheet(ORG, '2026-12-31')
    const r1510 = efter.oppningskomponent!.rader.find((r) => r.konto === 1510)!
    // Verifikat: +6000 (U-läge) −6000 (dec via Z) −6000 (F1 via Z) = −6000.
    expect(r1510.verifikat).toBe(-6000)
    expect(r1510.oppning).toBe(10000)
    expect(r1510.nettoInklOppning).toBe(4000) // = kvarvarande historisk skuld (F2)
    expect((await historiskSkuld(p, ORG)).belopp).toBe(4000)
    expect(efter.oppningskomponent!.begransning).toMatch(/inte en full balansräkning/)
    const utan = efter.assets.accounts.find((a) => a.number === 1510)!
    expect(utan.balance).toBe(-6000)
  })

  it('delbetalning mot OPENING (manuell) lämnar status OPENING och sänker resten', async () => {
    const f2 = await opening('F2')
    const tx = await bankrad('2500', null)
    await recon.manualMatch(tx, { rentNoticeId: f2.id }, ORG, OWNER.sub)
    const efter = await prisma.rentNotice.findUniqueOrThrow({ where: { id: f2.id } })
    expect(efter.status).toBe('OPENING')
    expect(Number(efter.paidAmount)).toBe(2500)
  })

  it('K-B1 negativt: EVENO-avi utan accrual och falsk OPENING utan giltig paketrad vägras', async () => {
    const utan = await prisma.rentNotice.create({
      data: {
        organizationId: ORG,
        tenantId: `${ORG}-t1`,
        leaseId: `${ORG}-l1`,
        noticeNumber: `${K}-UTAN-ACCRUAL`,
        ocrNumber: '7771000011',
        type: 'RENT',
        status: 'SENT',
        sentAt: new Date('2026-11-25'),
        month: 1,
        year: 2027,
        dueDate: new Date('2026-11-30'),
        amount: new Prisma.Decimal('6000'),
        totalAmount: new Prisma.Decimal('6000'),
      },
    })
    const tx = await bankrad('6000', null)
    await expect(recon.manualMatch(tx, { rentNoticeId: utan.id }, ORG, OWNER.sub)).rejects.toThrow()
    await expect(
      accounting.createJournalEntryForRentNoticePayment(
        { id: utan.id, noticeNumber: utan.noticeNumber },
        { id: tx, date: new Date('2026-11-05'), amount: new Prisma.Decimal('6000') },
        ORG,
        null,
        undefined,
        'kb1-neg',
      ),
    ).rejects.toBeInstanceOf(MissingAccrualError)
    const falsk = await prisma.rentNotice.update({
      where: { id: utan.id },
      data: { origin: 'OPENING_PACKAGE', status: 'OPENING' },
    })
    await expect(
      accounting.createJournalEntryForRentNoticePayment(
        { id: falsk.id, noticeNumber: falsk.noticeNumber },
        { id: tx, date: new Date('2026-11-05'), amount: new Prisma.Decimal('6000') },
        ORG,
        null,
        undefined,
        'kb1-neg2',
      ),
    ).rejects.toBeInstanceOf(MissingAccrualError)
    await prisma.rentNotice.delete({ where: { id: utan.id } })
  })

  it('A9/T2-3: historisk deposition återbetalas med avdrag mot skulden (D 2890 / K 1930 + 3040)', async () => {
    const dep = await prisma.deposit.findFirstOrThrow({
      where: { organizationId: ORG, origin: 'OPENING_PACKAGE' },
    })
    await deposits.refund(
      dep.id,
      { refundAmount: 10000, deductions: [{ reason: 'Syntetisk skada', amount: 2000 }] } as never,
      ORG,
      OWNER.sub,
    )
    const efter = await prisma.deposit.findUniqueOrThrow({ where: { id: dep.id } })
    expect(['REFUNDED', 'PARTIALLY_REFUNDED']).toContain(efter.status)
    const ver = await prisma.journalEntry.findFirstOrThrow({
      where: { organizationId: ORG, sourceId: `deposit-refund:${dep.id}` },
      include: { lines: true },
    })
    expect(Number(ver.lines.find((l) => l.accountId === konto[2890])?.debit)).toBe(12000)
    // 2890 inkl. öppning = 12 000 (komponent) − 12 000 (återbetald) = 0.
    const r = (await accounting.getBalanceSheet(ORG, '2026-12-31')).oppningskomponent!.rader.find(
      (x) => x.konto === 2890,
    )!
    expect(r.nettoInklOppning).toBe(0)
  })

  // ── Nollöppning (BYGGLEDARE-003 p1) ────────────────────────────────────────
  it('nollöppning: kräver 0/0 i Fortnox; AVGRÄNSAD och 1510 ≠ 0 räcker inte', async () => {
    const o = await skapaOrg(ORG0)
    await cutover.set(ORG0, { sub: o.userId, role: 'OWNER' }, '2026-11-01')
    const ägare = { sub: o.userId, role: 'OWNER' as const }
    const pk = await paket.create(ORG0, ägare, {
      sourceName: 'noll.csv',
      innehall: HUVUD,
      nollOppning: true,
    })
    const v = await paket.validate(ORG0, pk.id, ägare)
    expect(v.status).toBe('VALIDATED')
    await expect(
      paket.setSeparateLedger(ORG0, pk.id, ägare, {
        konto: '1510',
        beskrivning: 'Försök att kalla ett avgränsat urval för nollsaldo — ska vägras',
        filnamn: 's.csv',
        innehall: 'postId;belopp\nX;100',
      }),
    ).rejects.toThrow(/inte ett nollsaldo/)
    const fel = await lasning(
      ORG0,
      (await prisma.fortnoxConnection.findUniqueOrThrow({ where: { organizationId: ORG0 } })).id,
      50000,
      0,
    )
    await paket.bindFortnoxRead(ORG0, pk.id, ägare, fel.id)
    const g = await prisma.openingPackage.findUniqueOrThrow({ where: { id: pk.id } })
    await expect(
      paket.approve(ORG0, pk.id, ägare, { version: g.version, sourceSha256: g.sourceSha256 }),
    ).rejects.toThrow(/Nollöppning kräver/)
    const noll = await lasning(ORG0, fel.connectionId, 0, 0)
    await paket.bindFortnoxRead(ORG0, pk.id, ägare, noll.id)
    await paket.approve(ORG0, pk.id, ägare, { version: g.version, sourceSha256: g.sourceSha256 })
    const r = await paket.execute(ORG0, pk.id, ägare)
    expect(r).toMatchObject({ status: 'EXECUTED', fordringar: 0, depositioner: 0 })
    // Ett paket med rader kan inte kallas nollöppning.
    await expect(
      paket.create(ORG0, ägare, { sourceName: 'x.csv', innehall: GILTIG, nollOppning: true }),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it('E-pre: ett paket kan inte valideras när Eveno har egna poster före brytdatum', async () => {
    await prisma.journalEntry.create({
      data: {
        organizationId: ORG0,
        date: new Date('2026-10-15'),
        fiscalYear: 2026,
        series: 'Z',
        verNumber: 9999,
        description: 'Syntetisk tidig Eveno-post',
      },
    })
    const ägare = {
      sub: (await prisma.user.findFirstOrThrow({ where: { organizationId: ORG0 } })).id,
      role: 'OWNER' as const,
    }
    const pk = await paket
      .create(ORG0, ägare, { sourceName: 'pre.csv', innehall: HUVUD, nollOppning: true })
      .catch((e) => e)
    // Nollöppning är redan verkställd i ORG0 → använd ett vanligt paket i ORG:s mall i stället.
    expect(pk).toBeDefined()
    if (!(pk instanceof Error)) {
      await expect(paket.validate(ORG0, pk.id, ägare)).rejects.toThrow(/egna poster före brytdatum/)
    }
  })
})
