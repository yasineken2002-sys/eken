/**
 * #367 — ett ANDRA annulleringsförsök ska avvisas.
 *
 * Statusclaimen i `cancelNotice` grindade på `status: { not: PAID }`. `CANCELLED`
 * är inte `PAID`, så claimen träffade sin egen redan annullerade rad, skrev om
 * samma statusvärde och returnerade `count: 1`. Anroparen fick ett normalt svar
 * i stället för ett fel, och statusmaskinen påstod därmed att
 * `CANCELLED → CANCELLED` är en giltig övergång. Det är den inte.
 *
 * VARFÖR DET INTE KOSTADE PENGAR I DAG — och varför det ändå stängs: alla fyra
 * reverseringsvägar är idempotenta på sina `sourceId`, så huvudboken blev
 * identisk efter två körningar (mätt i A+B:s bevisrigg). Skyddet låg alltså i
 * BOKFÖRINGSLAGRET, inte i statusmaskinen — en spärr som råkar hålla, inte en
 * som är beslutad. Nästa väg som läggs i `cancelNotice` behöver inte vara
 * idempotent, och då kostar hålet.
 *
 * AVGRÄNSNINGEN LÄSTES MOT ALLA SEX ENUM-VÄRDENA, inte bara mot de två i
 * förslaget (`RentNoticeStatus`: PENDING, SENT, PAID, OVERDUE, CANCELLED,
 * FAILED). Bara PAID och CANCELLED utesluts. **FAILED ska förbli annullerbar** —
 * en avi vars utskick misslyckats är precis en som operatören behöver kunna
 * avbryta, och att låsa den hade varit en ny defekt införd i en fix.
 *
 * INGEN ANROPARE BEROR PÅ TYST OMKÖRNING (kontrollerat, ärendet krävde det):
 * `cancelNotice` har en enda anropare — `DELETE /avisering/:id` i controllern,
 * driven av webbens `useCancelNotice`. Ingen cron, ingen Bull-retry, och
 * mutationen sätter ingen `retry`. Ett fel på andra försöket når alltså en
 * människa, inte en automatik som förlitar sig på tystnad.
 *
 * DISKRIMINERANDE UPPSÄTTNING: `probableLossAt` och `writtenOffAt` hålls null i
 * samtliga fall här, så nedskrivningsgrinden aldrig kan vara det som fäller —
 * den prövas i avisering.cancel-bad-debt-block.spec.ts. Faller ett test här är
 * det statusen som är orsaken.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { BadRequestException, ConflictException } from '@nestjs/common'

import { AviseringService } from './avisering.service'

const NOTICE_ID = 'rn-42'
const ORG_ID = 'org-1'

function makeService(
  opts: {
    status?: string
    claimCount?: number
    /** Raden som läses om EFTER en missad claim. */
    rowEfterClaim?: { status?: string; probableLossAt: Date | null; writtenOffAt: Date | null }
  } = {},
) {
  const notice = {
    id: NOTICE_ID,
    noticeNumber: 'A-2026-0042',
    status: opts.status ?? 'OVERDUE',
    collectionStage: 'NONE',
    paidAmount: null,
    type: 'RENT',
    totalAmount: 7355,
    // Nedskrivningen får ALDRIG vara det som fäller i den här filen.
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
        status: opts.rowEfterClaim?.status ?? 'OVERDUE',
        probableLossAt: opts.rowEfterClaim?.probableLossAt ?? null,
        writtenOffAt: opts.rowEfterClaim?.writtenOffAt ?? null,
        noticeNumber: notice.noticeNumber,
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
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
  }

  const service = Object.create(AviseringService.prototype) as AviseringService
  const anyService = service as unknown as Record<string, unknown>
  anyService['prisma'] = prisma
  anyService['accounting'] = {
    reverseJournalEntryForRentNotice: jest.fn().mockResolvedValue(undefined),
    reverseJournalEntryForDepositAccrual: jest.fn().mockResolvedValue(undefined),
    reverseJournalEntryForReminderFee: jest.fn().mockResolvedValue(undefined),
    reverseJournalEntryForInterest: jest.fn().mockResolvedValue(undefined),
  }
  anyService['logger'] = { error: jest.fn(), log: jest.fn(), warn: jest.fn() }

  return { service, prisma, tx, claimWhere }
}

/** Statusvillkoret ur claimens where-klausul, normaliserat till en lista. */
function uteslutnaStatusar(claimWhere: Array<Record<string, unknown>>): string[] {
  const w = claimWhere[0]
  const s = w?.['status'] as { not?: string; notIn?: string[] } | undefined
  if (s?.notIn) return [...s.notIn].sort()
  if (s?.not) return [s.not]
  return []
}

describe('#367 — andra annulleringsförsöket avvisas', () => {
  it('CLAIMEN utesluter både PAID och CANCELLED', async () => {
    const { service, claimWhere } = makeService()

    await service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')

    // Kärnan i ärendet: `{ not: PAID }` släpper igenom CANCELLED.
    expect(uteslutnaStatusar(claimWhere)).toEqual(['CANCELLED', 'PAID'])
  })

  it('en REDAN ANNULLERAD avi avvisas före transaktionen', async () => {
    const { service, prisma } = makeService({ status: 'CANCELLED' })

    await expect(service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')).rejects.toBeInstanceOf(
      BadRequestException,
    )
    // Ingen transaktion öppnas för en händelse som inte ska inträffa.
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('beskedet säger ATT den är annullerad — inte "redan reglerad"', async () => {
    const { service } = makeService({ status: 'CANCELLED' })

    await expect(service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')).rejects.toThrow(/annullerad/i)
    await expect(service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')).rejects.not.toThrow(
      /redan reglerad/i,
    )
  })

  it('TOCTOU: förlorar claimen mot en parallell annullering ges samma besked', async () => {
    const { service } = makeService({
      claimCount: 0,
      rowEfterClaim: { status: 'CANCELLED', probableLossAt: null, writtenOffAt: null },
    })

    const fel = await service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1').catch((e: Error) => e)
    expect(fel).toBeInstanceOf(ConflictException)
    expect((fel as Error).message).toMatch(/annullerad/i)
  })

  it('AVGRÄNSNING: en FAILED avi går fortfarande att annullera', async () => {
    const { service, prisma } = makeService({ status: 'FAILED' })

    await expect(service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')).resolves.toBeDefined()
    expect(prisma.$transaction).toHaveBeenCalled()
  })

  it('OFÖRÄNDRAT: PENDING, SENT och OVERDUE annulleras som förut', async () => {
    for (const status of ['PENDING', 'SENT', 'OVERDUE']) {
      const { service, prisma } = makeService({ status })
      await expect(service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')).resolves.toBeDefined()
      expect(prisma.$transaction).toHaveBeenCalled()
    }
  })
})
