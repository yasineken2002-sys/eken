/**
 * #518 — EN KREDITERAD AVI KAN INTE ANNULLERAS UNDER SIG SJÄLV.
 *
 * SYSKON TILL `avisering.cancel-bad-debt-block.spec.ts`, och samma penningfel i
 * en annan namnrymd. `reverseJournalEntryForRentNotice` speglar originalposten
 * (`rent-notice:<id>`) OVILLKORLIGT och vet ingenting om krediteringens
 * verifikat, som ligger under `rent-notice-credit:<id>`. En annullering ovanpå
 * en delkreditering reverserar därför det redan krediterade beloppet en ANDRA
 * gång:
 *
 *   avisering           1510 D 10 000  /  39xx K 10 000
 *   kreditering  3 000    39xx D  3 000  /  1510 K  3 000
 *   annullering           39xx D 10 000  /  1510 K 10 000
 *   → 1510 = −3 000, 39xx = −3 000
 *
 * SYMMETRIN ÄR POÄNGEN. `assessRentNoticeCreditability` spärrar att KREDITERA en
 * annullerad avi. Utan spärren den här filen bevakar var bara den ena
 * riktningen stängd — exakt den asymmetri som hittades på fakturasidan i #517,
 * och som en maskinell bokföringsgranskning hittade här också.
 *
 * VAD SOM GÅR ATT BEVAKA HÄR — OCH VAD SOM INTE GÖR DET. Attrapper kan visa att
 * grinden läser krediteringen, att den fäller INNAN reverseringen körs, och att
 * claimen bär villkoret. De kan INTE visa kontosaldot som blir fel utan grinden
 * — det är saldon i en riktig huvudbok. Ett grönt utfall här är alltså inte
 * beviset, utan bevakningen av beviset.
 *
 * DISKRIMINERANDE: statusen hålls OVERDUE och `probableLossAt`/`writtenOffAt`
 * null i SAMTLIGA fall. Vore någon av de befintliga grindarna det som fällde
 * hade testerna inte kunnat se skillnad på "grindar på krediteringen" och
 * "grindar på något annat".
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { BadRequestException } from '@nestjs/common'

import { AviseringService } from './avisering.service'

const NOTICE_ID = 'rn-518'
const ORG_ID = 'org-1'

function makeService(opts: { krediterad?: boolean; claimCount?: number } = {}) {
  const notice = {
    id: NOTICE_ID,
    noticeNumber: 'AVI-2026-08-0042',
    // OVERDUE i ALLA fall — statusen får aldrig vara det som fäller.
    status: 'OVERDUE',
    collectionStage: 'NONE',
    paidAmount: null,
    type: 'RENT',
    // Inga andra grindar aktiva.
    probableLossAt: null,
    writtenOffAt: null,
  }

  const claimWhere: Array<Record<string, unknown>> = []
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    rentNotice: {
      updateMany: jest.fn((args: { where: Record<string, unknown> }) => {
        claimWhere.push(args.where)
        return Promise.resolve({ count: opts.claimCount ?? 1 })
      }),
      findFirst: jest.fn().mockResolvedValue({
        status: 'OVERDUE',
        probableLossAt: null,
        writtenOffAt: null,
        noticeNumber: notice.noticeNumber,
        // TOCTOU-fallet: krediteringen hann skrivas efter förläsningen.
        credits: opts.claimCount === 0 ? [{ id: 'kred-1' }] : [],
      }),
    },
    deposit: { findFirst: jest.fn().mockResolvedValue(null) },
    rentNoticeLine: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    consumptionCharge: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    miscCharge: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  }

  const prisma = {
    rentNotice: { findFirst: jest.fn().mockResolvedValue(notice) },
    rentNoticeEvent: { create: jest.fn().mockResolvedValue({}) },
    rentNoticeCredit: {
      findFirst: jest.fn().mockResolvedValue(opts.krediterad ? { id: 'kred-1' } : null),
    },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
  }

  const reverseJournalEntryForRentNotice = jest.fn().mockResolvedValue(undefined)

  const service = Object.create(AviseringService.prototype) as AviseringService
  const anyService = service as unknown as Record<string, unknown>
  anyService['prisma'] = prisma
  anyService['accounting'] = {
    reverseJournalEntryForRentNotice,
    reverseJournalEntryForDepositAccrual: jest.fn().mockResolvedValue(undefined),
    reverseJournalEntryForReminderFee: jest.fn().mockResolvedValue(undefined),
    reverseJournalEntryForInterest: jest.fn().mockResolvedValue(undefined),
  }
  anyService['logger'] = { error: jest.fn(), log: jest.fn(), warn: jest.fn() }

  return { service, prisma, tx, claimWhere, reverseJournalEntryForRentNotice }
}

describe('#518 — en krediterad avi kan inte annulleras', () => {
  it('en befintlig kreditering blockerar annulleringen', async () => {
    const { service } = makeService({ krediterad: true })
    await expect(service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })

  it('REVERSERINGEN KÖRS ALDRIG — det är den som gör felet', async () => {
    // Det avgörande. Att ett fel kastas räcker inte: hade reverseringen redan
    // hunnit köra vore huvudboken fel oavsett vad anroparen får för svar.
    const { service, reverseJournalEntryForRentNotice, tx } = makeService({ krediterad: true })
    await expect(service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')).rejects.toThrow()
    expect(reverseJournalEntryForRentNotice).not.toHaveBeenCalled()
    // Och transaktionen öppnas inte ens — grinden ligger före den.
    expect(tx.rentNotice.updateMany).not.toHaveBeenCalled()
  })

  it('beskedet säger VAD operatören ska göra i stället', async () => {
    const { service } = makeService({ krediterad: true })
    await expect(service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')).rejects.toThrow(
      /redan krediterats/,
    )
    await expect(service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')).rejects.toThrow(
      /Kreditera återstoden/,
    )
  })

  it('KONTROLLFALL: en OKREDITERAD avi annulleras som förut', async () => {
    // Utan den här raden mäter testerna ovan att en spärr finns, inte att den
    // är rätt kalibrerad — en grind som fällde ALLT hade varit lika grön.
    const { service, reverseJournalEntryForRentNotice } = makeService({ krediterad: false })
    await service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')
    expect(reverseJournalEntryForRentNotice).toHaveBeenCalledTimes(1)
  })

  it('TOCTOU: villkoret ligger ÄVEN i claimen, inte bara i förläsningen', async () => {
    // Förläsningen sker utanför transaktionen. En kreditering som skrivs mellan
    // läsningen och låset skulle annars glida förbi:
    //   T1 läser — inga krediteringar, släpps igenom
    //   T2 skriver krediteringen och committar
    //   T1 annullerar ändå → 1510 krediteras en andra gång
    const { service, claimWhere } = makeService({ krediterad: false })
    await service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')
    expect(claimWhere).toHaveLength(1)
    expect(claimWhere[0]).toMatchObject({ credits: { none: {} } })
  })

  it('förlorar claimen mot en kreditering ges RÄTT besked, inte "redan reglerad"', async () => {
    // Att svara fel om VAD som hänt är sitt eget fel: operatören letar då på
    // fel ställe. Samma krav som #367 ställde på annulleringsbeskedet.
    const { service } = makeService({ krediterad: false, claimCount: 0 })
    await expect(service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')).rejects.toThrow(
      /redan krediterats/,
    )
  })
})
