/**
 * P0-refaktor (PSD2-förberedelse): den delade ingest-kärnan `ingestFromFile`.
 * Bevisar att den EXAKT återger filimportens pipeline — fält-dedup → create →
 * matchTransaction — och att organizationId injiceras här (aldrig från raw).
 * Den härdade matchTransaction (#161-166) mockas bort; detta test rör bara vägen in.
 *
 * ── UPPDATERAD AV #F034b ────────────────────────────────────────────────────
 *
 * Kärnan har fått TVÅ lager i stället för ett, och den här filen äger
 * mekaniken i båda:
 *
 *   LAGER 1  fält-dedupens LÄSNING, nu `count` i stället för `findFirst`.
 *            Frågan är inte "finns raden?" utan "finns det redan minst
 *            `seq + 1` rader med den här identiteten?". Det är ledet som gör
 *            att två VERKLIGT skilda betalningar i samma fil bevaras båda.
 *
 *   LAGER 2  det partiella unika indexet. `create` fångar P2002 från
 *            `bank_transaction_identity_unique` och räknar raden som dubblett.
 *            ETT OKÄNT P2002 KASTAS VIDARE — `BankTransaction` bär också
 *            `@@unique([organizationId, externalId])`, och att svälja ett
 *            brott mot DEN hade tystat PSD2-vägens idempotensskydd.
 *
 * Att lagren faktiskt håller under SAMTIDIGHET kan den här filen inte se — den
 * mockar databasen. Det ägs av `bankimport-filidempotens.db.spec.ts`, som kör
 * mot riktig Postgres med tvingat överlapp.
 */

jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Prisma } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { ReconciliationService } from './reconciliation.service'
import { BankImportAttemptService } from './bank-import-attempt.service'

/**
 * #F034c — `count` anropas numera TVÅ gånger med olika frågor:
 *
 *   lager 1   kontoSCOPAD dedup      (`where.bankAccountId` = kontots id)
 *   lager 1b  KONTOLÖS historik      (`where.bankAccountId` = null)
 *
 * En attrapp som svarar samma tal på båda hade gjort varje prov till ett
 * granskningsutfall, eftersom lager 1b då alltid hittat "historik". Hjälparen
 * nedan låter provet sätta de två oberoende — och `historik: 0` är defaulten,
 * alltså en databas utan kontolösa rader.
 */
function countMock(lagrade: number, historik = 0): jest.Mock {
  return jest.fn(({ where }: { where: Record<string, unknown> }) =>
    Promise.resolve(where['bankAccountId'] === null ? historik : lagrade),
  )
}

function makeService(bankTransaction: { count: jest.Mock; create: jest.Mock }) {
  const prisma = { bankTransaction }
  const service = new ReconciliationService(
    prisma as never,
    {} as never, // invoices
    {} as never, // events
    {} as never, // accounting
    {} as never, // freshness,
    { record: jest.fn().mockResolvedValue({}) } as never, // #326 C — RentNoticeEventsService,
    // Agent 2 (etapp A): skuggkön och facitskrivningen. STUBBAR — ingen av
    // dem får kunna fälla en matchning, och det är just det de här proven
    // mäter genom att inte konfigurera dem.
    { enqueue: jest.fn().mockResolvedValue('jobb') } as never,
    {
      skrivFacitMatchad: jest.fn().mockResolvedValue(undefined),
      skrivFacitIngen: jest.fn().mockResolvedValue(undefined),
      nollstallFacit: jest.fn().mockResolvedValue(undefined),
    } as never,
    // #F034b — filnivåns importskydd. Riktig tjänst över samma prisma som
    // resten av riggen. Proven här kör ingen HEL import och når den aldrig.
    new BankImportAttemptService(prisma as never),
  )
  return service
}

const IDENTITET = { key: 'identitet-abc', seq: 0 }
const KONTO = 'konto-1'

const INPUT = {
  dedup: {
    bankAccountId: KONTO,
    date: new Date('2026-05-01'),
    description: 'Hyra',
    amount: new Decimal('8500.00'),
  },
  bankAccountId: KONTO,
  identity: IDENTITET,
  data: { date: new Date('2026-05-01'), description: 'Hyra', amount: new Decimal('8500.00') },
}

/** Ett P2002 som Prisma skulle kasta från ett namngivet index. */
function p2002(target: string | string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  })
}

describe('ReconciliationService.ingestFromFile — delad ingest-kärna', () => {
  it('dubblett: fält-dedup träffar → {duplicate:true}, ingen create, ingen matchning', async () => {
    const bankTransaction = {
      count: countMock(1),
      create: jest.fn(),
    }
    const service = makeService(bankTransaction)
    const matchSpy = jest.spyOn(service, 'matchTransaction')

    const result = await service.ingestFromFile('org-1', INPUT)

    expect(result).toEqual({ duplicate: true })
    expect(bankTransaction.create).not.toHaveBeenCalled()
    expect(matchSpy).not.toHaveBeenCalled()
  })

  it('ny + matchad: create → matchTransaction=true → {duplicate:false, matched:true}', async () => {
    const bankTransaction = {
      count: countMock(0),
      create: jest.fn().mockResolvedValue({ id: 'tx-1' }),
    }
    const service = makeService(bankTransaction)
    jest.spyOn(service, 'matchTransaction').mockResolvedValue(true)

    const result = await service.ingestFromFile('org-1', INPUT)

    expect(result).toEqual({ duplicate: false, transactionId: 'tx-1', matched: true })
  })

  it('ny + omatchad: matchTransaction=false → matched:false, ingen matchError', async () => {
    const bankTransaction = {
      count: countMock(0),
      create: jest.fn().mockResolvedValue({ id: 'tx-2' }),
    }
    const service = makeService(bankTransaction)
    jest.spyOn(service, 'matchTransaction').mockResolvedValue(false)

    const result = await service.ingestFromFile('org-1', INPUT)

    expect(result).toEqual({ duplicate: false, transactionId: 'tx-2', matched: false })
  })

  it('matchfel: matchTransaction kastar → raden skapad, matchError returneras (kastar EJ)', async () => {
    const bankTransaction = {
      count: countMock(0),
      create: jest.fn().mockResolvedValue({ id: 'tx-3' }),
    }
    const service = makeService(bankTransaction)
    jest.spyOn(service, 'matchTransaction').mockRejectedValue(new Error('korrupt journal'))

    const result = await service.ingestFromFile('org-1', INPUT)

    expect(result.duplicate).toBe(false)
    // Unionen bär numera även granskningsutfallet; smalna av innan fälten läses.
    if (result.duplicate === false && !('granskning' in result)) {
      expect(result.transactionId).toBe('tx-3')
      expect(result.matched).toBe(false)
      expect(result.matchError?.message).toBe('korrupt journal')
    } else {
      throw new Error('Förväntade ett matchfel-utfall, inte ett granskningsutfall')
    }
  })

  it('injicerar organizationId i BÅDE dedup och create (aldrig från raw)', async () => {
    const bankTransaction = {
      count: countMock(0),
      create: jest.fn().mockResolvedValue({ id: 'tx-4' }),
    }
    const service = makeService(bankTransaction)
    jest.spyOn(service, 'matchTransaction').mockResolvedValue(true)

    await service.ingestFromFile('org-42', INPUT)

    expect(bankTransaction.count).toHaveBeenCalledWith({
      where: { organizationId: 'org-42', ...INPUT.dedup },
    })
    expect(bankTransaction.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org-42',
        ...INPUT.data,
        identityKey: IDENTITET.key,
        identitySeq: IDENTITET.seq,
        bankAccountId: KONTO,
      },
    })
  })

  // ── #F034b: FÖREKOMSTLEDET ────────────────────────────────────────────────

  it('seq=1 med EN lagrad rad → SKAPAS (filens andra förekomst är en andra betalning)', async () => {
    const bankTransaction = {
      count: countMock(1),
      create: jest.fn().mockResolvedValue({ id: 'tx-5' }),
    }
    const service = makeService(bankTransaction)
    jest.spyOn(service, 'matchTransaction').mockResolvedValue(false)

    const result = await service.ingestFromFile('org-1', {
      ...INPUT,
      identity: { key: IDENTITET.key, seq: 1 },
    })

    // Basen svarade `{duplicate:true}` här och den betalningen nådde aldrig
    // databasen. Det är hela skälet till att förekomstledet finns.
    expect(result).toEqual({ duplicate: false, transactionId: 'tx-5', matched: false })
    expect(bankTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ identitySeq: 1, bankAccountId: KONTO }),
      }),
    )
  })

  it('seq=1 med TVÅ lagrade rader → dubblett (antalet summerar inte över filer)', async () => {
    const bankTransaction = {
      count: countMock(2),
      create: jest.fn(),
    }
    const service = makeService(bankTransaction)

    const result = await service.ingestFromFile('org-1', {
      ...INPUT,
      identity: { key: IDENTITET.key, seq: 1 },
    })

    expect(result).toEqual({ duplicate: true })
    expect(bankTransaction.create).not.toHaveBeenCalled()
  })

  // ── #F034c: KONTOLÖS HISTORIK ─────────────────────────────────────────────

  it('krock med KONTOLÖS historik → raden LAGRAS men matchas ALDRIG', async () => {
    const bankTransaction = {
      // Kontoscopad dedup hittar inget; den kontolösa historiken hittar EN rad.
      count: countMock(0, 1),
      create: jest.fn().mockResolvedValue({ id: 'tx-osäker' }),
    }
    const service = makeService(bankTransaction)
    const matchSpy = jest.spyOn(service, 'matchTransaction')

    const result = await service.ingestFromFile('org-1', INPUT)

    // BETALNINGEN FÅR INTE FÖRSVINNA — raden är skapad.
    expect(result).toEqual({
      duplicate: false,
      transactionId: 'tx-osäker',
      granskning: 'HISTORIK_UTAN_KONTO',
    })
    // OCH DEN FÅR INTE ALLOKERAS — matchningen kördes aldrig.
    expect(matchSpy).not.toHaveBeenCalled()
    // Stämpeln finns på raden, så utfallet går att hitta i efterhand.
    expect(bankTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          identityReviewReason: 'HISTORIK_UTAN_KONTO',
          identityReviewAt: expect.any(Date),
          bankAccountId: KONTO,
        }),
      }),
    )
  })

  it('frågan om historik ställs UTAN konto — annars kan den aldrig träffa', async () => {
    const bankTransaction = {
      count: countMock(0, 0),
      create: jest.fn().mockResolvedValue({ id: 'x' }),
    }
    const service = makeService(bankTransaction)
    jest.spyOn(service, 'matchTransaction').mockResolvedValue(false)

    await service.ingestFromFile('org-9', INPUT)

    // Historiska rader HAR inget konto. Bärs frågan med kontot kan den aldrig
    // matcha en sådan rad, och hela skyddet blir en tom mängd som ser grön ut.
    expect(bankTransaction.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ organizationId: 'org-9', bankAccountId: null }),
    })
    // …men den behåller ÖVRIGA fält. En bredare fråga hade flaggat rader som
    // inte krockar.
    const historikAnrop = bankTransaction.count.mock.calls.find(
      ([a]: [{ where: Record<string, unknown> }]) => a.where['bankAccountId'] === null,
    )
    expect(Object.keys(historikAnrop![0].where).sort()).toEqual([
      'amount',
      'bankAccountId',
      'date',
      'description',
      'organizationId',
    ])
  })

  it('ingen kontolös historik → vanligt utfall, ingen granskningsstämpel', async () => {
    const bankTransaction = {
      count: countMock(0, 0),
      create: jest.fn().mockResolvedValue({ id: 'tx-9' }),
    }
    const service = makeService(bankTransaction)
    jest.spyOn(service, 'matchTransaction').mockResolvedValue(true)

    // DEN OMVÄNDA RIKTNINGEN. Utan den här hade provet ovan varit grönt även om
    // koden ALLTID stämplade raden som osäker.
    expect(await service.ingestFromFile('org-1', INPUT)).toEqual({
      duplicate: false,
      transactionId: 'tx-9',
      matched: true,
    })
    expect(bankTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ identityReviewReason: expect.anything() }),
      }),
    )
  })

  it('historik som redan är täckt av filens förekomstnummer flaggar INTE', async () => {
    // seq=1 betyder att vi letar filens ANDRA förekomst. EN kontolös historisk
    // rad säger ingenting om den — frågan har ett svar, och det är "skapa".
    const bankTransaction = {
      count: countMock(1, 1),
      create: jest.fn().mockResolvedValue({ id: 'tx-10' }),
    }
    const service = makeService(bankTransaction)
    jest.spyOn(service, 'matchTransaction').mockResolvedValue(false)

    const result = await service.ingestFromFile('org-1', {
      ...INPUT,
      identity: { key: IDENTITET.key, seq: 1 },
    })

    expect(result).toEqual({ duplicate: false, transactionId: 'tx-10', matched: false })
  })

  // ── #F034b: DET UNIKA VILLKORET ───────────────────────────────────────────

  it('P2002 med den UPPMÄTTA formen (kolumnlistan) → dubblett', async () => {
    // Mätt mot Postgres 16 / Prisma 5.22: `meta.target` är kolumnlistan, inte
    // indexnamnet — trots att indexet bara finns i migrations-SQL. Den formen
    // MÅSTE bäras, annars kastas en verklig kollision vidare som ett radfel.
    const bankTransaction = {
      count: countMock(0),
      create: jest.fn().mockRejectedValue(p2002(['organizationId', 'identityKey', 'identitySeq'])),
    }
    const service = makeService(bankTransaction)

    expect(await service.ingestFromFile('org-1', INPUT)).toEqual({ duplicate: true })
  })

  it('NEGATIVKONTROLL: en DELMÄNGD av kolumnerna är ett ANNAT villkor och kastas', async () => {
    const bankTransaction = {
      count: countMock(0),
      create: jest.fn().mockRejectedValue(p2002(['organizationId'])),
    }
    const service = makeService(bankTransaction)

    // "Innehåller organizationId" hade matchat här. Mängdjämförelsen gör det
    // inte — ett framtida villkor över bara organisationen får inte tyst
    // räknas som en identitetsdubblett.
    await expect(service.ingestFromFile('org-1', INPUT)).rejects.toMatchObject({ code: 'P2002' })
  })

  it('P2002 med indexNAMNET (andra Prisma-versioners form) → dubblett', async () => {
    const bankTransaction = {
      count: countMock(0),
      create: jest.fn().mockRejectedValue(p2002('bank_transaction_identity_unique')),
    }
    const service = makeService(bankTransaction)
    const matchSpy = jest.spyOn(service, 'matchTransaction')

    const result = await service.ingestFromFile('org-1', INPUT)

    // Den andra parallella körningen ska se ett normalt dubblettutfall — inte
    // ett fel som rullar tillbaka hela importen.
    expect(result).toEqual({ duplicate: true })
    expect(matchSpy).not.toHaveBeenCalled()
  })

  it('P2002 med indexnamnet som ARRAY → dubblett', async () => {
    const bankTransaction = {
      count: countMock(0),
      create: jest.fn().mockRejectedValue(p2002(['bank_transaction_identity_unique'])),
    }
    const service = makeService(bankTransaction)

    expect(await service.ingestFromFile('org-1', INPUT)).toEqual({ duplicate: true })
  })

  it('NEGATIVKONTROLL: P2002 från externalId-villkoret KASTAS — sväljs aldrig', async () => {
    const bankTransaction = {
      count: countMock(0),
      create: jest.fn().mockRejectedValue(p2002(['BankTransaction_organizationId_externalId_key'])),
    }
    const service = makeService(bankTransaction)

    // Ett blint `code === 'P2002'` hade svalt det här och rapporterat "dubblett
    // — allt bra", alltså tystat PSD2-vägens idempotensskydd. Riggen visar att
    // avgränsningen på indexNAMNET faktiskt bär: samma felkod, motsatt utfall.
    await expect(service.ingestFromFile('org-1', INPUT)).rejects.toMatchObject({ code: 'P2002' })
  })

  it('NEGATIVKONTROLL: P2002 utan target kastas — ett okänt villkor är inte en dubblett', async () => {
    const bankTransaction = {
      count: countMock(0),
      create: jest.fn().mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      ),
    }
    const service = makeService(bankTransaction)

    await expect(service.ingestFromFile('org-1', INPUT)).rejects.toMatchObject({ code: 'P2002' })
  })
})
