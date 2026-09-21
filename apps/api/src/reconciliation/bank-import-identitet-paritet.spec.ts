/**
 * PARITETEN MELLAN DE TVÅ LAGREN — MÄTT, INTE PÅSTÅTT.
 *
 * ── VARFÖR FILEN FINNS ──────────────────────────────────────────────────────
 *
 * Filnivåskyddet har två lager som MÅSTE fråga efter samma fältmängd:
 *
 *   LAGER 1  `count` över fält-dedupens `where` — ser även historiska rader
 *   LAGER 2  det partiella unika indexet över `identityKey` — atomärt
 *
 * I första versionen av #F034b skrevs de som två objektliteraler i rad på
 * anropsstället, med en kommentar om att de var lika. Terminal 1:s läsgranskning
 * (fynd F1) pekade ut vad det betyder, med kodbasens egen regel: *"En regel som
 * frågar prosa i stället för kod är alltid uppfylld."*
 *
 * Strukturen är rättad — `filIdentitet` och `bgMaxIdentitet` returnerar BÅDA, så
 * ingen anropsplats kan skriva dem olika. Men de två uttrycken INUTI
 * funktionerna kan fortfarande glida isär, och det är det den här filen mäter.
 *
 * ── HUR MÄTNINGEN GÅR TILL ──────────────────────────────────────────────────
 *
 * För varje fält i indata STÖRS fältet, och båda riktningarna krävs:
 *
 *   a) hashen MÅSTE ändras   → fältet ingår i identiteten
 *   b) `dedup` MÅSTE ändras  → fältet ingår i where-satsen
 *
 * Håller båda för varje fält är hashens fältmängd och where-satsens fältmängd
 * samma mängd som indatas. Ett fält som faller ur den ena men inte den andra
 * fäller provet på det fältets namn.
 *
 * ── VAD VART OCH ETT AV FELLÄGENA KOSTAR ────────────────────────────────────
 *
 *   FÄLT I `dedup` MEN INTE I HASHEN. Två rader som skiljer sig bara i det
 *   fältet får samma `identityKey`. Fil A lagrar den ena som `(K, 0)`; fil B
 *   bär den andra, dess räknare börjar om på 0, lager 1 räknar med det extra
 *   fältet och hittar noll — och lager 2 möter `(K, 0)` som redan finns, kastar
 *   P2002 och raden räknas som DUBBLETT. En verklig betalning försvinner tyst.
 *
 *   FÄLT I HASHEN MEN INTE I `dedup`. Lager 1 blir för lösa och svarar
 *   "dubblett" innan lager 2 ens tillfrågas. Samma förlust, tidigare i kedjan.
 *
 * Båda är exakt det felläge #F034b finns för att ta bort, återinfört från
 * andra hållet.
 */

import { Prisma } from '@prisma/client'

import {
  bgMaxIdentitet,
  filIdentitet,
  type BgMaxRadFält,
  type FilRadFält,
} from './bank-import-identity'

const Decimal = Prisma.Decimal

/** Jämför två where-satser stabilt: Decimal och Date har ingen == som duger. */
function somText(v: unknown): string {
  if (v instanceof Date) return `D:${v.toISOString()}`
  if (v instanceof Prisma.Decimal) return `N:${v.toFixed(2)}`
  return `S:${String(v)}`
}
function dedupSomText(d: Record<string, unknown>): string {
  return Object.keys(d)
    .sort()
    .map((k) => `${k}=${somText(d[k])}`)
    .join('|')
}

describe('fält-dedupen och radidentiteten frågar efter SAMMA fältmängd', () => {
  describe('filvägen (CSV/XLSX/XLS + PDF-bekräftelse)', () => {
    // TYPAD som modulens egna kontrakt, inte inferrerad. Utan annoteringen
    // smalnar TypeScript `reference` till `string`, och störningen `null` —
    // som är hela F034:s poäng om att frånvaro är ett eget värde — går inte
    // att skriva.
    const bas: FilRadFält = {
      date: new Date('2026-03-02T00:00:00.000Z'),
      description: 'Insattning',
      amount: new Decimal('9000.00'),
      reference: '1234567897',
    }

    /** Varje fält, och ett värde som SKILJER SIG från basen. */
    const störningar: Array<[string, Partial<FilRadFält>]> = [
      ['date', { date: new Date('2026-03-03T00:00:00.000Z') }],
      ['description', { description: 'Overforing' }],
      ['amount', { amount: new Decimal('9000.01') }],
      ['reference', { reference: '9876543210' }],
      // FRÅNVARO ÄR ETT EGET VÄRDE, inte en joker (F034). Störningen prövar att
      // `null` skiljer sig från en referens — inte bara att två referenser gör det.
      ['reference→null', { reference: null }],
    ]

    it.each(störningar)('en störning i %s syns i BÅDE hashen och where-satsen', (_namn, delta) => {
      const a = filIdentitet(bas)
      const b = filIdentitet({ ...bas, ...delta })

      expect(b.key).not.toBe(a.key)
      expect(dedupSomText(b.dedup as Record<string, unknown>)).not.toBe(
        dedupSomText(a.dedup as Record<string, unknown>),
      )
    })

    it('where-satsen bär exakt indatas fält — varken fler eller färre', () => {
      // Golv OCH tak. Ett fält som tyst läggs till i where-satsen utan att ingå
      // i hashen fälls här; det behöver alltså inte upptäckas av en störning.
      expect(Object.keys(filIdentitet(bas).dedup).sort()).toEqual([
        'amount',
        'date',
        'description',
        'reference',
      ])
    })

    it('identiska fält ger identisk hash OCH identisk where-sats', () => {
      const a = filIdentitet(bas)
      const b = filIdentitet({ ...bas })
      expect(b.key).toBe(a.key)
      expect(dedupSomText(b.dedup as Record<string, unknown>)).toBe(
        dedupSomText(a.dedup as Record<string, unknown>),
      )
    })

    it('KANARIEFÅGEL: riggen KAN se en skillnad den letar efter', () => {
      // Utan den här raden hade `not.toBe` kunnat vara grönt av att jämförelsen
      // alltid ger olika, eller av att den alltid ger lika. Båda riktningarna
      // prövas: raden ovan visar att lika ger lika, den här att olika ger olika.
      const a = filIdentitet(bas)
      const b = filIdentitet({ ...bas, description: 'NÅGOT ANNAT' })
      expect(a.key).not.toBe(b.key)
      expect(a.key).toBe(filIdentitet(bas).key)
    })
  })

  describe('BgMax-vägen', () => {
    const bas: BgMaxRadFält = {
      date: new Date('2026-03-02T00:00:00.000Z'),
      amount: new Decimal('9000.00'),
      rawOcr: '1234567897',
    }

    const störningar: Array<[string, Partial<BgMaxRadFält>]> = [
      ['date', { date: new Date('2026-03-03T00:00:00.000Z') }],
      ['amount', { amount: new Decimal('9000.01') }],
      ['rawOcr', { rawOcr: '9876543210' }],
      ['rawOcr→null', { rawOcr: null }],
    ]

    it.each(störningar)('en störning i %s syns i BÅDE hashen och where-satsen', (_namn, delta) => {
      const a = bgMaxIdentitet(bas)
      const b = bgMaxIdentitet({ ...bas, ...delta })

      expect(b.key).not.toBe(a.key)
      expect(dedupSomText(b.dedup as Record<string, unknown>)).not.toBe(
        dedupSomText(a.dedup as Record<string, unknown>),
      )
    })

    it('where-satsen bär exakt indatas fält — description ingår INTE', () => {
      // `description` är syntetisk i BgMax (`BgMax inbetalning (OCR …)`). Att
      // hålla den utanför är det som gör att samma betalning importerad via
      // BÅDE BgMax och CSV känns igen som en. Kommer den in här faller provet.
      expect(Object.keys(bgMaxIdentitet(bas).dedup).sort()).toEqual(['amount', 'date', 'rawOcr'])
    })
  })

  it('de två vägarna har SKILDA namnrymder — samma fältvärden ger olika hash', () => {
    // BgMax frågar en annan fältuppsättning än filvägen. Delade de namnrymd
    // hade en BgMax-rad och en CSV-rad med samma dag och belopp kunnat kollidera
    // i det unika indexet trots att deras where-satser frågar olika saker.
    const datum = new Date('2026-03-02T00:00:00.000Z')
    const belopp = new Decimal('9000.00')
    const fil = filIdentitet({ date: datum, description: '', amount: belopp, reference: null })
    const bg = bgMaxIdentitet({ date: datum, amount: belopp, rawOcr: null })
    expect(fil.key).not.toBe(bg.key)
  })
})
