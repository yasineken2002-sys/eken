/**
 * #518 — KREDITERINGSUNDERLAGET SOM GRÄNSSNITTET LÄSER.
 *
 * Vyn får inte härleda sina egna villkor. Två saker måste därför komma FÄRDIGA
 * ur `getPreview`, och det är dem den här specen mäter:
 *
 *   1. Postens KUMULATIVA tak (`remaining`) — räknat över alla tidigare
 *      krediteringar. En klient som gissat "återstår = postens belopp" hade
 *      föreslagit belopp API:et sedan avvisar.
 *   2. PROJEKTIONEN av en tänkt kreditering — särskilt
 *      `interestOnlyAfterCredit`, som är en REGEL och inte en subtraktion:
 *      den avgör om avin stannar för människobeslut i stället för att gå vidare
 *      i kravtrappan. Räknades den i React hade regeln funnits på två ställen.
 */

jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Prisma, RentNoticeType } from '@prisma/client'

import { RentNoticeCreditService } from './rent-notice-credit.service'

const D = (n: number) => new Prisma.Decimal(n)

/**
 * En avi med hyra 9 000, en övrig post på 1 250 och (valfritt) upplupen ränta.
 * `krediterat` är radbeloppen som redan är krediterade per post.
 */
function rigg(
  over: {
    interest?: number
    credits?: number[]
    kreditrader?: Array<{ rentNoticeLineId: string | null; amount: number }>
  } = {},
) {
  const notice = {
    id: 'avi-1',
    noticeNumber: 'AVI-2026-09-0001',
    organizationId: 'org-1',
    type: RentNoticeType.RENT,
    status: 'SENT',
    month: 9,
    year: 2026,
    totalAmount: D(9_000),
    vatAmount: D(0),
    consumptionAmount: D(0),
    miscChargeAmount: D(1_250),
    reminderFeeAmount: D(0),
    interestAccruedAmount: D(over.interest ?? 0),
    collectionStage: 'REMINDED',
    probableLossAt: null,
    writtenOffAt: null,
    lines: [
      {
        id: 'rad-1',
        description: 'Ersättning förlorad nyckel',
        total: D(1_250),
        vatRate: 0,
        consumptionChargeId: null,
        miscChargeId: 'mc-1',
      },
    ],
    payments: [],
    credits: (over.credits ?? []).map((a, i) => ({
      id: `kredit-${i}`,
      amount: D(a),
      reason: 'felaktig debitering',
      creditedAt: new Date('2026-08-20'),
      lines: [],
    })),
  }

  const service = new RentNoticeCreditService(
    {
      rentNotice: { findFirst: jest.fn().mockResolvedValue(notice) },
      rentNoticeCreditLine: {
        findMany: jest.fn().mockResolvedValue(
          (over.kreditrader ?? []).map((r) => ({
            rentNoticeLineId: r.rentNoticeLineId,
            amount: D(r.amount),
          })),
        ),
      },
      rentNoticeEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    } as never,
    {} as never,
    {} as never,
  )
  return service
}

describe('#518 — posternas kumulativa tak', () => {
  it('KONTROLLFALL: utan tidigare kreditering är hela postbeloppet kvar', async () => {
    // Måste stå först: utan den kan varje mätning nedan vara grön för att
    // `remaining` alltid är noll.
    const p = await rigg().getPreview('avi-1', 'org-1')
    expect(p.buckets.map((b) => [b.description, b.invoiced, b.credited, b.remaining])).toEqual([
      ['Hyra 9/2026', 9_000, 0, 9_000],
      ['Ersättning förlorad nyckel', 1_250, 0, 1_250],
    ])
    expect(p.creditableNow).toBe(10_250)
  })

  it('taket krymper med vad som redan krediterats PÅ JUST DEN POSTEN', async () => {
    const p = await rigg({
      credits: [500],
      kreditrader: [{ rentNoticeLineId: 'rad-1', amount: 500 }],
    }).getPreview('avi-1', 'org-1')

    const nyckel = p.buckets.find((b) => b.rentNoticeLineId === 'rad-1')
    expect(nyckel).toMatchObject({ invoiced: 1_250, credited: 500, remaining: 750 })
    // Hyreskapitalet är OROT — krediteringen låg på den andra posten.
    expect(p.buckets.find((b) => b.rentNoticeLineId === null)).toMatchObject({
      credited: 0,
      remaining: 9_000,
    })
    expect(p.creditableNow).toBe(9_750)
  })

  it('krediteringarna följer med hela — belopp, skäl och datum, inte bara summan', async () => {
    // Utan skäl och datum kan avi-detaljen bara visa ATT skulden sjönk, inte varför.
    const p = await rigg({ credits: [500] }).getPreview('avi-1', 'org-1')
    expect(p.credits).toHaveLength(1)
    expect(p.credits[0]).toMatchObject({ amount: 500, reason: 'felaktig debitering' })
  })
})

describe('#518 — projektionen av en tänkt kreditering', () => {
  it('utan begärt belopp finns ingen projektion', async () => {
    // `null`, inte en nolla: en nolla hade renderats som ett svar.
    expect((await rigg().getPreview('avi-1', 'org-1')).projection).toBeNull()
  })

  it('KONTROLLFALL: delvis kreditering på en avi MED ränta stannar INTE avin', async () => {
    const p = await rigg({ interest: 218.5 }).getPreview('avi-1', 'org-1', 4_000)
    expect(p.projection).toMatchObject({
      applied: 4_000,
      ocrOutstanding: 6_250,
      interest: 218.5,
      interestOnlyAfterCredit: false,
    })
  })

  it('krediteras HELA det OCR-reglerbara beloppet med ränta kvar → avin stannar', async () => {
    const p = await rigg({ interest: 218.5 }).getPreview('avi-1', 'org-1', 10_250)
    expect(p.projection).toMatchObject({
      applied: 10_250,
      ocrOutstanding: 0,
      outstanding: 218.5,
      interest: 218.5,
      interestOnlyAfterCredit: true,
    })
  })

  it('utan ränta stannar avin inte, ens när allt krediteras', async () => {
    // Skillnaden mot fallet ovan är ENBART räntan. Utan det här paret kan
    // `interestOnlyAfterCredit: true` vara grön för att flaggan alltid sätts när
    // OCR-delen går till noll.
    const p = await rigg({ interest: 0 }).getPreview('avi-1', 'org-1', 10_250)
    expect(p.projection).toMatchObject({ ocrOutstanding: 0, interestOnlyAfterCredit: false })
  })

  it('ett belopp över taket KLAMPAS, och det klampade talet är det som redovisas', async () => {
    // Annars hade projektionen tyst gällt ett annat belopp än det som visas —
    // en frågesträng får inte kunna rendera ett utfall som ingen kreditering
    // skulle ge.
    const p = await rigg({ interest: 218.5 }).getPreview('avi-1', 'org-1', 99_999)
    expect(p.projection).toMatchObject({ requested: 99_999, applied: 10_250 })
  })
})
