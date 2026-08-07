/**
 * G2 — ingen påminnelseavgift utan avtalsvillkor.
 *
 * Påminnelseavgift får inte debiteras utan avtalsvillkor (2 § lagen 1981:739),
 * och villkoret binder bara framåt: "senast i samband med skuldens uppkomst".
 *
 * VAD SOM BEVAKAS HÄR: att regeln bara går att uttrycka på ETT ställe, och att
 * grinden vägrar av alla tre skälen. Vad grinden gör med kontosaldona bevisas i
 * bevisriggen mot riktig Postgres — attrapper kan inte visa ett saldo.
 *
 * DISKRIMINERANDE DATUM: villkorsdatum, periodStart och dueDate är tre olika
 * dagar i varje fall. Sammanföll de kunde testet inte se vilket fält regeln
 * faktiskt jämförde mot — och just den förväxlingen är felet som ligger
 * närmast till hands (se efterdebiteringsfallet nedan).
 */

import { AccountingService } from './accounting.service'
import {
  resolveNoticeDebtOrigin,
  resolveInvoiceDebtOrigin,
  isReminderFeeContractuallyAllowed,
} from './debt-origin'

function makeService() {
  const created: Array<Record<string, unknown>> = []
  const prisma = {
    account: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'acc-1510', number: 1510 },
        { id: 'acc-3593', number: 3593 },
      ]),
    },
    journalEntry: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((arg: Record<string, unknown>) => {
        created.push(arg)
        return Promise.resolve({ id: 'je-new', ...arg })
      }),
    },
  }
  ;(prisma as unknown as { $transaction: unknown }).$transaction = (cb: (tx: unknown) => unknown) =>
    cb(prisma)
  const service = new AccountingService(
    prisma as never,
    {
      allocate: jest.fn().mockResolvedValue({ series: 'A', verNumber: 1, fiscalYear: 2026 }),
    } as never,
  )
  return { service, prisma, created }
}

const bas = {
  organizationId: 'org-1',
  source: 'RENT_NOTICE' as const,
  sourceId: 'reminder-fee:rn-1',
  fee: 60,
  description: 'Påminnelseavgift hyresavi rn-1',
}

// Normal förskottsavi: förfall 30 juni, period 1–31 juli. dueDate är TIDIGAST.
const FÖRSKOTT = { periodStart: new Date('2026-07-01'), dueDate: new Date('2026-06-30') }
// Efterdebitering: perioden är historisk, dueDate en framtida betalningsdag.
// periodStart är TIDIGAST — och den ärliga tidpunkten skulden uppkom.
const EFTERDEBITERING = { periodStart: new Date('2025-01-01'), dueDate: new Date('2026-08-10') }

describe('G2 — grinden i bookReminderFee', () => {
  it('VÄGRAR utan avtalsgrund (termsFrom null) — det vanligaste fallet', async () => {
    const { service, created } = makeService()

    const entry = await service.bookReminderFee({
      ...bas,
      debtOrigin: resolveNoticeDebtOrigin(FÖRSKOTT),
      termsFrom: null,
    })

    expect(entry).toBeNull()
    expect(created).toHaveLength(0)
  })

  it('VÄGRAR när villkoret trädde i kraft EFTER skuldens uppkomst', async () => {
    // Skulden uppkom 2026-06-30, villkoret 2026-07-15. Avgiften vore retroaktiv.
    const { service, created } = makeService()

    const entry = await service.bookReminderFee({
      ...bas,
      debtOrigin: resolveNoticeDebtOrigin(FÖRSKOTT),
      termsFrom: new Date('2026-07-15'),
    })

    expect(entry).toBeNull()
    expect(created).toHaveLength(0)
  })

  it('VÄGRAR när skuldens uppkomst inte går att fastställa (periodStart null)', async () => {
    const { service, created } = makeService()

    const entry = await service.bookReminderFee({
      ...bas,
      debtOrigin: resolveNoticeDebtOrigin({ periodStart: null, dueDate: new Date('2026-06-30') }),
      termsFrom: new Date('2020-01-01'), // urgammalt villkor — ändå ingen avgift
    })

    expect(entry).toBeNull()
    expect(created).toHaveLength(0)
  })

  it('BOKFÖR när villkoret trädde i kraft före skuldens uppkomst', async () => {
    const { service, created } = makeService()

    const entry = await service.bookReminderFee({
      ...bas,
      debtOrigin: resolveNoticeDebtOrigin(FÖRSKOTT),
      termsFrom: new Date('2026-01-01'),
    })

    expect(entry).not.toBeNull()
    expect(created).toHaveLength(1)
  })

  it('gränsfallet: villkoret samma dag som skulden uppkom → BOKFÖR', async () => {
    // "senast i samband med skuldens uppkomst" — samma dag är i tid.
    const { service, created } = makeService()

    const entry = await service.bookReminderFee({
      ...bas,
      debtOrigin: resolveNoticeDebtOrigin(FÖRSKOTT),
      termsFrom: new Date('2026-06-30'),
    })

    expect(entry).not.toBeNull()
    expect(created).toHaveLength(1)
  })
})

describe('regeln för skuldens uppkomst', () => {
  it('FÖRSKOTTSAVI: dueDate är tidigast och vinner', () => {
    expect(resolveNoticeDebtOrigin(FÖRSKOTT)).toEqual(new Date('2026-06-30'))
  })

  it('EFTERDEBITERING: periodStart är tidigast och vinner — dueDate vore för tillåtande', () => {
    // DET HÄR ÄR FYNDET SOM STYRDE VALET. Ginge regeln på dueDate skulle ett
    // villkorsdatum från 2026 släppa igenom en avgift på en skuld från 2025.
    expect(resolveNoticeDebtOrigin(EFTERDEBITERING)).toEqual(new Date('2025-01-01'))
    expect(resolveNoticeDebtOrigin(EFTERDEBITERING)).not.toEqual(new Date('2026-08-10'))
  })

  it('en efterdebitering blockeras av ett villkor som dueDate hade släppt igenom', () => {
    const villkor = new Date('2026-06-01') // efter perioden, före dueDate
    expect(
      isReminderFeeContractuallyAllowed(resolveNoticeDebtOrigin(EFTERDEBITERING), villkor),
    ).toBe(false)
    // …och hade regeln gått på dueDate hade samma villkor släppt igenom:
    expect(villkor.getTime() <= EFTERDEBITERING.dueDate.getTime()).toBe(true)
  })

  it('periodStart null → null, aldrig en gissning på dueDate', () => {
    expect(
      resolveNoticeDebtOrigin({ periodStart: null, dueDate: new Date('2026-06-30') }),
    ).toBeNull()
  })

  it('FAKTURA: issueDate', () => {
    expect(resolveInvoiceDebtOrigin({ issueDate: new Date('2026-04-15') })).toEqual(
      new Date('2026-04-15'),
    )
  })

  it('predikatet är fail-closed på båda null-fallen', () => {
    const d = resolveInvoiceDebtOrigin({ issueDate: new Date('2026-04-15') })
    expect(isReminderFeeContractuallyAllowed(null, new Date('2020-01-01'))).toBe(false)
    expect(isReminderFeeContractuallyAllowed(d, null)).toBe(false)
    expect(isReminderFeeContractuallyAllowed(null, null)).toBe(false)
  })
})
