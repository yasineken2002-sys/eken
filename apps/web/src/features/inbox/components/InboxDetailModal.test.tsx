import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'

import { InboxDetailModal } from './InboxDetailModal'

import type { InboxItem } from '../api/inbox.api'

/**
 * BEKRÄFTELSEN — modalens egen mekanik, utan React Query emellan.
 *
 * `InboxPage.test.tsx` äger att sidan KOPPLAR IN modalen; den här filen äger vad
 * modalen GÖR. Att pröva det andra genom sidan hade lagt en mutation mellan
 * knappen och assertionen, och ett rött prov hade då inte sagt vilken av de två
 * som gått sönder.
 */
const item = (over: Partial<InboxItem> = {}): InboxItem =>
  ({
    id: 'a1',
    shadow: true,
    toolName: 'update_maintenance_status',
    toolInput: { ticketId: 'T-1' },
    title: 'Förslag för ärende T-1',
    reasoning: 'Beskrivningen pekar på en läcka.',
    consequence: 'SKUGGLÄGE: ingenting utförs.',
    undoHint: 'Inget att ångra.',
    evidence: [],
    confidence: 0.72,
    prediction: null,
    outcome: null,
    status: 'AWAITING_APPROVAL',
    statusReason: null,
    deadline: '2026-09-12T00:00:00.000Z',
    decidedAt: null,
    createdAt: '2026-09-05T03:00:00.000Z',
    ...over,
  }) as InboxItem

function rendera(over: Partial<InboxItem> = {}) {
  const onDecide = vi.fn()
  render(<InboxDetailModal item={item(over)} onClose={() => undefined} onDecide={onDecide} />)
  return onDecide
}

describe('bekräftelsen är obligatorisk', () => {
  it('Godkänn öppnar bara steget — det beslutar inte', () => {
    const onDecide = rendera()
    fireEvent.click(screen.getByRole('button', { name: 'Godkänn' }))
    expect(onDecide).not.toHaveBeenCalled()
  })

  it('Avvisa öppnar bara steget — det beslutar inte', () => {
    const onDecide = rendera()
    fireEvent.click(screen.getByRole('button', { name: 'Avvisa' }))
    expect(onDecide).not.toHaveBeenCalled()
  })

  it('texten säger att INGENTING utförs — beslutet är ett facit', () => {
    // Skugglägets sanning, utskriven. Utan den godkänner hyresvärden något i
    // tron att det händer, och den missuppfattningen är värre än ett dåligt
    // förslag.
    rendera()
    fireEvent.click(screen.getByRole('button', { name: 'Godkänn' }))
    expect(screen.getByText(/facit, inte en åtgärd/)).toBeTruthy()
  })

  it('Tillbaka stänger steget utan att besluta', () => {
    const onDecide = rendera()
    fireEvent.click(screen.getByRole('button', { name: 'Godkänn' }))
    fireEvent.click(screen.getByRole('button', { name: 'Tillbaka' }))
    expect(onDecide).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Godkänn' })).toBeTruthy()
  })
})

describe('det andra klicket beslutar', () => {
  it('Godkänn → Ja ger APPROVED utan skäl', () => {
    const onDecide = rendera()
    fireEvent.click(screen.getByRole('button', { name: 'Godkänn' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ja, förslaget var rätt' }))
    expect(onDecide).toHaveBeenCalledWith({ id: 'a1', decision: 'APPROVED' })
  })

  it('Avvisa → Ja bär med skälet när det fyllts i', () => {
    const onDecide = rendera()
    fireEvent.click(screen.getByRole('button', { name: 'Avvisa' }))
    fireEvent.change(screen.getByPlaceholderText(/minnesmat/), {
      target: { value: 'Vi har redan bokat.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Ja, avvisa' }))
    expect(onDecide).toHaveBeenCalledWith({
      id: 'a1',
      decision: 'REJECTED',
      reason: 'Vi har redan bokat.',
    })
  })

  it('ett TOMT skäl skickas inte som tom sträng', () => {
    // Fältet är valfritt. En tom sträng hade blivit ett skäl som säger
    // ingenting, och tjänsten kräver ett riktigt skäl vid avslag.
    const onDecide = rendera()
    fireEvent.click(screen.getByRole('button', { name: 'Avvisa' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ja, avvisa' }))
    expect(onDecide).toHaveBeenCalledWith({ id: 'a1', decision: 'REJECTED' })
  })

  it('skälet är begränsat till 500 tecken — samma tak som DTO:n', () => {
    rendera()
    fireEvent.click(screen.getByRole('button', { name: 'Avvisa' }))
    expect(screen.getByPlaceholderText(/minnesmat/).getAttribute('maxlength')).toBe('500')
  })
})

describe('ett REDAN BESLUTAT förslag', () => {
  it('har inga knappar — facit ändras inte i efterhand', () => {
    rendera({ status: 'APPROVED', decidedAt: '2026-09-05T10:00:00.000Z' })
    expect(screen.queryByRole('button', { name: 'Godkänn' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Avvisa' })).toBeNull()
  })

  it('visar människans skäl när det finns', () => {
    rendera({ status: 'REJECTED', statusReason: 'Vi har redan bokat.' })
    expect(screen.getByText('Ditt skäl')).toBeTruthy()
    expect(screen.getByText('Vi har redan bokat.')).toBeTruthy()
  })
})
