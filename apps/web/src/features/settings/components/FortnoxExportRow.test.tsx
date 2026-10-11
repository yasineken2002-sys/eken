import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  verify: vi.fn(),
  reconcile: vi.fn(),
  release: vi.fn(),
  scan: vi.fn(),
}))
vi.mock('../api/fortnox-export.api', () => ({
  sendFortnoxExport: mocks.send,
  verifyFortnoxExport: mocks.verify,
  reconcileFortnoxExport: mocks.reconcile,
  releaseRejectedFortnoxExport: mocks.release,
  reconcileScanFortnoxExport: mocks.scan,
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
      expect(screen.getByText(/Gäller Evenos verifikat je1/)).toBeTruthy() // K-S5
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

  // ── TESTKUND-016 ──────────────────────────────────────────────────────────────────────────
  it('visar «Exporteras som» och originaltexten när exporttexten skiljer sig', () => {
    show(
      row('DRY_RUN_READY', {
        exportText: [
          {
            falt: 'Description',
            rad: null,
            originaltext: 'Leverantörsfaktura: ACME — reparation',
            exporttext: 'Leverantörsfaktura: ACME – reparation',
          },
        ],
      }),
      false,
    )
    expect(screen.getByText('Leverantörsfaktura: ACME – reparation')).toBeTruthy()
    expect(screen.getByText(/Originaltext: Leverantörsfaktura: ACME — reparation/)).toBeTruthy()
  })

  it('stoppskälet TEXT_NOT_EXPORTABLE visas i klartext', () => {
    show(
      row('BLOCKED', {
        draftHash: null,
        blockReason:
          'TEXT_NOT_EXPORTABLE: Texten i Description innehåller tecken som Fortnox inte tar emot: «"» (U+0022). Ändra texten i Eveno före export.',
      }),
      false,
    )
    expect(screen.getByText(/U\+0022/)).toBeTruthy()
  })

  it('REJECTED_400_2000359: frisläppning kräver skäl och skickar exakt skälet', async () => {
    mocks.release.mockResolvedValue(row('BLOCKED'))
    const changed = show(row('REJECTED', { lastOutcome: 'REJECTED_400_2000359' }), false)
    expect(screen.getByText(/HTTP 400, kod 2000359/)).toBeTruthy()
    const btn = screen.getByRole('button', {
      name: 'Frisläpp för ny förhandskontroll',
    }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Skäl'), { target: { value: 'Texten är rättad' } })
    fireEvent.click(btn)
    await waitFor(() =>
      expect(mocks.release).toHaveBeenCalledWith('x1', { reason: 'Texten är rättad' }),
    )
    await waitFor(() => expect(changed).toHaveBeenCalled())
  })

  it.each([
    ['REJECTED_429_NA', 'RATE_LIMIT'],
    ['REJECTED_400_NA', 'NOT_PROVEN'],
    ['REJECTED_400_1000003', 'NOT_PROVEN'],
    ['REJECTED_400_9999999', 'NOT_PROVEN'],
    ['REJECTED_403_2000359', 'NOT_PROVEN'],
    ['REJECTED_401_2000359', 'NOT_PROVEN'],
    ['REJECTED_404_2000359', 'NOT_PROVEN'],
    ['REJECTED', 'LEGACY'],
  ])('%s: ingen frisläppningsknapp, bara förklaring (%s)', (lastOutcome, kind) => {
    show(row('REJECTED', { lastOutcome }), false)
    expect(screen.queryByRole('button', { name: /Frisläpp/ })).toBeNull()
    expect(document.querySelector(`[data-rejection-kind="${kind}"]`)).not.toBeNull()
  })

  it('UNKNOWN: aldrig frisläppning', () => {
    show(row('UNKNOWN', { lastOutcome: 'OUTCOME_UNKNOWN' }), false)
    expect(screen.queryByRole('button', { name: /Frisläpp/ })).toBeNull()
  })

  it('TESTKUND-035: UNKNOWN_429 förklaras; sökning utan träff visar tid, räckvidd och nästa säkra steg; ingen sändning eller frisläppning', async () => {
    mocks.scan.mockResolvedValue({
      ...row('UNKNOWN', { lastOutcome: 'UNKNOWN_429' }),
      avstamning: {
        utfall: 'EJ_HITTAD',
        at: '2026-10-09T22:30:00Z',
        financialYear: 3,
        verifikatLasta: 41,
        sidor: 1,
      },
    })
    show(row('UNKNOWN', { lastOutcome: 'UNKNOWN_429' }), true)
    expect(screen.getByText(/Fortnox svarade 429 \(för många anrop\)/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Skicka/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Frisläpp/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sök efter verifikatet i Fortnox' }))
    await waitFor(() => expect(mocks.scan).toHaveBeenCalledWith('x1'))
    const text = await screen.findByText(/Ingen post från det här verifikatet hittades/)
    expect(text.textContent).toMatch(/räkenskapsår-id 3, alla serier, 41 verifikat lästa/)
    expect(text.textContent).toMatch(/fortfarande okänt/)
    expect(text.textContent).toMatch(/Bokför inte verifikatet för hand/)
  })

  it('TESTKUND-035: äldre REJECTED_429 kan sökas men aldrig frisläppas', () => {
    show(row('REJECTED', { lastOutcome: 'REJECTED_429_NA' }), true)
    expect(screen.getByRole('button', { name: 'Sök efter verifikatet i Fortnox' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Frisläpp/ })).toBeNull()
  })

  it('TESTKUND-020 K-KP-2: en icke belagd avvisning beskrivs sant, inte som innehållsfel', () => {
    show(row('REJECTED', { lastOutcome: 'REJECTED_403_2000359' }), false)
    expect(
      screen.getByText(
        /Avvisningen är inte en belagd innehållsavvisning \(http 403, kod 2000359\)/,
      ),
    ).toBeTruthy()
    expect(screen.queryByText(/Fortnox avvisade innehållet/)).toBeNull()
  })
})
