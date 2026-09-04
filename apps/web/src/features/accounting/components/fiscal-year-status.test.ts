import { describe, expect, it } from 'vitest'

import { bekräftelseGiltig, årsKortStatus } from './fiscal-year-status'
import type { FiscalYearOverviewItem } from '../api/accounting.api'

const bas: FiscalYearOverviewItem = {
  fiscalYear: 2026,
  label: '2026',
  fiscalStart: '2026-01-01',
  yearEndDate: '2026-12-31',
  status: 'READY',
  closedAt: null,
  entry: null,
  monthsRemaining: [],
  finalMonth: '2026-12',
  finalMonthClosed: false,
}

describe('årsKortStatus', () => {
  it('CLOSED: kan inte stängas, och texten säger att det inte går att ångra', () => {
    const s = årsKortStatus({ ...bas, status: 'CLOSED', closedAt: '2027-02-15T09:00:00Z' })
    expect(s.kanStänga).toBe(false)
    expect(s.badge).toBe('Stängt')
    expect(s.beskrivning).toMatch(/kan inte öppnas igen/)
  })

  it('READY: knappen är aktiv och texten nämner vilken månad som stängs', () => {
    const s = årsKortStatus(bas)
    expect(s.kanStänga).toBe(true)
    expect(s.beskrivning).toMatch(/2026-12/)
  })

  it('MONTHS_PENDING: listar exakt vilka månader som saknas', () => {
    const s = årsKortStatus({
      ...bas,
      status: 'MONTHS_PENDING',
      monthsRemaining: ['2026-10', '2026-11'],
    })
    expect(s.kanStänga).toBe(false)
    expect(s.badge).toBe('2 månader kvar')
    expect(s.beskrivning).toMatch(/2026-10, 2026-11/)
  })

  it('MONTHS_PENDING med EN månad kvar böjs i singular', () => {
    const s = årsKortStatus({ ...bas, status: 'MONTHS_PENDING', monthsRemaining: ['2026-11'] })
    expect(s.badge).toBe('1 månad kvar')
  })

  it('SISTA MÅNADEN REDAN STÄNGD är ett EGET fall, inte "månader kvar"', () => {
    // De två har olika orsak och anvisar olika åtgärd. Slås de ihop skickas
    // operatören att stänga månader som redan är stängda.
    const s = årsKortStatus({
      ...bas,
      status: 'MONTHS_PENDING',
      monthsRemaining: [],
      finalMonthClosed: true,
    })
    expect(s.kanStänga).toBe(false)
    expect(s.badge).toBe('Sista månaden stängd')
    expect(s.beskrivning).toMatch(/Öppna månaden igen/)
    expect(s.beskrivning).not.toMatch(/måste stängas först/)
  })
})

describe('bekräftelseGiltig', () => {
  it('kräver exakt årtalet', () => {
    expect(bekräftelseGiltig('2026', 2026)).toBe(true)
    expect(bekräftelseGiltig('2025', 2026)).toBe(false)
    expect(bekräftelseGiltig('', 2026)).toBe(false)
    expect(bekräftelseGiltig('20261', 2026)).toBe(false)
  })

  it('tillåter omgivande blanksteg — klistrat värde ska inte straffas', () => {
    expect(bekräftelseGiltig('  2026 ', 2026)).toBe(true)
  })

  it('BRUTET ÅR bekräftas med ÅRTALET, inte med etiketten', () => {
    // Etiketten är "2026/2027". Att kräva snedstrecket hade gjort bekräftelsen
    // till ett stavningsprov i stället för ett ställningstagande.
    expect(bekräftelseGiltig('2026', 2026)).toBe(true)
    expect(bekräftelseGiltig('2026/2027', 2026)).toBe(false)
  })
})
