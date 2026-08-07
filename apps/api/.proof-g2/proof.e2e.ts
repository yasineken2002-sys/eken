/**
 * BEVISRIGG G2 — ingen påminnelseavgift utan avtalsvillkor.
 *
 * ORAKLET ÄR KONTOSALDONA. 3593 ska stå på 0 när avtalsgrunden saknas eller
 * kom för sent, och på avgiftsbeloppet när den fanns i tid. Ett statusfält
 * eller ett returvärde duger inte — det är huvudboken som avgör om en
 * hyresgäst har krävts på pengar.
 *
 * DISKRIMINERANDE DATUM: villkorsdatum, periodStart och dueDate är tre olika
 * dagar i varje scenario, och avgiften (60) skiljer sig från alla belopp i
 * uppställningen. Sammanföll de kunde riggen inte se vilket fält som jämfördes.
 */

jest.mock('../src/invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../src/storage/storage.service', () => ({ StorageService: class {} }))

import { PrismaClient } from '@prisma/client'

import { AccountingService } from '../src/accounting/accounting.service'
import { VerifikationsnummerService } from '../src/accounting/verifikationsnummer.service'
import { resolveNoticeDebtOrigin } from '../src/accounting/debt-origin'

const prisma = new PrismaClient({
  datasources: { db: { url: 'postgresql://eken:eken@localhost:5432/eken_g2' } },
})

const KAPITAL = 7355.0
const AVGIFT = 60.0

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

/** En org med ett avtal vars villkorsdatum sätts av scenariot. */
async function seed(namn: string, termsFrom: Date | null) {
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
      ...(termsFrom ? { reminderFeeTermsFrom: termsFrom } : {}),
    },
  })
  return { org, lease, tenant }
}

/** Avi för juli 2026: skulden uppkommer 2026-06-30 (förfall före perioden). */
async function seedNotice(
  org: { id: string },
  lease: { id: string },
  tenant: { id: string },
  periodStart: Date | null,
) {
  return prisma.rentNotice.create({
    data: {
      organizationId: org.id,
      leaseId: lease.id,
      tenantId: tenant.id,
      noticeNumber: `A-${Math.floor(Math.random() * 1000000)}`,
      ocrNumber: `9${Math.floor(Math.random() * 1000000000)}`.slice(0, 12),
      type: 'RENT',
      year: 2026,
      month: 7,
      amount: KAPITAL,
      vatAmount: 0,
      totalAmount: KAPITAL,
      dueDate: new Date('2026-06-30'),
      status: 'OVERDUE',
      ...(periodStart ? { periodStart, periodEnd: new Date('2026-07-31') } : {}),
    },
  })
}

/** Kör bokföringen via den skarpa vägen, med regeln hämtad ur sin enda källa. */
async function försökBokföraAvgift(orgId: string, noticeId: string) {
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
    fee: AVGIFT,
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

describe('G2 — grinden mot huvudboken', () => {
  it('S1: villkorsdatum NULL → ingen avgift, 3593 på 0', async () => {
    const { org, lease, tenant } = await seed('S1', null)
    const notice = await seedNotice(org, lease, tenant, new Date('2026-07-01'))

    const entry = await försökBokföraAvgift(org.id, notice.id)

    expect(entry).toBeNull()
    const bok = await ledger(org.id)
    expect(bok[3593] ?? 0).toBe(0)
    expect(bok[1510] ?? 0).toBe(0)
    expect(await prisma.journalEntry.count({ where: { organizationId: org.id } })).toBe(0)
  })

  it('S2: villkorsdatum EFTER skuldens uppkomst → ingen avgift, 3593 på 0', async () => {
    // Skulden uppkom 2026-06-30. Villkoret trädde i kraft 2026-07-15 — avgiften
    // vore retroaktiv, och en retroaktiv avgift är ett olagligt krav.
    const { org, lease, tenant } = await seed('S2', new Date('2026-07-15'))
    const notice = await seedNotice(org, lease, tenant, new Date('2026-07-01'))

    const entry = await försökBokföraAvgift(org.id, notice.id)

    expect(entry).toBeNull()
    const bok = await ledger(org.id)
    expect(bok[3593] ?? 0).toBe(0)
    expect(bok[1510] ?? 0).toBe(0)
  })

  it('S3: villkorsdatum FÖRE skuldens uppkomst → avgift bokförd som vanligt', async () => {
    const { org, lease, tenant } = await seed('S3', new Date('2026-01-01'))
    const notice = await seedNotice(org, lease, tenant, new Date('2026-07-01'))

    const entry = await försökBokföraAvgift(org.id, notice.id)

    expect(entry).not.toBeNull()
    const bok = await ledger(org.id)
    expect(bok[3593]).toBe(-AVGIFT)
    expect(bok[1510]).toBe(AVGIFT)
  })

  it('S4: periodStart saknas → ingen avgift trots urgammalt villkor', async () => {
    // Skuldens uppkomst går inte att fastställa. Vägrar hellre än gissar på
    // dueDate — det är den tillåtande riktningen för en efterdebitering.
    const { org, lease, tenant } = await seed('S4', new Date('2020-01-01'))
    const notice = await seedNotice(org, lease, tenant, null)

    const entry = await försökBokföraAvgift(org.id, notice.id)

    expect(entry).toBeNull()
    expect((await ledger(org.id))[3593] ?? 0).toBe(0)
  })

  it('S5: EFTERDEBITERING — periodStart styr, inte dueDate', async () => {
    // Historisk period (2025-01), framtida betalningsdag (2026-08-10).
    // Villkoret 2026-06-01 ligger EFTER perioden men FÖRE dueDate. Går regeln
    // på dueDate släpps avgiften igenom; går den på periodStart vägras den.
    const { org, lease, tenant } = await seed('S5', new Date('2026-06-01'))
    const notice = await prisma.rentNotice.create({
      data: {
        organizationId: org.id,
        leaseId: lease.id,
        tenantId: tenant.id,
        noticeNumber: 'A-backfill',
        ocrNumber: `9${Math.floor(Math.random() * 1000000000)}`.slice(0, 12),
        type: 'RENT',
        year: 2025,
        month: 1,
        amount: KAPITAL,
        vatAmount: 0,
        totalAmount: KAPITAL,
        dueDate: new Date('2026-08-10'),
        periodStart: new Date('2025-01-01'),
        periodEnd: new Date('2025-01-31'),
        status: 'OVERDUE',
      },
    })

    const entry = await försökBokföraAvgift(org.id, notice.id)

    expect(entry).toBeNull()
    expect((await ledger(org.id))[3593] ?? 0).toBe(0)
    // Kontrollen som visar att fallet ÄR diskriminerande: villkoret ligger före
    // dueDate, så en dueDate-baserad regel hade bokfört här.
    expect(new Date('2026-06-01').getTime() <= new Date('2026-08-10').getTime()).toBe(true)
  })
})
