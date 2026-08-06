/**
 * #347 — DE SKULDBÄRANDE STATUSARNA ÄR HÄRLEDDA UR STATUSMASKINEN.
 *
 * Låset som gör att listan och tabellen inte kan glida isär. Regeln är "en
 * status bär öppen skuld exakt när en betalning kan landa på den" — samma
 * princip som `COLLECTION_SOURCE_STATUSES` i #307 PR 2b.
 *
 * Före #347 fanns mängden HANDSKRIVEN på två ställen med olika innehåll:
 * `PAYABLE` i invoice-collection-payment.spec.ts (fyra statusar) och ett inlinat
 * `status === 'SENT' || status === 'OVERDUE'` i `analyze_payment_behavior` (två).
 * Att de skilde sig åt var hela buggen.
 */

import { INVOICE_TRANSITIONS } from '@eken/shared'
import type { InvoiceStatus } from '@prisma/client'
import { DEBT_BEARING_STATUSES, bearsOpenDebt, isAtCollection } from './invoice-payment-status'

const ALL_STATUSES = Object.keys(INVOICE_TRANSITIONS) as InvoiceStatus[]

describe('#347 · DEBT_BEARING_STATUSES', () => {
  it('är exakt de fyra statusar som kan bära en öppen fordran', () => {
    // Faller om någon utökar INVOICE_TRANSITIONS så att en ny status kan ta emot
    // betalning — och det är rätt: att en ny status börjar bära skuld i
    // rapporterna ska vara ett medvetet beslut, inte en bieffekt.
    expect([...DEBT_BEARING_STATUSES].sort()).toEqual([
      'OVERDUE',
      'PARTIAL',
      'SENT',
      'SENT_TO_COLLECTION',
    ])
  })

  it('DRAFT, PAID och VOID bär ingen skuld — de faller ut av regeln, inte av en lista', () => {
    expect(bearsOpenDebt('DRAFT')).toBe(false) // aldrig utställd, ingen fordran har uppstått
    expect(bearsOpenDebt('PAID')).toBe(false) // reglerad
    expect(bearsOpenDebt('VOID')).toBe(false) // makulerad
  })

  // HÄR STOD ETT TEST SOM BEVISADE INGENTING, och det togs bort med flit.
  //
  // Det loopade över alla statusar och jämförde `bearsOpenDebt(s)` mot
  // `isValidTransition(s, paymentTargetStatus(s, false))` — alltså exakt den
  // formel implementationen använder, inskriven en gång till. Ett test som
  // upprepar implementationen kan bara falla om implementationen ändras till
  // något annat än sig själv; det mäter ingen egenskap.
  //
  // Testerna ovan och nedan är riktiga orakel: ett hårdkodat facit och en
  // jämförelse mot den oberoende handskrivna PAYABLE-listan. Tillsammans
  // karaktäriserar de mängden fullständigt (vilka som ingår + vilka som inte
  // gör det), vilket det borttagna testet inte tillförde något till.
  // (Code-reviewer-granskning, #347 — samma familj som den tyst gröna
  // U+00A0-kontrollen i #325-specen.)

  it('den gamla handskrivna PAYABLE-listan är identisk med den härledda', () => {
    // invoice-collection-payment.spec.ts:302 stavade den för hand. Det här
    // testet är bryggan: samma innehåll, men nu med EN källa.
    const HANDSKRIVEN: InvoiceStatus[] = ['SENT', 'PARTIAL', 'OVERDUE', 'SENT_TO_COLLECTION']
    expect([...DEBT_BEARING_STATUSES].sort()).toEqual([...HANDSKRIVEN].sort())
  })

  it('isAtCollection pekar ut ombudsfallet och bara det', () => {
    for (const status of ALL_STATUSES) {
      expect(isAtCollection(status)).toBe(status === 'SENT_TO_COLLECTION')
    }
    // Inkassofordran är fortfarande en fordran — särredovisas, aldrig exkluderas.
    expect(bearsOpenDebt('SENT_TO_COLLECTION')).toBe(true)
  })
})
