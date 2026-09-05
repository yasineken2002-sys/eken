/**
 * DEN DELADE KONTERINGEN — och att BÅDA vägarna får samma rader.
 *
 * `create_journal_entry`/`record_expense` (AI) och POST
 * /accounting/journal-entries respektive /accounting/expenses (människa) bygger
 * sina rader med samma rena funktioner. Provet nedan mäter funktionerna själva;
 * att båda anropar dem bärs av `manual-entry-parity.spec.ts` och av att
 * `check-tool-human-path.mjs` kräver en väg för verktygen.
 */

import {
  byggUtgiftsrader,
  byggVerifikatrader,
  KONTO_BANK,
  KONTO_INGAENDE_MOMS,
} from './manual-entry'
import { AccountingService } from './accounting.service'

const KONTON = new Map<number, string>([
  [1930, 'id-1930'],
  [2641, 'id-2641'],
  [3011, 'id-3011'],
  [5070, 'id-5070'],
])

describe('byggVerifikatrader — balanskravet', () => {
  it('balanserat verifikat ger rader och summa', () => {
    const r = byggVerifikatrader(
      [
        { accountNumber: 1930, debit: 1000 },
        { accountNumber: 3011, credit: 1000 },
      ],
      KONTON,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.summa).toBe(1000)
    expect(r.rader).toEqual([
      { accountId: 'id-1930', debit: 1000 },
      { accountId: 'id-3011', credit: 1000 },
    ])
  })

  it('OBALANS avvisas, och meddelandet bär BÅDA beloppen', () => {
    // Beloppen i texten är poängen: "verifikatet balanserar inte" utan tal
    // tvingar den som läser att räkna om själv.
    const r = byggVerifikatrader(
      [
        { accountNumber: 1930, debit: 1000 },
        { accountNumber: 3011, credit: 900 },
      ],
      KONTON,
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.fel).toContain('1000.00')
    expect(r.fel).toContain('900.00')
  })

  it('ETT ÖRE är ett fel, inte brus — samma nolltolerans som C1-grinden', () => {
    const r = byggVerifikatrader(
      [
        { accountNumber: 1930, debit: 1000 },
        { accountNumber: 3011, credit: 999.99 },
      ],
      KONTON,
    )
    expect(r.ok).toBe(false)
  })

  it('MOTPROV: en HALV öre avrundas bort — jämförelsen är i hela ören, inte en tolerans', () => {
    // Utan den här raden går det inte att skilja "exakt jämförelse" från "en
    // tolerans som råkar vara mindre än ett öre". 999.995 avrundas till 100000
    // ören, precis som 1000 — samma tal, alltså balans.
    const r = byggVerifikatrader(
      [
        { accountNumber: 1930, debit: 1000 },
        { accountNumber: 3011, credit: 999.995 },
      ],
      KONTON,
    )
    expect(r.ok).toBe(true)
  })

  it('och flyttalsbruset fäller INTE ett verifikat som balanserar i ören', () => {
    // 0.1 + 0.2 === 0.30000000000000004. En exakt `!==` på flyttal hade fällt
    // det här; jämförelsen i hela ören gör det inte.
    const r = byggVerifikatrader(
      [
        { accountNumber: 1930, debit: 0.1 },
        { accountNumber: 1930, debit: 0.2 },
        { accountNumber: 3011, credit: 0.3 },
      ],
      KONTON,
    )
    expect(r.ok).toBe(true)
  })

  it('okänt konto avvisas med numret utskrivet', () => {
    const r = byggVerifikatrader(
      [
        { accountNumber: 9999, debit: 100 },
        { accountNumber: 3011, credit: 100 },
      ],
      KONTON,
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.fel).toContain('9999')
  })

  it('rad med både debet och kredit avvisas — separata rader krävs', () => {
    const r = byggVerifikatrader(
      [
        { accountNumber: 1930, debit: 100, credit: 100 },
        { accountNumber: 3011, credit: 100 },
      ],
      KONTON,
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.fel).toContain('separata rader')
  })

  it('rad utan belopp avvisas', () => {
    const r = byggVerifikatrader(
      [{ accountNumber: 1930 }, { accountNumber: 3011, credit: 100 }],
      KONTON,
    )
    expect(r.ok).toBe(false)
  })

  it('färre än två rader avvisas', () => {
    expect(byggVerifikatrader([{ accountNumber: 1930, debit: 100 }], KONTON).ok).toBe(false)
  })
})

describe('byggUtgiftsrader — momsen bryts UT ur bruttot', () => {
  it('med moms: netto på kostnadskontot, moms på 2641, BRUTTO på 1930', () => {
    const r = byggUtgiftsrader(
      { belopp: 1250, moms: 250, kontonummer: 5070, beskrivning: 'Rörmokare' },
      KONTON,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rader).toEqual([
      { accountId: 'id-5070', debit: 1000, description: 'Rörmokare' },
      { accountId: 'id-1930', credit: 1250, description: 'Betalning bank' },
      { accountId: 'id-2641', debit: 250, description: 'Ingående moms' },
    ])
    // RIKTNINGEN, uttryckligen: bankraden är 1250 och inte 1000. Den omvända
    // tolkningen ger ett verifikat som BALANSERAR men bokför fel summa på
    // banken — varken balansgrinden eller ett radantalsprov ser det.
    const bank = r.rader.find((rad) => rad.accountId === 'id-1930')
    expect(bank?.credit).toBe(1250)
  })

  it('resultatet balanserar: debet = kredit', () => {
    const r = byggUtgiftsrader(
      { belopp: 1250, moms: 250, kontonummer: 5070, beskrivning: 'x' },
      KONTON,
    )
    if (!r.ok) throw new Error('förväntade rader')
    const debet = r.rader.reduce((s, rad) => s + (rad.debit ?? 0), 0)
    const kredit = r.rader.reduce((s, rad) => s + (rad.credit ?? 0), 0)
    expect(debet).toBeCloseTo(kredit, 2)
  })

  it('utan moms: två rader, ingen 2641', () => {
    const r = byggUtgiftsrader({ belopp: 500, kontonummer: 5070, beskrivning: 'x' }, KONTON)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rader).toHaveLength(2)
    expect(r.rader.some((rad) => rad.accountId === 'id-2641')).toBe(false)
  })

  it('moms större än beloppet avvisas — beloppet är inklusive moms', () => {
    const r = byggUtgiftsrader(
      { belopp: 100, moms: 200, kontonummer: 5070, beskrivning: 'x' },
      KONTON,
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.fel).toContain('inklusive moms')
  })

  it('belopp ≤ 0 avvisas', () => {
    expect(byggUtgiftsrader({ belopp: 0, kontonummer: 5070, beskrivning: 'x' }, KONTON).ok).toBe(
      false,
    )
  })

  it('saknat bankkonto avvisas med kontonumret utskrivet', () => {
    const utanBank = new Map(KONTON)
    utanBank.delete(KONTO_BANK)
    const r = byggUtgiftsrader({ belopp: 100, kontonummer: 5070, beskrivning: 'x' }, utanBank)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.fel).toContain(String(KONTO_BANK))
  })

  it('moms begärd men 2641 saknas avvisas — momsen får inte tyst hamna i kostnaden', () => {
    const utanMoms = new Map(KONTON)
    utanMoms.delete(KONTO_INGAENDE_MOMS)
    const r = byggUtgiftsrader(
      { belopp: 125, moms: 25, kontonummer: 5070, beskrivning: 'x' },
      utanMoms,
    )
    expect(r.ok).toBe(false)
  })
})

/**
 * BILAGAN GENOM TJÄNSTEN, inte bara genom kolumnen.
 *
 * `manual-entry.db.spec.ts` bevisar att kolumnen finns och rundtrippar mot
 * riktig Postgres — men den skriver raden med rå Prisma. Det kan inte se att
 * `createManualJournalEntry` FÖR VIDARE fältet, och det var exakt den defekten
 * som fanns här innan: DTO:n tog emot `attachmentUrl`, tjänsten hade det i sin
 * signatur, och ingen skrev det. Bilagegränssnittet lovade sju års arkivering
 * (BFL 7 kap) och höll det inte.
 *
 * Provet nedan går genom tjänstemetoden med en attrapp-Prisma och läser vad som
 * faktiskt hamnade i `journalEntry.create`. Formen är lånad från
 * `accounting.balance-guard.spec.ts`, som prövar C1-grinden på samma sätt.
 */
describe('createManualJournalEntry — bilagan når journalEntry.create', () => {
  function makeService(): {
    service: AccountingService
    skapadeMed: () => Record<string, unknown> | null
  } {
    let sista: { data: Record<string, unknown> } | null = null
    const prisma = {
      journalEntry: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation((arg: { data: Record<string, unknown> }) => {
          sista = arg
          return Promise.resolve({ id: 'je-1', ...arg.data })
        }),
      },
      account: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'id-1930', number: 1930 },
          { id: 'id-3011', number: 3011 },
        ]),
      },
      accountingPeriodEvent: { findFirst: jest.fn().mockResolvedValue(null) },
      fiscalYearClose: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma)),
    }
    const verifikationsnummer = {
      allocate: jest.fn().mockResolvedValue({ series: 'V', verNumber: 1, fiscalYear: 2026 }),
    }
    const service = new AccountingService(prisma as never, verifikationsnummer as never)
    return { service, skapadeMed: () => sista?.data ?? null }
  }

  it('attachmentUrl skrivs igenom när den finns', async () => {
    const { service, skapadeMed } = makeService()
    await service.createManualJournalEntry({
      organizationId: 'org-1',
      date: new Date('2026-09-05'),
      description: 'Med kvitto',
      lines: [
        { accountNumber: 1930, debit: 100 },
        { accountNumber: 3011, credit: 100 },
      ],
      idempotencyKey: 'nyckel-1',
      attachmentUrl: 'https://exempel.test/kvitto.pdf',
    })
    expect(skapadeMed()?.['attachmentUrl']).toBe('https://exempel.test/kvitto.pdf')
  })

  it('MOTPROV: utan bilaga skrivs ingen tom sträng — fältet utelämnas', async () => {
    // Utan den här raden kan provet ovan vara grönt av att fältet alltid sätts,
    // och en tom sträng i kolumnen ser ut som en bilaga som inte går att öppna.
    const { service, skapadeMed } = makeService()
    await service.createManualJournalEntry({
      organizationId: 'org-1',
      date: new Date('2026-09-05'),
      description: 'Utan kvitto',
      lines: [
        { accountNumber: 1930, debit: 100 },
        { accountNumber: 3011, credit: 100 },
      ],
      idempotencyKey: 'nyckel-2',
    })
    expect(skapadeMed()).not.toHaveProperty('attachmentUrl')
  })
})
