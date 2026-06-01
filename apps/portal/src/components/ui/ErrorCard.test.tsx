import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ErrorCard } from './ErrorCard'

describe('ErrorCard', () => {
  it('visar felmeddelande + funkande retry-knapp vid äkta API-fel', () => {
    const onRetry = vi.fn()
    render(<ErrorCard message="Kunde inte ladda avier" onRetry={onRetry} />)

    // Felmeddelandet renderas, inte "under uppbyggnad"-texten.
    expect(screen.getByText('Kunde inte ladda avier')).toBeInTheDocument()
    expect(screen.queryByText(/under uppbyggnad/i)).not.toBeInTheDocument()

    // Retry-knappen finns och anropar onRetry vid klick.
    const retry = screen.getByRole('button', { name: 'Försök igen' })
    retry.click()
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('visar INTE retry-knapp i isUnderConstruction-läget (även om onRetry skickas)', () => {
    const onRetry = vi.fn()
    render(<ErrorCard isUnderConstruction onRetry={onRetry} />)

    // "Under uppbyggnad"-läget visas...
    expect(screen.getByText('Funktionen är under uppbyggnad')).toBeInTheDocument()
    // ...och retry-knappen renderas aldrig, så användaren kan inte klicka.
    expect(screen.queryByRole('button', { name: 'Försök igen' })).not.toBeInTheDocument()
    expect(onRetry).not.toHaveBeenCalled()
  })
})
