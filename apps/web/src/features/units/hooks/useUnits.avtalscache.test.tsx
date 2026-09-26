/**
 * R1 (CODEX2 på #933) · EN SPARAD FLAGGA MÅSTE NÅ FAKTURANS MOMSFÖRVAL I SAMMA SESSION
 *
 * Fakturaformuläret läser `voluntaryTaxLiability` ur AVTALSLISTAN
 * (`['leases','list']`), inte ur objektet. Appens QueryClient har staleTime
 * 60 s (main.tsx). Invaliderade objektsparningen bara objektets egna nycklar låg
 * avtalslistan kvar som färsk, och en ny faktura förvalde den GAMLA satsen —
 * som servern sedan avvisar.
 *
 * Provet kör appens verkliga hookar (`useUpdateUnit`, `useLeases` via
 * InvoiceForm) i ETT QueryClient med samma staleTime, och byter "vy" genom att
 * avmontera och montera — som en navigering inom appen, utan omladdning och
 * utan att vänta ut någon cachetid. Bara HTTP-transporten är ersatt.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { InvoiceForm } from '@/features/invoices/components/InvoiceForm'
import { useUpdateUnit } from './useUnits'

const ORG = '99999999-9999-4999-8999-000000000001'
const ENHET = '44444444-4444-4444-8444-000000000001'
const AVTAL = '11111111-1111-4111-8111-000000000001'

let flagga = false
let anrop: string[] = []
const ursprungligAdapter = api.defaults.adapter!

function svar(config: InternalAxiosRequestConfig, data: unknown): AxiosResponse {
  return { data: { success: true, data }, status: 200, statusText: '200', headers: {}, config }
}
const enhet = () => ({
  id: ENHET,
  propertyId: 'p1',
  name: 'Butik 0102',
  unitNumber: '0102',
  type: 'RETAIL',
  status: 'OCCUPIED',
  area: '40.00',
  monthlyRent: '10000.00',
  voluntaryTaxLiability: flagga,
  property: { id: 'p1', name: 'Ekens Gård 1' },
})

beforeEach(() => {
  anrop = []
  api.defaults.adapter = async (config) => {
    const metod = (config.method ?? 'get').toUpperCase()
    anrop.push(`${metod} ${config.url}`)
    if (metod === 'GET' && config.url === '/leases')
      return svar(config, [
        {
          id: AVTAL,
          organizationId: ORG,
          unitId: ENHET,
          tenantId: 't1',
          status: 'ACTIVE',
          leaseType: 'INDEFINITE',
          startDate: '2026-09-01T00:00:00.000Z',
          monthlyRent: '10000.00',
          unit: enhet(),
          tenant: { id: 't1', type: 'COMPANY', companyName: 'Butik AB' },
        },
      ])
    if (metod === 'GET' && config.url === '/customers') return svar(config, [])
    if (metod === 'GET' && config.url === '/organizations/me')
      return svar(config, { id: ORG, name: 'Test AB', bankgiro: '5050-1055' })
    if (metod === 'PATCH' && config.url === `/units/${ENHET}`) {
      const kropp = JSON.parse(config.data as string) as { voluntaryTaxLiability?: boolean }
      if (kropp.voluntaryTaxLiability !== undefined) flagga = kropp.voluntaryTaxLiability
      return svar(config, enhet())
    }
    throw new AxiosError(`ej riggat: ${metod} ${config.url}`, 'ERR_BAD_REQUEST', config)
  }
})

afterEach(() => {
  api.defaults.adapter = ursprungligAdapter
  cleanup()
})

/** Objektvyns sparning, reducerad till mutationen formuläret gör. */
function SparaObjekt({ kropp }: { kropp: Record<string, unknown> }) {
  const m = useUpdateUnit()
  return (
    <button type="button" onClick={() => m.mutate({ id: ENHET, ...kropp })}>
      {m.isSuccess ? 'Sparat' : 'Spara objekt'}
    </button>
  )
}

function App({ vy, kropp = {} }: { vy: 'faktura' | 'objekt'; kropp?: Record<string, unknown> }) {
  return vy === 'faktura' ? (
    <InvoiceForm onSubmit={vi.fn()} onCancel={vi.fn()} />
  ) : (
    <SparaObjekt kropp={kropp} />
  )
}

function rigg() {
  // SAMMA staleTime som appen (main.tsx) — annars mäter provet inte cachen.
  const qc = new QueryClient({
    defaultOptions: { queries: { staleTime: 60_000, retry: false }, mutations: { retry: false } },
  })
  const r = render(
    <QueryClientProvider client={qc}>
      <App vy="faktura" />
    </QueryClientProvider>,
  )
  const byt = (vy: 'faktura' | 'objekt', kropp: Record<string, unknown> = {}) =>
    r.rerender(
      <QueryClientProvider client={qc}>
        <App vy={vy} kropp={kropp} />
      </QueryClientProvider>,
    )
  return { qc, byt }
}

async function forvalForAvtalet(): Promise<string> {
  const falt = (await screen.findByLabelText('Hyresavtal')) as HTMLSelectElement
  await waitFor(() => expect(falt.disabled).toBe(false))
  fireEvent.change(falt, { target: { value: AVTAL } })
  const moms = (screen.getAllByRole('combobox') as HTMLSelectElement[]).find(
    (s) => [...s.options].map((o) => o.value).join(',') === '0,6,12,25',
  )!
  return moms.value
}

async function sparaObjektet() {
  fireEvent.click(await screen.findByRole('button', { name: 'Spara objekt' }))
  await screen.findByRole('button', { name: 'Sparat' })
}

describe('R1: flaggsparning når fakturans momsförval utan omladdning', () => {
  it('av → på: nästa faktura förväljer 25 %', async () => {
    flagga = false
    const { byt } = rigg()
    expect(await forvalForAvtalet()).toBe('0')

    byt('objekt', { voluntaryTaxLiability: true })
    await sparaObjektet()
    expect(flagga).toBe(true)

    byt('faktura')
    await waitFor(async () => expect(await forvalForAvtalet()).toBe('25'))
    expect(anrop.filter((a) => a === 'GET /leases').length).toBeGreaterThanOrEqual(2)
  })

  it('på → av: nästa faktura förväljer 0 %', async () => {
    flagga = true
    const { byt } = rigg()
    expect(await forvalForAvtalet()).toBe('25')

    byt('objekt', { voluntaryTaxLiability: false })
    await sparaObjektet()
    expect(flagga).toBe(false)

    byt('faktura')
    await waitFor(async () => expect(await forvalForAvtalet()).toBe('0'))
  })

  it('av → på → av i samma session, samma avtal', async () => {
    flagga = false
    const { byt } = rigg()
    expect(await forvalForAvtalet()).toBe('0')
    for (const [varde, sats] of [
      [true, '25'],
      [false, '0'],
    ] as const) {
      byt('objekt', { voluntaryTaxLiability: varde })
      await sparaObjektet()
      byt('faktura')
      await waitFor(async () => expect(await forvalForAvtalet()).toBe(sats))
    }
  })

  it('kontroll: en sparning utan flaggändring ändrar inte förvalet', async () => {
    flagga = false
    const { byt } = rigg()
    expect(await forvalForAvtalet()).toBe('0')
    byt('objekt', { name: 'Butik 0102 (nytt namn)' })
    await sparaObjektet()
    byt('faktura')
    await act(async () => {})
    expect(await forvalForAvtalet()).toBe('0')
  })
})
