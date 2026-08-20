/**
 * #326 C — behandlingshistorik vid avmatchning på AVI-sidan.
 *
 * `unmatchTransaction` raderade `RentNoticePayment` utan att lämna något spår.
 * Motverifikatet räcker inte: en vänd debet/kredit ser likadan ut oavsett om
 * betalningen var felallokerad, återbetald eller registrerad på fel avi — och
 * `logger.log` är inte räkenskapsinformation. Kombinationen delete + noll
 * händelselogg bryter BFL 5 kap 11 §.
 *
 * Fakturasidan fick sin `PAYMENT_REVERSED` i #326 B. Den här sviten hävdar att
 * avi-sidan nu har sin spegling, med samma fyra fält, och att AI-verktygets
 * `reason` — som efterfrågades av användaren och sedan kastades bort — bevaras.
 */

jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Decimal } from '@prisma/client/runtime/library'
import { ReconciliationService } from './reconciliation.service'
import { RentNoticeEventsService } from '../avisering/rent-notice-events.service'

const TX_ID = 'tx-avi'

const NOTICE_ALLOCATION = {
  id: 'rnp-1',
  rentNoticeId: 'rn-1',
  amount: new Decimal(4250),
  paidAt: new Date('2026-07-20T00:00:00.000Z'),
  source: 'BANK_RECONCILIATION',
}

/** Attrapp-Prisma som loggar ORDNINGEN på skrivningarna. */
function makeService(
  opts: { allocation?: unknown; reverseThrows?: boolean; noMirror?: boolean } = {},
) {
  const order: string[] = []
  const tx = {
    // #518 — krediteringarna läses på samma vägar som allokeringarna.
    rentNoticeCredit: { findMany: jest.fn().mockResolvedValue([]) },
    rentNoticePayment: {
      deleteMany: jest.fn(() => {
        order.push('delete:rentNoticePayment')
        return Promise.resolve({ count: 1 })
      }),
      // H3 PR A: avmatchningen läser de BORTTAGNA allokeringarna med findMany
      // (var findFirst — bankTransactionId var @unique). Samma metod används för
      // de KVARVARANDE i paidAmount-omräkningen, så riggen måste skilja på
      // frågorna via where-satsen.
      findMany: jest.fn((args: { where?: Record<string, unknown> }) => {
        if (args?.where && 'bankTransactionId' in args.where) {
          const a = opts.allocation === undefined ? NOTICE_ALLOCATION : opts.allocation
          // Accepterar både EN allokering (dagens fall) och FLERA (vattenfallet).
          return Promise.resolve(Array.isArray(a) ? a : a ? [a] : [])
        }
        return Promise.resolve([])
      }),
    },
    rentNoticeEvent: {
      create: jest.fn((args: unknown) => {
        order.push('write:rentNoticeEvent')
        return Promise.resolve(args)
      }),
    },
    rentNotice: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue({
        type: 'RENT',
        status: 'PAID',
        totalAmount: new Decimal(9000),
        consumptionAmount: new Decimal(0),
        miscChargeAmount: new Decimal(0),
        reminderFeeAmount: new Decimal(0),
        interestAccruedAmount: new Decimal(0),
        credits: [],
      }),
    },
    bankTransaction: {
      updateMany: jest.fn(() => {
        order.push('write:bankTransaction')
        return Promise.resolve({ count: 1 })
      }),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
    invoice: { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn() },
    invoicePayment: {
      findFirst: jest.fn().mockResolvedValue(null),
      deleteMany: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    invoiceEvent: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn() },
    // Aktörsuppslaget för denormaliseringen. Att det ligger på `tx` och inte på
    // poolen är #288:s läxa: en pooled läsning under ett pågående radlås
    // ockuperar en andra anslutning.
    user: { findUnique: jest.fn().mockResolvedValue({ firstName: 'Anna', lastName: 'Ek' }) },
  }
  const prisma = {
    bankTransaction: {
      findFirst: jest.fn().mockResolvedValue({
        id: TX_ID,
        status: 'MATCHED',
        invoice: null,
        matchedRentNotice: opts.noMirror ? null : { id: 'rn-1', status: 'PAID' },
      }),
      updateMany: tx.bankTransaction.updateMany,
    },
    rentNotice: { updateMany: tx.rentNotice.updateMany },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
  }
  const reverseJournalEntryForPayment = jest.fn(
    opts.reverseThrows
      ? () => Promise.reject(new Error('Kontoplan saknas'))
      : () => {
          order.push('reverse:journalEntry')
          return Promise.resolve()
        },
  )
  const service = new ReconciliationService(
    prisma as never,
    {} as never,
    {} as never,
    { reverseJournalEntryForPayment } as never,
    {} as never,
    // SKARP tjänst, inte en attrapp: det som ska bevisas är att aktörsetiketten
    // FAKTISKT denormaliseras, och en attrapp av `record` hade bevisat att
    // attrappen anropades.
    new RentNoticeEventsService(prisma as never) as never,
  )
  return { service, tx, order }
}

function eventData(tx: ReturnType<typeof makeService>['tx']) {
  return (tx.rentNoticeEvent.create.mock.calls[0]![0] as { data: Record<string, unknown> }).data
}

describe('#326 C — händelsen skrivs med alla fyra fälten', () => {
  it('BELOPP och TRANSAKTION i payload, AKTÖR och TIDPUNKT i kolumnerna', async () => {
    const { service, tx } = makeService()

    await service.unmatchTransaction(TX_ID, 'org-1', 'user-1')

    const data = eventData(tx)
    expect(data.type).toBe('PAYMENT_REVERSED')
    expect(data.rentNoticeId).toBe('rn-1')
    // AKTÖR — kolumnerna
    expect(data.actorType).toBe('USER')
    expect(data.actorId).toBe('user-1')

    const payload = data.payload as Record<string, unknown>
    expect(payload.amount).toBe(4250) // BELOPP
    expect(payload.transactionId).toBe(TX_ID) // TRANSAKTION
    expect(payload.paidAt).toBe('2026-07-20T00:00:00.000Z') // betalningens TIDPUNKT
    expect(payload.allocationSource).toBe('BANK_RECONCILIATION')
    expect(payload.source).toBe('bank_reconciliation_unmatch')
    // (Rättelsens egen tidpunkt är RentNoticeEvent.createdAt — DB-default.)
  })

  it('AKTÖRSETIKETTEN denormaliseras för en användare — namnet överlever att kontot raderas', async () => {
    // `users.service.ts` gör en RIKTIG delete, ingen soft-delete. Utan
    // denormaliseringen står bara ett UUID kvar i historiken den dag användaren
    // tas bort. Fakturasidan har gjort detta hela tiden; avi-sidan gjorde det
    // inte förrän den här posten gick genom RentNoticeEventsService.
    // (FAR-granskningens villkor för #326 C.)
    const { service, tx } = makeService()

    await service.unmatchTransaction(TX_ID, 'org-1', 'user-1')

    expect(eventData(tx).actorLabel).toBe('Anna Ek')
  })

  it('aktörsuppslaget går via transaktionsklienten, inte via poolen (#288)', async () => {
    const { service, tx } = makeService()
    await service.unmatchTransaction(TX_ID, 'org-1', 'user-1')
    expect(tx.user.findUnique).toHaveBeenCalledTimes(1)
  })

  it('systemkörning märks som SYSTEM med etikett, inte som en anonym användare', async () => {
    const { service, tx } = makeService()

    await service.unmatchTransaction(TX_ID, 'org-1', null)

    const data = eventData(tx)
    expect(data.actorType).toBe('SYSTEM')
    expect(data.actorLabel).toBe('System')
    expect(data.actorId).toBeUndefined()
  })

  it('typen är egen, INTE NOTE_ADDED — en post som bara går att hitta genom att läsa JSON är svår att granska', async () => {
    // `RentNoticeEvent` har @@index([rentNoticeId, type]). En förstklassig typ
    // går att fråga via indexet; en payload-diskriminerad NOTE_ADDED gör
    // avmatchningar oskiljbara från anteckningar.
    const { service, tx } = makeService()
    await service.unmatchTransaction(TX_ID, 'org-1', 'user-1')
    expect(eventData(tx).type).not.toBe('NOTE_ADDED')
  })
})

describe('#326 C — AI-verktygets reason bevaras', () => {
  it('skälet skrivs in i händelsen i stället för att bara ekas tillbaka', async () => {
    const { service, tx } = makeService()

    await service.unmatchTransaction(TX_ID, 'org-1', 'user-1', 'Betalningen hörde till fel avi')

    expect((eventData(tx).payload as Record<string, unknown>).reason).toBe(
      'Betalningen hörde till fel avi',
    )
  })

  it('utan skäl skrivs INGET reason-fält — ingen påhittad text', async () => {
    const { service, tx } = makeService()

    await service.unmatchTransaction(TX_ID, 'org-1', 'user-1')

    expect((eventData(tx).payload as Record<string, unknown>).reason).toBeUndefined()
  })
})

describe('#326 C — samma transaktion som raderingen', () => {
  it('SEKVENS: radera allokering → skriv händelse → bank-länk → motverifikat', async () => {
    const { service, order } = makeService()

    await service.unmatchTransaction(TX_ID, 'org-1', 'user-1')

    expect(order).toEqual([
      'delete:rentNoticePayment',
      'write:rentNoticeEvent',
      'write:bankTransaction',
      'reverse:journalEntry',
    ])
  })

  it('en FALLERAD avmatchning skriver ingen händelse — attrappens tx propagerar felet som en rollback', async () => {
    // Motverifikatet fallerar. I en riktig databas rullas hela transaktionen
    // tillbaka; här hävdas att felet propagerar, och riggen bevisar att
    // händelsen faktiskt uteblir i DB:n.
    const { service } = makeService({ reverseThrows: true })

    await expect(service.unmatchTransaction(TX_ID, 'org-1', 'user-1')).rejects.toThrow(
      'Kontoplan saknas',
    )
  })
})

describe('#326 C — avgränsning', () => {
  it('ingen avi-allokering → ingen händelse (det finns inget att dokumentera)', async () => {
    const { service, tx } = makeService({ allocation: null })

    await service.unmatchTransaction(TX_ID, 'org-1', 'user-1')

    expect(tx.rentNoticeEvent.create).not.toHaveBeenCalled()
    // …men avmatchningen i övrigt körs som förut.
    expect(tx.bankTransaction.updateMany).toHaveBeenCalledTimes(1)
  })

  it('FAIL-CLOSED: allokering och spegel-fält pekar på OLIKA avier → kastar, ingen post', async () => {
    // Spåret får inte hamna på EN avi medan paidAmount/status räknas om på en
    // ANNAN. Samma kontroll som fakturagrenen redan har. DISKRIMINERANDE:
    // attrappens spegel säger 'rn-1', allokeringen 'rn-drift'.
    const { service, tx } = makeService({
      allocation: { ...NOTICE_ALLOCATION, rentNoticeId: 'rn-drift' },
    })

    await expect(service.unmatchTransaction(TX_ID, 'org-1', 'user-1')).rejects.toThrow(
      /pekar på en annan hyresavi/,
    )
    expect(tx.rentNoticeEvent.create).not.toHaveBeenCalled()
  })

  it('utan spegel-fält följer posten ALLOKERINGENS rentNoticeId — spåret följer raden som togs bort', async () => {
    // `matchedRentNoticeId` är härlett. Saknas det men allokeringen finns ska
    // posten ändå skrivas, nycklad på allokeringens egen avi.
    const { service, tx } = makeService({
      allocation: { ...NOTICE_ALLOCATION, rentNoticeId: 'rn-fran-allokeringen' },
      noMirror: true,
    })

    await service.unmatchTransaction(TX_ID, 'org-1', 'user-1')

    expect(eventData(tx).rentNoticeId).toBe('rn-fran-allokeringen')
  })
})

// ── H3 PR A: EN händelse per borttagen allokering ────────────────────────────
//
// Avmatchningen läste tidigare EN allokering (`findFirst`, bankTransactionId var
// @unique) och skrev EN händelse — men `deleteMany` raderade alla. Med
// vattenfallet (PR B) kan flera allokeringar höra till samma banktransaktion, och
// då måste varje raderad allokering få sin egen post: en samlad hade dolt VILKA
// avier som rördes och med vilka belopp, vilket är precis det BFL 5 kap 11 §
// kräver att man kan följa.
describe('H3 PR A — behandlingshistorik för flera allokeringar', () => {
  const flera = [
    {
      id: 'rnp-1',
      rentNoticeId: 'rn-1',
      amount: new Decimal(10_000),
      paidAt: new Date('2026-07-20T00:00:00.000Z'),
      source: 'BANK_RECONCILIATION',
    },
    {
      id: 'rnp-2',
      rentNoticeId: 'rn-2',
      amount: new Decimal(4_000),
      paidAt: new Date('2026-07-20T00:00:00.000Z'),
      source: 'BANK_RECONCILIATION',
    },
  ]

  it('en post per allokering, på RÄTT avi och med RÄTT belopp', async () => {
    const { service, tx } = makeService({ allocation: flera })
    await service.unmatchTransaction('tx-1', 'org-1', 'user-1')

    const poster = tx.rentNoticeEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { rentNoticeId: string; payload: { amount: number } } }).data,
    )
    expect(poster.map((p) => p.rentNoticeId)).toEqual(['rn-1', 'rn-2'])
    expect(poster.map((p) => p.payload.amount)).toEqual([10_000, 4_000])
  })

  it('N=1 är OFÖRÄNDRAT — exakt en post', async () => {
    const { service, tx } = makeService()
    await service.unmatchTransaction('tx-1', 'org-1', 'user-1')
    expect(tx.rentNoticeEvent.create).toHaveBeenCalledTimes(1)
  })
})

// ── M2 PR 1: paret mottagande ↔ reversering ──────────────────────────────────
//
// `allocationId` lades till på BÅDA posterna för att de ska gå att para ihop.
// Med ett vattenfall har N reverseringar samma transactionId, samma paidAt och
// ofta samma belopp — utan allokeringens id går de inte att matcha mot sina
// mottaganden.
//
// Det här testet saknades när fältet infördes; negativkontrollen hittade det.
describe('M2 PR 1 — reverseringen bär allokeringens id', () => {
  it('KANARIEFÅGEL: payloaden innehåller allocationId, annars är paret oslutbart', async () => {
    const flera = [
      {
        id: 'rnp-1',
        rentNoticeId: 'rn-1',
        amount: new Decimal(10_000),
        paidAt: new Date('2026-07-20T00:00:00.000Z'),
        source: 'BANK_RECONCILIATION',
      },
      {
        id: 'rnp-2',
        rentNoticeId: 'rn-2',
        amount: new Decimal(10_000),
        paidAt: new Date('2026-07-20T00:00:00.000Z'),
        source: 'BANK_RECONCILIATION',
      },
    ]
    const { service, tx } = makeService({ allocation: flera })
    await service.unmatchTransaction('tx-1', 'org-1', 'user-1')

    const ids = tx.rentNoticeEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { payload: { allocationId?: string } } }).data.payload.allocationId,
    )
    // Samma belopp och samma paidAt — id:t är det ENDA som skiljer dem åt.
    expect(ids).toEqual(['rnp-1', 'rnp-2'])
  })
})
