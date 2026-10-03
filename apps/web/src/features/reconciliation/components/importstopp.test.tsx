/**
 * IMPORTSTOPP-009 (FORTNOX-100): kortet visar det filen sa — okända fält som "okänt" —
 * och upplösning kräver behörighet och motivering. Hela kedjan (verklig påminnelse
 * pausad/släppt) mäts i import-reminder-reproduction.db.spec.ts (IS-A–G).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Importstopp } from '../api/reconciliation.api'

let öppna: Importstopp[] = []
let alla: Importstopp[] = []
let kanSkriva = true
const lösMutate = vi.fn()

vi.mock('../hooks/useReconciliation', () => ({
  useImportStops: (status: 'open' | 'all') => ({ data: status === 'open' ? öppna : alla }),
  useResolveImportStop: () => ({ mutate: lösMutate, isPending: false, error: null }),
}))
vi.mock('@/hooks/useCanWrite', () => ({ useCanWrite: () => kanSkriva }))

import { ImportStopsCard } from './ImportStopsCard'

const bas: Importstopp = {
  id: 's1',
  kind: 'BGMAX',
  fileName: 'F1.txt',
  scope: 'BETALARE',
  reasonCode: 'AVDRAG_BETALARE',
  message: 'Betalningsdag 20261102: betalare med bankgiro 0051234567 har 1 betalning(ar) …',
  paymentDate: '2026-11-02T00:00:00.000Z',
  amount: 9108,
  reference: '00000000849, KREDIT-1',
  payerBankgiro: '0051234567',
  createdAt: '2026-11-03T08:00:00.000Z',
  resolvedAt: null,
  resolvedById: null,
  resolutionNote: null,
  bankAccount: { id: 'k', name: 'Hyreskonto', accountNumber: null },
}

beforeEach(() => {
  öppna = []
  alla = []
  kanSkriva = true
  lösMutate.mockReset()
})
afterEach(cleanup)

describe('ImportStopsCard (IMPORTSTOPP-009)', () => {
  it('syns inte när inga stopp finns', () => {
    const { container } = render(<ImportStopsCard />)
    expect(container.textContent).toBe('')
  })

  it('visar orsak, konto, fil, dag, belopp och betalare; säger att kraven är pausade', () => {
    öppna = [bas]
    alla = [bas]
    render(<ImportStopsCard />)
    expect(screen.getByText(/1 olöst\(a\) importstopp/).textContent).toMatch(/pausade/)
    expect(screen.getByText('En betalare importerades inte')).toBeTruthy()
    expect(screen.getByText('Hyreskonto')).toBeTruthy()
    expect(screen.getByText('F1.txt')).toBeTruthy()
    expect(screen.getByText('0051234567')).toBeTruthy()
  })

  it('filstopp: okända fält visas som okänt — inget gissat belopp eller datum', () => {
    const fil = {
      ...bas,
      id: 's2',
      scope: 'FIL' as const,
      reasonCode: 'FILRAM',
      paymentDate: null,
      amount: null,
      reference: null,
      payerBankgiro: null,
    }
    öppna = [fil]
    alla = [fil]
    render(<ImportStopsCard />)
    expect(screen.getByText('Hela filen importerades inte')).toBeTruthy()
    expect(screen.getAllByText('okänt')).toHaveLength(2)
  })

  it('upplösning kräver minst 10 teckens motivering och skickar den', () => {
    öppna = [bas]
    alla = [bas]
    render(<ImportStopsCard />)
    fireEvent.click(screen.getByRole('button', { name: /Markera hanterat…/ }))
    const knapp = screen.getByRole('button', { name: /^Markera hanterat$/ }) as HTMLButtonElement
    fireEvent.change(screen.getByLabelText(/Hur har stoppet hanterats/), {
      target: { value: 'kort' },
    })
    expect(knapp.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Hur har stoppet hanterats/), {
      target: { value: 'Registrerad manuellt mot kreditfakturan' },
    })
    fireEvent.click(knapp)
    expect(lösMutate).toHaveBeenCalledWith({
      id: 's1',
      note: 'Registrerad manuellt mot kreditfakturan',
    })
  })

  it('utan skrivroll går stoppet att se men inte lösa', () => {
    kanSkriva = false
    öppna = [bas]
    alla = [bas]
    render(<ImportStopsCard />)
    expect(screen.queryByRole('button', { name: /Markera hanterat/ })).toBeNull()
  })

  it('historiken visar vem som löst och varför (motiveringen)', () => {
    const löst = {
      ...bas,
      resolvedAt: '2026-11-04T09:00:00.000Z',
      resolvedById: 'u1',
      resolutionNote: 'Hanterad mot kreditfaktura K-1',
    }
    alla = [löst]
    render(<ImportStopsCard />)
    fireEvent.click(screen.getByRole('button', { name: /Historik \(1\)/ }))
    expect(screen.getByText(/Motivering: Hanterad mot kreditfaktura K-1/)).toBeTruthy()
  })
})
