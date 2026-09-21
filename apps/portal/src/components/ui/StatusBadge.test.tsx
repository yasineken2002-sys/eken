import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusBadge } from './StatusBadge'

/**
 * #913 — INGEN STATUS FÅR RENDERAS SOM RÅTT ENUM-NAMN.
 *
 * `StatusBadge` faller tillbaka på `{ label: status }` för okända värden. Det
 * är rätt som skyddsnät men betyder att en glömd etikett blir synlig engelsk
 * versaltext i hyresgästens vy. SENT_TO_COLLECTION var en sådan, och den når
 * portalen: `getInvoices` filtrerar bara bort DRAFT.
 */

const FAKTURASTATUSAR = [
  'DRAFT',
  'SENT',
  'PARTIAL',
  'PAID',
  'OVERDUE',
  'VOID',
  'SENT_TO_COLLECTION',
] as const

describe('StatusBadge — fakturastatusar', () => {
  it('SENT_TO_COLLECTION visas som "Hos inkasso", samma ord som i web/admin', () => {
    render(<StatusBadge type="invoice" status="SENT_TO_COLLECTION" />)
    expect(screen.getByText('Hos inkasso')).toBeTruthy()
  })

  it('INGEN av fakturastatusarna renderas som sitt enum-namn', () => {
    for (const status of FAKTURASTATUSAR) {
      const { unmount } = render(<StatusBadge type="invoice" status={status} />)
      // Kanariefågel: provet ska kunna falla. Ett påhittat värde SKA visas rått,
      // annars mäter slingan ovan ingenting.
      expect(screen.queryByText(status)).toBeNull()
      unmount()
    }
    render(<StatusBadge type="invoice" status="PAHITTAT_VARDE" />)
    expect(screen.getByText('PAHITTAT_VARDE')).toBeTruthy()
  })
})
