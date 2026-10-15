/**
 * TESTKUND-045 (F-043-1, ACCEPTANS-044): manuell betalning av en deposition vars länkade depositionsavi
 * står i FAILED (utskicket misslyckades — här: hyresgästen saknar e-post, produktens egen väg). Riktig
 * Postgres, riktiga tjänster (AviseringService.createInitialNoticesForLease, DepositsService.markPaid,
 * ReconciliationService.matchTransaction). Allt syntetiskt.
 *
 * Kundeffekt som mäts: avin ska bli PAID när depositionen betalas manuellt (restskuld 0, inget öppet krav),
 * och hyresgästens nästa bankbetalning med samma (fasta) OCR ska matchas mot HYRESAVIN — inte bli liggande
 * för att två avier ser öppna ut. «DB-FÖRBEREDELSE» = uttryckligt syntetiskt läge satt direkt i databasen.
 */
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {},
  PutObjectCommand: class {},
  DeleteObjectCommand: class {},
  GetObjectCommand: class {},
}))
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: async () => '' }))

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common'
import { PrismaClient, Prisma } from '@prisma/client'
import type { RentNoticeStatus } from '@prisma/client'
import { InvoicesService } from '../invoices/invoices.service'
import { InvoiceEventsService } from '../invoices/invoice-events.service'
import type { ReconciliationService } from '../reconciliation/reconciliation.service'
import { reconciliationUtanKundtillgodo } from '../reconciliation/customer-credit.test-double'
import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { RentNoticeEventsService } from '../avisering/rent-notice-events.service'
import { BankImportAttemptService } from '../reconciliation/bank-import-attempt.service'
import { PaymentFreshnessService } from '../payment-freshness/payment-freshness.service'
import { AviseringService } from '../avisering/avisering.service'
import { aviseringUtanAutomatisktTillgodo } from '../avisering/customer-credit.test-double'
import { OcrService } from '../common/ocr/ocr.service'
import type { PrismaService } from '../common/prisma/prisma.service'
import { DepositsService } from './deposits.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip
jest.setTimeout(120_000)

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => expect(HAR_DB).toBe(true))
})

const K = `f0431-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const ORG = `${K}-org`
const ORG2 = `${K}-org2`

medDb('F-043-1: manuell depositionsbetalning via FAILED depositionsavi', () => {
  let prisma: PrismaClient
  let p: PrismaService
  let deposits: DepositsService
  let avisering: AviseringService
  let recon: ReconciliationService
  let userId = ''
  let nr = 0

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
    recon = reconciliationUtanKundtillgodo(
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
    avisering = aviseringUtanAutomatisktTillgodo(
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

  /**
   * Nytt hyresförhållande från 2026-10-01 med deposition 5 000 och hyra 7 000. utanEpost: hyresgästen saknar e-post
   * och utskicket körs genom produktens egen sändningsväg (processNoticeSendJob) → avin FAILED «Hyresgästen saknar
   * e-postadress». Annars (e-post unik per org) sätts FAILED som DB-FÖRBEREDELSE.
   */
  async function nyttFall(org = ORG, utanEpost = false) {
    nr++
    const t = await prisma.tenant.create({
      data: {
        organizationId: org,
        type: 'INDIVIDUAL',
        firstName: 'Syntetisk',
        lastName: `Hyresgäst ${nr}`,
        email: utanEpost ? '' : `${K}-t${nr}@example.invalid`,
      },
    })
    const u = await prisma.unit.create({
      data: {
        propertyId: `${org}-p`,
        name: `Lgh ${nr}`,
        unitNumber: `F${nr}`,
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
        depositAmount: new Prisma.Decimal('5000'),
      },
    })
    await avisering.createInitialNoticesForLease(l.id)
    const dep = await prisma.deposit.findFirstOrThrow({ where: { leaseId: l.id } })
    if (utanEpost) await avisering.processNoticeSendJob(org, dep.rentNoticeId!)
    else
      await prisma.rentNotice.update({
        where: { id: dep.rentNoticeId! },
        data: { status: 'FAILED', sendError: 'DB-FÖRBEREDELSE: syntetiskt misslyckat utskick' },
      })
    const depAvi = await prisma.rentNotice.findUniqueOrThrow({ where: { id: dep.rentNoticeId! } })
    const hyresavi = await prisma.rentNotice.findFirstOrThrow({
      where: { leaseId: l.id, type: 'RENT' },
    })
    const ocr = (await prisma.tenant.findUniqueOrThrow({ where: { id: t.id } })).ocrNumber!
    return { tenantId: t.id, leaseId: l.id, dep, depAvi, hyresavi, ocr }
  }
  const avi = (id: string) =>
    prisma.rentNotice.findUniqueOrThrow({
      where: { id },
      select: { status: true, paidAt: true, paidAmount: true, totalAmount: true },
    })
  const verifikat = (depId: string) =>
    prisma.journalEntry.findMany({
      where: { sourceId: `deposit-manual-payment:${depId}` },
      include: { lines: { include: { account: true } } },
    })
  const rader = (je: {
    lines: {
      account: { number: number }
      debit: Prisma.Decimal | null
      credit: Prisma.Decimal | null
    }[]
  }) =>
    je.lines
      .map((l) => [
        l.account.number,
        Math.round(Number(l.debit ?? 0) * 100),
        Math.round(Number(l.credit ?? 0) * 100),
      ])
      .sort((a, b) => a[0]! - b[0]!)
  // Bit-för-bit-avtryck av allt som en nekad betalning inte får röra.
  const avtryck = async (f: Awaited<ReturnType<typeof nyttFall>>) =>
    JSON.stringify([
      await prisma.deposit.findUniqueOrThrow({ where: { id: f.dep.id } }),
      await prisma.rentNotice.findUniqueOrThrow({ where: { id: f.depAvi.id } }),
      await prisma.journalEntry.count({ where: { organizationId: { in: [ORG, ORG2] } } }),
      await prisma.rentNoticePayment.count({
        where: { rentNotice: { organizationId: { in: [ORG, ORG2] } } },
      }),
    ])

  let a1: Awaited<ReturnType<typeof nyttFall>>
  it('förutsättning: produktens egen väg ger depositionsavin FAILED (saknad e-post) och depositionen PENDING', async () => {
    a1 = await nyttFall(ORG, true)
    expect([
      a1.depAvi.status,
      a1.depAvi.sendError,
      a1.dep.status,
      Number(a1.depAvi.totalAmount),
    ]).toEqual(['FAILED', 'Hyresgästen saknar e-postadress', 'PENDING', 5000])
  })

  it('A1: FAILED-avi → markPaid ger avin PAID (paidAt), depositionen PAID och exakt ett verifikat D1930/K1510 5 000', async () => {
    await deposits.markPaid(a1.dep.id, ORG, userId)
    const efter = await avi(a1.depAvi.id)
    const dep = await prisma.deposit.findUniqueOrThrow({ where: { id: a1.dep.id } })
    const je = await verifikat(a1.dep.id)
    expect([efter.status, efter.paidAt !== null, dep.status]).toEqual(['PAID', true, 'PAID'])
    expect(je).toHaveLength(1)
    expect(rader(je[0]!)).toEqual([
      [1510, 0, 500000],
      [1930, 500000, 0],
    ])
  })

  it('A5: hyresgästens nästa bankbetalning (samma OCR, 7 000) matchas mot HYRESAVIN; depositionsavin får ingen allokering', async () => {
    const tx = await prisma.bankTransaction.create({
      data: {
        organizationId: ORG,
        date: new Date('2026-10-05'),
        amount: new Prisma.Decimal('7000'),
        description: 'Syntetisk inbetalning',
        rawOcr: a1.ocr,
        status: 'UNMATCHED',
      },
    })
    const ok = await recon.matchTransaction(
      (await prisma.bankTransaction.findUniqueOrThrow({ where: { id: tx.id } })) as never,
      ORG,
    )
    const rad = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: tx.id } })
    const alloc = await prisma.rentNoticePayment.findMany({ where: { bankTransactionId: tx.id } })
    const hyr = await avi(a1.hyresavi.id)
    expect([ok, rad.status]).toEqual([true, 'MATCHED'])
    expect(alloc.map((x) => [x.rentNoticeId, Number(x.amount)])).toEqual([[a1.hyresavi.id, 7000]])
    expect(hyr.status).toBe('PAID')
    expect(await prisma.rentNoticePayment.count({ where: { rentNoticeId: a1.depAvi.id } })).toBe(0)
    expect(
      await prisma.journalEntry.count({
        where: { sourceId: `rent-notice-bank-payment:${alloc[0]!.id}` },
      }),
    ).toBe(1)
  })

  it.each(['SENT', 'PENDING', 'OVERDUE'] as const)(
    'A2: positiv kontroll — avin %s (DB-FÖRBEREDELSE) ger samma utfall',
    async (status: RentNoticeStatus) => {
      const f = await nyttFall()
      await prisma.rentNotice.update({ where: { id: f.depAvi.id }, data: { status } })
      await deposits.markPaid(f.dep.id, ORG, userId)
      const efter = await avi(f.depAvi.id)
      expect([
        efter.status,
        efter.paidAt !== null,
        (await prisma.deposit.findUniqueOrThrow({ where: { id: f.dep.id } })).status,
      ]).toEqual(['PAID', true, 'PAID'])
      expect((await verifikat(f.dep.id)).map(rader)).toEqual([
        [
          [1510, 0, 500000],
          [1930, 500000, 0],
        ],
      ])
    },
  )

  it('A3/A4: redan betald deposition (replay) → 400, inget andra verifikat, avin och DB oförändrade', async () => {
    const fore = await avtryck(a1)
    await expect(deposits.markPaid(a1.dep.id, ORG, userId)).rejects.toBeInstanceOf(
      BadRequestException,
    )
    expect(await avtryck(a1)).toBe(fore)
    expect(await verifikat(a1.dep.id)).toHaveLength(1)
  })

  it('A3: annan organisation → 404 och ingen effekt', async () => {
    const f = await nyttFall()
    const fore = await avtryck(f)
    await expect(deposits.markPaid(f.dep.id, ORG2, userId)).rejects.toBeInstanceOf(
      NotFoundException,
    )
    expect(await avtryck(f)).toBe(fore)
  })

  it('A3: annullerad depositionsavi (DB-FÖRBEREDELSE) → 409, hel rollback, ingen effekt', async () => {
    const f = await nyttFall()
    await prisma.rentNotice.update({ where: { id: f.depAvi.id }, data: { status: 'CANCELLED' } })
    const fore = await avtryck(f)
    await expect(deposits.markPaid(f.dep.id, ORG, userId)).rejects.toBeInstanceOf(ConflictException)
    expect(await avtryck(f)).toBe(fore)
  })

  it('A6: fail-closed — avi i oväntat läge (OPENING, DB-FÖRBEREDELSE) → 409, rollback: depositionen PENDING, inget verifikat', async () => {
    const f = await nyttFall()
    await prisma.rentNotice.update({ where: { id: f.depAvi.id }, data: { status: 'OPENING' } })
    const fore = await avtryck(f)
    await expect(deposits.markPaid(f.dep.id, ORG, userId)).rejects.toBeInstanceOf(ConflictException)
    expect(await avtryck(f)).toBe(fore)
    expect(await verifikat(f.dep.id)).toHaveLength(0)
  })

  it('samtidighet: två samtidiga markPaid på FAILED-avi → exakt ett verifikat, avin PAID, den andra nekas', async () => {
    const f = await nyttFall()
    const utfall = await Promise.allSettled([
      deposits.markPaid(f.dep.id, ORG, userId),
      deposits.markPaid(f.dep.id, ORG, userId),
    ])
    expect(utfall.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    expect(await verifikat(f.dep.id)).toHaveLength(1)
    expect((await avi(f.depAvi.id)).status).toBe('PAID')
  })
})
