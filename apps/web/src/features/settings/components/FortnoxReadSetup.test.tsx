import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FortnoxCatalogResponse } from '../api/fortnox.api'
import { buildMappingSelection, buildReadSelection } from './fortnox-selection'
const mocks = vi.hoisted(() => ({
  hook: vi.fn(),
  read: vi.fn(),
  mapping: vi.fn(),
  catalogRefresh: vi.fn(),
  propertiesRefresh: vi.fn(),
}))
vi.mock('../hooks/useFortnoxCatalog', () => ({
  useFortnoxCatalog: mocks.hook,
}))
vi.mock('@/lib/api', () => ({
  isForbidden: (error: { status?: number } | null) => error?.status === 403,
}))
import { FortnoxReadSetup } from './FortnoxReadSetup'

function catalog(yearId: number | null = 9): FortnoxCatalogResponse {
  return {
    ready: true,
    complete: true,
    reason: null,
    observedAt: '2026-10-01T10:00:00Z',
    company: { name: 'Bolag A', orgNumber: null, databaseNumber: 42 },
    financialYears: [
      { id: 9, from: '2026-01-01', to: '2026-12-31' },
      { id: 8, from: '2025-01-01', to: '2025-12-31' },
    ],
    selectedFinancialYearId: yearId,
    costAccounts:
      yearId === null
        ? []
        : [
            {
              number: 4010,
              name: 'Verifierat konto A',
              selectable: true,
              reason: null,
            },
            {
              number: 5070,
              name: 'Verifierat konto B',
              selectable: true,
              reason: null,
            },
            {
              number: 9999,
              name: 'Inaktivt konto',
              selectable: false,
              reason: 'Kontot är inaktivt',
            },
          ],
    dimensions: [{ dimensionType: 'PROJECT', code: 'P22', name: 'Projekt Eken' }],
  }
}
const own = { id: 'house-A', organizationId: 'org-A', name: 'Eken 1' }
let catalogOverrides: Record<string, unknown> = {}
let responseOverride: Partial<FortnoxCatalogResponse> = {}
let propertyOverrides: Record<string, unknown> = {}
beforeEach(() => {
  vi.clearAllMocks()
  catalogOverrides = {}
  responseOverride = {}
  propertyOverrides = {}
  mocks.read.mockResolvedValue({ status: 'PARTIAL' })
  mocks.mapping.mockResolvedValue(undefined)
  mocks.catalogRefresh.mockResolvedValue({ isSuccess: true, data: catalog() })
  mocks.propertiesRefresh.mockResolvedValue({ isSuccess: true })
  mocks.hook.mockImplementation((year: number | null) => ({
    catalog: {
      data: { ...catalog(year), ...responseOverride },
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
      refetch: mocks.catalogRefresh,
      ...catalogOverrides,
    },
    properties: {
      data: [own, { id: 'house-B', organizationId: 'org-B', name: 'Främmande hus' }],
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
      refetch: mocks.propertiesRefresh,
      ...propertyOverrides,
    },
    read: { isPending: false, error: null, mutateAsync: mocks.read },
    mapping: { isPending: false, error: null, mutateAsync: mocks.mapping },
    organizationId: 'org-A',
  }))
})
afterEach(cleanup)
function show() {
  const onAccessDenied = vi.fn()
  return {
    ...render(
      <FortnoxReadSetup companyNumber={42} blocked={false} onAccessDenied={onAccessDenied} />,
    ),
    onAccessDenied,
  }
}
function chooseRead() {
  fireEvent.change(screen.getByLabelText('Räkenskapsår'), {
    target: { value: '9' },
  })
  fireEvent.click(screen.getByRole('checkbox', { name: /4010/ }))
  fireEvent.change(screen.getByLabelText('Från och med'), {
    target: { value: '2026-09-01' },
  })
  fireEvent.change(screen.getByLabelText('Till och med'), {
    target: { value: '2026-09-30' },
  })
}
function chooseMapping() {
  fireEvent.change(screen.getByLabelText('Dimension i Fortnox'), {
    target: { value: 'PROJECT:P22' },
  })
  fireEvent.change(screen.getByLabelText('Egen fastighet'), {
    target: { value: 'house-A' },
  })
}

describe('Fortnox verified selections', () => {
  it('loading is not an empty successful catalog', () => {
    catalogOverrides = { data: undefined, isLoading: true }
    show()
    expect(screen.getByRole('status').textContent).toContain('Hämtar verifierade')
    expect(screen.queryByRole('button', { name: 'Läs valt underlag' })).toBeNull()
  })
  it('catalog error has a retry and no selectable data', () => {
    catalogOverrides = { isError: true }
    show()
    expect(screen.getByRole('alert').textContent).toContain('kunde inte hämtas')
    fireEvent.click(screen.getByRole('button', { name: 'Hämta om valen' }))
    expect(mocks.catalogRefresh).toHaveBeenCalledTimes(1)
    expect(mocks.read).not.toHaveBeenCalled()
  })
  it.each([
    { ready: false },
    { complete: false },
    { company: { name: 'Fel', orgNumber: null, databaseNumber: 77 } },
  ])('blocks unsafe catalog %j', (override) => {
    responseOverride = override
    show()
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Läs valt underlag' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Spara fastighetskoppling' })).toBeNull()
  })
  it('submits exact verified year bounds, explicit period and selected accounts once', async () => {
    show()
    chooseRead()
    fireEvent.click(screen.getByRole('button', { name: 'Läs valt underlag' }))
    fireEvent.click(screen.getByRole('button', { name: 'Läs valt underlag' }))
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1))
    expect(mocks.read).toHaveBeenCalledWith({
      financialYearId: 9,
      financialYearStart: '2026-01-01',
      financialYearEnd: '2026-12-31',
      periodFrom: '2026-09-01',
      periodTo: '2026-09-30',
      costAccounts: [4010],
    })
    expect(await screen.findByText(/Läsningen blev inte komplett/)).toBeTruthy()
  })
  it('blocks dates outside the verified year and reversed periods', () => {
    show()
    chooseRead()
    fireEvent.change(screen.getByLabelText('Till och med'), {
      target: { value: '2027-01-01' },
    })
    fireEvent.submit(screen.getByRole('form', { name: 'Läs valt underlag' }))
    expect(mocks.read).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Till och med'), {
      target: { value: '2026-08-01' },
    })
    fireEvent.submit(screen.getByRole('form', { name: 'Läs valt underlag' }))
    expect(mocks.read).not.toHaveBeenCalled()
  })
  it('acknowledges a completed read without claiming a full company result', async () => {
    mocks.read.mockResolvedValueOnce({ status: 'COMPLETE' })
    show()
    chooseRead()
    fireEvent.click(screen.getByRole('button', { name: 'Läs valt underlag' }))
    expect(await screen.findByText(/Läsningen är slutförd/)).toBeTruthy()
    expect(mocks.read).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/ger inte i sig företagets resultat/)).toBeTruthy()
  })
  it('an unconfirmed read remains an error and never automatically submits again', async () => {
    mocks.read.mockRejectedValueOnce(new Error('synthetic server error'))
    show()
    chooseRead()
    fireEvent.click(screen.getByRole('button', { name: 'Läs valt underlag' }))
    expect(await screen.findByText(/Läsningen kunde inte bekräftas/)).toBeTruthy()
    expect(screen.queryByText(/Läsningen är slutförd/)).toBeNull()
    fireEvent.submit(screen.getByRole('form', { name: 'Läs valt underlag' }))
    expect(mocks.read).toHaveBeenCalledTimes(1)
  })
  it('year change clears old account selections and refreshes the catalog key', () => {
    show()
    chooseRead()
    fireEvent.change(screen.getByLabelText('Räkenskapsår'), {
      target: { value: '8' },
    })
    expect(mocks.hook).toHaveBeenLastCalledWith(8, 42)
    expect((screen.getByRole('checkbox', { name: /4010/ }) as HTMLInputElement).checked).toBe(false)
    fireEvent.submit(screen.getByRole('form', { name: 'Läs valt underlag' }))
    expect(mocks.read).not.toHaveBeenCalled()
  })
  it('a stale server selection requires refresh and new account selection before retry', async () => {
    mocks.read.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 409 },
    })
    show()
    chooseRead()
    fireEvent.click(screen.getByRole('button', { name: 'Läs valt underlag' }))
    expect(await screen.findByText(/Urvalet har ändrats/)).toBeTruthy()
    fireEvent.submit(screen.getByRole('form', { name: 'Läs valt underlag' }))
    expect(mocks.read).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Hämta om valen' }))
    await waitFor(() => expect(screen.queryByText(/Hämta om valen innan nästa försök/)).toBeNull())
    expect((screen.getByRole('checkbox', { name: /4010/ }) as HTMLInputElement).checked).toBe(false)
  })
  it('maps a known dimension to an own property and says older reads do not change', async () => {
    show()
    expect(screen.queryByRole('option', { name: 'Främmande hus' })).toBeNull()
    chooseMapping()
    fireEvent.click(screen.getByRole('button', { name: 'Spara fastighetskoppling' }))
    await waitFor(() =>
      expect(mocks.mapping).toHaveBeenCalledWith({
        dimensionType: 'PROJECT',
        code: 'P22',
        propertyId: 'house-A',
      }),
    )
    expect(await screen.findByText(/Fastighetskopplingen är sparad/)).toBeTruthy()
  })
  it('mapping server failure is not shown as success and requires refresh', async () => {
    mocks.mapping.mockRejectedValueOnce(new Error('server failure'))
    show()
    chooseMapping()
    fireEvent.click(screen.getByRole('button', { name: 'Spara fastighetskoppling' }))
    expect(await screen.findByText(/Fastighetskopplingen kunde inte bekräftas/)).toBeTruthy()
    expect(screen.queryByText(/Fastighetskopplingen är sparad/)).toBeNull()
    fireEvent.submit(screen.getByRole('form', { name: 'Koppla dimension till fastighet' }))
    expect(mocks.mapping).toHaveBeenCalledTimes(1)
  })
  it('property load errors retain the read form but block mapping and offer retry', () => {
    propertyOverrides = { isError: true }
    show()
    chooseRead()
    expect(screen.getByRole('button', { name: 'Läs valt underlag' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Spara fastighetskoppling' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Hämta fastigheter igen' }))
    expect(mocks.propertiesRefresh).toHaveBeenCalledTimes(1)
  })
  it('catalog 403 requests removal of the whole parent panel', async () => {
    catalogOverrides = { isError: true, error: { status: 403 } }
    const { onAccessDenied } = show()
    await waitFor(() => expect(onAccessDenied).toHaveBeenCalled())
    expect(screen.queryByRole('form')).toBeNull()
  })
  it('blocks a stale cached catalog while it is being fetched again', () => {
    catalogOverrides = { isFetching: true }
    show()
    fireEvent.submit(screen.getByRole('form', { name: 'Läs valt underlag' }))
    expect(mocks.read).not.toHaveBeenCalled()
  })
  it('rejects forged, inactive, foreign and wrong-year values before request effects', () => {
    const selection = {
      yearId: 9,
      from: '2026-09-01',
      to: '2026-09-30',
      accounts: [4010],
    }
    expect(() => buildReadSelection(catalog(), 42, { ...selection, accounts: [123456] })).toThrow()
    expect(() => buildReadSelection(catalog(), 42, { ...selection, accounts: [9999] })).toThrow()
    expect(() => buildReadSelection(catalog(8), 42, selection)).toThrow()
    expect(() =>
      buildMappingSelection(
        catalog(),
        42,
        { dimensionKey: 'PROJECT:P22', propertyId: 'house-B' },
        [{ id: 'house-B', organizationId: 'org-B' }],
        'org-A',
      ),
    ).toThrow()
    expect(() =>
      buildMappingSelection(
        catalog(),
        42,
        { dimensionKey: 'PROJECT:invented', propertyId: own.id },
        [own],
        'org-A',
      ),
    ).toThrow()
  })
})
