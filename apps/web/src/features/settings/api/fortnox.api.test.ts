import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  api: { put: vi.fn() },
}))
vi.mock('@/lib/api', () => mocks)
import {
  connectFortnox,
  disconnectFortnox,
  getFortnoxStatus,
  validateFortnoxAuthUrl,
  getFortnoxCatalog,
  startFortnoxRead,
  saveFortnoxMapping,
} from './fortnox.api'
beforeEach(() => vi.clearAllMocks())
describe('Fortnox client boundary', () => {
  it('adds only the selected year to the catalog query and validates the response', async () => {
    mocks.get.mockResolvedValue({ ready: true })
    await expect(getFortnoxCatalog(9)).rejects.toThrow()
    expect(mocks.get).toHaveBeenCalledWith('/integrations/fortnox/catalog', {
      financialYearId: 9,
    })
  })
  it('blocks invalid civil periods before making a read request', async () => {
    await expect(
      startFortnoxRead({
        financialYearId: 9,
        financialYearStart: '2026-01-01',
        financialYearEnd: '2026-12-31',
        periodFrom: '2026-02-30',
        periodTo: '2026-03-01',
        costAccounts: [4010],
      }),
    ).rejects.toThrow()
    expect(mocks.post).not.toHaveBeenCalled()
  })
  it('saves the explicit mapping through the same configured Axios client', async () => {
    mocks.api.put.mockResolvedValue({ data: { data: {} } })
    await saveFortnoxMapping({
      dimensionType: 'PROJECT',
      code: 'P22',
      propertyId: 'house-A',
    })
    expect(mocks.api.put).toHaveBeenCalledWith('/integrations/fortnox/mappings', {
      dimensionType: 'PROJECT',
      code: 'P22',
      propertyId: 'house-A',
    })
  })
  it.each([
    'https://evil.example/oauth-v1/auth',
    'javascript:alert(1)',
    'https://apps.fortnox.se.evil.example/oauth-v1/auth',
    'https://apps.fortnox.se/oauth-v1/token',
    'https://user:pass@apps.fortnox.se/oauth-v1/auth',
  ])('rejects unsafe authorization destination %s', (authUrl) => {
    expect(() => validateFortnoxAuthUrl({ authUrl })).toThrow()
  })
  it('uses existing authenticated helper without putting org or secrets in request', async () => {
    mocks.post.mockResolvedValue({
      authUrl: 'https://apps.fortnox.se/oauth-v1/auth?state=synthetic-state',
    })
    expect(await connectFortnox()).toContain('https://apps.fortnox.se/oauth-v1/auth?')
    expect(mocks.post).toHaveBeenCalledWith('/integrations/fortnox/connect')
  })
  it('does not turn incomplete status payload into empty data or zeros', async () => {
    mocks.get.mockResolvedValue({ enabled: true })
    await expect(getFortnoxStatus()).rejects.toThrow()
    expect(mocks.get).toHaveBeenCalledWith('/integrations/fortnox/status')
  })
  it('requires a real disconnect receipt', async () => {
    mocks.post.mockResolvedValue({ disconnected: false })
    await expect(disconnectFortnox()).rejects.toThrow()
    expect(mocks.post).toHaveBeenCalledWith('/integrations/fortnox/disconnect')
  })
})
