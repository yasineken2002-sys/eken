import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ send: vi.fn(), verify: vi.fn(), reconcile: vi.fn() }))
vi.mock('../api/fortnox-export.api', () => ({
  sendFortnoxExport: mocks.send,
  verifyFortnoxExport: mocks.verify,
  reconcileFortnoxExport: mocks.reconcile,
}))
vi.mock('@/lib/api', () => ({
  extractApiError: () => 'Posten i Fortnox stämmer inte med det skickade underlaget',
}))

import { FortnoxExportRowView } from './FortnoxExportRow'
import type { FortnoxExportRow } from '../api/fortnox-export.api'

const H = 'a'.repeat(64)
const row = (
  state: FortnoxExportRow['state'],
  over: Partial<FortnoxExportRow> = {},
): FortnoxExportRow => ({
  id: 'x1',
  journalEntryId: 'je1',
  state,
  blockReason: null,
  draftHash: H,
  updatedAt: '2026-10-02T12:00:00Z',
  ...over,
})
function show(r: FortnoxExportRow, sendingEnabled: boolean) {
  const onChanged = vi.fn(async () => undefined)
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      <ul>
        <FortnoxExportRowView row={r} sendingEnabled={sendingEnabled} onChanged={onChanged} />
      </ul>
    </QueryClientProvider>,
  )
  return onChanged
}

describe('FortnoxExportRowView', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('produktkonfiguration: ingen sändknapp även för READY', () => {
    show(row('DRY_RUN_READY'), false)
    expect(screen.queryByRole('button', { name: /Skicka/ })).toBeNull()
  })

  it('syntetiskt aktiverad: sändning kräver kryssruta och skickar exakt draftHash + confirm', async () => {
    mocks.send.mockResolvedValue(row('CONFIRMED'))
    const changed = show(row('DRY_RUN_READY'), true)
    const btn = screen.getByRole('button', { name: 'Skicka till Fortnox' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(btn)
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith('x1', { draftHash: H, confirm: true }),
    )
    await waitFor(() => expect(changed).toHaveBeenCalled())
  })

  it.each(['UNKNOWN', 'REJECTED', 'RECEIPT_MISMATCH'] as const)(
    '%s: ingen sändknapp, avstämning med exakt identitet',
    async (state) => {
      mocks.reconcile.mockRejectedValue(new Error('409'))
      show(row(state), true)
      expect(screen.queryByRole('button', { name: /Skicka/ })).toBeNull()
      const stam = screen.getByRole('button', { name: 'Stäm av' }) as HTMLButtonElement
      expect(stam.disabled).toBe(true)
      fireEvent.change(screen.getByLabelText('Räkenskapsår-id'), { target: { value: '1' } })
      fireEvent.change(screen.getByLabelText('Serie'), { target: { value: 'A' } })
      fireEvent.change(screen.getByLabelText('Nummer'), { target: { value: '0' } })
      expect(stam.disabled).toBe(true) // nummer 0 är ingen identitet
      fireEvent.change(screen.getByLabelText('Nummer'), { target: { value: '12' } })
      fireEvent.click(stam)
      await waitFor(() =>
        expect(mocks.reconcile).toHaveBeenCalledWith('x1', { year: 1, series: 'A', number: 12 }),
      )
      expect(await screen.findByText(/stämmer inte med det skickade underlaget/)).toBeTruthy()
    },
  )

  it('RECEIPT_IDENTIFIED: kontrollera, inget avstämningsformulär', async () => {
    mocks.verify.mockResolvedValue(row('CONFIRMED'))
    show(
      row('RECEIPT_IDENTIFIED', { externalYear: 1, externalSeries: 'A', externalNumber: 3 }),
      true,
    )
    expect(screen.getByText(/Fortnox-verifikat A3/)).toBeTruthy()
    expect(screen.queryByRole('form', { name: 'Avstämning mot Fortnox' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Kontrollera i Fortnox' }))
    await waitFor(() => expect(mocks.verify).toHaveBeenCalledWith('x1'))
  })

  it('CONFIRMED: inga åtgärder', () => {
    show(row('CONFIRMED', { externalYear: 1, externalSeries: 'A', externalNumber: 1 }), true)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})
