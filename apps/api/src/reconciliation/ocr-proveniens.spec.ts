jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
/**
 * PROVENIENS — en siffra ur prosa är inte en avsiktshandling.
 *
 * M2 (#492) stänger av fuzzy när transaktionen bär en OCR som inte löser ut.
 * Villkoret är `transaction.rawOcr` satt, och det villkoret läser som "betalaren
 * angav ett OCR". Det gjorde det inte: `extractOcr` tar längsta siffersekvensen
 * om 4–20 tecken ur BÅDE referenskolumnen och bankens fritext, utan att pröva
 * någon kontrollsiffra. Ett datum, ett mobilnummer eller ett kontonummer i
 * beskrivningen gjorde alltså transaktionen omatchbar.
 *
 * Testerna KÖR HELA INGEST-VÄGEN (`importBankStatement` → `ingestFromFile` →
 * `matchTransaction`), inte `matchTransaction` med ett handsatt `rawOcr`. Det är
 * skillnaden som gjorde defekten osynlig: `ocr-tidig-retur.spec.ts` matar
 * grinden direkt och kan därför aldrig se vad som gjorde `rawOcr` satt.
 *
 * ── VAD SOM SKULLE FÄLLA VARJE GRUPP ─────────────────────────────────────────
 *
 * Grupp 1 (prosa)      faller om `description` åter läses med den ogrindade
 *                      extraktorn — då blir fuzzy avstängd av ett datum igen.
 * Grupp 2 (avsiktsfält) faller om någon "förenklar" fixen till ett rent
 *                      Luhn-krav överallt — då börjar systemet beloppsgissa
 *                      ovanpå ett OCR ur ett gammalt system, alltså exakt den
 *                      skada M2 finns för. KANARIEFÅGEL åt motsatt håll.
 * Grupp 3 (grinden lever) faller om den tidiga returen tas bort helt.
 */

import { Decimal } from '@prisma/client/runtime/library'
import { ReconciliationService } from './reconciliation.service'
import { extractOcr, extractOcrFromProse } from './ocr-proveniens'

const dec = (v: string | number) => new Decimal(v)

/**
 * Riggen. `rentNotice.findFirst` returnerar null → INGET OCR-uppslag löser ut,
 * vilket är förutsättningen för att grinden alls ska prövas. `findMany`
 * returnerar EN unik kandidat på rätt belopp → fuzzy skulle lyckas om den kördes.
 *
 * Utfallet blir därmed diskriminerande: `autoMatched: 1` betyder att fuzzy kördes,
 * `unmatched: 1` att den hoppades över. Ingen tolkning behövs.
 */
function rigg() {
  const kandidat = {
    id: 'rn-fuzzy',
    totalAmount: dec(8_000),
    consumptionAmount: dec(0),
    miscChargeAmount: dec(0),
    reminderFeeAmount: dec(0),
    credits: [],
  }
  const txMock = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    tenant: { findFirst: jest.fn().mockResolvedValue(null) },
    rentNotice: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue({
        id: 'rn-fuzzy',
        noticeNumber: 'AVI-1',
        status: 'SENT',
        collectionStage: 'NONE',
        type: 'RENT',
        totalAmount: dec(8_000),
        consumptionAmount: dec(0),
        miscChargeAmount: dec(0),
        reminderFeeAmount: dec(0),
        interestAccruedAmount: dec(0),
        credits: [],
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    rentNoticeCredit: { findMany: jest.fn().mockResolvedValue([]) },
    rentNoticePayment: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'rnp-1' }),
    },
    bankTransaction: { update: jest.fn().mockResolvedValue({}) },
  }
  const prisma = {
    invoice: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    tenant: { findFirst: jest.fn().mockResolvedValue(null) },
    rentNotice: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([kandidat]),
    },
    bankTransaction: {
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'tx-1', ...data }),
        ),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(txMock)),
  }
  const service = new ReconciliationService(
    prisma as never,
    {} as never,
    { record: jest.fn() } as never,
    {
      createJournalEntryForRentNoticePayment: jest.fn().mockResolvedValue({ id: 'je-1' }),
    } as never,
    // arg 5 = freshness, arg 6 = rentNoticeEvents. Byter man plats på dem blir
    // varje fuzzy-träff FALSK — avi-händelsen kan inte skrivas, matchningen
    // avvisas, och testet blir rött av fel skäl.
    { recordPaymentDataThrough: jest.fn().mockResolvedValue({}) } as never,
    { record: jest.fn().mockResolvedValue({}) } as never,
  )
  return { service, prisma }
}

/** Kontoutdrag med EN inbetalning à 8 000 kr. Referenskolumnen är valfri. */
function utdrag(beskrivning: string, referens?: string) {
  const head =
    referens === undefined ? 'Datum;Beskrivning;Belopp' : 'Datum;Beskrivning;Belopp;Referens'
  const rad =
    referens === undefined
      ? `2026-06-20;${beskrivning};8000,00`
      : `2026-06-20;${beskrivning};8000,00;${referens}`
  return Buffer.from(`${head}\n${rad}\n`, 'utf-8')
}

/** Importerar och returnerar (rawOcr som sparades, kördes fuzzy?). */
async function importera(beskrivning: string, referens?: string) {
  const { service, prisma } = rigg()
  const resultat = await service.importBankStatement(
    utdrag(beskrivning, referens),
    'utdrag.csv',
    'org-1',
  )
  const skapad = (prisma.bankTransaction.create.mock.calls[0]?.[0]?.data ?? {}) as {
    rawOcr?: string
  }
  return {
    rawOcr: skapad.rawOcr,
    fuzzyKördes: prisma.rentNotice.findMany.mock.calls.length > 0,
    autoMatched: resultat.autoMatched,
    unmatched: resultat.unmatched,
  }
}

// ── enhetsnivå: var går gränsen? ─────────────────────────────────────────────

describe('extraktorerna skiljer sig ÅT — annars mäter provenienskravet inget', () => {
  // KANARIEFÅGEL. Går båda extraktorerna att byta mot varandra utan att något
  // ändras är hela klassificeringen dekoration. Fallet nedan MÅSTE skilja dem.
  it('KANARIEFÅGEL: samma indata ger OLIKA svar ur de två extraktorerna', () => {
    const prosaMedDatum = 'Inbetalning 20260601'
    expect(extractOcr(prosaMedDatum)).toBe('20260601') // avsiktsfält: släpps igenom
    expect(extractOcrFromProse(prosaMedDatum)).toBeNull() // prosa: faller på Luhn
  })

  it('ett giltigt OCR passerar BÅDA — prosakravet blockerar inte riktiga OCR', () => {
    // Banker skriver ofta "OCR <nummer>" rakt in i beskrivningen.
    const prosaMedOcr = 'Inbetalning OCR 00000000019'
    expect(extractOcr(prosaMedOcr)).toBe('00000000019')
    expect(extractOcrFromProse(prosaMedOcr)).toBe('00000000019')
  })

  it('text utan siffror ger null ur båda', () => {
    expect(extractOcr('Hyra Andersson')).toBeNull()
    expect(extractOcrFromProse('Hyra Andersson')).toBeNull()
  })
})

// ── grupp 1: PROSA får inte stänga av fuzzy ──────────────────────────────────

describe('KÄRNAN — en siffra ur bankens fritext stänger inte av beloppsmatchningen', () => {
  const fall: Array<[string, string]> = [
    ['Inbetalning 20260601', 'ett DATUM'],
    ['Swish 0701234567 Andersson', 'ett MOBILNUMMER'],
    ['Hyra juni konto 12345678', 'ett KONTONUMMER'],
  ]

  for (const [beskrivning, vad] of fall) {
    it(`"${beskrivning}" — ${vad} blir inte rawOcr, fuzzy körs`, async () => {
      const r = await importera(beskrivning)
      expect(r.rawOcr).toBeUndefined()
      expect(r.fuzzyKördes).toBe(true)
      expect(r.autoMatched).toBe(1)
      expect(r.unmatched).toBe(0)
    })
  }

  it('KANARIEFÅGEL: ett GILTIGT OCR i beskrivningen blir fortfarande rawOcr', async () => {
    // Utan det här fallet vore "släpp igenom prosa" lika grönt som att sluta
    // läsa `description` över huvud taget — och då försvinner en fungerande
    // matchningsväg utan att ett enda test blir rött.
    const r = await importera('Inbetalning OCR 00000000019')
    expect(r.rawOcr).toBe('00000000019')
    // OCR:t löser inte ut i riggen → grinden fires, precis som M2 kräver.
    expect(r.fuzzyKördes).toBe(false)
    expect(r.unmatched).toBe(1)
  })
})

// ── grupp 2: AVSIKTSFÄLT gissas fortfarande inte på ──────────────────────────

describe('NEGATIVKONTROLL — grinden GÖR fortfarande sitt jobb för avsiktsfält', () => {
  it('ett OCR i REFERENSKOLUMNEN som inte löser ut → ingen fuzzy, trots giltig Luhn', async () => {
    const r = await importera('Inbetalning', '00000000019')
    expect(r.rawOcr).toBe('00000000019')
    expect(r.fuzzyKördes).toBe(false)
    expect(r.autoMatched).toBe(0)
    expect(r.unmatched).toBe(1)
  })

  /**
   * DEN VIKTIGASTE RADEN I FILEN.
   *
   * Ett OCR ur ett gammalt system (Vitec/Momentum) har en annan kontrollsiffra
   * och FALLER på Luhn. Det är ändå en avsiktshandling — betalaren skrev in det
   * i referensfältet, och autogiromedgivandet bär det vidare.
   *
   * Den mest sannolika förenklingen av den här fixen är "kräv Luhn överallt".
   * Gör man det börjar systemet beloppsgissa ovanpå ett uttryckligen angivet
   * OCR — exakt den skada M2 byggdes för att hindra. Det här fallet faller då.
   */
  it('KANARIEFÅGEL: Luhn-OGILTIGT OCR i referenskolumnen räknas ändå som angivet', async () => {
    const legacyOcr = '12345678' // gammalt systems OCR — faller på Luhn
    expect(extractOcrFromProse(legacyOcr)).toBeNull() // hade prosa-regeln gällt: bortkastat
    const r = await importera('Inbetalning', legacyOcr)
    expect(r.rawOcr).toBe(legacyOcr) // men referenskolumnen är ett avsiktsfält
    expect(r.fuzzyKördes).toBe(false) // ⇒ ingen beloppsgissning
    expect(r.unmatched).toBe(1)
  })
})

// ── grupp 3: den legitima fuzzy-vägen lever ──────────────────────────────────

describe('NEGATIVKONTROLL — fuzzy fungerar fortfarande när ingen OCR angetts', () => {
  it('beskrivning utan siffror → fuzzy matchar på belopp, som förr', async () => {
    const r = await importera('Hyra Andersson')
    expect(r.rawOcr).toBeUndefined()
    expect(r.fuzzyKördes).toBe(true)
    expect(r.autoMatched).toBe(1)
  })
})
