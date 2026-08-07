/**
 * F + E (avi-sidan) — debiteringarna LOSSAS, bokföringen rörs aldrig.
 *
 * Här vänder principen mot resten av annulleringen, och det är avsiktligt.
 * Förbruknings- och övrigdebiteringen är bokförd på EGEN grund vid CONFIRM
 * (`consumption-charge:<id>` / `misc-charge:<id>`), oberoende av vilket dokument
 * som presenterar den. Elen levererades; skadan skedde. Att reversera vore att
 * påstå motsatsen.
 *
 * DET SOM MÅSTE BEVAKAS ÄR ATT LOSSNINGEN FAKTISKT FUNGERAR, inte att ett
 * statusfält blev CONFIRMED. `RentNoticeLine.consumptionChargeId` och
 * `.miscChargeId` är båda `@unique` — lämnas raden kvar kan chargen aldrig läggas
 * på en ny avi, och statusen hade ljugit om att den var ledig. Därför asserterar
 * testerna på RADBORTTAGNINGEN lika hårt som på statusbytet.
 *
 * Att bokföringen inte rörs bevisas negativt här (inga accounting-anrop för
 * charges) och positivt i bevisriggen, där hela huvudboken jämförs före/efter.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { AviseringService } from './avisering.service'

const NOTICE_ID = 'rn-11'
const ORG_ID = 'org-1'
const CONSUMPTION_ID = 'cc-el-1'
const MISC_ID = 'mc-skada-1'

function makeService(
  opts: {
    lines?: Array<{
      id: string
      consumptionChargeId: string | null
      miscChargeId: string | null
    }>
  } = {},
) {
  const lines = opts.lines ?? [
    { id: 'line-el', consumptionChargeId: CONSUMPTION_ID, miscChargeId: null },
    { id: 'line-skada', consumptionChargeId: null, miscChargeId: MISC_ID },
  ]

  const noticeUpdateMany = jest.fn().mockResolvedValue({ count: 1 })
  const lineDeleteMany = jest.fn().mockResolvedValue({ count: lines.length })
  const consumptionUpdateMany = jest.fn().mockResolvedValue({ count: 1 })
  const miscUpdateMany = jest.fn().mockResolvedValue({ count: 1 })

  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    rentNotice: { updateMany: noticeUpdateMany, findFirst: jest.fn().mockResolvedValue(null) },
    rentNoticeLine: {
      findMany: jest.fn().mockResolvedValue(lines),
      deleteMany: lineDeleteMany,
    },
    consumptionCharge: { updateMany: consumptionUpdateMany },
    miscCharge: { updateMany: miscUpdateMany },
    deposit: { findFirst: jest.fn().mockResolvedValue(null) },
  }

  const prisma = {
    rentNotice: {
      findFirst: jest.fn().mockResolvedValue({
        id: NOTICE_ID,
        noticeNumber: 'A-2026-0011',
        status: 'OVERDUE',
        collectionStage: 'NONE',
        paidAmount: null,
        type: 'RENT',
        probableLossAt: null,
        writtenOffAt: null,
      }),
    },
    rentNoticeEvent: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
  }

  const accounting = {
    reverseJournalEntryForRentNotice: jest.fn().mockResolvedValue(undefined),
    reverseJournalEntryForReminderFee: jest.fn().mockResolvedValue(undefined),
    reverseJournalEntryForInterest: jest.fn().mockResolvedValue(undefined),
    reverseJournalEntryForDepositAccrual: jest.fn().mockResolvedValue(undefined),
  }

  const service = Object.create(AviseringService.prototype) as AviseringService
  const anyService = service as unknown as Record<string, unknown>
  anyService['prisma'] = prisma
  anyService['accounting'] = accounting
  anyService['logger'] = { error: jest.fn(), log: jest.fn(), warn: jest.fn() }

  return {
    service,
    tx,
    accounting,
    noticeUpdateMany,
    lineDeleteMany,
    consumptionUpdateMany,
    miscUpdateMany,
  }
}

describe('F+E (avi) — charges lossas vid annullering', () => {
  it('BÅDA laddningstyperna lossas: förbrukning och övrig debitering', async () => {
    const { service, consumptionUpdateMany, miscUpdateMany } = makeService()

    await service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')

    expect(consumptionUpdateMany).toHaveBeenCalledTimes(1)
    expect(miscUpdateMany).toHaveBeenCalledTimes(1)

    const cc = consumptionUpdateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>
      data: Record<string, unknown>
    }
    expect(cc.where).toMatchObject({
      id: { in: [CONSUMPTION_ID] },
      organizationId: ORG_ID,
      // Villkorat: en charge som hunnit bli CANCELLED får inte återuppstå.
      status: 'ATTACHED',
    })
    expect(cc.data).toEqual({ status: 'CONFIRMED' })

    const mc = miscUpdateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>
      data: Record<string, unknown>
    }
    expect(mc.where).toMatchObject({ id: { in: [MISC_ID] }, status: 'ATTACHED' })
    expect(mc.data).toEqual({ status: 'CONFIRMED' })
  })

  it('RADEN TAS BORT — annars blockerar @unique en ny påläggning', async () => {
    // Det här är skillnaden mellan en lossning och ett statusbyte i limbo.
    const { service, lineDeleteMany } = makeService()

    await service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')

    expect(lineDeleteMany).toHaveBeenCalledTimes(1)
    const del = lineDeleteMany.mock.calls[0]![0] as { where: { id: { in: string[] } } }
    expect(del.where.id.in).toEqual(['line-el', 'line-skada'])
  })

  it('beloppsfälten nollas — avin får inte påstå komponenter utan rader', async () => {
    const { service, noticeUpdateMany } = makeService()

    await service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')

    const nollning = noticeUpdateMany.mock.calls.find((c) => {
      const arg = c[0] as { data?: Record<string, unknown> }
      return arg.data && 'consumptionAmount' in arg.data
    })
    expect(nollning).toBeDefined()
    expect((nollning![0] as { data: Record<string, unknown> }).data).toEqual({
      consumptionAmount: 0,
      miscChargeAmount: 0,
    })
  })

  it('BOKFÖRINGEN RÖRS INTE: ingen reversering av charge-verifikaten', async () => {
    // Reverseringarna som körs är kapital, avgift och ränta — de tre som hör till
    // dokumentet. Charges har inga reverseringsvägar alls i annulleringen, och
    // ska inte ha det: deras grund består.
    const { service, accounting } = makeService()

    await service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')

    expect(accounting).not.toHaveProperty('reverseJournalEntryForMiscCharge')
    expect(accounting).not.toHaveProperty('reverseJournalEntryForConsumptionCharge')
    // De tre dokumentreverseringarna körs som förut.
    expect(accounting.reverseJournalEntryForRentNotice).toHaveBeenCalledTimes(1)
    expect(accounting.reverseJournalEntryForReminderFee).toHaveBeenCalledTimes(1)
    expect(accounting.reverseJournalEntryForInterest).toHaveBeenCalledTimes(1)
  })

  it('BARA förbrukning på avin → miscCharge rörs inte', async () => {
    const { service, consumptionUpdateMany, miscUpdateMany } = makeService({
      lines: [{ id: 'line-el', consumptionChargeId: CONSUMPTION_ID, miscChargeId: null }],
    })

    await service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')

    expect(consumptionUpdateMany).toHaveBeenCalledTimes(1)
    expect(miscUpdateMany).not.toHaveBeenCalled()
  })

  it('INGA charge-rader → ingen radering, ingen nollning', async () => {
    const { service, lineDeleteMany, consumptionUpdateMany, miscUpdateMany, noticeUpdateMany } =
      makeService({ lines: [] })

    await service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')

    expect(lineDeleteMany).not.toHaveBeenCalled()
    expect(consumptionUpdateMany).not.toHaveBeenCalled()
    expect(miscUpdateMany).not.toHaveBeenCalled()
    const nollning = noticeUpdateMany.mock.calls.find((c) => {
      const arg = c[0] as { data?: Record<string, unknown> }
      return arg.data && 'consumptionAmount' in arg.data
    })
    expect(nollning).toBeUndefined()
  })

  it('ATOMISKT: lossningen sker på transaktionsklienten, inte bredvid den', async () => {
    // Attrappens tx är ETT EGET objekt, skilt från prisma (läxan från #288).
    // Går uppslaget och skrivningarna via tx rullas lossningen tillbaka om
    // annulleringen faller — ingen charge frigörs för ett dokument som lever kvar.
    const { service, tx } = makeService()

    await service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')

    expect(tx.rentNoticeLine.findMany).toHaveBeenCalledTimes(1)
    expect(tx.rentNoticeLine.deleteMany).toHaveBeenCalledTimes(1)
    expect(tx.consumptionCharge.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.miscCharge.updateMany).toHaveBeenCalledTimes(1)
  })
})
