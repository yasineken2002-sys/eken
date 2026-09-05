import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'

import { ShadowAgentSection } from './ShadowAgentSection'

/**
 * VÄXELN — synlig för ägaren, dold för alla andra.
 *
 * Provet mäter GRÄNSSNITTETS halva av grinden. Den andra halvan — att API:t
 * avvisar en icke-ägare med 403 — ägs av
 * `apps/api/src/organizations/shadow-agent-field-authz.spec.ts`. Att bara dölja
 * knappen hade varit en artighet, inte en spärr, och det står i komponentens fil.
 */
const rendera = (over: Partial<Parameters<typeof ShadowAgentSection>[0]> = {}) => {
  const onToggle = vi.fn()
  render(
    <ShadowAgentSection roll="OWNER" pa={false} onToggle={onToggle} antalForslag={12} {...over} />,
  )
  return onToggle
}

describe('vem som ser växeln', () => {
  it('OWNER ser den', () => {
    rendera()
    expect(screen.getByRole('button', { name: /skuggagenten/i })).toBeTruthy()
  })

  it.each(['ADMIN', 'MANAGER', 'ACCOUNTANT', 'VIEWER', undefined])('%s ser den INTE', (roll) => {
    rendera({ roll })
    expect(screen.queryByRole('button', { name: /skuggagenten/i })).toBeNull()
  })

  it('en icke-ägare får veta VARFÖR växeln saknas', () => {
    // Ett dolt reglage utan förklaring läses som ett fel i gränssnittet.
    rendera({ roll: 'ADMIN' })
    expect(screen.getByText(/Bara organisationens ägare/)).toBeTruthy()
  })

  it('en icke-ägare ser ändå antalet förslag', () => {
    // Hen ska kunna se ATT agenten är på utan att kunna ändra det.
    rendera({ roll: 'ADMIN' })
    expect(screen.getByText('12 förslag hittills.')).toBeTruthy()
  })
})

describe('texten säger vad agenten INTE gör', () => {
  it('nämner att ingenting utförs', () => {
    rendera()
    expect(screen.getByText(/utför\s+ingenting/)).toBeTruthy()
  })
})

describe('antalet förslag', () => {
  it('visar ett hämtningsläge i stället för noll', () => {
    // `0 förslag` medan summan hämtas hade varit ett påstående, inte ett läge.
    rendera({ antalForslag: undefined })
    expect(screen.getByText(/Hämtar antal förslag/)).toBeTruthy()
  })

  it('visar noll när det verkligen är noll', () => {
    rendera({ antalForslag: 0 })
    expect(screen.getByText('0 förslag hittills.')).toBeTruthy()
  })
})

describe('växeln', () => {
  it('slår PÅ när den är av', () => {
    const onToggle = rendera({ pa: false })
    fireEvent.click(screen.getByRole('button', { name: /skuggagenten/i }))
    expect(onToggle).toHaveBeenCalledWith(true)
  })

  it('slår AV när den är på', () => {
    const onToggle = rendera({ pa: true })
    fireEvent.click(screen.getByRole('button', { name: /skuggagenten/i }))
    expect(onToggle).toHaveBeenCalledWith(false)
  })

  it('går inte att klicka medan den sparar', () => {
    const onToggle = rendera({ sparar: true })
    fireEvent.click(screen.getByRole('button', { name: /skuggagenten/i }))
    expect(onToggle).not.toHaveBeenCalled()
  })
})
