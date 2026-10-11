/**
 * F-LIST-1 / BYGGLEDARE-CI-021: den sidvisa huvudboken ska nås av samma invalidering som
 * årsstängning, rättelse och manuell post gör (['accounting','journal']). Annars syns ett
 * nytt verifikat (t.ex. bokslutets resultatavräkning) först efter omladdning.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

const sida = vi.fn(async () => ({ entries: [], total: 0, offset: 0, limit: 100 }))
vi.mock('../api/accounting.api', async (orig) => ({
  ...(await orig<object>()),
  fetchJournalPage: () => sida(),
}))

import { useJournalPages } from './useAccounting'

describe('useJournalPages och invalideringen', () => {
  it('invalidering av [accounting, journal] hämtar om den sidvisa listan', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useJournalPages(), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(sida).toHaveBeenCalledTimes(1)
    await qc.invalidateQueries({ queryKey: ['accounting', 'journal'] })
    await waitFor(() => expect(sida).toHaveBeenCalledTimes(2))
  })
})
