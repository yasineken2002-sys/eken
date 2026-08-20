/**
 * MANUELL RÄTTELSE OCH AUTOMATISK REVERSERING — BÅDA ORDNINGARNA.
 *
 * DET HÄR ÄR LUCKAN SOM ÖVERLEVDE. `reverse-entry.spec.ts` prövar manuell mot
 * manuell, och de automatiska vägarnas specar prövar var och en för sig. Ingen
 * prövade KOMBINATIONEN — och det var precis där hålet satt: den manuella vägen
 * satte `reversalOfEntryId`, de sju automatiska gjorde det inte, så `@unique`
 * på kolumnen band bara ihop manuell med manuell.
 *
 *   manuell först:      rättelsen nollar posten, sedan speglar annulleringen
 *                       originalet EN GÅNG TILL
 *   automatisk först:   `reversedBy` förblev NULL, så operatörens guard
 *                       passerade och rättelsen bokförde bort beloppet igen
 *
 * Båda ger negativ kundfordran och negativ intäkt på det dubbelräknade
 * beloppet. Varje enskilt verifikat balanserar; felet uppstår först i sekvensen.
 *
 * MOT DEN RIKTIGA TJÄNSTEN. `AccountingService` instansieras skarp i varje test
 * och båda vägarna körs genom den — ingen av dem är stubbad, eftersom det är
 * just samspelet MELLAN dem som prövas. Databasen är en dubbel som modellerar
 * det `@unique` garanterar: som mest en reversering per original.
 */

import { ConflictException } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { AccountingService } from './accounting.service'

const ORG = 'org-1'
const ORIGINAL_ID = 'je-original'

/**
 * En liten huvudbok. `reversalOfEntryId` är unik — precis som i schemat — så
 * riggen kan inte råka tillåta det databasen förbjuder.
 */
function huvudbok() {
  const poster: Array<Record<string, unknown>> = [
    {
      id: ORIGINAL_ID,
      organizationId: ORG,
      date: new Date('2026-03-15T00:00:00Z'),
      description: 'Hyresavi mars',
      series: 'A',
      verNumber: 7,
      source: 'INVOICE',
      sourceId: `rent-notice:${'rn-1'}`,
      reversalOfEntryId: null,
      lines: [
        {
          accountId: 'acc-1510',
          debit: new Prisma.Decimal(10_000),
          credit: null,
          description: 'Kundfordran',
        },
        {
          accountId: 'acc-3911',
          debit: null,
          credit: new Prisma.Decimal(10_000),
          description: 'Hyresintäkt',
        },
      ],
    },
  ]
  let nästaNummer = 8

  const findFirst = jest.fn(async (args: { where: Record<string, unknown>; include?: unknown }) => {
    const w = args.where
    const träff = poster.find((p) => {
      if (w['id'] != null && p['id'] !== w['id']) return false
      if (w['organizationId'] != null && p['organizationId'] !== w['organizationId']) return false
      if (w['sourceId'] != null && p['sourceId'] !== w['sourceId']) return false
      if (w['source'] != null && p['source'] !== w['source']) return false
      if (w['reversalOfEntryId'] != null && p['reversalOfEntryId'] !== w['reversalOfEntryId'])
        return false
      // En fråga UTAN någon av nycklarna ska inte matcha allt.
      return w['id'] != null || w['sourceId'] != null || w['reversalOfEntryId'] != null
    })
    if (!träff) return null
    // `reversedBy` är back-relationen: posten som reverserar den här.
    const reversedBy = poster.find((p) => p['reversalOfEntryId'] === träff['id']) ?? null
    return { ...träff, reversedBy }
  })

  const create = jest.fn(async (args: { data: Record<string, unknown> }) => {
    const d = args.data
    const revOf = d['reversalOfEntryId'] as string | undefined
    // DEN UNIKA SPÄRREN, modellerad. Utan den kan riggen tillåta något
    // databasen vägrar, och testet nedan hade bevisat fel sak.
    if (revOf && poster.some((p) => p['reversalOfEntryId'] === revOf)) {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['reversalOfEntryId'] },
      })
    }
    const rad = {
      id: `je-${nästaNummer}`,
      organizationId: ORG,
      series: 'A',
      verNumber: nästaNummer++,
      reversalOfEntryId: revOf ?? null,
      source: d['source'],
      sourceId: d['sourceId'],
      description: d['description'],
      lines: [],
    }
    poster.push(rad)
    return rad
  })

  const prisma = {
    journalEntry: { findFirst, create, update: jest.fn(), delete: jest.fn() },
    account: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: (cb: (tx: unknown) => unknown) => cb(prisma),
  }
  const verifikationsnummer = {
    allocate: jest.fn(async () => ({ series: 'A', verNumber: nästaNummer, fiscalYear: 2026 })),
  }
  const service = new AccountingService(prisma as never, verifikationsnummer as never)
  return { service, poster, prisma }
}

/** Antal poster som reverserar originalet. Får ALDRIG bli fler än ett. */
const antalReverseringar = (poster: Array<Record<string, unknown>>) =>
  poster.filter((p) => p['reversalOfEntryId'] === ORIGINAL_ID).length

const MANUELLT = {
  entryId: ORIGINAL_ID,
  organizationId: ORG,
  actorRole: 'ACCOUNTANT' as never,
  actorUserId: 'u-1',
  reason: 'Fel belopp aviserat',
}

describe('ORDNING 1 — manuell rättelse FÖRST, därefter automatisk reversering', () => {
  it('den automatiska reverseringen vägrar, och bokför ingenting', async () => {
    const { service, poster } = huvudbok()

    await service.reverseJournalEntry(MANUELLT)
    expect(antalReverseringar(poster)).toBe(1)

    await expect(
      service.reverseJournalEntryForRentNotice('rn-1', ORG, 'u-1'),
    ).rejects.toBeInstanceOf(ConflictException)

    // Det avgörande: fortfarande EN reversering. Utan spärren hade det blivit
    // två, och 1510 samt 3911 hade båda stått på −10 000.
    expect(antalReverseringar(poster)).toBe(1)
  })

  it('beskedet är läsbart och pekar ut reverseringen — inte ett rått databasfel', async () => {
    const { service } = huvudbok()
    await service.reverseJournalEntry(MANUELLT)

    await expect(service.reverseJournalEntryForRentNotice('rn-1', ORG, 'u-1')).rejects.toThrow(
      /redan reverserat, med verifikat A8/,
    )
    // Ingen P2002, ingen "Unique constraint" som läcker igenom till operatören.
    await expect(service.reverseJournalEntryForRentNotice('rn-1', ORG, 'u-1')).rejects.not.toThrow(
      /P2002|Unique constraint/,
    )
  })
})

describe('ORDNING 2 — automatisk reversering FÖRST, därefter manuell rättelse', () => {
  it('den manuella rättelsen vägrar, och bokför ingenting', async () => {
    const { service, poster } = huvudbok()

    await service.reverseJournalEntryForRentNotice('rn-1', ORG, 'u-1')
    expect(antalReverseringar(poster)).toBe(1)

    await expect(service.reverseJournalEntry(MANUELLT)).rejects.toBeInstanceOf(ConflictException)
    expect(antalReverseringar(poster)).toBe(1)
  })

  it('beskedet säger att posten annullerades — inte att den "redan är rättad"', async () => {
    // Ordvalet är inte kosmetik. "Redan rättat" får operatören att leta efter en
    // rättelse som inte finns; sanningen är att dokumentet annullerades och att
    // beloppet därför redan är bokat bort.
    const { service } = huvudbok()
    await service.reverseJournalEntryForRentNotice('rn-1', ORG, 'u-1')

    await expect(service.reverseJournalEntry(MANUELLT)).rejects.toThrow(
      /annullerades eller makulerades/,
    )
    await expect(service.reverseJournalEntry(MANUELLT)).rejects.not.toThrow(/redan rättat/)
  })
})

describe('KONTROLLFALL — spärren får inte fälla det som ska gå igenom', () => {
  it('EN reversering går igenom, oavsett vilken väg som tar den', async () => {
    // Utan de här två raderna kan testerna ovan vara gröna för att BÅDA vägarna
    // vägrar allt — då mäter de att en spärr finns, inte att den diskriminerar.
    const a = huvudbok()
    await a.service.reverseJournalEntry(MANUELLT)
    expect(antalReverseringar(a.poster)).toBe(1)

    const b = huvudbok()
    await b.service.reverseJournalEntryForRentNotice('rn-1', ORG, 'u-1')
    expect(antalReverseringar(b.poster)).toBe(1)
  })

  it('IDEMPOTENSEN ÄR ORÖRD: samma automatiska väg körd två gånger är en no-op', async () => {
    // Retry-säkerheten får inte offras för spärren. Andra körningen träffar sin
    // EGEN sourceId, och då ska den falla igenom till idempotensen — inte fällas.
    const { service, poster } = huvudbok()
    await service.reverseJournalEntryForRentNotice('rn-1', ORG, 'u-1')
    await service.reverseJournalEntryForRentNotice('rn-1', ORG, 'u-1')
    expect(antalReverseringar(poster)).toBe(1)
  })
})
