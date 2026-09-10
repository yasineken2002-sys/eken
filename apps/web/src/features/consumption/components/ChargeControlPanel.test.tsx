import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChargeControl } from '@eken/shared'
import { ChargeControlPanel } from './ChargeControlPanel'

// UI-kontrakt; DB/bokföring bevisas separat i charge-gate.db.spec.ts.
const api = vi.hoisted(() => ({ control: vi.fn(), confirm: vi.fn() }))
vi.mock('../api/charges.api', () => ({
  fetchChargeControl: api.control,
  confirmCharge: api.confirm,
}))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})
const control = (overrides: Partial<ChargeControl> = {}): ChargeControl => ({
  chargeId: 'charge',
  readingId: 'reading',
  fingerprint: 'a'.repeat(64),
  ruleVersion: 'rule',
  allowed: true,
  problems: [],
  findingCount: 0,
  hasCurrentCheck: false,
  ...overrides,
})
function mount() {
  const onReview = vi.fn()
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <ChargeControlPanel chargeId="charge" onReview={onReview} />
    </QueryClientProvider>,
  )
  return { onReview }
}
it('blockerad post förklarar varningen och öppnar Granskning', async () => {
  api.control.mockResolvedValue(
    control({
      allowed: false,
      findingCount: 1,
      problems: ['Avläsning reading (HIGH_RATE) behöver aktuellt intyg.'],
    }),
  )
  const { onReview } = mount()
  await screen.findByText('Avläsning reading (HIGH_RATE) behöver aktuellt intyg.')
  expect(
    (screen.getByRole('button', { name: 'Bekräfta och bokför' }) as HTMLButtonElement).disabled,
  ).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Öppna Granskning' }))
  expect(onReview).toHaveBeenCalledOnce()
  expect(api.confirm).not.toHaveBeenCalled()
})
it('konfirmerar bara den uttryckligen lästa kontrollens fingerprint', async () => {
  api.control.mockResolvedValue(control())
  api.confirm.mockResolvedValue({ id: 'charge' })
  mount()
  const check = await screen.findByRole('checkbox')
  const submit = screen.getByRole('button', { name: 'Bekräfta och bokför' })
  expect((submit as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(check)
  fireEvent.click(submit)
  await screen.findByText('Kontrollen och konfirmeringen har sparats.')
  expect(api.confirm.mock.calls[0]).toEqual(['charge', { expectedFingerprint: 'a'.repeat(64) }])
})
it('409 bevarar valet men kräver omläsning och ett nytt uttryckligt val', async () => {
  api.control.mockResolvedValue(control())
  api.confirm.mockRejectedValue({
    isAxiosError: true,
    response: {
      status: 409,
      data: { error: { message: 'Underlaget ändrat. Läs om kontrollen.' } },
    },
  })
  mount()
  fireEvent.click(await screen.findByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Bekräfta och bokför' }))
  await screen.findByText('Underlaget ändrat. Läs om kontrollen.')
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  expect(
    (screen.getByRole('button', { name: 'Bekräfta och bokför' }) as HTMLButtonElement).disabled,
  ).toBe(true)
  api.control.mockResolvedValue(control({ fingerprint: 'b'.repeat(64) }))
  fireEvent.click(screen.getByRole('button', { name: 'Läs om kontrollen' }))
  await waitFor(() => expect(api.control).toHaveBeenCalledTimes(2))
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  api.confirm.mockResolvedValue({ id: 'charge' })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Bekräfta och bokför' }))
  await screen.findByText('Kontrollen och konfirmeringen har sparats.')
  expect(api.confirm.mock.calls[1]).toEqual(['charge', { expectedFingerprint: 'b'.repeat(64) }])
})
