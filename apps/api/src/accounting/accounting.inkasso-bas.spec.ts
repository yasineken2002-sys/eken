/**
 * Inkasso PR 1 — kontoplan (6352 / 8131 / 8313).
 *
 * Verifierar att basChartFor seedar de tre nya skuld-/finanskontona med rätt
 * kontotyp, och att inga befintliga konton som inkasso-flödet bygger på har
 * försvunnit (1510, 1515, 3593). Backfillen för befintliga orgs sker i
 * migrationen (verifierad live mot DB: 138/138 orgs); detta täcker
 * seed-källan basChartFor som nya orgs får vid registrering.
 */

import { basChartFor } from './bas-chart'
import type { CompanyForm } from '@prisma/client'

describe('Inkasso PR 1 — BAS-kontoplan', () => {
  const FORMS: CompanyForm[] = ['AB', 'ENSKILD_FIRMA', 'HB', 'KB', 'FORENING', 'STIFTELSE']

  describe('nya konton finns för alla företagsformer', () => {
    it.each(FORMS)('%s innehåller 6352, 8131, 8313', (form) => {
      const numbers = basChartFor(form).map((a) => a.number)
      expect(numbers).toEqual(expect.arrayContaining([6352, 8131, 8313]))
    })
  })

  describe('kontotyper', () => {
    const chart = basChartFor('AB')
    const byNumber = (n: number) => chart.find((a) => a.number === n)

    it('6352 (konstaterad kundförlust) är EXPENSE', () => {
      expect(byNumber(6352)).toMatchObject({ number: 6352, type: 'EXPENSE' })
    })

    it('8131 (dröjsmålsränta) är REVENUE (finansiell intäkt)', () => {
      expect(byNumber(8131)).toMatchObject({ number: 8131, type: 'REVENUE' })
    })

    it('8313 (ränteintäkter kundfordringar) är REVENUE', () => {
      expect(byNumber(8313)).toMatchObject({ number: 8313, type: 'REVENUE' })
    })
  })

  describe('regression — konton som inkasso-flödet bygger på finns kvar', () => {
    const numbers = basChartFor('AB').map((a) => a.number)

    it('1510 Kundfordringar finns', () => {
      expect(numbers).toContain(1510)
    })

    it('1515 Osäkra kundfordringar (befarad kundförlust) finns', () => {
      expect(numbers).toContain(1515)
    })

    it('3593 Påminnelseavgifter finns (skild från dröjsmålsränta 8131)', () => {
      const acc = basChartFor('AB').find((a) => a.number === 3593)
      expect(acc).toMatchObject({ number: 3593, type: 'REVENUE' })
    })
  })

  describe('inga dubbletter i kontoplanen', () => {
    it.each(FORMS)('%s har unika kontonummer', (form) => {
      const numbers = basChartFor(form).map((a) => a.number)
      expect(new Set(numbers).size).toBe(numbers.length)
    })
  })
})
