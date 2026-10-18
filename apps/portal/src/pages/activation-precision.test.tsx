import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useSessionStore } from '@/store/session.store'
import type { PortalActivationInfo } from '@/types/portal.types'
import { ActivatePage } from './ActivatePage/ActivatePage'

// Avsiktlig API-leafmock: provet isolerar riktig sidrender/formatterare, inte HTTP eller DB.
const api = vi.hoisted(() => ({
  fetchActivationInfo: vi.fn<(token: string) => Promise<PortalActivationInfo>>(),
  fetchActivationContract: vi.fn(),
  activateAccount: vi.fn(),
}))
vi.mock('@/api/portal.api', () => api)
const TOKEN = 'synthetic-activation-amounts'
const clients: QueryClient[] = []

function info(monthlyRent: number, depositAmount: number): PortalActivationInfo {
  return {
    tenant: {
      id: 'synthetic-tenant',
      type: 'INDIVIDUAL',
      firstName: 'Alicia',
      lastName: 'Prov',
      companyName: null,
      email: 'activation@example.invalid',
    },
    organization: { id: 'synthetic-org', name: 'Syntetisk hyresvärd' },
    lease: {
      id: 'synthetic-lease',
      status: 'ACTIVE',
      startDate: '2026-01-01',
      endDate: null,
      monthlyRent,
      depositAmount,
      noticePeriodMonths: 3,
      leaseType: 'INDEFINITE',
      unit: {
        id: 'synthetic-unit',
        name: 'Bostad A',
        unitNumber: '1001',
        property: {
          name: 'Fastighet A',
          street: 'Provvägen 1',
          city: 'Provstad',
          postalCode: '12345',
        },
      },
    },
  }
}
async function show(monthlyRent: number, depositAmount: number) {
  api.fetchActivationInfo.mockResolvedValue(info(monthlyRent, depositAmount))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  clients.push(client)
  render(
    <MemoryRouter
      initialEntries={[`/activate?token=${TOKEN}`]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <QueryClientProvider client={client}>
        <ActivatePage />
      </QueryClientProvider>
    </MemoryRouter>,
  )
  await screen.findByRole('heading', { name: 'Välkommen, Alicia Prov!' })
  await waitFor(() =>
    expect(client.getQueryState(['tenant-portal', 'activation-contract', TOKEN])?.status).toBe(
      'error',
    ),
  )
  expect(screen.getByText('Sammanfattning', { exact: true })).toBeInTheDocument()
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useSessionStore.getState().clearSession()
  // Tillåten saknad PDF ger den befintliga HTML-sammanfattningen; inget filanrop.
  api.fetchActivationContract.mockRejectedValue({ response: { status: 404 } })
})
afterEach(async () => {
  cleanup()
  await act(async () => {
    await Promise.all(clients.map((client) => client.cancelQueries()))
  })
  clients.splice(0).forEach((client) => client.clear())
  useSessionStore.getState().clearSession()
  localStorage.clear()
})

describe('aktiveringens kontraktsbelopp', () => {
  // Oberoende bokstavliga facit; formatCurrency/Intl anropas aldrig av testet som oracle.
  it.each([
    { rent: 7500.29, deposit: 15000.58, rentText: '7 500,29 kr', depositText: '15 000,58 kr' },
    { rent: 12.5, deposit: 0.29, rentText: '12,5 kr', depositText: '0,29 kr' },
    { rent: 7500, deposit: 15000, rentText: '7 500 kr', depositText: '15 000 kr' },
    { rent: 7500, deposit: 0, rentText: '7 500 kr', depositText: null },
  ])(
    'visar hyra $rent och deposition $deposit utan heltalsavrundning',
    async ({ rent, deposit, rentText, depositText }) => {
      const generation = useSessionStore.getState().sessionGeneration
      await show(rent, deposit)
      const rentRow = screen.getByText('Månadshyra', { exact: true }).parentElement!
      // RTL normaliserar endast typografiska blanksteg; samma rad måste innehålla rätt literal.
      expect.soft(within(rentRow).queryByText(rentText, { exact: true })).toBeInTheDocument()
      const depositLabel = screen.queryByText('Deposition', { exact: true })
      if (depositText === null) {
        expect(depositLabel).not.toBeInTheDocument()
      } else {
        expect(depositLabel).toBeInTheDocument()
        expect
          .soft(within(depositLabel!.parentElement!).queryByText(depositText, { exact: true }))
          .toBeInTheDocument()
      }
      expect(api.fetchActivationInfo).toHaveBeenCalledTimes(1)
      expect(api.fetchActivationInfo).toHaveBeenCalledWith(TOKEN)
      expect(api.fetchActivationContract).toHaveBeenCalledTimes(1)
      expect(api.fetchActivationContract).toHaveBeenCalledWith(TOKEN)
      expect(api.activateAccount).not.toHaveBeenCalled()
      expect(useSessionStore.getState()).toMatchObject({
        sessionGeneration: generation,
        sessionToken: null,
        tenant: null,
        isAuthenticated: false,
      })
    },
  )
})
