import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { BalanceSheet } from '@eken/shared'
import { BalanceSheetView } from './ReportsPage'

afterEach(cleanup)

// F-TK-1 (TESTKUND-20261004): ej bokslutat resultat visas som en märkt BERÄKNAD rad, och korrekt
// bokföring påstås inte vara obalanserad. En verklig differens visas fortfarande.
const bas: BalanceSheet = {
  asOf: '2026-10-04',
  assets: { total: 786850, accounts: [{ number: 1510, name: 'Kundfordringar', balance: 786850 }] },
  liabilitiesAndEquity: { total: 786850, accounts: [] },
  calculatedResult: { amount: 786850, label: 'Beräknat resultat (ej bokslutat)' },
  difference: 0,
  oppningskomponent: null,
}

describe('balansräkningens beräknade resultat', () => {
  it('visar raden märkt BERÄKNAD och ingen obalans när differensen är 0', () => {
    render(<BalanceSheetView data={bas} />)
    expect(screen.getByText(/Beräknat resultat \(ej bokslutat\)/)).toBeDefined()
    expect(screen.getByText('BERÄKNAD, inget verifikat')).toBeDefined()
    expect(screen.queryByText(/boken balanserar inte/)).toBeNull()
    expect(screen.getByText(/Balansräkningen balanserar/)).toBeDefined()
  })
  it('en verklig differens visas fortfarande', () => {
    render(<BalanceSheetView data={{ ...bas, difference: 100 }} />)
    expect(screen.getByText(/boken balanserar inte/)).toBeDefined()
  })
  it('nollresultat ger ingen beräknad rad', () => {
    render(
      <BalanceSheetView
        data={{
          ...bas,
          calculatedResult: { amount: 0, label: 'Beräknat resultat (ej bokslutat)' },
        }}
      />,
    )
    expect(screen.queryByText('BERÄKNAD, inget verifikat')).toBeNull()
  })
})
