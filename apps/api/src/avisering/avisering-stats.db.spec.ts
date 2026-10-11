/**
 * TESTKUND-047 (F-046-2, ACCEPTANS-048 S1–S4): månadsöversiktens tre belopp (`AviseringService.getStats`, kortén
 * «Totalt att fakturera», «Inkasserat», «Utestående») mot riktig Postgres med produktens egna vägar: depositionsavi
 * betald manuellt (DepositsService.markPaid → PAID, paidAmount null, ingen allokering), obetald deposition,
 * hyresavi del- och fullbetald via ReconciliationService.manualMatch, annullerad via AviseringService.cancelNotice,
 * förfallen delbetald, en annan månad och en annan organisation (de två sista som märkt DB-FÖRBEREDELSE).
 * Belopp i KRONOR. Läsningen får inte ändra något: DB-avtryck före och efter.
 */
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {},
  PutObjectCommand: class {},
  DeleteObjectCommand: class {},
  GetObjectCommand: class {},
}))
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: async () => '' }))

import { PrismaClient, Prisma } from '@prisma/client'
import { InvoicesService } from '../invoices/invoices.service'
import { InvoiceEventsService } from '../invoices/invoice-events.service'
import { ReconciliationService } from '../reconciliation/reconciliation.service'
import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { RentNoticeEventsService } from '../avisering/rent-notice-events.service'
import { BankImportAttemptService } from '../reconciliation/bank-import-attempt.service'
import { PaymentFreshnessService } from '../payment-freshness/payment-freshness.service'
import { AviseringService } from '../avisering/avisering.service'
import { OcrService } from '../common/ocr/ocr.service'
import type { PrismaService } from '../common/prisma/prisma.service'
import { DepositsService } from '../deposits/deposits.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip
jest.setTimeout(120_000)

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => expect(HAR_DB).toBe(true))
})

const K = `f0462-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const ORG = `${K}-org`
const ORG2 = `${K}-org2`

medDb('F-046-2: månadsöversiktens belopp (getStats) mot riktig Postgres', () => {
  let prisma: PrismaClient
  let p: PrismaService
  let deposits: DepositsService
  let avisering: AviseringService
  let recon: ReconciliationService
  let userId = ''

  const stub = (namn: string) =>
    new Proxy(
      {},
      {
        get: (_t, prop) => () => {
          throw new Error(`OVÄNTAT ANROP: ${namn}.${String(prop)}`)
        },
      },
    )

  beforeAll(async () => {
    prisma = new PrismaClient()
    p = prisma as unknown as PrismaService
    const accounting = new AccountingService(p, new VerifikationsnummerService(p))
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
    recon = new ReconciliationService(
      p,
      invoices,
      invoiceEvents,
      accounting,
      new PaymentFreshnessService(p, { send: async () => undefined } as never) as never,
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
    avisering = new AviseringService(
      p,
      new OcrService(p),
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
    for (const id of [ORG, ORG2]) {
      await prisma.organization.create({
        data: {
          id,
          name: `F0431 ${id.slice(-4)} AB`,
          email: `${id}@example.invalid`,
          street: 'Gatan 1',
          city: 'Staden',
          postalCode: '12345',
          bankgiro: '5678-1230',
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
      if (id === ORG) userId = u.id
      await accounting.seedDefaultAccounts(id)
      await prisma.property.create({
        data: {
          id: `${id}-p`,
          organizationId: id,
          name: 'Riggfastigheten',
          propertyDesignation: `${id}-1:1`,
          type: 'RESIDENTIAL',
          street: 'Riggatan 1',
          city: 'Staden',
          postalCode: '12345',
          totalArea: new Prisma.Decimal('500'),
        },
      })
    }
  })

  afterAll(async () => {
    if (!prisma) return
    try {
      for (const org of [ORG, ORG2]) {
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
        await prisma.bankTransaction.deleteMany({ where: { organizationId: org } })
        await prisma.deposit.deleteMany({ where: { organizationId: org } })
        await prisma.rentNotice.deleteMany({ where: { organizationId: org } })
        await prisma.lease.deleteMany({ where: { organizationId: org } })
        await prisma.unit.deleteMany({ where: { property: { organizationId: org } } })
        await prisma.property.deleteMany({ where: { organizationId: org } })
        await prisma.tenant.deleteMany({ where: { organizationId: org } })
        await prisma.account.deleteMany({ where: { organizationId: org } })
        await prisma.notification
          .deleteMany({ where: { organizationId: org } })
          .catch(() => undefined)
        await prisma.rentNoticeNumberSequence.deleteMany({ where: { organizationId: org } })
        await prisma.tenantOcrSequence
          .deleteMany({ where: { organizationId: org } })
          .catch(() => undefined)
        await prisma.user.deleteMany({ where: { organizationId: org } })
        await prisma.organization.deleteMany({ where: { id: org } })
      }
    } finally {
      await prisma.$disconnect()
    }
  })

  let nyttNr = 0
  async function fall(org: string, opts: { deposition: boolean }) {
    nyttNr++
    const t = await prisma.tenant.create({
      data: {
        organizationId: org,
        type: 'INDIVIDUAL',
        firstName: 'Syntetisk',
        lastName: `Stat ${nyttNr}`,
        email: `${K}-s${nyttNr}@example.invalid`,
      },
    })
    const u = await prisma.unit.create({
      data: {
        propertyId: `${org}-p`,
        name: `Lgh S${nyttNr}`,
        unitNumber: `S${nyttNr}`,
        type: 'APARTMENT',
        area: new Prisma.Decimal('50'),
        monthlyRent: new Prisma.Decimal('7000'),
      },
    })
    const l = await prisma.lease.create({
      data: {
        organizationId: org,
        unitId: u.id,
        tenantId: t.id,
        status: 'ACTIVE',
        startDate: new Date('2026-10-01'),
        tenancyStartDate: new Date('2026-10-01'),
        monthlyRent: new Prisma.Decimal('7000'),
        depositAmount: new Prisma.Decimal(opts.deposition ? '5000' : '0'),
      },
    })
    await avisering.createInitialNoticesForLease(l.id)
    const hyra = await prisma.rentNotice.findFirstOrThrow({
      where: { leaseId: l.id, type: 'RENT' },
    })
    const dep = await prisma.deposit.findFirst({ where: { leaseId: l.id } })
    return { leaseId: l.id, hyra, dep }
  }
  const bankBetalning = async (org: string, aviId: string, kronor: string) => {
    const tx = await prisma.bankTransaction.create({
      data: {
        organizationId: org,
        date: new Date('2026-10-05'),
        amount: new Prisma.Decimal(kronor),
        description: 'Syntetisk inbetalning',
        status: 'UNMATCHED',
      },
    })
    await recon.manualMatch(tx.id, { rentNoticeId: aviId }, org, userId)
  }
  const avtryck = async () =>
    JSON.stringify([
      await prisma.rentNotice.findMany({
        where: { organizationId: { in: [ORG, ORG2] } },
        orderBy: { id: 'asc' },
        select: { id: true, status: true, paidAmount: true, paidAt: true, totalAmount: true },
      }),
      await prisma.rentNoticePayment.count({
        where: { rentNotice: { organizationId: { in: [ORG, ORG2] } } },
      }),
      await prisma.journalEntry.count({ where: { organizationId: { in: [ORG, ORG2] } } }),
      await prisma.journalEntryLine.aggregate({
        where: { journalEntry: { organizationId: { in: [ORG, ORG2] } } },
        _sum: { debit: true, credit: true },
      }),
      await prisma.deposit.findMany({
        where: { organizationId: { in: [ORG, ORG2] } },
        orderBy: { id: 'asc' },
        select: { id: true, status: true },
      }),
    ])
  const belopp = (s: { totalAmount: number; paidAmount: number; outstandingAmount: number }) => [
    s.totalAmount,
    s.paidAmount,
    s.outstandingAmount,
  ]

  beforeAll(async () => {
    // T1: deposition betald manuellt (markPaid → PAID, paidAmount null), hyran obetald.
    const t1 = await fall(ORG, { deposition: true })
    await deposits.markPaid(t1.dep!.id, ORG, userId)
    // T2: deposition obetald, hyran helt betald via bank (manuell matchning).
    const t2 = await fall(ORG, { deposition: true })
    await bankBetalning(ORG, t2.hyra.id, '7000')
    // T3: hyran delbetald 3 500.
    const t3 = await fall(ORG, { deposition: false })
    await bankBetalning(ORG, t3.hyra.id, '3500')
    // T4: hyran annullerad.
    const t4 = await fall(ORG, { deposition: false })
    await avisering.cancelNotice(t4.hyra.id, ORG, userId)
    // T5: hyran delbetald 2 000 och förfallen.
    const t5 = await fall(ORG, { deposition: false })
    await bankBetalning(ORG, t5.hyra.id, '2000')
    await prisma.rentNotice.update({
      where: { id: t5.hyra.id },
      data: { dueDate: new Date('2026-09-25') },
    })
    // DB-FÖRBEREDELSE: en novemberavi i ORG (annan månad) och en oktoberavi i ORG2 (annan organisation), obetalda.
    for (const [org, month, nrr] of [
      [ORG, 11, 'NOV'],
      [ORG2, 10, 'ORG2'],
    ] as const) {
      const t = await prisma.tenant.create({
        data: {
          organizationId: org,
          type: 'INDIVIDUAL',
          firstName: 'Syntetisk',
          lastName: `Stat ${nrr}`,
          email: `${K}-${nrr}@example.invalid`,
          ocrNumber: `9${nrr === 'NOV' ? '1' : '2'}00000017`,
        },
      })
      const u = await prisma.unit.create({
        data: {
          propertyId: `${org}-p`,
          name: `Lgh ${nrr}`,
          unitNumber: nrr,
          type: 'APARTMENT',
          area: new Prisma.Decimal('50'),
          monthlyRent: new Prisma.Decimal('7000'),
        },
      })
      const l = await prisma.lease.create({
        data: {
          organizationId: org,
          unitId: u.id,
          tenantId: t.id,
          status: 'ACTIVE',
          startDate: new Date('2026-10-01'),
          tenancyStartDate: new Date('2026-10-01'),
          monthlyRent: new Prisma.Decimal('7000'),
          depositAmount: new Prisma.Decimal('0'),
        },
      })
      await prisma.rentNotice.create({
        data: {
          organizationId: org,
          tenantId: t.id,
          leaseId: l.id,
          noticeNumber: `${K}-${nrr}`,
          ocrNumber: t.ocrNumber!,
          type: 'RENT',
          status: 'SENT',
          month,
          year: 2026,
          dueDate: new Date(`2026-${month}-30`),
          amount: new Prisma.Decimal('7000'),
          totalAmount: new Prisma.Decimal('7000'),
        },
      })
    }
  })

  it('förutsättning: depositionsavin är PAID med paidAmount null och utan allokering (manuell väg), den annullerade är CANCELLED', async () => {
    const dep = await prisma.rentNotice.findMany({
      where: { organizationId: ORG, type: 'DEPOSIT' },
      select: { status: true, paidAmount: true, _count: { select: { payments: true } } },
      orderBy: { status: 'asc' },
    })
    expect(
      dep.map((d) => [
        d.status,
        d.paidAmount === null ? null : Number(d.paidAmount),
        d._count.payments,
      ]),
    ).toEqual(expect.arrayContaining([['PAID', null, 0]]))
    expect(
      await prisma.rentNotice.count({ where: { organizationId: ORG, status: 'CANCELLED' } }),
    ).toBe(1)
  })

  it('S1/S2: oktober i ORG — Totalt 38 000, Inkasserat 17 500, Utestående 20 500 kr; identiteten Totalt = Inkasserat + Utestående − överbetalt håller', async () => {
    const s = await avisering.getStats(ORG, 10, 2026)
    expect(belopp(s)).toEqual([38000, 17500, 20500])
    expect(s.totalAmount).toBe(s.paidAmount + s.outstandingAmount)
  })

  it('S2: annan månad (november, 7 000 obetald) och annan organisation (ORG2 oktober, 7 000 obetald) räknas var för sig', async () => {
    expect(belopp(await avisering.getStats(ORG, 11, 2026))).toEqual([7000, 0, 7000])
    expect(belopp(await avisering.getStats(ORG2, 10, 2026))).toEqual([7000, 0, 7000])
  })

  it('S2: statusräkningen (antal) är oförändrad i semantik: annullerad räknas som annullerad, betald som betald', async () => {
    const s = await avisering.getStats(ORG, 10, 2026)
    expect([s.total, s.cancelled]).toEqual([7, 1])
  })

  it('S4: läsningen ändrar ingenting (avier, allokeringar, verifikat, summor, depositioner)', async () => {
    const fore = await avtryck()
    await avisering.getStats(ORG, 10, 2026)
    await avisering.getStats(ORG, 11, 2026)
    expect(await avtryck()).toBe(fore)
  })
})
