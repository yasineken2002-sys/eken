import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: 'user-A', role: 'OWNER' },
    organization: { id: 'org-A' },
  },
  catalog: vi.fn(),
  properties: vi.fn(),
  read: vi.fn(),
  mapping: vi.fn(),
}))
vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector(mocks.auth),
}))
vi.mock('@/features/properties/api/properties.api', () => ({
  fetchProperties: mocks.properties,
}))
vi.mock('../api/fortnox.api', () => ({
  getFortnoxCatalog: mocks.catalog,
  startFortnoxRead: mocks.read,
  saveFortnoxMapping: mocks.mapping,
}))
import { useFortnoxCatalog } from './useFortnoxCatalog'
beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth = {
    user: { id: 'user-A', role: 'OWNER' },
    organization: { id: 'org-A' },
  }
  mocks.properties.mockResolvedValue([])
  mocks.catalog.mockResolvedValue({ marker: 'company-A' })
  mocks.read.mockResolvedValue({ status: 'COMPLETE' })
  mocks.mapping.mockResolvedValue(undefined)
})
afterEach(cleanup)
function fixture() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, wrapper }
}

describe('Fortnox catalog cache scope', () => {
  it('does not expose previous company/property cache after an organization switch', async () => {
    const { wrapper } = fixture()
    mocks.properties.mockResolvedValueOnce([{ id: 'house-A', organizationId: 'org-A' }])
    const view = renderHook(() => useFortnoxCatalog(9, 42), { wrapper })
    await waitFor(() => expect(view.result.current.catalog.isSuccess).toBe(true))
    expect(view.result.current.properties.data?.[0]?.id).toBe('house-A')
    mocks.catalog.mockImplementationOnce(() => new Promise(() => {}))
    mocks.properties.mockImplementationOnce(() => new Promise(() => {}))
    mocks.auth = {
      user: { id: 'user-B', role: 'OWNER' },
      organization: { id: 'org-B' },
    }
    view.rerender()
    expect(view.result.current.catalog.data).toBeUndefined()
    expect(view.result.current.properties.data).toBeUndefined()
    await waitFor(() => expect(mocks.properties).toHaveBeenCalledTimes(2))
  })
  it('fetches nothing for a disallowed role', () => {
    mocks.auth.user.role = 'VIEWER'
    const { wrapper } = fixture()
    renderHook(() => useFortnoxCatalog(null, 42), { wrapper })
    expect(mocks.catalog).not.toHaveBeenCalled()
    expect(mocks.properties).not.toHaveBeenCalled()
  })
  it('separates year selection and invalidates only the current scoped status after save', async () => {
    const { wrapper, client } = fixture()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const view = renderHook(({ year }) => useFortnoxCatalog(year, 42), {
      wrapper,
      initialProps: { year: 9 },
    })
    await waitFor(() => expect(mocks.catalog).toHaveBeenCalledWith(9))
    view.rerender({ year: 8 })
    await waitFor(() => expect(mocks.catalog).toHaveBeenCalledWith(8))
    await act(() =>
      view.result.current.mapping.mutateAsync({
        dimensionType: 'PROJECT',
        code: 'P22',
        propertyId: 'house-A',
      }),
    )
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['fortnox', 'status', 'org-A', 'user-A', 'OWNER'],
    })
  })
})
