import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { MaintenanceCategory, MaintenancePriority } from '@prisma/client'

import { FRAGEBARA_NYCKLAR } from '../../questions/question-fields'
import { skuggverktygForFelanmalan } from '../shadow-tool-gate'

/**
 * KORPUSEN ÄR TESTDATA, OCH DEN MÅSTE HÅLLA IHOP MED KODEN.
 *
 * ── VARFÖR DEN HÄR SPECEN FINNS ─────────────────────────────────────────────
 *
 * Ett facit som pekar på ett värde som inte finns kan aldrig träffas. Utfallet
 * är inte ett fel utan en TYST sänkning av träffgraden: mätningen ser ut att
 * fungera och rapporterar att agenten är sämre än den är.
 *
 * Mängderna HÄRLEDS — enumerna ur Prisma-klienten, verktygen ur
 * `skuggverktygForFelanmalan()`, frågefälten ur `FRAGEBARA_NYCKLAR`. En skriven
 * lista här hade varit en andra uppräkning som glider.
 *
 * ── VAD DEN INTE MÄTER ──────────────────────────────────────────────────────
 *
 * Att facit är RÄTT. Det är en mänsklig bedömning och kan inte prövas av kod;
 * varje post bär därför ett `skal` på svenska, så att en miss går att läsa och
 * ifrågasätta. Här mäts att facit är MÖJLIGT.
 */
interface Arende {
  id: string
  titel: string
  beskrivning: string
  registreradKategori: string
  registreradPrioritet: string
  facit: {
    kategori: string
    prioritet: string
    atgard: string
    fragaRatt: boolean
    fragaFalt?: string
    skal: string
  }
}

const korpus = JSON.parse(readFileSync(join(__dirname, 'korpus.json'), 'utf8')) as {
  arenden: Arende[]
}

const KATEGORIER = new Set<string>(Object.values(MaintenanceCategory))
const PRIORITETER = new Set<string>(Object.values(MaintenancePriority))
const VERKTYG = new Set<string>([...skuggverktygForFelanmalan(), 'INGEN'])

describe('mätkorpusen', () => {
  it('KANARIEFÅGEL: korpusen är inte tom, och mängderna den prövas mot är det inte heller', () => {
    // Utan golvet kan en tom korpus eller en tom enum "bevisa" att allt är rätt.
    expect(korpus.arenden.length).toBeGreaterThanOrEqual(50)
    expect(KATEGORIER.size).toBeGreaterThan(5)
    expect(PRIORITETER.size).toBe(4)
    expect(VERKTYG.size).toBeGreaterThan(2)
  })

  it('id:n är unika — annars skriver rapporten över sig själv', () => {
    const ids = korpus.arenden.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(korpus.arenden.map((a) => [a.id, a] as const))(
    '%s: facit använder bara värden som FINNS',
    (_id, a) => {
      expect(KATEGORIER.has(a.facit.kategori)).toBe(true)
      expect(PRIORITETER.has(a.facit.prioritet)).toBe(true)
      expect(VERKTYG.has(a.facit.atgard)).toBe(true)
      // Även det REGISTRERADE värdet måste vara lagligt — det skrivs in i en
      // riktig `MaintenanceTicket` av riggen och hade annars fällt en FK.
      expect(KATEGORIER.has(a.registreradKategori)).toBe(true)
      expect(PRIORITETER.has(a.registreradPrioritet)).toBe(true)
    },
  )

  it.each(korpus.arenden.filter((a) => a.facit.fragaRatt).map((a) => [a.id, a] as const))(
    '%s: ett frågefall pekar på ett FRÅGEBART fält',
    (_id, a) => {
      expect(a.facit.fragaFalt).toBeDefined()
      expect(FRAGEBARA_NYCKLAR).toContain(a.facit.fragaFalt)
    },
  )

  it('inget ärende har fragaFalt UTAN fragaRatt — det vore ett facit som säger två saker', () => {
    const motsägande = korpus.arenden.filter((a) => !a.facit.fragaRatt && a.facit.fragaFalt)
    expect(motsägande.map((a) => a.id)).toEqual([])
  })

  it('varje post bär ett SKÄL — en miss måste gå att läsa', () => {
    const utan = korpus.arenden.filter((a) => (a.facit.skal ?? '').trim().length < 20)
    expect(utan.map((a) => a.id)).toEqual([])
  })

  describe('fördelningen bär det mätningen ska kunna säga något om', () => {
    it('MINST 8 fall där frågan är rätt utfall', () => {
      expect(korpus.arenden.filter((a) => a.facit.fragaRatt).length).toBeGreaterThanOrEqual(8)
    })

    it('MINST 5 fall där rätt svar är att INTE föreslå något', () => {
      // ── RENA INGEN-FALL, inte "INGEN i facit" ──────────────────────────
      //
      // De tio frågefallen har OCKSÅ `atgard: 'INGEN'` — det finns inget
      // verktyg att föreslå — men där är rätt svar en FRÅGA, inte tystnad. Ett
      // krav som räknade dem hade varit uppfyllt av frågefallen ensamma, och
      // "föreslå ingenting" hade kunnat sakna täckning helt.
      //
      // Uppmätt: efter en trimning av korpusen fanns bara TRE rena fall kvar,
      // och den gamla formuleringen var fortfarande grön.
      const rena = korpus.arenden.filter((a) => a.facit.atgard === 'INGEN' && !a.facit.fragaRatt)
      expect(rena.length).toBeGreaterThanOrEqual(5)
    })

    it('MINST 6 kategorier och ALLA fyra prioriteter förekommer', () => {
      // En korpus som bara innehåller NORMAL kan inte mäta prioritetsträffgrad.
      expect(new Set(korpus.arenden.map((a) => a.facit.kategori)).size).toBeGreaterThanOrEqual(6)
      expect(new Set(korpus.arenden.map((a) => a.facit.prioritet)).size).toBe(4)
    })

    it('MINST 10 fall där det REGISTRERADE värdet är fel — annars mäts ingen läsning', () => {
      // Håller agenten bara med om det som redan står i ärendet mäter träffgraden
      // portalens formulär, inte agenten.
      const avvikande = korpus.arenden.filter(
        (a) =>
          a.registreradKategori !== a.facit.kategori ||
          a.registreradPrioritet !== a.facit.prioritet,
      )
      expect(avvikande.length).toBeGreaterThanOrEqual(10)
    })
  })
})
