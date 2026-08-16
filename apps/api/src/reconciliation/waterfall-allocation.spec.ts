jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
/**
 * H3 PR B — VATTENFALL: en klumpbetalning fördelas över flera avier.
 *
 * En hyresgäst med tre obetalda avier à 10 000 kr som betalade 30 000 kr fick
 * INGENTING registrerat: beloppet klassades mot ENDAST den äldsta avins restskuld,
 * sågs som en överbetalning, och hela matchningen avvisades. Pengarna fanns på
 * kontot men inte i systemet.
 *
 * Beteendet hette D4 och stod i #109 under "De fyra låsta besluten (hålls)". Tre
 * specar låste det. De skrivs om här, inte bort — se `reconciliation-payment-
 * allocation.spec.ts` för de två som gäller enskild avi respektive manuell
 * matchning, vilka är OFÖRÄNDRADE.
 */

import { InternalServerErrorException } from '@nestjs/common'
import { Decimal } from '@prisma/client/runtime/library'
import { ReconciliationService } from './reconciliation.service'

const dec = (v: string | number) => new Decimal(v)

interface AviSpec {
  id: string
  tenantId?: string
  dueDate: string
  createdAt?: string
  totalAmount: number
  priorAllocations?: number[]
}

function avi(a: AviSpec) {
  return {
    id: a.id,
    tenantId: a.tenantId ?? 'tenant-1',
    noticeNumber: `AVI-${a.id}`,
    status: 'SENT',
    collectionStage: 'NONE',
    type: 'RENT',
    dueDate: new Date(a.dueDate),
    createdAt: new Date(a.createdAt ?? a.dueDate),
    totalAmount: dec(a.totalAmount),
    consumptionAmount: dec(0),
    miscChargeAmount: dec(0),
    reminderFeeAmount: dec(0),
    interestAccruedAmount: dec(0),
  }
}

function makeService(
  avier: ReturnType<typeof avi>[],
  opts: { priorPerAvi?: Record<string, number[]> } = {},
) {
  const skapade: Array<{ rentNoticeId: string; amount: number }> = []
  const statusar: Array<{ id: string; data: Record<string, unknown> }> = []

  const txMock = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    rentNotice: {
      // Vattenfallet läser kandidaterna med findMany (ordnad).
      findMany: jest.fn().mockResolvedValue(avier),
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn((args: { where: { id: string }; data: Record<string, unknown> }) => {
        statusar.push({ id: args.where.id, data: args.data })
        return Promise.resolve({ count: 1 })
      }),
    },
    rentNoticePayment: {
      findMany: jest.fn((args: { where: { rentNoticeId: string } }) =>
        Promise.resolve(
          (opts.priorPerAvi?.[args.where.rentNoticeId] ?? []).map((n) => ({ amount: dec(n) })),
        ),
      ),
      create: jest.fn((args: { data: { rentNoticeId: string; amount: Decimal } }) => {
        skapade.push({ rentNoticeId: args.data.rentNoticeId, amount: args.data.amount.toNumber() })
        return Promise.resolve({ id: `rnp-${skapade.length}` })
      }),
    },
    bankTransaction: { update: jest.fn().mockResolvedValue({}) },
  }

  const createJournalEntryForRentNoticePayment = jest.fn().mockResolvedValue({ id: 'je-1' })
  const prisma = {
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(txMock)),
  }
  const service = new ReconciliationService(
    prisma as never,
    {} as never,
    { record: jest.fn() } as never,
    { createJournalEntryForRentNoticePayment } as never,
    {} as never,
    { record: jest.fn().mockResolvedValue({}) } as never,
  )
  // Privat metod — testas direkt, för det är allokeringsregeln som är kravet.
  const kör = (belopp: number, tenantOcr = '00000000019') =>
    (
      service as unknown as {
        applyWaterfallToRentNotices: (
          t: string,
          o: string,
          org: string,
          a: Decimal,
          d: Date,
          u: string | null,
        ) => Promise<boolean>
      }
    ).applyWaterfallToRentNotices(
      'tx-1',
      tenantOcr,
      'org-1',
      dec(belopp),
      new Date('2026-06-20'),
      null,
    )

  return { kör, skapade, statusar, txMock, createJournalEntryForRentNoticePayment }
}

const TRE_AVIER = [
  avi({ id: 'rn-1', dueDate: '2026-04-30', totalAmount: 10_000 }),
  avi({ id: 'rn-2', dueDate: '2026-05-31', totalAmount: 10_000 }),
  avi({ id: 'rn-3', dueDate: '2026-06-30', totalAmount: 10_000 }),
]

describe('vattenfall — de tre formerna', () => {
  it('TÄCKER N AVIER EXAKT → N × PAID', async () => {
    const { kör, skapade, statusar } = makeService(TRE_AVIER)
    await expect(kör(30_000)).resolves.toBe(true)

    expect(skapade).toEqual([
      { rentNoticeId: 'rn-1', amount: 10_000 },
      { rentNoticeId: 'rn-2', amount: 10_000 },
      { rentNoticeId: 'rn-3', amount: 10_000 },
    ])
    expect(statusar.every((s) => s.data.status === 'PAID')).toBe(true)
  })

  it('TÄCKER N-1 HELT + DEL AV N → (N-1) × PAID + 1 × PARTIAL', async () => {
    // 25 000 mot tre à 10 000: två blir PAID, den tredje delbetald på 5 000.
    // Det vanligaste verkliga fallet — pengarna får plats, bara inte som hela avier.
    const { kör, skapade, statusar } = makeService(TRE_AVIER)
    await expect(kör(25_000)).resolves.toBe(true)

    expect(skapade).toEqual([
      { rentNoticeId: 'rn-1', amount: 10_000 },
      { rentNoticeId: 'rn-2', amount: 10_000 },
      { rentNoticeId: 'rn-3', amount: 5_000 },
    ])
    const paid = statusar.filter((s) => s.data.status === 'PAID').map((s) => s.id)
    expect(paid).toEqual(['rn-1', 'rn-2'])
    // Den delbetalda behåller status — bara paidAmount-spegeln uppdateras.
    expect(statusar.find((s) => s.id === 'rn-3')!.data.status).toBeUndefined()
  })

  it('KANARIEFÅGEL: överstiger allt med EN KRONA → UNMATCHED, NOLL allokeringar', async () => {
    // Grenen som skiljer "allt-eller-inget" från "allokera och lämna en återstod".
    // Den ska vara omöjlig att glida ur: inte N-1 allokeringar plus ett fel, inte
    // en delvis bokförd betalning — ingenting.
    const { kör, skapade, statusar, txMock, createJournalEntryForRentNoticePayment } =
      makeService(TRE_AVIER)

    await expect(kör(30_001.01)).resolves.toBe(false)

    expect(skapade).toEqual([])
    expect(statusar).toEqual([])
    expect(createJournalEntryForRentNoticePayment).not.toHaveBeenCalled()
    expect(txMock.bankTransaction.update).not.toHaveBeenCalled()
  })
})

describe('vattenfall — toleransen gäller SUMMAN', () => {
  it('50 öre över totalen absorberas, precis som på en enskild avi', async () => {
    // Utan detta vore 30 000,50 mot tre avier avvisad medan 10 000,50 mot en avi
    // absorberas — en ny asymmetri av precis den sort vi rensat bort.
    const { kör, skapade } = makeService(TRE_AVIER)
    await expect(kör(30_000.5)).resolves.toBe(true)
    expect(skapade.map((s) => s.amount)).toEqual([10_000, 10_000, 10_000])
  })

  it('50 öre UNDER totalen ger också full reglering — öret läggs på sista avin', async () => {
    const { kör, skapade, statusar } = makeService(TRE_AVIER)
    await expect(kör(29_999.5)).resolves.toBe(true)
    expect(skapade.map((s) => s.amount)).toEqual([10_000, 10_000, 10_000])
    expect(statusar.every((s) => s.data.status === 'PAID')).toBe(true)
  })
})

describe('vattenfall — ordningen ÄR allokeringsregeln', () => {
  it('äldsta förfallodag först', async () => {
    const oordnat = [
      avi({ id: 'rn-ny', dueDate: '2026-06-30', totalAmount: 10_000 }),
      avi({ id: 'rn-gammal', dueDate: '2026-04-30', totalAmount: 10_000 }),
    ]
    // Riggen returnerar dem i den ordning databasen skulle ge med orderBy —
    // testet pinnar att koden inte sorterar om eller vänder på dem.
    const sorterade = [...oordnat].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())
    const { kör, skapade } = makeService(sorterade)
    await expect(kör(15_000)).resolves.toBe(true)
    expect(skapade[0]!.rentNoticeId).toBe('rn-gammal')
    expect(skapade[1]!.amount).toBe(5_000)
  })

  it('SAMMA förfallodag → createdAt avgör, deterministiskt', async () => {
    // Utan tie-break avgör databasens infall vilken avi som blir betald när
    // pengarna tar slut. Det är en allokeringsregel, inte en presentationsdetalj.
    const samma = [
      avi({ id: 'rn-först', dueDate: '2026-05-31', createdAt: '2026-05-01', totalAmount: 10_000 }),
      avi({ id: 'rn-sedan', dueDate: '2026-05-31', createdAt: '2026-05-02', totalAmount: 10_000 }),
    ]
    const { kör, skapade } = makeService(samma)
    await expect(kör(15_000)).resolves.toBe(true)
    expect(skapade[0]!.rentNoticeId).toBe('rn-först')
    expect(skapade[0]!.amount).toBe(10_000)
    expect(skapade[1]!.rentNoticeId).toBe('rn-sedan')
    expect(skapade[1]!.amount).toBe(5_000)
  })

  it('frågan ställs med rätt orderBy — dueDate, sedan createdAt', async () => {
    const { kör, txMock } = makeService(TRE_AVIER)
    await kör(30_000)
    expect(txMock.rentNotice.findMany.mock.calls[0]![0].orderBy).toEqual([
      { dueDate: 'asc' },
      { createdAt: 'asc' },
    ])
  })
})

describe('vattenfall — same-tenant-invarianten', () => {
  it('KANARIEFÅGEL: avier hos OLIKA hyresgäster → kastar, INGENTING allokeras', async () => {
    // Kandidaterna väljs på OCR-STRÄNGEN. I det riktiga flödet kan de inte
    // divergera, men att gå från en avi till flera förstärker konsekvensen om
    // antagandet någon gång bryts — en betalning skulle kunna svepa över avier
    // hos olika hyresgäster. Invarianten gör den skaderisken omöjlig.
    const blandat = [
      avi({ id: 'rn-1', tenantId: 'tenant-A', dueDate: '2026-04-30', totalAmount: 10_000 }),
      avi({ id: 'rn-2', tenantId: 'tenant-B', dueDate: '2026-05-31', totalAmount: 10_000 }),
    ]
    const { kör, skapade, createJournalEntryForRentNoticePayment } = makeService(blandat)

    await expect(kör(20_000)).rejects.toBeInstanceOf(InternalServerErrorException)
    expect(skapade).toEqual([])
    expect(createJournalEntryForRentNoticePayment).not.toHaveBeenCalled()
  })

  it('felet NAMNGER transaktionen och de motstridiga hyresgästerna', async () => {
    const blandat = [
      avi({ id: 'rn-1', tenantId: 'tenant-A', dueDate: '2026-04-30', totalAmount: 10_000 }),
      avi({ id: 'rn-2', tenantId: 'tenant-B', dueDate: '2026-05-31', totalAmount: 10_000 }),
    ]
    const { kör } = makeService(blandat)
    await expect(kör(20_000)).rejects.toThrow(/tx-1[\s\S]*tenant-A[\s\S]*tenant-B/)
  })
})

describe('vattenfall — tar inte över det enskildvägen klarar', () => {
  it('en enda öppen avi → vattenfallet avstår', async () => {
    const { kör, skapade } = makeService([TRE_AVIER[0]!])
    await expect(kör(10_000)).resolves.toBe(false)
    expect(skapade).toEqual([])
  })

  it('beloppet ryms i ÄLDSTA avin → vattenfallet avstår (enskildvägen äger fallet)', async () => {
    const { kör, skapade } = makeService(TRE_AVIER)
    await expect(kör(4_000)).resolves.toBe(false)
    expect(skapade).toEqual([])
  })

  it('redan delbetalda avier räknas på RESTSKULDEN, inte totalen', async () => {
    // rn-1 har 6 000 betalt → 4 000 kvar. 14 000 täcker den resten + hela rn-2.
    const { kör, skapade } = makeService(TRE_AVIER.slice(0, 2), {
      priorPerAvi: { 'rn-1': [6_000] },
    })
    await expect(kör(14_000)).resolves.toBe(true)
    expect(skapade).toEqual([
      { rentNoticeId: 'rn-1', amount: 4_000 },
      { rentNoticeId: 'rn-2', amount: 10_000 },
    ])
  })
})
