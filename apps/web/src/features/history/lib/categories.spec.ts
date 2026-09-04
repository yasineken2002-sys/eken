import { describe, it, expect } from 'vitest'
import { categoryOf, categoriesPresent, eventLabel, CATEGORY_LABELS } from './categories'
import type { HistoryEvent } from '../api/history.api'

/**
 * Filen påstår två saker i sin egen huvudkommentar, och de bär hela garantin
 * att en filterflik inte kan GÖMMA en händelse:
 *
 *   1. `categoryOf` är TOTAL — ingen väg ut som ger undefined.
 *   2. Flikarna HÄRLEDS UR DATAN, inte ur konstantlistan.
 *
 * Proven nedan riktas mot de påståendena, inte mot regeluppräkningen: vilka
 * prefix som finns är en produktfråga som får ändras, medan totaliteten och
 * härledningen är det som gör funktionen säker.
 */

const händelse = (type: string): HistoryEvent =>
  ({ type, at: '2026-01-01T00:00:00.000Z' }) as unknown as HistoryEvent

describe('categoryOf', () => {
  it('är TOTAL — en okänd typ blir ÖVRIGT, aldrig undefined', () => {
    // Det här är hela punkt 1. En typ API:t hittar på i morgon får inte kunna
    // trilla ur gränssnittet.
    expect(categoryOf('NÅGOT_HELT_NYTT_FRÅN_API')).toBe('ÖVRIGT')
    expect(categoryOf('')).toBe('ÖVRIGT')
    expect(categoryOf('lowercase_utan_prefix')).toBe('ÖVRIGT')
  })

  it('ger alltid en kategori som har en etikett', () => {
    // Svarar funktionen med något som saknar etikett blir fliken namnlös.
    for (const typ of ['LEASE_CREATED', 'INVOICE_X', 'AI_TOOL_EXECUTED', 'ZZ_OKÄND']) {
      expect(CATEGORY_LABELS[categoryOf(typ)]).toBeTruthy()
    }
  })

  it('låter den mer specifika regeln vinna över den bredare', () => {
    // Ordningen i RULES är betydelsebärande enligt kommentaren. Båda hamnar i
    // UNDERHÅLL, så kategorin ensam bevisar inget — etiketten skiljer dem åt.
    expect(categoryOf('MAINTENANCE_PLAN_CREATED')).toBe('UNDERHÅLL')
    expect(categoryOf('MAINTENANCE_REPORTED')).toBe('UNDERHÅLL')
    expect(eventLabel('MAINTENANCE_PLAN_CREATED')).toBe('Underhållsplan skapad')
    expect(eventLabel('MAINTENANCE_REPORTED')).toBe('Felanmälan')
  })
})

describe('categoriesPresent', () => {
  it('härleds ur händelserna — en okänd typ ger ÖVRIGT-fliken av sig själv', () => {
    // Punkt 2. Fliken finns därför att datan innehåller den, inte därför att
    // någon kom ihåg att lägga till den.
    expect(categoriesPresent([händelse('NÅGOT_NYTT')])).toEqual(['ÖVRIGT'])
  })

  it('tar bara med kategorier som faktiskt förekommer', () => {
    const ut = categoriesPresent([händelse('LEASE_CREATED'), händelse('INVOICE_PAID')])
    expect(ut).toContain('AVTAL')
    expect(ut).toContain('EKONOMI')
    expect(ut).not.toContain('BESIKTNING')
  })

  it('ger tom lista för tom indata — inga flikar att visa', () => {
    expect(categoriesPresent([])).toEqual([])
  })

  it('avduplicerar och behåller EventCategory-ordningen', () => {
    // Ordningen ska vara konstantens, inte händelsernas — annars hoppar
    // flikarna omkring när svaret sorteras om.
    const ut = categoriesPresent([
      händelse('AI_TOOL_EXECUTED'),
      händelse('LEASE_CREATED'),
      händelse('LEASE_TERMINATED'),
    ])
    expect(ut).toEqual(['AVTAL', 'AI'])
  })
})

describe('eventLabel', () => {
  it('ger den exakta svenska etiketten när typen är känd', () => {
    expect(eventLabel('DEPOSIT_REFUNDED')).toBe('Deposition återbetald')
  })

  it('faller till familjenamn för typer som byggs av data', () => {
    expect(eventLabel('INVOICE_WHATEVER')).toBe('Fakturahändelse')
    expect(eventLabel('RENT_NOTICE_WHATEVER')).toBe('Avihändelse')
  })

  it('returnerar nyckeln RÅ för okänt — aldrig en auto-översättning', () => {
    // Kommentaren är uttrycklig: alternativet hade producerat ENGELSKA rader i
    // ett svenskt gränssnitt och sett översatt ut utan att vara det.
    expect(eventLabel('ZZ_OKÄND_TYP')).toBe('ZZ_OKÄND_TYP')
    expect(eventLabel('ZZ_OKÄND_TYP')).not.toMatch(/^Zz /)
  })
})
