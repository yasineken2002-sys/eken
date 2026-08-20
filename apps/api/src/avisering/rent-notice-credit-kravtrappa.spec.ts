/**
 * #518 — KRAVTRAPPAN MOT EN KREDITERAD AVI, I TRE LÄGEN.
 *
 * Helkrediterad ska INTE eskalera. Delkrediterad ska eskalera på RÄTT belopp.
 * Okrediterad ska eskalera precis som förut. Det tredje läget är inte artighet:
 * utan det kan de två första vara gröna för att grinden stängt AV ALLT, och då
 * mäter de att en spärr finns — inte att den är rätt kalibrerad.
 *
 * ── MOT DE RIKTIGA TJÄNSTERNA ────────────────────────────────────────────────
 *
 * `RentDebtService` instansieras SKARP i varje test och läser samma fejkade
 * databas som tjänsterna under prövning. Det är hela poängen: stubbas den
 * delade skulden kan varje konsuments spec vara grön medan ytorna visar olika
 * tal, eftersom ingen av dem längre prövar den gemensamma beräkningen. Bara de
 * kollaboratörer som ligger UTANFÖR skuldfrågan är stubbade — post, PDF, R2,
 * kön, bokföringen — och ingen av dem påverkar vilket belopp en grind läser.
 */

// R2/Puppeteer dras in transitivt via påminnelse- och exportvägarna och har
// inget med skuldberäkningen att göra. Samma stubbning som credit-note-guard.
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { RentNoticeType } from '@prisma/client'
import { Prisma } from '@prisma/client'

import { RentDebtService } from './rent-debt.service'
import { RentReminderService } from './rent-reminder.service'
import { RentBadDebtService } from './rent-bad-debt.service'
import { RentCollectionExportService } from '../collections/rent-collection-export.service'
import { OverdueDebtService } from '../overdue/overdue-debt.service'

const D = (n: number) => new Prisma.Decimal(n)

interface FakeNotice {
  id: string
  organizationId: string
  noticeNumber: string
  type: RentNoticeType
  status: string
  collectionStage: string
  isBackfill: boolean
  dueDate: Date
  totalAmount: Prisma.Decimal
  consumptionAmount: Prisma.Decimal
  miscChargeAmount: Prisma.Decimal
  reminderFeeAmount: Prisma.Decimal
  interestAccruedAmount: Prisma.Decimal
  interestAccruedThrough: Date | null
  vatAmount: Prisma.Decimal
  probableLossAt: Date | null
  writtenOffAt: Date | null
  collectionReadyAt: Date | null
  payments: Array<{ amount: Prisma.Decimal }>
  credits: Array<{ amount: Prisma.Decimal }>
}

/** 10 000 kr hyra, förfallen för 30 dagar sedan. Inga andra poster — talen ska gå att följa. */
function avi(over: Partial<FakeNotice> = {}): FakeNotice {
  return {
    id: 'avi-1',
    organizationId: 'org-1',
    noticeNumber: 'AVI-2026-08-0001',
    type: RentNoticeType.RENT,
    status: 'OVERDUE',
    collectionStage: 'NONE',
    isBackfill: false,
    dueDate: new Date(Date.now() - 30 * 24 * 3_600_000),
    totalAmount: D(10_000),
    consumptionAmount: D(0),
    miscChargeAmount: D(0),
    reminderFeeAmount: D(0),
    interestAccruedAmount: D(0),
    credits: [],
    interestAccruedThrough: null,
    vatAmount: D(0),
    probableLossAt: null,
    writtenOffAt: null,
    collectionReadyAt: null,
    payments: [],
    ...over,
  }
}

/**
 * Minimal Prisma-dubbel som svarar på de frågor skuldvägen faktiskt ställer.
 * Rader är vanliga objekt med `payments`/`credits` på sig, så både
 * `RentDebtService.outstanding` (select) och kravtrappans `findMany` (include)
 * får det de behöver ur samma källa — inga två sanningar i riggen.
 */
function fakePrisma(notices: FakeNotice[], extra: Record<string, unknown> = {}) {
  const matchar = (n: FakeNotice, where: Record<string, unknown> = {}): boolean => {
    for (const [nyckel, villkor] of Object.entries(where)) {
      if (nyckel === 'organization' || nyckel === 'OR') continue
      const värde = (n as unknown as Record<string, unknown>)[nyckel]
      if (villkor === null || typeof villkor !== 'object') {
        if (värde !== villkor) return false
        continue
      }
      const v = villkor as Record<string, unknown>
      if ('in' in v && !(v['in'] as unknown[]).includes(värde)) return false
      if ('notIn' in v && (v['notIn'] as unknown[]).includes(värde)) return false
      if ('not' in v && värde === v['not']) return false
    }
    return true
  }

  return {
    rentNotice: {
      findMany: jest.fn(async (args: { where?: Record<string, unknown> } = {}) =>
        notices
          .filter((n) => matchar(n, args.where ?? {}))
          // Påminnelsevägen kräver en leveransbar adress för att ta ut avgiften
          // — utan tenant hade ALLA tre lägena hoppats över, och testet blivit
          // grönt av fel skäl.
          .map((n) => ({ ...n, organization: org, tenant: { email: 'hyresgast@example.se' } })),
      ),
      findFirst: jest.fn(async (args: { where?: Record<string, unknown> } = {}) => {
        const träff = notices.find((n) => matchar(n, args.where ?? {}))
        return träff ? { ...träff } : null
      }),
      updateMany: jest.fn(async () => ({ count: 1 })),
      update: jest.fn(async () => ({})),
    },
    rentNoticePayment: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
    rentNoticeCredit: {
      findMany: jest.fn(async (args: { where?: { rentNoticeId?: string } } = {}) => {
        const n = notices.find((x) => x.id === args.where?.rentNoticeId)
        return n ? n.credits : []
      }),
    },
    invoice: { findMany: jest.fn(async () => []) },
    ...extra,
  }
}

const org = {
  id: 'org-1',
  name: 'Testbolaget',
  remindersEnabled: true,
  rentReminderDay: 7,
  reminderFeeSek: 60,
  rentInkassoDaysAfterReminder: 14,
}

/** Alla kollaboratörer utanför skuldfrågan. Ingen av dem kan påverka ett belopp. */
function reminderRigg(notices: FakeNotice[]) {
  const prisma = fakePrisma(notices)
  const rentDebt = new RentDebtService(prisma as never) // SKARP, inte stubbad
  const escalate = jest.fn().mockResolvedValue(true)
  const service = new RentReminderService(
    prisma as never,
    {} as never,
    { record: jest.fn() } as never,
    {} as never,
    { enqueue: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    rentDebt,
    { evaluateAndAlert: jest.fn().mockResolvedValue(new Set<string>()) } as never,
  )
  // Eskaleringens SIDOEFFEKT (avgift, verifikat, PDF-kö) är inte det som prövas
  // här — det som prövas är OM den anropas, och med vilken avi. Att spionera på
  // den i stället för att köra den håller testet på grinden.
  ;(service as unknown as Record<string, unknown>)['escalateNoticeToReminded'] = escalate
  ;(service as unknown as Record<string, unknown>)['daysSince'] = () => 30
  return { service, escalate, rentDebt }
}

describe('#518 — steg 2 (påminnelse): krediteringen syns i eskaleringsgrinden', () => {
  it('HELKREDITERAD avi eskalerar INTE', async () => {
    const { service, escalate } = reminderRigg([avi({ credits: [{ amount: D(10_000) }] })])
    const summary = await service.escalateOverdueRentNotices()
    expect(escalate).not.toHaveBeenCalled()
    expect(summary.skipped).toBe(1)
  })

  it('DELKREDITERAD avi eskalerar — och restskulden är 6 000, inte 10 000', async () => {
    const notices = [avi({ credits: [{ amount: D(4_000) }] })]
    const { service, escalate, rentDebt } = reminderRigg(notices)
    await service.escalateOverdueRentNotices()

    expect(escalate).toHaveBeenCalledTimes(1)
    // Beloppet, inte bara att den eskalerade: en grind som släpper igenom rätt
    // avi men räknar fel skuld hade varit grön på raden ovan.
    const debt = await rentDebt.outstanding('avi-1', 'org-1')
    expect(debt.ocrOutstanding).toBe(6_000)
    expect(debt.credited).toBe(4_000)
    // Krediteringen är INTE en betalning, och det ska synas.
    expect(debt.paid).toBe(0)
  })

  it('KONTROLLFALL: okrediterad avi eskalerar som förut, på hela beloppet', async () => {
    const { service, escalate, rentDebt } = reminderRigg([avi()])
    await service.escalateOverdueRentNotices()
    expect(escalate).toHaveBeenCalledTimes(1)
    expect((await rentDebt.outstanding('avi-1', 'org-1')).ocrOutstanding).toBe(10_000)
  })
})

describe('#518 — steg 5 (inkasso-export): krediteringen stänger grinden', () => {
  function exportRigg(notices: FakeNotice[]) {
    const prisma = fakePrisma(notices)
    const rentDebt = new RentDebtService(prisma as never) // SKARP
    const service = new RentCollectionExportService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      rentDebt,
    )
    return { service }
  }

  const redo = (over: Partial<FakeNotice> = {}) =>
    avi({ collectionStage: 'INKASSO_READY', collectionReadyAt: new Date(), ...over })

  it('HELKREDITERAD avi listas inte som exporterbar', async () => {
    const { service } = exportRigg([redo({ credits: [{ amount: D(10_000) }] })])
    expect(await service.listReady('org-1')).toHaveLength(0)
  })

  it('DELKREDITERAD avi listas — det finns fortfarande en fordran att driva in', async () => {
    const { service } = exportRigg([redo({ credits: [{ amount: D(4_000) }] })])
    expect(await service.listReady('org-1')).toHaveLength(1)
  })

  it('KONTROLLFALL: okrediterad inkasso-redo avi listas som förut', async () => {
    const { service } = exportRigg([redo()])
    expect(await service.listReady('org-1')).toHaveLength(1)
  })

  it('KAPITAL BORTKREDITERAT MEN RÄNTA KVAR: avin stannar och kräver människobeslut', async () => {
    // Det farliga fallet, och skälet till att `interestOnlyAfterCredit` finns:
    // `outstanding` mäter HELA fordran inklusive ränta, så avin hade sett ut att
    // ha en skuld på 320 kr — vars grund just krediterats bort.
    const { service } = exportRigg([
      redo({ credits: [{ amount: D(10_000) }], interestAccruedAmount: D(320) }),
    ])
    expect(await service.listReady('org-1')).toHaveLength(0)
  })
})

describe('#518 — steg 6 (kundförlust): cronen skriver aldrig ned ren restränta efter kreditering', () => {
  function badDebtRigg(notices: FakeNotice[]) {
    const prisma = fakePrisma(notices)
    const rentDebt = new RentDebtService(prisma as never) // SKARP
    const reclassify = jest.fn().mockResolvedValue({ booked: true })
    const service = new RentBadDebtService(
      prisma as never,
      {} as never,
      { record: jest.fn() } as never,
      rentDebt,
      { evaluateAndAlert: jest.fn().mockResolvedValue(new Set<string>()) } as never,
      { createForOrg: jest.fn() } as never,
    )
    ;(service as unknown as Record<string, unknown>)['reclassifyToProbableLoss'] = reclassify
    return { service, reclassify }
  }

  const redo = (over: Partial<FakeNotice> = {}) =>
    avi({ collectionStage: 'INKASSO_READY', collectionReadyAt: new Date(), ...over })

  it('kapitalet krediterat, ränta kvar → hoppas över och räknas', async () => {
    const { service, reclassify } = badDebtRigg([
      redo({ credits: [{ amount: D(10_000) }], interestAccruedAmount: D(320) }),
    ])
    const summary = await service.reclassifyProbableLosses()
    expect(reclassify).not.toHaveBeenCalled()
    expect(summary.creditedInterestOnly).toBe(1)
  })

  it('KONTROLLFALL: okrediterad avi med ränta skrivs ned som förut', async () => {
    const { service, reclassify } = badDebtRigg([redo({ interestAccruedAmount: D(320) })])
    const summary = await service.reclassifyProbableLosses()
    expect(reclassify).toHaveBeenCalledTimes(1)
    expect(summary.creditedInterestOnly).toBe(0)
  })
})

describe('#518 — steg 7 (skuldsumman): en krediterad avi höjer inte den öppna fordran', () => {
  function overdueRigg(notices: FakeNotice[]) {
    const prisma = fakePrisma(notices)
    return new OverdueDebtService(prisma as never)
  }

  it('helkrediterad avi räknas varken i belopp eller antal', async () => {
    const service = overdueRigg([avi({ credits: [{ amount: D(10_000) }] })])
    const res = await service.getOverdueSnapshot('org-1')
    expect(res.total).toBe(0)
    expect(res.count).toBe(0)
  })

  it('delkrediterad avi räknas på restskulden', async () => {
    const service = overdueRigg([avi({ credits: [{ amount: D(4_000) }] })])
    expect((await service.getOverdueSnapshot('org-1')).total).toBe(6_000)
  })

  it('KONTROLLFALL: okrediterad avi räknas på hela beloppet', async () => {
    const service = overdueRigg([avi()])
    expect((await service.getOverdueSnapshot('org-1')).total).toBe(10_000)
  })
})
