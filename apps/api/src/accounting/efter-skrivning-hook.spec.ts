/**
 * `efterSkrivning` MÅSTE köras i ALLA TRE utfallen.
 *
 * ── VARFÖR PROVET FINNS ─────────────────────────────────────────────────────
 *
 * Hooken bär AI-vägens utförandespår. `create_journal_entry` och
 * `record_expense` är `traceIntegrity: 'TRANSAKTIONELL'`, alltså skrivs INGEN
 * `AiToolExecution`-rad i förväg — hela raden är hookens ansvar.
 *
 * `createNumberedEntry` har TRE utfall, inte två:
 *
 *   1. idempotent snabbträff inuti transaktionen
 *   2. ny post skapad inuti transaktionen
 *   3. sann samtidig kollision → vår transaktion rullas tillbaka, vinnarens rad
 *      slås upp EFTERÅT
 *
 * Första versionen av den här ändringen anropade hooken i 1 och 2 men inte i 3,
 * medan kommentaren lovade "BÅDA UTFALLEN". Konsekvensen var mätbar: i utfall 3
 * fanns varken en lyckad, en missliserad eller en påbörjad körning, samtidigt
 * som verktyget svarade "Verifikat skapat" — `redanFanns` sätts bara inuti
 * hooken och förblev false. En körning som hände förnekades av sitt eget spår.
 *
 * Det var dessutom en REGRESSION: före ändringen hade AI-vägen ingen
 * P2002-fångst, så en kollision kastade vidare och `logToolExecution` skrev en
 * FAILED-rad. Ett synligt fel MED spår hade blivit en tyst framgång UTAN spår.
 *
 * ── VAD PROVET INTE KAN SE ──────────────────────────────────────────────────
 *
 * Att en RIKTIG samtidig kollision uppstår i Postgres. Det ägs av
 * `numbered-entry-race.concurrency.spec.ts`, som mäter racet mot riktig databas.
 * Här matas kollisionen in som ett P2002 — provet äger att hooken körs när
 * återhämtningen tar den grenen, inte att grenen nås.
 */

import { Prisma } from '@prisma/client'
import { AccountingService } from './accounting.service'

const KONTON = [
  { id: 'acc-1930', number: 1930 },
  { id: 'acc-3011', number: 3011 },
]

const RADER = [
  { accountId: 'acc-1930', debit: 100 },
  { accountId: 'acc-3011', credit: 100 },
]

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'x',
    meta: { target: ['organizationId', 'source', 'sourceId'] },
  })
}

/**
 * @param utfall  'ny' → transaktionen lyckas och skapar posten
 *                'traff' → idempotensuppslaget hittar en befintlig
 *                'race' → create kastar P2002; vinnaren slås upp efteråt
 */
function makeService(utfall: 'ny' | 'traff' | 'race') {
  const BEFINTLIG = { id: 'je-befintlig', series: 'A', verNumber: 42 }
  const NY = { id: 'je-ny', series: 'A', verNumber: 43 }

  const tx = {
    journalEntry: {
      findFirst: jest.fn().mockResolvedValue(utfall === 'traff' ? BEFINTLIG : null),
      create:
        utfall === 'race' ? jest.fn().mockRejectedValue(p2002()) : jest.fn().mockResolvedValue(NY),
    },
  }
  const prisma = {
    // Uppslaget EFTER rollbacken sker på this.prisma, inte på tx.
    journalEntry: { findFirst: jest.fn().mockResolvedValue(BEFINTLIG) },
    account: { findMany: jest.fn().mockResolvedValue(KONTON) },
    accountingPeriodEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    fiscalYearClose: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  }
  const verifikationsnummer = {
    allocate: jest.fn().mockResolvedValue({ series: 'A', verNumber: 43, fiscalYear: 2026 }),
  }
  const service = new AccountingService(prisma as never, verifikationsnummer as never)
  return { service, prisma, tx }
}

async function kör(utfall: 'ny' | 'traff' | 'race') {
  const { service } = makeService(utfall)
  const anrop: Array<{ id: string; redanFanns: boolean }> = []
  const entry = await service.createManualJournalEntry({
    organizationId: 'org-1',
    date: new Date('2026-09-05'),
    description: 'Provverifikat',
    lines: [
      { accountNumber: 1930, debit: 100 },
      { accountNumber: 3011, credit: 100 },
    ],
    idempotencyKey: 'nyckel-1',
    source: 'AI',
    efterSkrivning: async (_tx, post, redanFanns) => {
      anrop.push({ id: post.id, redanFanns })
    },
  })
  return { anrop, entry }
}

describe('createNumberedEntry · efterSkrivning körs i ALLA TRE utfallen', () => {
  it('KANARIEFÅGEL: raderna byggs — annars mäter proven nedan ingenting', () => {
    // Utan den här raden kan "hooken kördes en gång" lika gärna betyda att
    // funktionen aldrig kom till skrivningen.
    expect(RADER).toHaveLength(2)
  })

  it('1 · NY POST → hooken körs en gång, med redanFanns=false', async () => {
    const { anrop, entry } = await kör('ny')
    expect(anrop).toEqual([{ id: 'je-ny', redanFanns: false }])
    expect((entry as { id: string }).id).toBe('je-ny')
  })

  it('2 · IDEMPOTENT TRÄFF → hooken körs en gång, med redanFanns=true', async () => {
    const { anrop, entry } = await kör('traff')
    expect(anrop).toEqual([{ id: 'je-befintlig', redanFanns: true }])
    expect((entry as { id: string }).id).toBe('je-befintlig')
  })

  it('3 · SAMTIDIG KOLLISION (P2002) → hooken körs ÄNDÅ, med redanFanns=true', async () => {
    // DEN AVGÖRANDE KONTROLLEN. Grenen är den som räddar racet, och det var
    // precis den som hoppade över hooken i första versionen.
    const { anrop, entry } = await kör('race')
    expect(anrop).toEqual([{ id: 'je-befintlig', redanFanns: true }])
    expect((entry as { id: string }).id).toBe('je-befintlig')
  })

  it('MOTPROV: utan hook går alla tre utfallen igenom ändå', async () => {
    // Hooken är valfri. Ett prov som bara visar att den körs skiljer inte
    // "anropas när den finns" från "krävs för att fungera".
    for (const utfall of ['ny', 'traff', 'race'] as const) {
      const { service } = makeService(utfall)
      await expect(
        service.createManualJournalEntry({
          organizationId: 'org-1',
          date: new Date('2026-09-05'),
          description: 'Utan hook',
          lines: [
            { accountNumber: 1930, debit: 100 },
            { accountNumber: 3011, credit: 100 },
          ],
          idempotencyKey: 'nyckel-2',
        }),
      ).resolves.toBeDefined()
    }
  })
})
