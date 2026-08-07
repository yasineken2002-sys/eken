/**
 * C — en NEDSKRIVEN fordran kan inte annulleras under sig själv.
 *
 * VARFÖR DEN HÄR FILEN FINNS. `reverseJournalEntryForRentNotice` speglar
 * originalposten ovillkorligt: den krediterar 1510 med hela kapitalbeloppet utan
 * att fråga om fordran hunnit skrivas ned. Har `reclassifyToProbableLoss` redan
 * bokfört 1515 D / 1510 K på HELA kravet är 1510 tömd, och annulleringen
 * krediterar den en andra gång → negativt kundfordringssaldo, med 1515 kvar som
 * en öppen nedskrivning av en fordran som formellt inte finns.
 *
 * VAD SOM GÅR ATT BEVAKA HÄR — OCH VAD SOM INTE GÖR DET. Attrapper kan visa att
 * grinden läser rätt fält, att den fäller före transaktionen öppnas, och att
 * claimen bär villkoret. De kan INTE visa kontosaldot som blir fel utan grinden;
 * det är kontosaldon i en riktig huvudbok, och det bevisas i bevisriggen mot
 * riktig Postgres (negativkontroll: 1510 går negativt med exakt kapitalbeloppet).
 * Ett grönt utfall här är alltså inte beviset — det är bevakningen av beviset.
 *
 * DISKRIMINERANDE UPPSÄTTNING: `probableLossAt` och `writtenOffAt` sätts var för
 * sig i skilda fall, och statusen hålls OVERDUE i samtliga. Vore statusen den
 * grind som fällde hade testerna inte kunnat se skillnad på "grindar på
 * nedskrivningen" och "grindar på status" — och just den förväxlingen är felet
 * som ligger närmast till hands: `WRITTEN_OFF` är ett `RentCollectionStage`,
 * inte en `RentNoticeStatus`, så en avskriven avi STÅR KVAR som OVERDUE.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { BadRequestException, ConflictException } from '@nestjs/common'

import { AviseringService } from './avisering.service'

const NOTICE_ID = 'rn-42'
const ORG_ID = 'org-1'

function makeService(
  opts: {
    probableLossAt?: Date | null
    writtenOffAt?: Date | null
    /** Rad som claimen ser i DB — används för TOCTOU-fallet (count === 0). */
    claimCount?: number
    rowEfterClaim?: { probableLossAt: Date | null; writtenOffAt: Date | null } | null
  } = {},
) {
  const notice = {
    id: NOTICE_ID,
    noticeNumber: 'A-2026-0042',
    // OVERDUE i ALLA fall: statusen får aldrig vara det som fäller.
    status: 'OVERDUE',
    collectionStage: 'INKASSO_READY',
    paidAmount: null,
    type: 'RENT',
    totalAmount: 7355,
    probableLossAt: opts.probableLossAt ?? null,
    writtenOffAt: opts.writtenOffAt ?? null,
  }

  const claimWhere: Array<Record<string, unknown>> = []

  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    rentNotice: {
      updateMany: jest.fn((args: { where: Record<string, unknown> }) => {
        claimWhere.push(args.where)
        return Promise.resolve({ count: opts.claimCount ?? 1 })
      }),
      findFirst: jest
        .fn()
        .mockResolvedValue(
          opts.rowEfterClaim === undefined
            ? { probableLossAt: null, writtenOffAt: null, noticeNumber: notice.noticeNumber }
            : opts.rowEfterClaim === null
              ? null
              : { ...opts.rowEfterClaim, noticeNumber: notice.noticeNumber },
        ),
    },
    deposit: { findFirst: jest.fn().mockResolvedValue(null) },
  }

  const prisma = {
    rentNotice: { findFirst: jest.fn().mockResolvedValue(notice) },
    rentNoticeEvent: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
  }

  const reverseJournalEntryForRentNotice = jest.fn().mockResolvedValue(undefined)
  const reverseJournalEntryForDepositAccrual = jest.fn().mockResolvedValue(undefined)

  const service = Object.create(AviseringService.prototype) as AviseringService
  const anyService = service as unknown as Record<string, unknown>
  anyService['prisma'] = prisma
  anyService['accounting'] = {
    reverseJournalEntryForRentNotice,
    reverseJournalEntryForDepositAccrual,
    // A+B: avgiftens och räntans motverifikat. Stubbade här — deras
    // beteende bevisas i accounting.fee-interest-reversal.spec.ts och i
    // bevisriggen, inte av att den här attrappen råkar finnas.
    reverseJournalEntryForReminderFee: jest.fn().mockResolvedValue(undefined),
    reverseJournalEntryForInterest: jest.fn().mockResolvedValue(undefined),
  }
  anyService['logger'] = { error: jest.fn(), log: jest.fn(), warn: jest.fn() }

  return { service, prisma, tx, claimWhere, reverseJournalEntryForRentNotice }
}

describe('C — nedskriven fordran kan inte annulleras', () => {
  it('BEFARAD förlust (probableLossAt satt) blockerar annulleringen', async () => {
    const { service, prisma, reverseJournalEntryForRentNotice } = makeService({
      probableLossAt: new Date('2026-08-01'),
    })

    await expect(service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')).rejects.toBeInstanceOf(
      BadRequestException,
    )

    // Grinden fäller FÖRE transaktionen öppnas — ingen reversering, ingen statusflipp.
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(reverseJournalEntryForRentNotice).not.toHaveBeenCalled()
  })

  it('KONSTATERAD förlust (writtenOffAt satt, probableLossAt null) blockerar också', async () => {
    // Fail-closed. `confirmLoss` förutsätter i dag en föregående nedskrivning, så
    // kombinationen ska inte kunna uppstå — men grinden får inte vila på det.
    const { service, prisma } = makeService({ writtenOffAt: new Date('2026-08-05') })

    await expect(service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')).rejects.toBeInstanceOf(
      BadRequestException,
    )
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('felmeddelandet namnger avin och pekar på kundförlust-flödet', async () => {
    const { service } = makeService({ probableLossAt: new Date('2026-08-01') })

    await expect(service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')).rejects.toThrow(
      /A-2026-0042.*kundförlust/s,
    )
  })

  it('OFÖRÄNDRAT: en avi UTAN nedskrivning annulleras som förut', async () => {
    // Negativ kontroll i sviten: fäller grinden allt är den värdelös. Statusen är
    // OVERDUE och kravsteget INKASSO_READY även här — det är enbart avsaknaden av
    // probableLossAt/writtenOffAt som skiljer det här fallet från de två ovan.
    const { service, prisma, reverseJournalEntryForRentNotice } = makeService()

    await service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(reverseJournalEntryForRentNotice).toHaveBeenCalledTimes(1)
  })

  it('TOCTOU: claimen bär nedskrivningsvillkoret, inte bara förläsningen', async () => {
    // Förläsningen sker utanför transaktionen och kan hinna bli inaktuell (#302).
    // Utan villkoret i claimen kan en nedskrivning som committar mitt i vår
    // transaktion släppas förbi.
    const { service, claimWhere } = makeService()

    await service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')

    expect(claimWhere).toHaveLength(1)
    expect(claimWhere[0]).toMatchObject({ probableLossAt: null, writtenOffAt: null })
  })

  it('förlorar claimen mot en nedskrivning ges rätt besked, inte "redan reglerad"', async () => {
    // Ett felaktigt besked skickar operatören att leta efter en betalning som
    // inte finns, medan fordran i själva verket har skrivits ned.
    const { service } = makeService({
      claimCount: 0,
      rowEfterClaim: { probableLossAt: new Date('2026-08-06'), writtenOffAt: null },
    })

    const felet = await service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1').catch((e: unknown) => e)

    expect(felet).toBeInstanceOf(ConflictException)
    expect(String(felet)).toMatch(/kundförlust/)
    expect(String(felet)).not.toMatch(/redan reglerad/)
  })

  it('förlorar claimen av ANNAT skäl behålls det gamla beskedet', async () => {
    const { service } = makeService({ claimCount: 0 })

    const felet = await service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1').catch((e: unknown) => e)

    expect(felet).toBeInstanceOf(ConflictException)
    expect(String(felet)).toMatch(/redan reglerad/)
  })
})
