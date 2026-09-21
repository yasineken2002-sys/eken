/**
 * PSD2 P1 — ingestFromApi (väg byggd, ingen skarp källa förrän P2). Bevisar:
 *   • atomär dedup: dubbel-API-request samma externalId → EN rad, inget 500,
 *   • valuta-avvisning (icke-SEK) — explicit, ingen create,
 *   • storno/negativa — avvisas EXPLICIT, aldrig tyst drop,
 *   • booked-only (pending avvisas),
 *   • MIGRATIONSFÄLLAN: samma betalning via fil OCH API → ingen andra rad, ingen
 *     dubbel-allokering (bägge riktningarna),
 *   • bookingDate normaliseras till Europe/Stockholm-kalenderdag.
 * Den härdade matchTransaction (#161-166) mockas bort — detta rör bara vägen in.
 */

jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Prisma } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { ReconciliationService } from './reconciliation.service'
import { BankImportAttemptService } from './bank-import-attempt.service'

// In-memory BankTransaction-tabell med de where-former ingest-vägarna använder.
function makeFake() {
  const rows: Array<Record<string, unknown>> = []
  let seq = 0

  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean => {
    for (const [k, v] of Object.entries(where)) {
      if (k === 'organizationId') {
        if (row.organizationId !== v) return false
      } else if (k === 'externalId') {
        if (v && typeof v === 'object' && 'not' in (v as object)) {
          if ((v as { not: unknown }).not === null && row.externalId == null) return false
        } else if (row.externalId !== v) return false
      } else if (k === 'dedupKey') {
        if (row.dedupKey !== v) return false
      } else if (k === 'date') {
        if ((row.date as Date)?.getTime?.() !== (v as Date)?.getTime?.()) return false
      } else if (k === 'amount') {
        if (String(row.amount) !== String(v)) return false
      } else if (row[k] !== v) {
        return false
      }
    }
    return true
  }

  const prisma = {
    bankTransaction: {
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(rows.find((r) => matches(r, where)) ?? null),
      ),
      // #F034c — cross-source-uppslaget mot API-rader frågar `findMany` och
      // inte `findFirst`, därför att svaret beror på API-radernas KONTO: med
      // `findFirst` hade utfallet berott på vilken rad databasen råkade lämna
      // först. Attrappen måste bära samma form som kärnan frågar.
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(rows.filter((r) => matches(r, where))),
      ),
      // #F034b — fält-dedupens läsning är numera förekomstmedveten och frågar
      // `count`, inte `findFirst`.
      count: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        // #F034c — kärnan frågar TVÅ gånger: kontoscopad dedup och KONTOLÖS
        // historik. Attrappen svarar 0 på den andra (inga historiska rader i
        // den här riggen), annars hade varje prov blivit ett granskningsutfall.
        if (where['bankAccountId'] === null) return Promise.resolve(0)
        return Promise.resolve(rows.filter((r) => matches(r, where)).length)
      }),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        // Speglar @@unique(organizationId, externalId): dubblett (icke-null) → P2002.
        if (
          data.externalId != null &&
          rows.some(
            (r) => r.organizationId === data.organizationId && r.externalId === data.externalId,
          )
        ) {
          throw new Prisma.PrismaClientKnownRequestError('dup', {
            code: 'P2002',
            clientVersion: 'test',
          })
        }
        // #F034c — EN NULLBAR KOLUMN SOM INTE SATTS BLIR `null`, INTE `undefined`.
        // Attrappen utelämnade nyckeln helt, och då svarade `r.bankAccountId
        // === null` falskt för en rad Postgres hade gett `null`. Kärnan såg en
        // kontolös API-rad som "konto känt, och inte mitt" och matchade raden.
        // Riggen ljög alltså åt det farliga hållet; databasen hade gjort rätt.
        const row = { bankAccountId: null, ...data, id: `tx-${(seq += 1)}` }
        rows.push(row)
        return Promise.resolve(row)
      }),
    },
  }
  return { prisma, rows }
}

function makeService() {
  const fake = makeFake()
  const service = new ReconciliationService(
    fake.prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
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
    // resten av riggen: proven nedan som inte kör en import når den aldrig,
    // och de som gör det ska se skyddet och inte ett genomsläpp.
    new BankImportAttemptService(fake.prisma as never),
  )
  const matchSpy = jest.spyOn(service, 'matchTransaction').mockResolvedValue(true)
  return { service, matchSpy, ...fake }
}

const OCR = '00123459'
const SEK_TX = {
  bookingDate: new Date('2026-05-01T10:00:00Z'),
  booked: true,
  currency: 'SEK',
  amount: 8500,
  description: 'Inbetalning',
  ocr: OCR,
}

describe('ReconciliationService.ingestFromApi — PSD2 P1', () => {
  it('atomär dedup: dubbel-request samma externalId → EN rad, inget 500', async () => {
    const { service, rows, matchSpy } = makeService()
    const r1 = await service.ingestFromApi('org-1', 'ext-1', SEK_TX)
    const r2 = await service.ingestFromApi('org-1', 'ext-1', SEK_TX)

    expect(r1.outcome).toBe('imported')
    expect(r2.outcome).toBe('duplicate')
    if (r2.outcome === 'duplicate') expect(r2.transactionId).toBe(rows[0]!.id)
    expect(rows).toHaveLength(1) // bara EN rad
    expect(matchSpy).toHaveBeenCalledTimes(1) // matchning bara på första raden
  })

  it('valuta: icke-SEK avvisas EXPLICIT, ingen rad skapas', async () => {
    const { service, rows } = makeService()
    const result = await service.ingestFromApi('org-1', 'ext-eur', { ...SEK_TX, currency: 'EUR' })
    expect(result).toEqual({ outcome: 'rejected', reason: 'NON_SEK' })
    expect(rows).toHaveLength(0)
  })

  it('storno/negativa: amount<=0 avvisas EXPLICIT (aldrig tyst drop)', async () => {
    const { service, rows } = makeService()
    const neg = await service.ingestFromApi('org-1', 'ext-neg', { ...SEK_TX, amount: -8500 })
    const zero = await service.ingestFromApi('org-1', 'ext-zero', { ...SEK_TX, amount: 0 })
    expect(neg).toEqual({ outcome: 'rejected', reason: 'NON_POSITIVE' })
    expect(zero).toEqual({ outcome: 'rejected', reason: 'NON_POSITIVE' })
    expect(rows).toHaveLength(0)
  })

  it('booked-only: pending (booked=false) avvisas', async () => {
    const { service, rows } = makeService()
    const result = await service.ingestFromApi('org-1', 'ext-pending', { ...SEK_TX, booked: false })
    expect(result).toEqual({ outcome: 'rejected', reason: 'NOT_BOOKED' })
    expect(rows).toHaveLength(0)
  })

  it('bookingDate normaliseras till Europe/Stockholm-kalenderdag', async () => {
    const { service, rows } = makeService()
    // 2026-05-01 23:30 UTC = 2026-05-02 01:30 svensk tid → dag 2026-05-02.
    await service.ingestFromApi('org-1', 'ext-tz', {
      ...SEK_TX,
      bookingDate: new Date('2026-05-01T23:30:00Z'),
    })
    expect((rows[0]!.date as Date).toISOString().slice(0, 10)).toBe('2026-05-02')
  })

  it('MIGRATIONSFÄLLAN fil→API: fil-rad finns → API dedupar (dedupKey), ingen dubbel-allokering', async () => {
    const { service, rows, matchSpy } = makeService()
    // 1) Betalning ingestas via FIL (stämplar dedupKey), matchas → allokerad EN gång.
    const fileOutcome = await service.ingestFromFile('org-1', {
      dedup: { date: new Date('2026-05-01'), description: 'Hyra', amount: new Decimal('8500.00') },
      // #F034b — radidentiteten. Provet mäter CROSS-SOURCE-dedupen (dedupKey),
      // inte identitetsindexet; nyckeln är därför bara ett giltigt värde.
      identity: { key: 'fil-hyra-20260501', seq: 0 },
      // #F034c — målkontot. Provet mäter cross-source-dedupen, inte
      // kontoseparationen; id:t är bara ett giltigt värde.
      bankAccountId: 'konto-1',
      data: {
        date: new Date('2026-05-01'),
        description: 'Hyra',
        amount: new Decimal('8500.00'),
        rawOcr: OCR,
      },
      crossSource: { date: new Date('2026-05-01'), amount: new Decimal('8500.00'), ocr: OCR },
    })
    expect(fileOutcome.duplicate).toBe(false)
    expect(rows).toHaveLength(1)

    // 2) SAMMA betalning kommer via PSD2-API → måste kännas igen (dedupKey), INGEN rad 2.
    const apiOutcome = await service.ingestFromApi('org-1', 'ext-1', SEK_TX)
    expect(apiOutcome.outcome).toBe('duplicate')
    if (apiOutcome.outcome === 'duplicate') expect(apiOutcome.via).toBe('dedupKey')
    expect(rows).toHaveLength(1) // fortfarande EN rad
    expect(matchSpy).toHaveBeenCalledTimes(1) // matchning bara EN gång → ingen dubbel-allokering
  })

  /** Filraden i de två API→fil-proven nedan. Bara kontot skiljer utfallen åt. */
  function filrad(kontoId: string) {
    return {
      dedup: {
        date: new Date('2026-05-01'),
        description: 'Annan text',
        amount: new Decimal('8500.00'),
        bankAccountId: kontoId,
      },
      // #F034b — se noten i föregående prov.
      identity: { key: `fil-annantext-20260501-${kontoId}`, seq: 0 },
      bankAccountId: kontoId,
      data: {
        date: new Date('2026-05-01'),
        description: 'Annan text',
        amount: new Decimal('8500.00'),
        rawOcr: OCR,
      },
      crossSource: { date: new Date('2026-05-01'), amount: new Decimal('8500.00'), ocr: OCR },
    }
  }

  it('MIGRATIONSFÄLLAN API→fil: KONTOLÖS API-rad ger GRANSKNING — lagrad, aldrig matchad', async () => {
    // ── VAD PROVET SA FÖRR, OCH VARFÖR DET ÄNDRATS (#F034c) ─────────────
    //
    // Provet krävde tidigare `duplicate: true`. Det var rätt svar på fel
    // fråga. `dedupKey` är Stockholm-dag + belopp + OCR och bär INGET konto,
    // och `ingestFromApi` sätter aldrig `bankAccountId` — varje API-rad är
    // alltså kontolös. Kravet lydde därför i praktiken: "okänd
    // kontotillhörighet SKA räknas som en säker dubblett", vilket är exakt
    // det felläge #F034c finns för att ta bort. En verklig betalning på ett
    // annat konto hade försvunnit tyst.
    //
    // DET PROVET EGENTLIGEN VAKTADE STÅR KVAR och mäts nedan: ingen dubbel
    // ALLOKERING. Filraden lagras — en betalning får aldrig kastas — men
    // `matchTransaction` körs aldrig för den, så inga pengar bokförs två
    // gånger. Skyddet mot #162-klassen är alltså oförändrat; det som ändrats
    // är att betalningen inte längre behöver offras för att få det.
    const { service, rows, matchSpy } = makeService()
    await service.ingestFromApi('org-1', 'ext-1', SEK_TX)
    expect(rows).toHaveLength(1)

    const fileOutcome = await service.ingestFromFile('org-1', filrad('konto-1'))

    expect(fileOutcome.duplicate).toBe(false)
    expect(fileOutcome).toMatchObject({ granskning: 'API_UTAN_KONTO' })
    expect(rows).toHaveLength(2) // betalningen finns, som en GRANSKNINGSRAD
    expect(rows[1]!.identityReviewReason).toBe('API_UTAN_KONTO')
    expect(rows[1]!.identityReviewAt).toBeInstanceOf(Date)
    // DET LASTBÄRANDE: matchningen kördes bara för API-raden. Ingen andra
    // allokering, inget andra verifikat.
    expect(matchSpy).toHaveBeenCalledTimes(1)
  })

  it('MIGRATIONSFÄLLAN API→fil: API-rad på SAMMA konto är samma betalning → dubblett', async () => {
    // Motsatsriktningen, och den som gör provet ovan till ett påstående om
    // KONTOT och inte om att grenen slutat deduplicera: vet vi att API-raden
    // kom in på samma konto är frågan besvarad, och svaret är dubblett.
    const { service, rows, matchSpy } = makeService()
    await service.ingestFromApi('org-1', 'ext-1', SEK_TX)
    // P2 kommer att sätta kontot på API-raden; riggen gör det för hand,
    // eftersom `ingestFromApi` ännu inte gör det.
    rows[0]!.bankAccountId = 'konto-1'

    const fileOutcome = await service.ingestFromFile('org-1', filrad('konto-1'))

    expect(fileOutcome.duplicate).toBe(true)
    expect(rows).toHaveLength(1) // ingen andra rad
    expect(matchSpy).toHaveBeenCalledTimes(1)
  })

  it('MIGRATIONSFÄLLAN API→fil: API-rad på ANNAT konto är en EGEN betalning', async () => {
    const { service, rows, matchSpy } = makeService()
    await service.ingestFromApi('org-1', 'ext-1', SEK_TX)
    rows[0]!.bankAccountId = 'konto-2'

    const fileOutcome = await service.ingestFromFile('org-1', filrad('konto-1'))

    // Ingen osäkerhet: båda kontona är kända och de är olika. Raden lagras och
    // matchas normalt — två konton, två betalningar.
    expect(fileOutcome.duplicate).toBe(false)
    expect(fileOutcome).not.toHaveProperty('granskning')
    expect(rows).toHaveLength(2)
    expect(rows[1]!.identityReviewAt).toBeUndefined()
    expect(matchSpy).toHaveBeenCalledTimes(2)
  })
})
