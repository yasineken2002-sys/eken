/**
 * A + B — påminnelseavgiften och dröjsmålsräntan reverseras vid makulering/annullering.
 *
 * Båda ligger i EGNA namnrymder som dokumentens egna reverseringar aldrig kan nå:
 *
 *   avgift:  reminder-fee:<dokumentId>        source = INVOICE | RENT_NOTICE
 *   ränta:   interest:<noticeId>:<YYYY-MM-DD> source = RENT_NOTICE, N poster
 *
 * TESTERNA ÄR DISKRIMINERANDE PÅ BÅDA AXLARNA. Attrappen svarar bara när BÅDE
 * `source` OCH `sourceId` stämmer — det unika indexet är (org, source, sourceId),
 * och avgiftens nyckel skiljer sig från avins accrual på båda. En implementation
 * som vidgar sourceId men gissar fel source ser inget original, blir en tyst
 * no-op, och faller här.
 *
 * RÄNTANS TEST ÄR DET SOM BÄR: den har N poster per avi, inte en. Ett `findFirst`
 * hade vänt den första och tyst lämnat resten — en delvis reverserad räntefordran
 * som SER reverserad ut i verifikationslistan. Därför har testdatan TRE
 * kristalliseringspunkter med OLIKA belopp; sammanföll de kunde testet inte se om
 * alla tre vändes eller om samma vändes tre gånger.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Prisma } from '@prisma/client'

import { AccountingService } from './accounting.service'

const NOTICE_ID = 'rn-7'
const INVOICE_ID = 'inv-3'
const AVGIFT = 60
// Tre punkter, tre OLIKA belopp — annars kan testet inte skilja "alla tre vändes"
// från "en vändes tre gånger".
const RANTEPUNKTER: Array<[string, number]> = [
  ['2026-07-20', 8.4],
  ['2026-08-05', 3.71],
  ['2026-08-20', 2.0],
]

function feeEntry(dokumentId: string, beskrivning: string) {
  return {
    id: `je-fee-${dokumentId}`,
    description: beskrivning,
    lines: [
      {
        accountId: 'acc-1510',
        debit: new Prisma.Decimal(AVGIFT),
        credit: null,
        description: 'Påminnelseavgift fordran',
      },
      {
        accountId: 'acc-3593',
        debit: null,
        credit: new Prisma.Decimal(AVGIFT),
        description: 'Påminnelseintäkt (momsfri)',
      },
    ],
  }
}

function interestEntry(punkt: string, belopp: number) {
  return {
    id: `je-int-${punkt}`,
    sourceId: `interest:${NOTICE_ID}:${punkt}`,
    description: `Dröjsmålsränta hyresavi A-2026-0007 t.o.m. ${punkt}`,
    lines: [
      {
        accountId: 'acc-1510',
        debit: new Prisma.Decimal(belopp),
        credit: null,
        description: 'Dröjsmålsränta fordran',
      },
      {
        accountId: 'acc-8131',
        debit: null,
        credit: new Prisma.Decimal(belopp),
        description: 'Dröjsmålsränteintäkt',
      },
    ],
  }
}

function makeService(opts: { rantepunkter?: Array<[string, number]> } = {}) {
  const punkter = opts.rantepunkter ?? RANTEPUNKTER

  // Svarar BARA på exakt (source, sourceId) — som det unika indexet gör.
  const findFirst = jest.fn((args: { where: { source: string; sourceId: string } }) => {
    const { source, sourceId } = args.where
    if (source === 'RENT_NOTICE' && sourceId === `reminder-fee:${NOTICE_ID}`) {
      return Promise.resolve(feeEntry(NOTICE_ID, 'Påminnelseavgift hyresavi A-2026-0007'))
    }
    if (source === 'INVOICE' && sourceId === `reminder-fee:${INVOICE_ID}`) {
      return Promise.resolve(
        feeEntry(INVOICE_ID, 'Påminnelseavgift faktura F-2026-0003 – Anna Andersson'),
      )
    }
    return Promise.resolve(null)
  })

  const findMany = jest.fn(
    (args: { where: { source: string; sourceId?: { startsWith?: string } } }) => {
      const prefix = args.where.sourceId?.startsWith
      if (args.where.source !== 'RENT_NOTICE' || prefix !== `interest:${NOTICE_ID}:`) {
        return Promise.resolve([])
      }
      return Promise.resolve(punkter.map(([p, b]) => interestEntry(p, b)))
    },
  )

  const prisma = { journalEntry: { findFirst, findMany } }
  const service = new AccountingService(prisma as never, {} as never)

  // Fångar varje skriven reversering utan att gå till DB.
  const skrivna: Array<{ source: string; sourceId: string; description: string; lines: unknown }> =
    []
  ;(service as unknown as Record<string, unknown>)['createNumberedEntry'] = jest.fn(
    (p: { source: string; sourceId: string; description: string; lines: unknown }) => {
      skrivna.push({
        source: p.source,
        sourceId: p.sourceId,
        description: p.description,
        lines: p.lines,
      })
      return Promise.resolve({ id: `je-rev-${skrivna.length}` })
    },
  )

  return { service, skrivna, findFirst, findMany }
}

describe('A — påminnelseavgiftens motverifikat', () => {
  it('AVI: hittar avgiften på (RENT_NOTICE, reminder-fee:<noticeId>) och vänder den', async () => {
    const { service, skrivna, findFirst } = makeService()

    await service.reverseJournalEntryForReminderFee(
      'RENT_NOTICE',
      NOTICE_ID,
      'org-1',
      'Annullerad hyresavi',
      'user-1',
    )

    expect(findFirst).toHaveBeenCalledTimes(1)
    const fråga = findFirst.mock.calls[0]![0] as { where: Record<string, unknown> }
    expect(fråga.where).toMatchObject({
      source: 'RENT_NOTICE',
      sourceId: `reminder-fee:${NOTICE_ID}`,
    })

    expect(skrivna).toHaveLength(1)
    expect(skrivna[0]!.sourceId).toBe(`reminder-fee-reversal:${NOTICE_ID}`)
    expect(skrivna[0]!.source).toBe('RENT_NOTICE')
    // Debet/kredit har bytt plats.
    expect(skrivna[0]!.lines).toEqual([
      expect.objectContaining({ accountId: 'acc-1510', credit: AVGIFT }),
      expect.objectContaining({ accountId: 'acc-3593', debit: AVGIFT }),
    ])
  })

  it('FAKTURA: samma form men source INVOICE — nyckeln skiljer på TVÅ axlar', async () => {
    const { service, skrivna, findFirst } = makeService()

    await service.reverseJournalEntryForReminderFee(
      'INVOICE',
      INVOICE_ID,
      'org-1',
      'Makulerad faktura',
      'user-1',
    )

    const fråga = findFirst.mock.calls[0]![0] as { where: Record<string, unknown> }
    expect(fråga.where).toMatchObject({ source: 'INVOICE', sourceId: `reminder-fee:${INVOICE_ID}` })
    expect(skrivna[0]!.sourceId).toBe(`reminder-fee-reversal:${INVOICE_ID}`)
  })

  it('fel source ger INGEN träff — attrappen speglar det unika indexet', async () => {
    // Diskriminerande: samma sourceId, fel source. En implementation som skickar
    // in fel source blir en tyst no-op, och det ska synas.
    const { service, skrivna } = makeService()

    await service.reverseJournalEntryForReminderFee(
      'INVOICE', // fel för en AVI
      NOTICE_ID,
      'org-1',
      'Annullerad hyresavi',
      null,
    )

    expect(skrivna).toHaveLength(0)
  })

  it('etiketten följer med posten: originalets text bärs in i motverifikatet', async () => {
    const { service, skrivna } = makeService()

    await service.reverseJournalEntryForReminderFee(
      'INVOICE',
      INVOICE_ID,
      'org-1',
      'Makulerad faktura',
      null,
    )

    // Inte bara "Makulerad faktura" — motverifikatet ska säga VAD som vändes,
    // med fakturanummer och motpart (BFL 5 kap 7 §).
    expect(skrivna[0]!.description).toBe(
      'Makulerad faktura: Påminnelseavgift faktura F-2026-0003 – Anna Andersson',
    )
  })

  it('ingen avgift bokförd → no-op, inget motverifikat', async () => {
    const { service, skrivna } = makeService()

    await service.reverseJournalEntryForReminderFee(
      'RENT_NOTICE',
      'rn-utan-avgift',
      'org-1',
      'Annullerad hyresavi',
      null,
    )

    expect(skrivna).toHaveLength(0)
  })
})

describe('B — dröjsmålsräntans motverifikat (N poster)', () => {
  it('sveper ALLA kristalliseringspunkter, inte bara den första', async () => {
    const { service, skrivna } = makeService()

    await service.reverseJournalEntryForInterest(
      NOTICE_ID,
      'org-1',
      'Annullerad hyresavi',
      'user-1',
    )

    expect(skrivna).toHaveLength(RANTEPUNKTER.length)
    // Varje punkt får SIN egen reverseringsnyckel, med datumet bevarat.
    expect(skrivna.map((s) => s.sourceId)).toEqual([
      `interest-reversal:${NOTICE_ID}:2026-07-20`,
      `interest-reversal:${NOTICE_ID}:2026-08-05`,
      `interest-reversal:${NOTICE_ID}:2026-08-20`,
    ])
  })

  it('varje motverifikat vänder SITT belopp — inte samma tre gånger', async () => {
    const { service, skrivna } = makeService()

    await service.reverseJournalEntryForInterest(NOTICE_ID, 'org-1', 'Annullerad hyresavi', null)

    const krediterat = skrivna.map(
      (s) => (s.lines as Array<{ accountId: string; credit?: number }>)[0]!.credit,
    )
    expect(krediterat).toEqual([8.4, 3.71, 2.0])
    // Summan är hela räntefordran — det är den 1510 ska befrias från.
    expect(krediterat.reduce<number>((a, b) => a + (b ?? 0), 0)).toBeCloseTo(14.11, 2)
  })

  it('frågar på prefixet med avslutande kolon (annat avi-id får inte matcha)', async () => {
    const { service, findMany } = makeService()

    await service.reverseJournalEntryForInterest(NOTICE_ID, 'org-1', 'Annullerad hyresavi', null)

    const fråga = findMany.mock.calls[0]![0] as {
      where: { source: string; sourceId: { startsWith: string } }
    }
    expect(fråga.where.source).toBe('RENT_NOTICE')
    expect(fråga.where.sourceId.startsWith).toBe(`interest:${NOTICE_ID}:`)
    expect(fråga.where.sourceId.startsWith.endsWith(':')).toBe(true)
  })

  it('etiketten följer med: varje motverifikat namnger sin kristalliseringspunkt', async () => {
    const { service, skrivna } = makeService()

    await service.reverseJournalEntryForInterest(NOTICE_ID, 'org-1', 'Annullerad hyresavi', null)

    expect(skrivna[0]!.description).toBe(
      'Annullerad hyresavi: Dröjsmålsränta hyresavi A-2026-0007 t.o.m. 2026-07-20',
    )
    expect(skrivna[2]!.description).toContain('2026-08-20')
  })

  it('EN punkt fungerar lika bra som tre (dagens produktionsdata)', async () => {
    const { service, skrivna } = makeService({ rantepunkter: [['2026-07-20', 14.11]] })

    await service.reverseJournalEntryForInterest(NOTICE_ID, 'org-1', 'Annullerad hyresavi', null)

    expect(skrivna).toHaveLength(1)
  })

  it('SVEPET FÅR INTE PLOCKA UPP SINA EGNA MOTVERIFIKAT', async () => {
    // Funktionen både LETAR med ett prefix och SKRIVER nya poster. Hamnade
    // motverifikaten inom samma prefix skulle en andra körning reversera
    // reverseringarna — och idempotens per nyckel skyddar INTE, eftersom de nya
    // posterna skulle få nya, lediga nycklar.
    //
    // Skyddet vilar på ETT TECKEN: `interest:` mot `interest-`. Döper någon om
    // reverseringsnyckeln till `interest:reversal:…` öppnas hålet utan att något
    // annat test faller. Det här testet är spärren mot just det.
    //
    // Båda värdena läses ur KODENS faktiska utdata — prefixet den frågar med och
    // nyckeln den skriver — inte ur handskrivna literaler bredvid.
    const { service, skrivna, findMany } = makeService()

    await service.reverseJournalEntryForInterest(NOTICE_ID, 'org-1', 'Annullerad hyresavi', null)

    const prefix = (findMany.mock.calls[0]![0] as { where: { sourceId: { startsWith: string } } })
      .where.sourceId.startsWith

    for (const post of skrivna) {
      expect(post.sourceId.startsWith(prefix)).toBe(false)
    }
    // …och prefixet fångar bevisligen originalen, annars vore ovanstående tomt.
    expect(`interest:${NOTICE_ID}:2026-07-20`.startsWith(prefix)).toBe(true)
  })

  it('ingen ränta bokförd → no-op', async () => {
    const { service, skrivna } = makeService({ rantepunkter: [] })

    await service.reverseJournalEntryForInterest(NOTICE_ID, 'org-1', 'Annullerad hyresavi', null)

    expect(skrivna).toHaveLength(0)
  })
})
