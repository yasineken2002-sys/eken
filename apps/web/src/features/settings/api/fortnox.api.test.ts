import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('@/lib/api', () => mocks)
import {
  connectFortnox,
  disconnectFortnox,
  getFortnoxStatus,
  validateFortnoxAuthUrl,
} from './fortnox.api'
beforeEach(() => vi.clearAllMocks())
describe('Fortnox client boundary', () => {
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
