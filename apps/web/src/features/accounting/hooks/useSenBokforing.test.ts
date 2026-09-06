import { describe, expect, it } from 'vitest'

import { delaDatum } from './useSenBokforing'

/**
 * DATUMDELNINGEN — den halva av hooken som går att pröva utan en server.
 *
 * ── VARFÖR DEN ÖVER HUVUD TAGET FINNS ───────────────────────────────────────
 *
 * Hooken frågar `/accounting/periods/:år/:månad/history`. Ett datumfält som är
 * halvskrivet (`2026-0`) eller tomt får INTE bli ett anrop på `NaN/NaN` — ett
 * sådant anrop svarar 400 eller värre, och gör att blocket blinkar förbi medan
 * operatören skriver.
 *
 * ── VAD PROVET INTE KAN SE ──────────────────────────────────────────────────
 *
 * Att `enabled` faktiskt hindrar anropet, och att `fiscalYearClosed` läses rätt
 * ur svaret. Det kräver en React Query-provider och en attrapp av endpointen;
 * här mäts predikatet som avgör frågan, som en ren funktion.
 */
describe('delaDatum', () => {
  it('delar ett fullständigt ISO-datum', () => {
    expect(delaDatum('2026-03-15')).toEqual({ ar: 2026, manad: 3 })
    expect(delaDatum('2025-12-31')).toEqual({ ar: 2025, manad: 12 })
    expect(delaDatum('2025-01-01')).toEqual({ ar: 2025, manad: 1 })
  })

  it('trimmar', () => {
    expect(delaDatum('  2026-03-15  ')).toEqual({ ar: 2026, manad: 3 })
  })

  it.each([
    ['', 'tomt fält'],
    ['2026', 'bara år — halvskrivet'],
    ['2026-0', 'halvskriven månad'],
    ['2026-03', 'ingen dag'],
    ['inte-ett-datum', 'skräp'],
    ['2026-13-01', 'månad 13'],
    ['2026-00-01', 'månad 0'],
  ])('%s ger null (%s)', (indata) => {
    expect(delaDatum(indata)).toBeNull()
  })

  it('undefined ger null — inget datum är ingen fråga', () => {
    expect(delaDatum(undefined)).toBeNull()
  })
})
