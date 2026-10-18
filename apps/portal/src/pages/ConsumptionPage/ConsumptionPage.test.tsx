import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConsumptionPage } from './ConsumptionPage'
import type { PortalConsumptionCharge } from '@/types/portal.types'

const api = vi.hoisted(() => ({ fetchConsumption: vi.fn() }))
vi.mock('@/api/portal.api', () => api)

const clients: QueryClient[] = []
const BASE: PortalConsumptionCharge = {
  id: 'synthetic-consumption',
  meterType: 'ELECTRICITY',
  periodStart: '2026-01-01T12:00:00Z',
  periodEnd: '2026-01-31T12:00:00Z',
  quantity: 12.345,
  netAmount: 987.65,
  vatAmount: 246.91,
  totalAmount: 1234.56,
}

function show(charges: PortalConsumptionCharge[]) {
  api.fetchConsumption.mockResolvedValue(charges)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  clients.push(client)
  render(
    <QueryClientProvider client={client}>
      <ConsumptionPage />
    </QueryClientProvider>,
  )
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
})

describe('förbrukningskortets debiterade belopp', () => {
  // Bokstavliga facit från syntetiska API-svar, aldrig produktformatteraren.
  it.each([
    { total: 0.29, net: 0.23, vat: 0.06, expected: '0,29 kr' },
    { total: 0.01, net: 0.01, vat: 0, expected: '0,01 kr' },
    { total: 1234.56, net: 987.65, vat: 246.91, expected: '1 234,56 kr' },
    { total: 12.5, net: 10, vat: 2.5, expected: '12,5 kr' },
    // Defensivt API-fall: normal recordReading skapar ingen nollbeloppspost.
    { total: 0, net: 0, vat: 0, expected: '0 kr' },
    { total: 7500, net: 6000, vat: 1500, expected: '7 500 kr' },
  ])(
    'visar $total som $expected utan att ändra kvantiteten',
    async ({ total, net, vat, expected }) => {
      show([{ ...BASE, totalAmount: total, netAmount: net, vatAmount: vat }])
      const title = await screen.findByText('El', { exact: true })
      const card = title.parentElement!.parentElement!.parentElement!
      expect(within(card).getByText(expected, { exact: true })).toBeInTheDocument()
      expect(within(card).getByText('12,345 kWh', { exact: true })).toBeInTheDocument()
      expect(within(card).queryByText('Hög', { exact: true })).toBeNull()
      expect(api.fetchConsumption).toHaveBeenCalledTimes(1)
    },
  )

  it('bevarar alla fyra mätartyper, enheter och den befintliga Hög-markeringen', async () => {
    show([
      { ...BASE, id: 'el-low', quantity: 100, netAmount: 100, vatAmount: 25, totalAmount: 125 },
      {
        ...BASE,
        id: 'el-high',
        quantity: 250,
        netAmount: 250,
        vatAmount: 62.5,
        totalAmount: 312.5,
      },
      {
        ...BASE,
        id: 'cold',
        meterType: 'WATER_COLD',
        quantity: 8.125,
        netAmount: 8.4,
        vatAmount: 2.1,
        totalAmount: 10.5,
      },
      {
        ...BASE,
        id: 'hot',
        meterType: 'WATER_HOT',
        quantity: 2.5,
        netAmount: 24.2,
        vatAmount: 6.05,
        totalAmount: 30.25,
      },
      {
        ...BASE,
        id: 'heat',
        meterType: 'HEATING',
        quantity: 200,
        netAmount: 800,
        vatAmount: 200,
        totalAmount: 1000,
      },
    ])
    await screen.findByText('Värme', { exact: true })
    expect(screen.getAllByText('El', { exact: true })).toHaveLength(2)
    expect(screen.getAllByText('Hög', { exact: true })).toHaveLength(1)
    for (const [label, quantity] of [
      ['Kallvatten', '8,125 m³'],
      ['Varmvatten', '2,5 m³'],
      ['Värme', '200 kWh'],
    ] as const) {
      const card = screen.getByText(label, { exact: true }).parentElement!.parentElement!
        .parentElement!
      expect(within(card).getByText(quantity, { exact: true })).toBeInTheDocument()
      expect(within(card).queryByText('Hög', { exact: true })).toBeNull()
    }
    const highCard = screen.getByText('Hög', { exact: true }).parentElement!.parentElement!
      .parentElement!
    expect(within(highCard).getByText('El', { exact: true })).toBeInTheDocument()
    expect(within(highCard).getByText(/250 kWh/)).toBeInTheDocument()
    expect(within(highCard).getByText('312,5 kr', { exact: true })).toBeInTheDocument()
    expect(api.fetchConsumption).toHaveBeenCalledTimes(1)
  })
})
