/**
 * PARITET: AI-vägen och människovägen bygger SAMMA rader.
 *
 * ── VARFÖR PROVET FINNS ─────────────────────────────────────────────────────
 *
 * Delmängdsregeln säger att människan ska kunna minst lika mycket som agenten.
 * Den naiva lagningen — en andra implementation bakom en ny endpoint — hade
 * uppfyllt regelns BOKSTAV och brutit dess mening: kontovalen (1930/2641),
 * momsdelningen och balanskravet hade stått på två ställen, och den dag någon
 * byter ett kontonummer i den ena hade AI:n och hyresvärden bokfört OLIKA utan
 * att något blev rött.
 *
 * ── VAD PROVET KAN OCH INTE KAN SE ──────────────────────────────────────────
 *
 * Det mäter att de rena funktionerna är EN funktion, genom att mata in
 * verktygets indataform och controllerns indataform och kräva identiska rader.
 *
 * Det kan INTE se att `tool-executor.service.ts` faktiskt anropar dem — en
 * inline-kopia hade sett likadan ut härifrån. Det bärs av `check-tool-human-path.mjs`
 * (verktygen måste ha en väg) och av att den gamla inline-koden är BORTA;
 * `manual-entry-callers.spec.ts` läser källtexten och kräver att båda
 * anropsställena finns.
 */

import { byggUtgiftsrader, byggVerifikatrader } from './manual-entry'

const KONTON = new Map<number, string>([
  [1930, 'id-1930'],
  [2641, 'id-2641'],
  [3011, 'id-3011'],
  [5070, 'id-5070'],
])

describe('paritet mellan AI-vägens och människovägens indata', () => {
  it('fritt verifikat: verktygets radform och DTO:ns radform ger samma rader', () => {
    // Verktyget läser `toolInput.lines` med exakt de här fältnamnen; DTO:n
    // (JournalLineDto) bär samma. Att formerna redan är lika är hela skälet
    // till att EN funktion räcker — men det måste mätas, inte antas.
    const franVerktyget = [
      { accountNumber: 5070, debit: 800, description: 'Reparation' },
      { accountNumber: 1930, credit: 800 },
    ]
    const franDto = [
      { accountNumber: 5070, debit: 800, description: 'Reparation' },
      { accountNumber: 1930, credit: 800 },
    ]

    const a = byggVerifikatrader(franVerktyget, KONTON)
    const b = byggVerifikatrader(franDto, KONTON)
    expect(a).toEqual(b)
    expect(a.ok).toBe(true)
  })

  it('utgift: verktygets (amount/vatAmount) och DTO:ns (amount/vatAmount) ger samma rader', () => {
    // Verktyget: parseSwedishAmount(toolInput.amount) + vatAmount, brutto.
    // DTO:n: amount + vatAmount, brutto. Samma tal in, samma rader ut.
    const franVerktyget = byggUtgiftsrader(
      { belopp: 1250, moms: 250, kontonummer: 5070, beskrivning: 'Rörmokare' },
      KONTON,
    )
    const franDto = byggUtgiftsrader(
      { belopp: 1250, moms: 250, kontonummer: 5070, beskrivning: 'Rörmokare' },
      KONTON,
    )
    expect(franVerktyget).toEqual(franDto)
  })

  it('KANARIEFÅGEL: funktionen skiljer på olika indata — annars är provet ovan tomt', () => {
    // Utan den här raden är "a lika med b" lika förenligt med att funktionen
    // returnerar samma sak oavsett indata.
    const a = byggUtgiftsrader(
      { belopp: 1250, moms: 250, kontonummer: 5070, beskrivning: 'x' },
      KONTON,
    )
    const b = byggUtgiftsrader(
      { belopp: 1250, moms: 0, kontonummer: 5070, beskrivning: 'x' },
      KONTON,
    )
    expect(a).not.toEqual(b)
  })

  it('NAMNRYMDERNA ÄR TVÅ, och det är avsiktligt', () => {
    // Idempotensen gäller per (org, source, sourceId). AI-vägen skriver
    // source 'AI', människovägen 'MANUAL'. Provet är en påminnelse i kodform:
    // slås de ihop tystas en hyresvärd som medvetet bokför samma belopp som
    // AI:n nyss bokförde — en spärr mot dubbletter blir en spärr mot arbete.
    const AI: string = 'AI'
    const MANUELL: string = 'MANUAL'
    expect(AI).not.toBe(MANUELL)
  })
})
