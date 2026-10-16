import { isCancel, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth.store'
import { fetchJournalPage, type JournalPage } from './accounting.api'

/** Riktig API-funktion, Axios och authinterceptors. Bara nättransporten ersätts. */
const originalAdapter = api.defaults.adapter!
const originalAuth = useAuthStore.getState()
const query = {
  offset: 50,
  limit: 25,
  from: '2024-02-29',
  to: '2026-10-25',
  source: 'RENT_NOTICE',
} satisfies Parameters<typeof fetchJournalPage>[0]
const page: JournalPage = {
  offset: 50,
  limit: 25,
  total: 51,
  entries: [
    {
      id: 'synthetic-journal',
      organizationId: 'synthetic-org',
      date: '2024-02-29',
      description: 'Syntetiskt historiskt verifikat',
      source: 'RENT_NOTICE',
      reference: 'Syntetisk referens',
      sourceId: 'synthetic-notice',
      lines: [],
      createdById: 'synthetic-user',
      createdAt: '2024-03-01T12:00:00.000Z',
      series: 'A',
      verNumber: 51,
      reversedBy: null,
      reversalOf: null,
    },
  ],
}

function response(config: InternalAxiosRequestConfig): AxiosResponse {
  return { data: { success: true, data: page }, status: 200, statusText: 'OK', headers: {}, config }
}

function signal() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

let transportCalls = 0

beforeEach(() => {
  transportCalls = 0
  useAuthStore.setState({
    user: {
      id: 'synthetic-user',
      organizationId: 'synthetic-org',
      role: 'OWNER',
      email: 'synthetic@example.invalid',
      firstName: 'Test',
      lastName: 'Person',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    organization: {
      id: 'synthetic-org',
      name: 'Syntetisk organisation',
      orgNumber: null,
      termsVersion: null,
    },
    accessToken: 'synthetic-journal-test-token',
    refreshToken: null,
    isAuthenticated: true,
  })
  // Ett oarrangerat anrop får aldrig använda den vanliga nätadaptern.
  api.defaults.adapter = async () => {
    transportCalls += 1
    throw new Error('Oarrangerad journaltransport')
  }
})

afterEach(() => {
  api.defaults.adapter = originalAdapter
  useAuthStore.setState(originalAuth)
})

describe('fetchJournalPage genom riktig Axios', () => {
  it('skickar det validerade urvalet och packar upp hela sidan för befintliga anrop utan signal', async () => {
    api.defaults.adapter = async (config) => {
      transportCalls += 1
      expect(config.method).toBe('get')
      expect(config.url).toBe('/accounting/journal-page')
      expect(config.params).toStrictEqual(query)
      expect(config.data).toBeUndefined()
      // Verkliga requestinterceptorn körs, utan att provet skriver ut tokenvärdet.
      expect(config.headers.has('Authorization')).toBe(true)
      return response(config)
    }
    expect(await fetchJournalPage(query)).toBe(page)
    expect(transportCalls).toBe(1)
  })

  it.each([
    { offset: 1.5 },
    { offset: 2147483648 },
    { limit: 0 },
    { limit: 201 },
    { from: '2026-02-29' },
    { from: '2026-03-01', to: '2026-02-28' },
    { organizationId: 'annan-organisation' },
    { group: 'ALL' },
  ])('avvisar %p före transport, genom det delade schemat', async (changed) => {
    await expect(fetchJournalPage({ ...query, ...changed })).rejects.toBeInstanceOf(ZodError)
    expect(transportCalls).toBe(0)
  })

  it('en redan avbruten signal stoppar Axios före adapteranropet', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(fetchJournalPage(query, controller.signal)).rejects.toMatchObject({
      code: 'ERR_CANCELED',
    })
    expect(transportCalls).toBe(0)
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
  })

  it('avbrottet når en väntande transport och riktig Axios avvisar dess sena 200-svar', async () => {
    const started = signal()
    const serverFinished = signal()
    const controller = new AbortController()
    let transportSawAbort = false
    let removeListener = () => {}
    api.defaults.adapter = async (config) => {
      transportCalls += 1
      const onAbort = () => {
        transportSawAbort = true
      }
      config.signal?.addEventListener?.('abort', onAbort, { once: true })
      removeListener = () => config.signal?.removeEventListener?.('abort', onAbort)
      started.resolve()
      // Leverera medvetet sent trots abort: Axios egen avbrottskontroll ska fälla
      // svaret. Testadaptern kastar alltså inte själv det förväntade felet.
      await serverFinished.promise
      return response(config)
    }
    const observed = fetchJournalPage(query, controller.signal).then(
      (data) => ({ kind: 'success' as const, data }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    )
    try {
      await Promise.race([
        started.promise,
        observed.then(() => {
          throw new Error('Anropet avslutades innan transportbarriären nåddes')
        }),
      ])
      controller.abort()
      expect(transportSawAbort).toBe(true)
      serverFinished.resolve()
      const outcome = await observed
      expect(outcome.kind).toBe('error')
      if (outcome.kind !== 'error') throw new Error('Ett avbrutet anrop gav en journalsida')
      expect(isCancel(outcome.error)).toBe(true)
      expect(outcome.error).toMatchObject({ code: 'ERR_CANCELED' })
      expect(transportCalls).toBe(1)
      expect(useAuthStore.getState().isAuthenticated).toBe(true)
    } finally {
      controller.abort()
      serverFinished.resolve()
      await observed
      removeListener()
    }
  })
})
