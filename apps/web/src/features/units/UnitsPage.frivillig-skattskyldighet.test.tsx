/**
 * I2 · DETALJVYN VISAR DEN SPARADE FLAGGAN, INTE LISTRADEN FRÅN KLICKET
 *
 * Uppmätt i webbläsaren (CLAUDE2 4L, efter-1): efter att "Objektet är
 * frivilligt skattskyldigt för moms" sparats visade detaljvyn "Nej". Raden läste
 * `selected` — listraden som fångades vid klicket — medan sparningen bara
 * invaliderar list- och detaljfrågan. Raden läser nu detaljfrågan.
 *
 * Hookarna mockas som i UnitsPage.redigera-laddning.test.tsx: provet mäter vad
 * sidan visar ur listrad respektive detaljsvar, inte att endpointen svarar.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UnitDetail, UnitWithProperty } from './api/units.api'

const FASTIGHET = '11111111-1111-4111-8111-111111111111'
const KONTOR = '44444444-4444-4444-8444-444444444444'
const LGH = '55555555-5555-4555-8555-555555555555'

const rad = (
  id: string,
  namn: string,
  type: UnitWithProperty['type'],
  flagga: boolean,
): UnitWithProperty => ({
  id,
  propertyId: FASTIGHET,
  name: namn,
  unitNumber: id.slice(0, 4),
  type,
  status: 'VACANT',
  area: 40,
  floor: 1,
  rooms: null,
  monthlyRent: 12000,
  voluntaryTaxLiability: flagga,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  property: { id: FASTIGHET, name: 'Ekens Gård 1' },
  _count: { leases: 0 },
})

// Listraden säger fortfarande "av" — som direkt efter en sparning.
const KONTOR_LISTA = rad(KONTOR, 'Kontor 0101', 'OFFICE', false)
const LGH_LISTA = rad(LGH, 'Lägenhet 1101', 'APARTMENT', false)
let detaljSvar: Record<string, UnitDetail | undefined> = {}

vi.mock('./hooks/useUnits', () => ({
  useUnits: () => ({ data: [KONTOR_LISTA, LGH_LISTA], isLoading: false, isError: false }),
  useUnit: (id: string | null) => ({
    data: id ? detaljSvar[id] : undefined,
    isError: false,
    refetch: vi.fn(),
  }),
  useCreateUnit: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateUnit: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteUnit: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('@/hooks/useCanWrite', () => ({ useCanWrite: () => true }))
vi.mock('@/features/documents/components/DocumentList', () => ({ DocumentList: () => <div /> }))
vi.mock('@/features/history/HistoryTab', () => ({ HistoryTab: () => <div /> }))
vi.mock('./components/EquipmentSection', () => ({ EquipmentSection: () => <div /> }))
vi.mock('@/features/properties/hooks/useProperties', () => ({
  useProperties: () => ({ data: [{ id: FASTIGHET, name: 'Ekens Gård 1' }], isLoading: false }),
}))

import { UnitsPage } from './UnitsPage'

afterEach(() => {
  cleanup()
  detaljSvar = {}
})

const rutan = () => screen.queryByText('Frivillig skattskyldighet')?.parentElement ?? null

describe('I2 · frivillig skattskyldighet i objektets detaljvy', () => {
  it('lokal: visar detaljsvarets värde (Ja) även när listraden fortfarande säger Nej', () => {
    detaljSvar = { [KONTOR]: { ...KONTOR_LISTA, voluntaryTaxLiability: true, leases: [] } }
    render(<UnitsPage />)
    fireEvent.click(screen.getByText('Kontor 0101'))
    expect(rutan()?.textContent).toContain('Ja')
  })

  it('lokal utan flaggan: Nej', () => {
    detaljSvar = { [KONTOR]: { ...KONTOR_LISTA, leases: [] } }
    render(<UnitsPage />)
    fireEvent.click(screen.getByText('Kontor 0101'))
    expect(rutan()?.textContent).toContain('Nej')
  })

  it('bostad: ingen rad om frivillig skattskyldighet', () => {
    detaljSvar = { [LGH]: { ...LGH_LISTA, leases: [] } }
    render(<UnitsPage />)
    fireEvent.click(screen.getByText('Lägenhet 1101'))
    expect(screen.queryByText('Frivillig skattskyldighet')).toBeNull()
  })
})
