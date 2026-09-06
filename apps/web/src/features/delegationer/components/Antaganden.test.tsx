import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Antagande } from '../api/delegationer.api'

/**
 * ANTAGANDEN — den andra halvan av "se vad systemet tror om hen".
 *
 * Proven mäter att sektionen SÄGER att antagandena inte används, att båda
 * svaren finns per rad, och att ett tomt läge är ett utfall och inte en
 * försvunnen sektion.
 *
 * Vad de INTE mäter: att servern faktiskt slutar läsa posten. Det ägs av
 * `memory-provenance.db.spec.ts` mot riktig Postgres.
 */
const hamta = vi.fn()
const bekraftaMock = vi.fn()
const avvisaMock = vi.fn()

vi.mock('../api/delegationer.api', () => ({
  fetchAntaganden: (...a: unknown[]) => hamta(...a),
  bekraftaAntagande: (...a: unknown[]) => bekraftaMock(...a),
  avvisaAntagande: (...a: unknown[]) => avvisaMock(...a),
}))

import { Antaganden } from './Antaganden'

const post = (over: Partial<Antagande> = {}): Antagande => ({
  id: 'm1',
  key: 'Bekräftelse före åtgärd',
  value: 'Vill alltid bekräfta innan utskick',
  type: 'preference',
  createdAt: '2026-07-26T00:00:00.000Z',
  updatedAt: '2026-07-26T00:00:00.000Z',
  ...over,
})

function rendera() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <Antaganden />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  hamta.mockReset()
  bekraftaMock.mockReset()
  avvisaMock.mockReset()
  bekraftaMock.mockResolvedValue(undefined)
  avvisaMock.mockResolvedValue(undefined)
  hamta.mockResolvedValue([post()])
})

describe('sektionen säger vad den är', () => {
  it('SKRIVER UT att antagandena inte används förrän de bekräftats', async () => {
    // Utan meningen ser listan ut som vad agenten redan använder — alltså
    // motsatsen till vad den är.
    rendera()
    expect(await screen.findByText(/används av\s+agenten förrän du bekräftat det/)).toBeTruthy()
  })

  it('säger att ett nej SPARAS — inte att posten försvinner', async () => {
    rendera()
    expect(await screen.findByText(/sparas som ett nej/)).toBeTruthy()
  })

  it('visar både nyckeln och värdet — en nyckel ensam går inte att svara på', async () => {
    rendera()
    expect(await screen.findByText('Bekräftelse före åtgärd')).toBeTruthy()
    expect(screen.getByText('Vill alltid bekräfta innan utskick')).toBeTruthy()
  })
})

describe('svaren', () => {
  it('Bekräfta skickar postens id', async () => {
    rendera()
    fireEvent.click(await screen.findByRole('button', { name: 'Bekräfta' }))
    await waitFor(() => expect(bekraftaMock.mock.calls[0]?.[0]).toBe('m1'))
    expect(avvisaMock).not.toHaveBeenCalled()
  })

  it('Avvisa skickar postens id', async () => {
    rendera()
    fireEvent.click(await screen.findByRole('button', { name: 'Avvisa' }))
    await waitFor(() => expect(avvisaMock.mock.calls[0]?.[0]).toBe('m1'))
    expect(bekraftaMock).not.toHaveBeenCalled()
  })

  it('BÅDA svaren finns per rad — en lista med bara Bekräfta lär bara av ja:n', async () => {
    hamta.mockResolvedValue([post({ id: 'a' }), post({ id: 'b' })])
    rendera()
    await screen.findAllByText('Bekräftelse före åtgärd')
    expect(screen.getAllByRole('button', { name: 'Bekräfta' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'Avvisa' })).toHaveLength(2)
  })
})

describe('tomt är ett utfall', () => {
  it('sektionen finns kvar och säger att inget väntar', async () => {
    hamta.mockResolvedValue([])
    rendera()
    expect(await screen.findByText('Inga antaganden väntar på svar.')).toBeTruthy()
    // RUBRIKEN STÅR KVAR: att sektionen försvann hade gjort "inget att svara på"
    // oskiljbart från "funktionen finns inte".
    expect(screen.getByText('Antaganden')).toBeTruthy()
  })
})
