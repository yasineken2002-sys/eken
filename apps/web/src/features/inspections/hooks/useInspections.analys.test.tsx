/**
 * MISSLYCKAD AI-ANALYS LÄSER OM BESIKTNINGEN (slutpaketets E3c)
 *
 * Servern sparar bilderna FÖRE AI-anropet (`saveAnalysisImages` → `analyzeImages`
 * i inspections.controller). Ett försök som svarar 400 kan alltså ha lagt till
 * bilagor. Kroken ska därför läsa om `['inspections']` även vid fel — annars syns
 * inte den sparade bilden, och ett nytt försök laddar upp samma bild igen.
 *
 * ── VAD PROVET INTE KAN SE ──────────────────────────────────────────────────
 *
 * Att servern faktiskt har sparat bilden, och att panelen visar den. Det bärs av
 * slutpaketets webbläsarsond (analys-sond: riktig 400 från API:t, rad i
 * InspectionImage, "Bilagornas innehåll" synlig utan omladdning). Här mäts bara
 * att kroken begär omläsningen i båda utfallen.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as InspectionsApi from '../api/inspections.api'

const analyzeInspection = vi.fn()
vi.mock('../api/inspections.api', async (orig) => ({
  ...(await orig<typeof InspectionsApi>()),
  analyzeInspection: (...a: unknown[]) => analyzeInspection(...a),
}))

import { useAnalyzeInspection } from './useInspections'

function rigg() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const invalidate = vi.spyOn(qc, 'invalidateQueries')
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(() => useAnalyzeInspection(), { wrapper })
  const lasteOm = () =>
    invalidate.mock.calls.filter(([f]) => JSON.stringify(f?.queryKey) === '["inspections"]').length
  return { result, lasteOm }
}

const bild = { file: new File([new Uint8Array([1, 2, 3])], 'b.png', { type: 'image/png' }) }

afterEach(() => analyzeInspection.mockReset())

describe('useAnalyzeInspection — omläsning efter försöket', () => {
  it('läser om besiktningarna när analysen MISSLYCKAS (bilderna kan redan vara sparade)', async () => {
    analyzeInspection.mockRejectedValueOnce(new Error('Request failed with status code 400'))
    const { result, lasteOm } = rigg()
    await act(async () => {
      await result.current.mutateAsync({ id: 'b1', files: [bild] }).catch(() => undefined)
    })
    expect(lasteOm()).toBe(1)
  })

  it('läser om besiktningarna när analysen LYCKAS (positiv kontroll, oförändrat beteende)', async () => {
    analyzeInspection.mockResolvedValueOnce({ analysis: {}, updatedItems: 0, createdItems: 0 })
    const { result, lasteOm } = rigg()
    await act(async () => {
      await result.current.mutateAsync({ id: 'b1', files: [bild] })
    })
    expect(lasteOm()).toBe(1)
  })
})
