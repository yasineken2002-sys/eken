/**
 * BEVISRIGG G4a — stryk en felaktigt debiterad påminnelseavgift.
 *
 * ORAKLET ÄR KONTOSALDONA OCH `ocrOutstanding`, inte att endpointen svarade.
 *
 * DEN ARITMETISKA GRÄNSEN är riggens huvudsak. Scenario (a) — det enda som
 * uppstår av sig självt — har ALLTID en registrerad betalning: det är just den
 * som avslöjar att avgiften var felaktig. En gräns på `paid > 0` hade därför
 * vägrat exakt det fall funktionen finns för. Rätt gräns är att strykningen
 * inte får kunna skapa en överbetalning: `paid <= ocrGross − avgiften`.
 *
 * DISKRIMINERANDE BELOPP: kapital 7 355,00, avgift 60,00. ocrGross = 7 415,00.
 * Gränsen går alltså vid 7 355,00 — samma tal som kapitalet, vilket är
 * meningen: "kapitalet betalt, avgiften kvar" är exakt gränsfallet.
 */

jest.mock('../src/invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../src/storage/storage.service', () => ({ StorageService: class {} }))

import { PrismaClient } from '@prisma/client'

import { AccountingService } from '../src/accounting/accounting.service'
import { VerifikationsnummerService } from '../src/accounting/verifikationsnummer.service'
import { AviseringService } from '../src/avisering/avisering.service'
import { RentNoticeEventsService } from '../src/avisering/rent-notice-events.service'
import { RentDebtService } from '../src/avisering/rent-debt.service'
import { resolveNoticeDebtOrigin } from '../src/accounting/debt-origin'

const prisma = new PrismaClient({
  datasources: { db: { url: 'postgresql://eken:eken@localhost:5432/eken_g4' } },
})

const KAPITAL = 7355.0
const AVGIFT = 60.0
const OCR_GROSS = KAPITAL + AVGIFT // 7 415,00
const SKAL = 'Betalningen hade kommit fram men var inte matchad när cronen körde'

const accounting = new AccountingService(
  prisma as never,
  new VerifikationsnummerService(prisma as never),
)
const rentDebt = new RentDebtService(prisma as never)

const avisering = Object.create(AviseringService.prototype) as AviseringService
const a = avisering as unknown as Record<string, unknown>
a['prisma'] = prisma
a['accounting'] = accounting
a['rentNoticeEvents'] = new RentNoticeEventsService(prisma as never)
a['logger'] = { error: jest.fn(), log: jest.fn(), warn: jest.fn() }

const BAS: Array<[number, string, string]> = [
  [1510, 'Kundfordringar', 'ASSET'],
  [1515, 'Osäkra kundfordringar', 'ASSET'],
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

/** Avi med kapital + bokförd avgift, och en valfri registrerad betalning. */
async function seed(namn: string, paid: number, opts: { probableLoss?: boolean } = {}) {
  const org = await prisma.organization.create({
    data: {
      name: namn,
      email: `${namn.toLowerCase()}@test.se`,
      street: 'Testgatan 1',
      city: 'Stockholm',
      postalCode: '11122',
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
      collectionStage: 'REMINDED',
      reminderFeeAmount: AVGIFT,
      ...(opts.probableLoss ? { probableLossAt: new Date('2026-08-01') } : {}),
    },
  })

  // Kapitalets accrual + avgiftens verifikat, båda via de skarpa vägarna.
  await accounting.createJournalEntryForRentNotice(
    {
      id: notice.id,
      noticeNumber: notice.noticeNumber,
      leaseId: lease.id,
      type: 'RENT' as never,
      amount: KAPITAL,
      vatAmount: 0,
      totalAmount: KAPITAL,
      year: 2026,
      month: 7,
    },
    org.id,
    null,
  )
  await accounting.bookReminderFee({
    organizationId: org.id,
    source: 'RENT_NOTICE',
    sourceId: `reminder-fee:${notice.id}`,
    fee: AVGIFT,
    description: `Påminnelseavgift hyresavi ${notice.noticeNumber}`,
    debtOrigin: resolveNoticeDebtOrigin({
      periodStart: new Date('2026-07-01'),
      dueDate: new Date('2026-06-30'),
    }),
    termsFrom: new Date('2026-01-01'),
  })

  if (paid > 0) {
    await prisma.rentNoticePayment.create({
      data: {
        rentNoticeId: notice.id,
        amount: paid,
        paidAt: new Date('2026-07-05'),
        source: 'MANUAL',
      },
    })
    await prisma.rentNotice.update({
      where: { id: notice.id },
      data: { paidAmount: paid },
    })
  }

  return { org, notice }
}

beforeAll(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "JournalEntryLine","JournalEntry","JournalEntrySequence","RentNoticePayment",
     "RentNoticeEvent","RentNoticeLine","RentNotice","Lease","Tenant","Unit","Property",
     "Account","Organization" RESTART IDENTITY CASCADE`,
  )
})
afterAll(async () => {
  await prisma.$disconnect()
})

describe('G4a — den aritmetiska gränsen', () => {
  it('paid = 0 → TILLÅTS, 3593 på 0 och hyresintäkten orörd', async () => {
    const { org, notice } = await seed('S1', 0)

    const före = await ledger(org.id)
    expect(före[3593]).toBe(-AVGIFT)
    expect(före[1510]).toBe(OCR_GROSS)

    await avisering.reverseReminderFee(notice.id, org.id, SKAL, null)

    const efter = await ledger(org.id)
    expect(efter[3593]).toBe(0)
    expect(efter[1510]).toBe(KAPITAL) // bara kapitalets fordran kvar
    expect(efter[3911]).toBe(-KAPITAL) // hyresintäkten ORÖRD

    const kvar = await prisma.rentNotice.findFirstOrThrow({ where: { id: notice.id } })
    expect(Number(kvar.reminderFeeAmount)).toBe(0)
    expect(kvar.status).toBe('OVERDUE') // avin lever vidare
  })

  it('paid = ocrGross − 60 (kapitalet betalt) → TILLÅTS, ocrOutstanding landar på EXAKT 0', async () => {
    // Gränsfallet. Före strykningen är ocrOutstanding 60 — hyresgästen krävs på
    // en avgift hen inte skulle ha. Efter strykningen ska den vara 0, och det
    // ska vara ett ÄKTA 0, inte ett klampat.
    const { org, notice } = await seed('S2', KAPITAL)

    const före = await rentDebt.outstanding(notice.id, org.id)
    expect(före.ocrOutstanding).toBe(AVGIFT)

    await avisering.reverseReminderFee(notice.id, org.id, SKAL, null)

    const efter = await rentDebt.outstanding(notice.id, org.id)
    expect(efter.ocrOutstanding).toBe(0)
    // ÄKTA noll: bruttot minus betalt är exakt 0, inte negativt-och-klampat.
    expect(efter.capital + efter.reminderFee - efter.paid).toBe(0)

    const bok = await ledger(org.id)
    expect(bok[3593]).toBe(0)
    expect(bok[1510]).toBe(KAPITAL)
  })

  it('paid = ocrGross (allt betalt) → VÄGRAS, huvudboken orörd', async () => {
    // Strykningen skulle skapa en överbetalning på 60 kr som `Math.max(0, …)`
    // klampar bort (#378). Vägran är rätt tills överbetalning kan uttryckas.
    const { org, notice } = await seed('S3', OCR_GROSS)

    const före = await ledger(org.id)

    await expect(avisering.reverseReminderFee(notice.id, org.id, SKAL, null)).rejects.toThrow(
      /överbetalning/,
    )

    expect(await ledger(org.id)).toEqual(före)
    const kvar = await prisma.rentNotice.findFirstOrThrow({ where: { id: notice.id } })
    expect(Number(kvar.reminderFeeAmount)).toBe(AVGIFT)
  })
})

describe('G4a — övriga grindar och spårbarhet', () => {
  it('nedskriven avi VÄGRAS — avgiften ingår i 1515', async () => {
    const { org, notice } = await seed('S4', 0, { probableLoss: true })

    await expect(avisering.reverseReminderFee(notice.id, org.id, SKAL, null)).rejects.toThrow(
      /kundförlust/,
    )
    expect((await ledger(org.id))[3593]).toBe(-AVGIFT)
  })

  it('för kort skäl VÄGRAS innan något rörs', async () => {
    const { org, notice } = await seed('S5', 0)

    await expect(avisering.reverseReminderFee(notice.id, org.id, 'fel', null)).rejects.toThrow(
      /minst 10 tecken/,
    )
    expect((await ledger(org.id))[3593]).toBe(-AVGIFT)
  })

  it('händelsen skrivs — utan den är strykningen osynlig i historiken', async () => {
    const { org, notice } = await seed('S6', 0)

    await avisering.reverseReminderFee(notice.id, org.id, SKAL, null)

    const events = await prisma.rentNoticeEvent.findMany({
      where: { rentNoticeId: notice.id, type: 'REMINDER_FEE_REVERSED' },
    })
    expect(events).toHaveLength(1)
    expect(JSON.stringify(events[0]!.payload)).toContain('inte matchad')
  })

  it('SAMMA NYCKEL som cancelNotice — en senare annullering dubbelreverserar inte', async () => {
    const { org, notice } = await seed('S7', 0)

    await avisering.reverseReminderFee(notice.id, org.id, SKAL, null)
    const efterStrykning = await ledger(org.id)

    // Annullera avin efteråt. Dess avgiftsreversering ska hitta den befintliga
    // posten via idempotensen och INTE skriva en andra.
    await avisering.cancelNotice(notice.id, org.id, null)

    const efterAnnullering = await ledger(org.id)
    // Kapitalet vänds nu, men 3593 rörs inte igen — den står kvar på 0.
    expect(efterAnnullering[3593]).toBe(0)
    expect(efterStrykning[3593]).toBe(0)
    expect(efterAnnullering[3911]).toBe(0)

    const avgiftsReverseringar = await prisma.journalEntry.count({
      where: { organizationId: org.id, sourceId: `reminder-fee-reversal:${notice.id}` },
    })
    expect(avgiftsReverseringar).toBe(1)
  })

  it('en avi UTAN avgift VÄGRAS med begripligt besked', async () => {
    const { org, notice } = await seed('S8', 0)
    await avisering.reverseReminderFee(notice.id, org.id, SKAL, null)

    await expect(avisering.reverseReminderFee(notice.id, org.id, SKAL, null)).rejects.toThrow(
      /ingen påminnelseavgift/,
    )
  })
})
