/**
 * TESTKUND-049 (F-047-2, FACIT-049): `processNoticeSendJob` får aldrig återöppna en betald eller annullerad avi,
 * förvanska leveranshistoriken eller skapa en falsk fordran, och ett mejl till en avi som hunnit betalas eller
 * annulleras ska inte köas (återprövning efter renderingen) eller skickas (mejlarbetarens statusgrind).
 *
 * Deterministiska BARRIÄRER (inga sleeps): pdf-renderingen, mejlköandet och jobbets första läsning (Prisma-
 * frågekrok) kör en kundhändelse genom produktens egna vägar — AviseringService.cancelNotice och
 * ReconciliationService.manualMatch — innan jobbet fortsätter. Mejl fångas lokalt (inget skickas). Riktig Postgres.
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
import type { ReconciliationService } from '../reconciliation/reconciliation.service'
import { reconciliationUtanKundtillgodo } from '../reconciliation/customer-credit.test-double'
import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { RentNoticeEventsService } from '../avisering/rent-notice-events.service'
import { BankImportAttemptService } from '../reconciliation/bank-import-attempt.service'
import { PaymentFreshnessService } from '../payment-freshness/payment-freshness.service'
import { AviseringService } from '../avisering/avisering.service'
import { OcrService } from '../common/ocr/ocr.service'
import type { PrismaService } from '../common/prisma/prisma.service'
import { DepositsService } from '../deposits/deposits.service'
import { MailWorkerNormal } from '../mail/mail.worker'
import type { MailJobPayload } from '../mail/mail.types'
import type { Job } from 'bull'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip
jest.setTimeout(120_000)

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => expect(HAR_DB).toBe(true))
})

const K = `f0492-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const ORG = `${K}-org`
const ORG2 = `${K}-org2`

medDb('F-047-2: utskicksjobbet mot annullering och betalning (barriärer, riktig Postgres)', () => {
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

  // ── Utskicksjobb med barriärer ────────────────────────────────────────────────────────────────
  const krok: {
    pdf?: (() => Promise<void>) | undefined
    pdfKast?: boolean
    mejl?: (() => Promise<void>) | undefined
    lasning?: (() => Promise<void>) | undefined
  } = {}
  const mejl: Array<{ rentNoticeId: string; to: string }> = []
  let jobb: AviseringService
  let arbetare: MailWorkerNormal
  const resendAnrop: string[] = []
  let nr = 0

  beforeAll(async () => {
    let iKrok = false
    const krokad = prisma.$extends({
      query: {
        rentNotice: {
          async findFirst({ args, query }) {
            const r = await query(args)
            if (krok.lasning && !iKrok) {
              iKrok = true
              const f = krok.lasning
              krok.lasning = undefined
              try {
                await f()
              } finally {
                iKrok = false
              }
            }
            return r
          },
        },
      },
    })
    const kp = krokad as unknown as PrismaService
    const accounting = new AccountingService(kp, new VerifikationsnummerService(kp))
    jobb = new AviseringService(
      kp,
      new OcrService(kp),
      {
        sendRentNotice: async (o: { rentNoticeId: string; to: string }) => {
          mejl.push({ rentNoticeId: o.rentNoticeId, to: o.to })
          if (krok.mejl) {
            const f = krok.mejl
            krok.mejl = undefined
            await f()
          }
          return 'rigg-jobb'
        },
      } as never,
      {
        generateFromHtml: async () => {
          if (krok.pdf) {
            const f = krok.pdf
            krok.pdf = undefined
            await f()
          }
          if (krok.pdfKast) {
            krok.pdfKast = false
            throw new Error('Syntetiskt renderingsfel')
          }
          return Buffer.from('%PDF-syntetisk')
        },
      } as never,
      stub('StorageService') as never,
      stub('PdfQueue') as never,
      accounting,
      stub('ConsumptionService') as never,
      stub('MiscChargeService') as never,
      deposits,
      new RentNoticeEventsService(kp),
    )
    arbetare = new MailWorkerNormal(
      { render: async () => ({ html: '<p>x</p>', text: 'x' }) } as never,
      p,
      { get: () => undefined } as never,
      new RentNoticeEventsService(p),
    )
    ;(arbetare as unknown as { resend: unknown }).resend = {
      emails: {
        send: async (o: { to: string }) => {
          resendAnrop.push(o.to)
          return { data: { id: `rigg-${resendAnrop.length}` }, error: null }
        },
      },
    }
  })

  async function nyAvi(org = ORG, utanEpost = false) {
    nr++
    const t = await prisma.tenant.create({
      data: {
        organizationId: org,
        type: 'INDIVIDUAL',
        firstName: 'Syntetisk',
        lastName: `Race ${nr}`,
        email: utanEpost ? '' : `${K}-r${nr}@example.invalid`,
      },
    })
    const u = await prisma.unit.create({
      data: {
        propertyId: `${org}-p`,
        name: `Lgh R${nr}`,
        unitNumber: `R${nr}`,
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
    await avisering.createInitialNoticesForLease(l.id)
    const a = await prisma.rentNotice.findFirstOrThrow({ where: { leaseId: l.id, type: 'RENT' } })
    return {
      id: a.id,
      org,
      ocr: (await prisma.tenant.findUniqueOrThrow({ where: { id: t.id } })).ocrNumber!,
    }
  }
  const lage = (id: string) =>
    prisma.rentNotice.findUniqueOrThrow({
      where: { id },
      select: {
        status: true,
        sentAt: true,
        sentTo: true,
        sendError: true,
        paidAt: true,
        paidAmount: true,
      },
    })
  const mejlFor = (id: string) => mejl.filter((m) => m.rentNoticeId === id).length
  const annullera = (a: { id: string; org: string }) => async () => {
    await avisering.cancelNotice(a.id, a.org, userId)
  }
  const betala = (a: { id: string; org: string }) => async () => {
    const tx = await prisma.bankTransaction.create({
      data: {
        organizationId: a.org,
        date: new Date('2026-10-05'),
        amount: new Prisma.Decimal('7000'),
        description: 'Syntetisk inbetalning',
        status: 'UNMATCHED',
      },
    })
    await recon.manualMatch(tx.id, { rentNoticeId: a.id }, a.org, userId)
  }
  const motverifikat = async (id: string) => {
    const orig = await prisma.journalEntry.findFirst({
      where: { sourceId: `rent-notice:${id}` },
      select: { id: true },
    })
    return orig ? prisma.journalEntry.count({ where: { reversalOfEntryId: orig.id } }) : -1
  }
  const allokeringar = (id: string) =>
    prisma.rentNoticePayment.count({ where: { rentNoticeId: id } })
  const kor = (a: { id: string; org: string }) => jobb.processNoticeSendJob(a.org, a.id)

  const R: Record<string, { id: string; org: string; ocr: string }> = {}

  it('R1: annullering under renderingen → CANCELLED, ingen leveranshistorik, mejlet köas inte; motverifikatet finns', async () => {
    const a = (R.R1 = await nyAvi())
    krok.pdf = annullera(a)
    await kor(a)
    expect(await lage(a.id)).toMatchObject({ status: 'CANCELLED', sentAt: null, sentTo: null })
    expect(mejlFor(a.id)).toBe(0)
    expect(await motverifikat(a.id)).toBe(1)
  })

  it('R2: bankbetalning under renderingen → PAID med allokeringen orörd, mejlet köas inte', async () => {
    const a = (R.R2 = await nyAvi())
    krok.pdf = betala(a)
    await kor(a)
    expect(await lage(a.id)).toMatchObject({ status: 'PAID', sentAt: null, sentTo: null })
    expect(await allokeringar(a.id)).toBe(1)
    expect(mejlFor(a.id)).toBe(0)
  })

  it('R3: annullering efter köningen → statusen förblir CANCELLED (mejlet var redan köat; se W)', async () => {
    const a = (R.R3 = await nyAvi())
    krok.mejl = annullera(a)
    await kor(a)
    expect(await lage(a.id)).toMatchObject({ status: 'CANCELLED', sentAt: null, sentTo: null })
    expect(mejlFor(a.id)).toBe(1)
    expect(await motverifikat(a.id)).toBe(1)
  })

  it('R4: betalning efter köningen → statusen förblir PAID, allokeringen orörd', async () => {
    const a = (R.R4 = await nyAvi())
    krok.mejl = betala(a)
    await kor(a)
    expect(await lage(a.id)).toMatchObject({ status: 'PAID', sentAt: null, sentTo: null })
    expect(await allokeringar(a.id)).toBe(1)
  })

  it('R5: annullering under renderingen och renderingen kastar → CANCELLED, inte FAILED', async () => {
    const a = await nyAvi()
    krok.pdf = annullera(a)
    krok.pdfKast = true
    await kor(a).catch(() => undefined)
    expect(await lage(a.id)).toMatchObject({ status: 'CANCELLED', sendError: null })
    expect(mejlFor(a.id)).toBe(0)
  })

  it('R6: betalning under renderingen och renderingen kastar → PAID, inte FAILED', async () => {
    const a = await nyAvi()
    krok.pdf = betala(a)
    krok.pdfKast = true
    await kor(a).catch(() => undefined)
    expect(await lage(a.id)).toMatchObject({ status: 'PAID', sendError: null })
    expect(await allokeringar(a.id)).toBe(1)
  })

  it('R7: annullering efter jobbets läsning, i den tidiga FAILED-grenen (saknad e-post) → CANCELLED, inte FAILED', async () => {
    const a = await nyAvi(ORG2, true)
    krok.lasning = annullera(a)
    await kor(a)
    expect(await lage(a.id)).toMatchObject({ status: 'CANCELLED', sendError: null })
  })

  it('W: mejlarbetaren skickar inte ett köat avimejl när avin hunnit annulleras eller betalas; en skickad avi går iväg', async () => {
    const p1 = await nyAvi()
    await kor(p1)
    const jobbFor = (id: string, org: string, to: string) =>
      ({
        id: `j-${id}`,
        attemptsMade: 0,
        opts: { attempts: 3 },
        queue: { name: 'mail-normal' },
        data: {
          template: 'custom',
          props: {},
          to,
          subject: 'Hyresavi',
          organizationId: org,
          correlation: { kind: 'rent-notice', rentNoticeId: id },
        },
      }) as unknown as Job<MailJobPayload>
    const fore = resendAnrop.length
    await (
      arbetare as unknown as { processJob: (j: Job<MailJobPayload>) => Promise<void> }
    ).processJob(jobbFor(R.R3!.id, ORG, 'r3@example.invalid'))
    await (
      arbetare as unknown as { processJob: (j: Job<MailJobPayload>) => Promise<void> }
    ).processJob(jobbFor(R.R4!.id, ORG, 'r4@example.invalid'))
    expect(resendAnrop.length - fore).toBe(0)
    await (
      arbetare as unknown as { processJob: (j: Job<MailJobPayload>) => Promise<void> }
    ).processJob(jobbFor(p1.id, ORG, 'p1@example.invalid'))
    expect(resendAnrop.slice(fore)).toEqual(['p1@example.invalid'])
  })

  it('P1–P4: normalt utskick SENT med sentAt/sentTo och ett mejl; normalt renderingsfel FAILED och kastet går vidare; replay inget nytt mejl; annan organisation 404', async () => {
    const a = await nyAvi()
    await kor(a)
    const s = await lage(a.id)
    expect([s.status, s.sentAt !== null, s.sentTo]).toEqual([
      'SENT',
      true,
      expect.stringContaining('@example.invalid'),
    ])
    expect(mejlFor(a.id)).toBe(1)
    await kor(a)
    expect(mejlFor(a.id)).toBe(1)
    const b = await nyAvi()
    krok.pdfKast = true
    await expect(kor(b)).rejects.toThrow('Syntetiskt renderingsfel')
    expect(await lage(b.id)).toMatchObject({
      status: 'FAILED',
      sendError: 'Syntetiskt renderingsfel',
      sentAt: null,
    })
    const fore = await lage(b.id)
    await expect(jobb.processNoticeSendJob(ORG2, b.id)).rejects.toThrow()
    expect(await lage(b.id)).toEqual(fore)
  })

  it('Ekonomi: OCR-betalning efter R1 matchas inte mot den annullerade avin; månadsöversikten utesluter R1 och räknar R2 som inkasserad', async () => {
    const tx = await prisma.bankTransaction.create({
      data: {
        organizationId: ORG,
        date: new Date('2026-10-06'),
        amount: new Prisma.Decimal('7000'),
        description: 'Syntetisk OCR-inbetalning',
        rawOcr: R.R1!.ocr,
        status: 'UNMATCHED',
      },
    })
    await recon.matchTransaction(
      (await prisma.bankTransaction.findUniqueOrThrow({ where: { id: tx.id } })) as never,
      ORG,
    )
    expect(await allokeringar(R.R1!.id)).toBe(0)
    const s = await avisering.getStats(ORG, 10, 2026)
    const avier = await prisma.rentNotice.findMany({
      where: { organizationId: ORG, month: 10, year: 2026 },
      select: { id: true, status: true },
    })
    const r1 = avier.find((x) => x.id === R.R1!.id)
    expect(r1?.status).toBe('CANCELLED')
    expect(s.cancelled).toBeGreaterThanOrEqual(1)
  })
})
