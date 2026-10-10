/**
 * TESTKUND-051 (FACIT-051; kriterier ur C2:s RAPPORT-050, tillskrivna C2): utskickets SANNING.
 *  V  — O-050-4: när företagets transaktionella mejl är avstängda köar `MailQueue.enqueue` inget och returnerar '';
 *       utskicket får då inte bära leveransmarkörer (SENT, sentAt, sentTo) eller en SENT-händelse.
 *  P  — O-050-5: ett köat påminnelsemejl (`rent-notice-reminder`) skickas inte av mejlarbetaren om avin hunnit
 *       betalas eller annulleras — även efter ett transientfel och ny körning; en legitim påminnelse går igenom.
 *  G0 — O-050-1: en OPENING-avi renderas inte alls.
 * Riktig MailQueue (med sin riktiga ventil) där Bull-köerna är LOKALA FÅNGARE; riktig RentReminderService och
 * MailWorkerNormal; Resend är en lokal fångare. Barriärer, inga sleeps. Riktig Postgres.
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
import { MailWorkerNormal } from '../mail/mail.worker'
import { MailQueue } from '../mail/mail.queue'
import { MailService } from '../mail/mail.service'
import { RentReminderService } from './rent-reminder.service'
import { RentDebtService } from './rent-debt.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip
jest.setTimeout(120_000)

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => expect(HAR_DB).toBe(true))
})

const K = `s051-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const ORG = `${K}-org`
const ORG2 = `${K}-org2`

medDb('051: utskickets sanning (ventil, påminnelsegrind, OPENING) mot riktig Postgres', () => {
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

  // ── Riktig MailQueue med lokala köfångare ───────────────────────────────────────────────────────
  const koat: Array<{
    template: string
    to: string
    correlation?: { kind: string; rentNoticeId: string; sendId?: string }
  }> = []
  const kofangare = {
    add: async (payload: (typeof koat)[number]) => {
      koat.push(payload)
      return { id: `rigg-${koat.length}` }
    },
  }
  let mail: MailService
  let jobb: AviseringService
  let paminnelse: RentReminderService
  let arbetare: MailWorkerNormal
  const resend: string[] = []
  let resendKastar = false
  const krok: { pdf?: (() => Promise<void>) | undefined; pdfAnrop: number } = { pdfAnrop: 0 }
  let nr = 0

  beforeAll(async () => {
    mail = new MailService(
      new MailQueue(kofangare as never, kofangare as never, kofangare as never, p),
    )
    const accounting = new AccountingService(p, new VerifikationsnummerService(p))
    const pdf = {
      generateFromHtml: async () => {
        krok.pdfAnrop++
        if (krok.pdf) {
          const f = krok.pdf
          krok.pdf = undefined
          await f()
        }
        return Buffer.from('%PDF-syntetisk')
      },
    }
    jobb = new AviseringService(
      p,
      new OcrService(p),
      mail as never,
      pdf as never,
      stub('StorageService') as never,
      stub('PdfQueue') as never,
      accounting,
      stub('ConsumptionService') as never,
      stub('MiscChargeService') as never,
      deposits,
      new RentNoticeEventsService(p),
    )
    paminnelse = new RentReminderService(
      p as never,
      accounting,
      new RentNoticeEventsService(p),
      stub('RentInterestService') as never,
      stub('PdfQueue') as never,
      mail as never,
      pdf as never,
      { uploadFile: async () => undefined } as never,
      new RentDebtService(p as never),
      stub('PaymentFreshnessService') as never,
      stub('CronErrorSink') as never,
      stub('NotificationsService') as never,
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
          if (resendKastar) {
            resendKastar = false
            return { data: null, error: { message: 'syntetiskt transientfel' } }
          }
          resend.push(o.to)
          return { data: { id: `rigg-r-${resend.length}` }, error: null }
        },
      },
    }
  })

  async function nyAvi(org = ORG) {
    nr++
    const t = await prisma.tenant.create({
      data: {
        organizationId: org,
        type: 'INDIVIDUAL',
        firstName: 'Syntetisk',
        lastName: `Sanning ${nr}`,
        email: `${K}-s${nr}@example.invalid`,
      },
    })
    const u = await prisma.unit.create({
      data: {
        propertyId: `${org}-p`,
        name: `Lgh S${nr}`,
        unitNumber: `S${nr}`,
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
    return { id: a.id, org, to: t.email }
  }
  const ventil = (av: boolean) =>
    prisma.organization.update({ where: { id: ORG }, data: { transactionalEmailsDisabled: av } })
  const lage = (id: string) =>
    prisma.rentNotice.findUniqueOrThrow({
      where: { id },
      select: {
        status: true,
        sentAt: true,
        sentTo: true,
        reminderFeeAmount: true,
        collectionStage: true,
        paidAmount: true,
      },
    })
  const handelser = (id: string, typ: string) =>
    prisma.rentNoticeEvent.count({ where: { rentNoticeId: id, type: typ as never } })
  const koatTill = (to: string) => koat.filter((k) => k.to === to).length
  const ekonomi = async (id: string) =>
    JSON.stringify([
      await lage(id),
      await prisma.journalEntry.count({ where: { organizationId: ORG } }),
      await prisma.rentNoticePayment.count({ where: { rentNoticeId: id } }),
    ])

  it('V4 (positiv kontroll, samma körning): ventilen öppen → ett köat mejl, SENT med sentAt och sentTo', async () => {
    await ventil(false)
    const a = await nyAvi()
    await jobb.processNoticeSendJob(ORG, a.id)
    const l = await lage(a.id)
    expect([koatTill(a.to), l.status, l.sentAt !== null, l.sentTo]).toEqual([1, 'SENT', true, a.to])
  })

  it('V1/V3: ventilen avstängd före utskicket, två körningar → inget köat, ingen leveransmarkör, ingen SENT-händelse, ekonomi oförändrad', async () => {
    const a = await nyAvi()
    await ventil(true)
    const fore = await ekonomi(a.id)
    await jobb.processNoticeSendJob(ORG, a.id)
    await jobb.processNoticeSendJob(ORG, a.id)
    await ventil(false)
    const l = await lage(a.id)
    expect([koatTill(a.to), l.sentAt, l.sentTo, l.status]).toEqual([0, null, null, 'PENDING'])
    expect(await handelser(a.id, 'SENT')).toBe(0)
    expect(await ekonomi(a.id)).toBe(fore)
  })

  it('V2: ventilen stängs mellan renderingen och köningen → inget köat, ingen leveransmarkör', async () => {
    const a = await nyAvi()
    krok.pdf = async () => {
      await ventil(true)
    }
    await jobb.processNoticeSendJob(ORG, a.id)
    await ventil(false)
    const l = await lage(a.id)
    expect([koatTill(a.to), l.sentAt, l.sentTo, l.status]).toEqual([0, null, null, 'PENDING'])
  })

  // Påminnelser: avin förfallen (DB-FÖRBEREDELSE: förfallodag passerad och status OVERDUE, som förfallokörningen sätter).
  const forfallen = async () => {
    const a = await nyAvi()
    await prisma.rentNotice.update({
      where: { id: a.id },
      data: { status: 'OVERDUE', dueDate: new Date('2026-09-01') },
    })
    return a
  }
  const koatPaminnelse = (id: string) =>
    koat.filter(
      (k) => k.correlation?.kind === 'rent-notice-reminder' && k.correlation.rentNoticeId === id,
    )
  const kor = (k: (typeof koat)[number], id: string) =>
    (arbetare as unknown as { processJob: (j: unknown) => Promise<void> }).processJob({
      id: `j-${id}`,
      attemptsMade: 0,
      opts: { attempts: 5 },
      queue: { name: 'mail-normal' },
      data: { ...k, organizationId: ORG },
    })

  it('V5: påminnelse med ventilen avstängd → ej köad, ingen SENT-händelse; avgift, verifikat och kravsteg oförändrade', async () => {
    const a = await forfallen()
    await ventil(true)
    const fore = await ekonomi(a.id)
    await paminnelse.processReminderSendJob(ORG, a.id)
    await ventil(false)
    expect(koatPaminnelse(a.id)).toHaveLength(0)
    expect(await handelser(a.id, 'SENT')).toBe(0)
    expect(await ekonomi(a.id)).toBe(fore)
  })

  it('P4: legitim påminnelse (förfallen, obetald) köas och skickas av arbetaren', async () => {
    const a = await forfallen()
    await paminnelse.processReminderSendJob(ORG, a.id)
    const k = koatPaminnelse(a.id)
    expect(k).toHaveLength(1)
    const fore = resend.length
    await kor(k[0]!, a.id)
    expect(resend.slice(fore)).toEqual([a.to])
  })

  it('P1/P2: köat påminnelsemejl, därefter slutförd betalning respektive annullering → arbetaren skickar inte; ingen FailedEmail/SEND_FAILED; avgift/verifikat/kravsteg oförändrade', async () => {
    for (const handling of ['betala', 'annullera'] as const) {
      const a = await forfallen()
      await paminnelse.processReminderSendJob(ORG, a.id)
      const k = koatPaminnelse(a.id)[0]!
      if (handling === 'betala') {
        const tx = await prisma.bankTransaction.create({
          data: {
            organizationId: ORG,
            date: new Date('2026-10-05'),
            amount: new Prisma.Decimal('7000'),
            description: 'Syntetisk inbetalning',
            status: 'UNMATCHED',
          },
        })
        await recon.manualMatch(tx.id, { rentNoticeId: a.id }, ORG, userId)
      } else {
        await avisering.cancelNotice(a.id, ORG, userId)
      }
      const fore = {
        e: await ekonomi(a.id),
        fail: await handelser(a.id, 'SEND_FAILED'),
        fe: await prisma.failedEmail.count(),
        r: resend.length,
      }
      await kor(k, a.id)
      expect([
        resend.length - fore.r,
        (await handelser(a.id, 'SEND_FAILED')) - fore.fail,
        (await prisma.failedEmail.count()) - fore.fe,
      ]).toEqual([0, 0, 0])
      expect(await ekonomi(a.id)).toBe(fore.e)
    }
  })

  it('P3: transientfel (leverantören avvisar) → betalning → nytt försök skickar inte', async () => {
    const a = await forfallen()
    await paminnelse.processReminderSendJob(ORG, a.id)
    const k = koatPaminnelse(a.id)[0]!
    resendKastar = true
    await expect(kor(k, a.id)).rejects.toThrow('Resend rejected mail')
    const tx = await prisma.bankTransaction.create({
      data: {
        organizationId: ORG,
        date: new Date('2026-10-05'),
        amount: new Prisma.Decimal('7000'),
        description: 'Syntetisk inbetalning',
        status: 'UNMATCHED',
      },
    })
    await recon.manualMatch(tx.id, { rentNoticeId: a.id }, ORG, userId)
    const fore = resend.length
    await kor(k, a.id)
    expect(resend.length - fore).toBe(0)
  })

  it('G0 (O-050-1): en OPENING-avi renderas inte och köas inte; status oförändrad', async () => {
    const a = await nyAvi()
    await prisma.rentNotice.update({ where: { id: a.id }, data: { status: 'OPENING' } })
    const fore = krok.pdfAnrop
    await jobb.processNoticeSendJob(ORG, a.id)
    expect([krok.pdfAnrop - fore, koatTill(a.to), (await lage(a.id)).status]).toEqual([
      0,
      0,
      'OPENING',
    ])
  })
})
