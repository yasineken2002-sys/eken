import { describe, expect, it } from 'vitest'

import { schema } from './LeaseForm'

/**
 * FORMULÄRETS NORMALLÄGE MÅSTE PASSERA SITT EGET SCHEMA.
 *
 * ── VARFÖR FILEN FINNS ──────────────────────────────────────────────────────
 *
 * Klassen av fel den fångar kostade TVÅ röda CI-körningar, och båda såg
 * likadana ut från utsidan: E2E `create-base-data.spec.ts:109` väntade på att
 * modalen "Nytt hyresavtal" skulle stängas och fick "unexpected value visible".
 * Användaren trycker Spara, och ingenting händer.
 *
 * Mekaniken är densamma i båda fallen. Formuläret fyller tomma fält med `''`,
 * medan trådens schema — helt riktigt — avvisar `''` som datum, och avvisade
 * dessutom `''` som ett "angivet" indexfält. Felen hamnade på fält som bara
 * renderas i ett annat läge (slutdatum bara för FIXED_TERM, indexuppgifter bara
 * när en klausul valts), så RHF blockerade submit UTAN att något syntes.
 *
 * Ett fältfel utan renderad plats är en tyst blockerare. Provet nedan är
 * billigare än en webbläsare och fäller samma sak.
 *
 * ── VAD PROVET INTE KAN SE ──────────────────────────────────────────────────
 *
 * Att `defaultValues` i komponenten faktiskt är de värden som räknas upp här —
 * det är en HANDSKRIVEN kopia. Ändrar någon komponentens defaults utan att
 * ändra den här filen märker provet ingenting. Den riktningen ägs av E2E.
 * Kopian är ändå värd sitt pris: den fäller på sekunder i stället för minuter,
 * och den pekar ut FÄLTET i stället för en modal som inte stängdes.
 */
const normallage = {
  propertyId: 'p1',
  unitId: '11111111-2222-4333-8444-555555555555',
  tenantMode: 'new' as const,
  existingTenantId: '',
  newTenantType: 'INDIVIDUAL' as const,
  firstName: 'Anna',
  lastName: 'Ek',
  email: 'anna@ek.se',
  monthlyRent: 12000,
  startDate: '2026-01-01',
  // Fälten som fällde formuläret. Alla tomma, alla i sitt defaultläge.
  endDate: '',
  leaseType: 'INDEFINITE' as const,
  usagePurpose: '',
  petsApprovalNotes: '',
  indexClauseType: 'NONE' as const,
  indexAdjustmentDate: '',
  indexNotes: '',
  specialTerms: '',
}

describe('LeaseForms schema mot formulärets egna defaultvärden', () => {
  it('DEN AVGÖRANDE: normalläget går att skicka', () => {
    const utfall = schema.safeParse(normallage)
    const fel = utfall.success ? [] : utfall.error.issues.map((i) => i.path.join('.'))
    expect(fel).toEqual([])
  })

  it('tomt slutdatum blir UTELÄMNAT, inte ett ogiltigt datum', () => {
    const utfall = schema.safeParse(normallage)
    expect(utfall.success && utfall.data.endDate).toBeUndefined()
  })

  it('ett tidsbegränsat avtal utan slutdatum fälls — på ett fält som SYNS', () => {
    const utfall = schema.safeParse({ ...normallage, leaseType: 'FIXED_TERM' })
    expect(utfall.success).toBe(false)
    if (!utfall.success) {
      // Slutdatumsfältet renderas för FIXED_TERM, så felet har en plats.
      expect(utfall.error.issues.map((i) => i.path.join('.'))).toContain('endDate')
    }
  })

  it('KANARIEFÅGEL: ett ogiltigt datum avvisas ÄNDÅ — översättningen är inte ett hål', () => {
    const utfall = schema.safeParse({ ...normallage, endDate: '30 juni 2026' })
    expect(utfall.success).toBe(false)
  })

  it('ett VERKLIGT indexfält utan klausul fälls fortfarande', () => {
    const utfall = schema.safeParse({ ...normallage, indexBaseYear: 2026 })
    expect(utfall.success).toBe(false)
  })
})
