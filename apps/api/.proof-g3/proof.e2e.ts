/**
 * BEVISRIGG G3 — det lagstadgade taket mot huvudboken.
 *
 * ORAKLET ÄR KONTOSALDONA. En org konfigurerad till 500 kr ska ge −60,00 på
 * 3593, inte −500,00. Ett returvärde eller ett loggat varningsmeddelande duger
 * inte — det är huvudboken som avgör vad hyresgästen har krävts på.
 *
 * DISKRIMINERANDE BELOPP: 500 är varken en multipel av 60 eller nära det, och
 * skiljer sig från kapitalet (7 355). En klampning som råkade ge fel tal syns.
 *
 * FÖRMÄTNING: ingen organisation ligger över taket i dag (dev 246 org, alla på
 * 60; prod 1 org på 0). Riggen sätter därför värdena själv — klampningen är
 * beredskap mot framtida värden, inte städning av befintliga.
 */

jest.mock('../src/invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../src/storage/storage.service', () => ({ StorageService: class {} }))

import { PrismaClient } from '@prisma/client'

import { AccountingService } from '../src/accounting/accounting.service'
import { VerifikationsnummerService } from '../src/accounting/verifikationsnummer.service'
import { resolveNoticeDebtOrigin } from '../src/accounting/debt-origin'

const prisma = new PrismaClient({
  datasources: { db: { url: 'postgresql://eken:eken@localhost:5432/eken_g3' } },
})

const KAPITAL = 7355.0

const accounting = new AccountingService(
  prisma as never,
  new VerifikationsnummerService(prisma as never),
)

const BAS: Array<[number, string, string]> = [
  [1510, 'Kundfordringar', 'ASSET'],
  [3593, 'Påminnelseavgifter', 'REVENUE'],
  [3911, 'Hyresintäkter bostäder', 'REVENUE'],
]

async function ledger(orgId: string) {
  const lines = await prisma.journalEntryLine.findMany({
    where: { journalEntry: { organizationId: orgId } },
    include: { account: { select: { number: true } } },
  })
  const per: Record<number, number> = {}
  for (const l of lines) {
    per[l.account.number] =
      Math.round(((per[l.account.number] ?? 0) + Number(l.debit) - Number(l.credit)) * 100) / 100
  }
  return per
}

/** Org med en KONFIGURERAD avgift och ett avtal med giltig avtalsgrund. */
async function seed(namn: string, reminderFeeSek: number) {
  const org = await prisma.organization.create({
    data: {
      name: namn,
      email: `${namn.toLowerCase()}@test.se`,
      street: 'Testgatan 1',
      city: 'Stockholm',
      postalCode: '11122',
      reminderFeeSek,
    },
  })
  await prisma.account.createMany({
    data: BAS.map(([number, name, type]) => ({
      organizationId: org.id,
      number,
      name,
      type: type as never,
    })),
  })
  const property = await prisma.property.create({
    data: {
      organizationId: org.id,
      name: 'Testfastighet',
      propertyDesignation: `Eken 1:${namn}`,
      street: 'Testgatan 1',
      postalCode: '11122',
      city: 'Stockholm',
      type: 'RESIDENTIAL',
      totalArea: 550,
    },
  })
  const unit = await prisma.unit.create({
    data: {
      propertyId: property.id,
      name: 'Lgh 1001',
      unitNumber: '1001',
      type: 'APARTMENT',
      area: 55,
      monthlyRent: KAPITAL,
    },
  })
  const tenant = await prisma.tenant.create({
    data: {
      organizationId: org.id,
      firstName: 'Test',
      lastName: 'Hyresgäst',
      email: `t-${org.id.slice(0, 8)}@test.se`,
      type: 'INDIVIDUAL',
    },
  })
  const lease = await prisma.lease.create({
    data: {
      organizationId: org.id,
      unitId: unit.id,
      tenantId: tenant.id,
      startDate: new Date('2026-01-01'),
      tenancyStartDate: new Date('2026-01-01'),
      monthlyRent: KAPITAL,
      depositAmount: 0,
      status: 'ACTIVE',
      // Avtalsgrunden är på plats — G2:s grind ska inte vara den som fäller här.
      reminderFeeTermsFrom: new Date('2026-01-01'),
    },
  })
  const notice = await prisma.rentNotice.create({
    data: {
      organizationId: org.id,
      leaseId: lease.id,
      tenantId: tenant.id,
      noticeNumber: `A-${namn}`,
      ocrNumber: `9${Math.floor(Math.random() * 1000000000)}`.slice(0, 12),
      type: 'RENT',
      year: 2026,
      month: 7,
      amount: KAPITAL,
      vatAmount: 0,
      totalAmount: KAPITAL,
      dueDate: new Date('2026-06-30'),
      periodStart: new Date('2026-07-01'),
      periodEnd: new Date('2026-07-31'),
      status: 'OVERDUE',
    },
  })
  return { org, notice }
}

/** Debiterar med orgens KONFIGURERADE avgift, precis som cron gör. */
async function debitera(orgId: string, noticeId: string) {
  const org = await prisma.organization.findFirstOrThrow({ where: { id: orgId } })
  const n = await prisma.rentNotice.findFirstOrThrow({
    where: { id: noticeId },
    select: {
      periodStart: true,
      dueDate: true,
      lease: { select: { reminderFeeTermsFrom: true } },
    },
  })
  return accounting.bookReminderFee({
    organizationId: orgId,
    source: 'RENT_NOTICE',
    sourceId: `reminder-fee:${noticeId}`,
    fee: Number(org.reminderFeeSek),
    description: `Påminnelseavgift hyresavi ${noticeId}`,
    debtOrigin: resolveNoticeDebtOrigin(n),
    termsFrom: n.lease?.reminderFeeTermsFrom ?? null,
  })
}

beforeAll(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "JournalEntryLine","JournalEntry","JournalEntrySequence","RentNoticeLine",
     "RentNotice","Lease","Tenant","Unit","Property","Account","Organization"
     RESTART IDENTITY CASCADE`,
  )
})
afterAll(async () => {
  await prisma.$disconnect()
})

describe('G3 — taket mot huvudboken', () => {
  it('S1: org satt till 500 → 3593 på −60,00, inte −500,00', async () => {
    const { org, notice } = await seed('S1', 500)

    await debitera(org.id, notice.id)

    const bok = await ledger(org.id)
    expect(bok[3593]).toBe(-60)
    expect(bok[1510]).toBe(60)
    // Det som INTE hände — utan klampningen står det −500 här.
    expect(bok[3593]).not.toBe(-500)
  })

  it('S2: org satt till 60 → −60,00', async () => {
    const { org, notice } = await seed('S2', 60)

    await debitera(org.id, notice.id)

    const bok = await ledger(org.id)
    expect(bok[3593]).toBe(-60)
    expect(bok[1510]).toBe(60)
  })

  it('S3: org satt till 0 → ingen bokföring alls, 3593 på 0', async () => {
    const { org, notice } = await seed('S3', 0)

    const entry = await debitera(org.id, notice.id)

    expect(entry).toBeNull()
    expect((await ledger(org.id))[3593] ?? 0).toBe(0)
    expect(await prisma.journalEntry.count({ where: { organizationId: org.id } })).toBe(0)
  })

  it('S4: verifikatet BALANSERAR efter klampning', async () => {
    // En klampning som bara träffat ena benet hade gett debet 500 / kredit 60.
    const { org, notice } = await seed('S4', 500)

    await debitera(org.id, notice.id)

    const lines = await prisma.journalEntryLine.findMany({
      where: { journalEntry: { organizationId: org.id } },
    })
    const debet = lines.reduce((s, l) => s + Number(l.debit), 0)
    const kredit = lines.reduce((s, l) => s + Number(l.credit), 0)
    expect(debet).toBe(kredit)
    expect(debet).toBe(60)
  })
})
