/**
 * F057 · REDIGERA-FLIKEN NÄR DETALJEN INTE HUNNIT FRAM
 *
 * ── FYNDET ──────────────────────────────────────────────────────────────────
 *
 * `UnitsPage.tsx` monterar `UnitDetailPanel` så snart en rad valts, men
 * detaljfrågan (`useUnit`) svarar först senare. Klickar användaren "Redigera"
 * innan svaret kommit monteras `UnitForm` UTAN `defaultValues` och UTAN
 * `propertyId`-prop, och react-hook-form initierar fastighetsfältet till `''`.
 *
 * När detaljen sedan anländer får samma redan monterade formulär en sann
 * `propertyId`-prop. RHF återställer inte sina värden av att `defaultValues`
 * ändras, så fältet står kvar tomt — och nu är väljaren dessutom LÅST, så
 * användaren kan inte rätta det. UUID-regeln stoppar sparningen, och fliken har
 * ingen väg vidare.
 *
 * Det andra ledet — låsningen — kom med F057:s egen rättning. Den här filen
 * finns för att den rättningen inte får göra ett laddningsfall obrukbart.
 *
 * ── VARFÖR SIDAN OCH INTE BARA FORMULÄRET ───────────────────────────────────
 *
 * Felet sitter i VILLKORET för när formuläret monteras, inte i formuläret. Ett
 * prov som bara renderar `UnitForm` med ändrade props hade mätt RHF:s beteende,
 * som redan är känt, och hade förblivit grönt oavsett hur sidan rättas.
 *
 * API-lagret mockas därför på hook-nivå: proven mäter sidans montering, inte
 * att endpointen svarar. Det senare ägs av `unit-property-move.db.spec.ts`.
 */

import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UnitDetail, UnitWithProperty } from './api/units.api'

const FASTIGHET_A = '11111111-1111-4111-8111-111111111111'
const OBJEKT_A = '44444444-4444-4444-8444-444444444444'
const FASTIGHET_B = '22222222-2222-4222-8222-222222222222'
const OBJEKT_B = '55555555-5555-4555-8555-555555555555'

const listrad = (
  id: string,
  propertyId: string,
  namn: string,
  fastighetsnamn: string,
): UnitWithProperty => ({
  id,
  propertyId,
  name: namn,
  unitNumber: '301',
  type: 'APARTMENT',
  status: 'VACANT',
  area: 72,
  floor: 3,
  rooms: 3,
  monthlyRent: 9500,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  property: { id: propertyId, name: fastighetsnamn },
  _count: { leases: 0 },
})

const detalj = (rad: UnitWithProperty): UnitDetail => ({ ...rad, leases: [] })

const RAD_A = listrad(OBJEKT_A, FASTIGHET_A, 'Lägenhet 3A', 'Ekens Gård 1')
const RAD_B = listrad(OBJEKT_B, FASTIGHET_B, 'Lokal 1B', 'Ekens Gård 2')

/** Detaljsvaret styrs per objekt-id, så laddning kan hållas kvar med flit. */
let detaljSvar: Record<string, UnitDetail | undefined> = {}
const uppdateraMock = vi.fn()

vi.mock('./hooks/useUnits', () => ({
  useUnits: () => ({ data: [RAD_A, RAD_B], isLoading: false, isError: false }),
  useUnit: (id: string | null) => ({ data: id ? detaljSvar[id] : undefined }),
  useCreateUnit: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateUnit: () => ({ mutate: uppdateraMock, isPending: false }),
  useDeleteUnit: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/hooks/useCanWrite', () => ({ useCanWrite: () => true }))
vi.mock('@/features/documents/components/DocumentList', () => ({
  DocumentList: () => <div />,
}))
vi.mock('@/features/history/HistoryTab', () => ({ HistoryTab: () => <div /> }))
vi.mock('./components/EquipmentSection', () => ({ EquipmentSection: () => <div /> }))
// Fastighetsväljaren i UnitForm hämtar sina alternativ härifrån.
vi.mock('@/features/properties/hooks/useProperties', () => ({
  useProperties: () => ({
    data: [
      { id: FASTIGHET_A, name: 'Ekens Gård 1' },
      { id: FASTIGHET_B, name: 'Ekens Gård 2' },
    ],
    isLoading: false,
  }),
}))

import { UnitsPage } from './UnitsPage'

function oppnaRedigera(rad: UnitWithProperty) {
  fireEvent.click(screen.getByText(rad.name))
  // Två knappar heter "Redigera": flikremsan och detaljflikens fot. Flikremsan
  // står först i DOM:en och är den väg som når fliken medan detaljen laddar —
  // fotknappen finns bara när detaljfliken redan renderats.
  fireEvent.click(screen.getAllByRole('button', { name: 'Redigera' })[0]!)
}

function fastighetsvaljare(): HTMLSelectElement | null {
  return screen.queryByLabelText('Fastighet') as HTMLSelectElement | null
}

afterEach(() => {
  cleanup()
  detaljSvar = {}
  uppdateraMock.mockReset()
})

describe('F057 · redigeringsfliken och sen detaljladdning', () => {
  it('visar ett laddningsläge i stället för ett tomt, låst fastighetsfält när detaljen dröjer', () => {
    detaljSvar = {} // detaljen har inte svarat än
    const { rerender } = render(<UnitsPage />)
    oppnaRedigera(RAD_A)

    // Under laddningen får det INTE finnas ett låst fastighetsfält med tomt
    // värde — det är fällan: låst och fel, utan väg vidare.
    const underLaddning = fastighetsvaljare()
    if (underLaddning) {
      expect(underLaddning.value).not.toBe('')
    }

    // Svaret anländer.
    detaljSvar = { [OBJEKT_A]: detalj(RAD_A) }
    rerender(<UnitsPage />)

    const efter = fastighetsvaljare()
    expect(efter).not.toBeNull()
    expect(efter!.value).toBe(FASTIGHET_A)
    expect(efter!.disabled).toBe(true)
  })

  it('sparar rätt fastighet efter ett fördröjt detaljsvar', () => {
    detaljSvar = {}
    const { rerender } = render(<UnitsPage />)
    oppnaRedigera(RAD_A)

    detaljSvar = { [OBJEKT_A]: detalj(RAD_A) }
    rerender(<UnitsPage />)

    fireEvent.change(screen.getByLabelText('Enhetsnamn'), { target: { value: 'Nytt namn' } })
    fireEvent.submit(screen.getByRole('button', { name: 'Spara ändringar' }).closest('form')!)

    return Promise.resolve().then(() =>
      new Promise((r) => setTimeout(r, 0)).then(() => {
        expect(uppdateraMock).toHaveBeenCalledTimes(1)
        const dto = uppdateraMock.mock.calls[0]![0] as { propertyId: string; name: string }
        expect(dto.propertyId).toBe(FASTIGHET_A)
        expect(dto.name).toBe('Nytt namn')
      }),
    )
  })

  it('fungerar likadant när detaljen finns direkt', () => {
    detaljSvar = { [OBJEKT_A]: detalj(RAD_A) }
    render(<UnitsPage />)
    oppnaRedigera(RAD_A)

    const valjare = fastighetsvaljare()
    expect(valjare).not.toBeNull()
    expect(valjare!.value).toBe(FASTIGHET_A)
    expect(valjare!.disabled).toBe(true)
  })

  it('återanvänder inte föregående objekts värden när ett annat objekt öppnas', () => {
    detaljSvar = { [OBJEKT_A]: detalj(RAD_A), [OBJEKT_B]: detalj(RAD_B) }
    render(<UnitsPage />)

    oppnaRedigera(RAD_A)
    expect(fastighetsvaljare()!.value).toBe(FASTIGHET_A)
    expect((screen.getByLabelText('Enhetsnamn') as HTMLInputElement).value).toBe('Lägenhet 3A')

    // Stäng och öppna det andra objektet.
    fireEvent.click(screen.getByRole('button', { name: 'Stäng' }))
    oppnaRedigera(RAD_B)

    expect(fastighetsvaljare()!.value).toBe(FASTIGHET_B)
    expect((screen.getByLabelText('Enhetsnamn') as HTMLInputElement).value).toBe('Lokal 1B')
  })

  it('skapa-formuläret har fortfarande en olåst fastighetsväljare', () => {
    detaljSvar = {}
    render(<UnitsPage />)
    fireEvent.click(screen.getByRole('button', { name: /Nytt objekt/ }))

    const valjare = fastighetsvaljare()
    expect(valjare).not.toBeNull()
    expect(valjare!.disabled).toBe(false)
  })
})
