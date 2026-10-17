import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Profiler, type ProfilerOnRenderCallback } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FortnoxExportsPageQuery, UserRole } from '@eken/shared'
import { useAuthStore } from '@/stores/auth.store'
import type { FortnoxExportRow } from '../api/fortnox-export.api'
import { FortnoxExportList, type FortnoxExportListProps } from './FortnoxExportList'

type Page = { items: FortnoxExportRow[]; total: number; offset: number; limit: number }
const mocks = vi.hoisted(() => ({
  list: vi.fn<(query: FortnoxExportsPageQuery) => Promise<Page>>(),
  send: vi.fn(),
  verify: vi.fn(),
  reconcile: vi.fn(),
  scan: vi.fn(),
  release: vi.fn(),
}))

vi.mock('../api/fortnox-export.api', () => ({
  listFortnoxExportsPage: mocks.list,
  sendFortnoxExport: mocks.send,
  verifyFortnoxExport: mocks.verify,
  reconcileFortnoxExport: mocks.reconcile,
  reconcileScanFortnoxExport: mocks.scan,
  releaseRejectedFortnoxExport: mocks.release,
}))

const clients: QueryClient[] = []
const changed = vi.fn(async () => undefined)

function setScope(organizationId = 'org-a', userId = 'user-a', role: UserRole = 'OWNER') {
  useAuthStore.setState({
    user: {
      id: userId,
      organizationId,
      role,
      email: 'synthetic@example.invalid',
      firstName: 'Test',
      lastName: 'Person',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    organization: { id: organizationId, name: organizationId, orgNumber: null, termsVersion: null },
    isAuthenticated: true,
  })
}

function row(id: string, state: FortnoxExportRow['state'] = 'BLOCKED'): FortnoxExportRow {
  return {
    id,
    journalEntryId: `journal-${id}`,
    state,
    blockReason: id,
    draftHash: 'a'.repeat(64),
    updatedAt: '2001-01-01T12:00:00Z',
  }
}

function page(query: FortnoxExportsPageQuery, total: number, prefix = 'Export'): Page {
  const offset = query.offset ?? 0
  const limit = query.limit ?? 50
  return {
    offset,
    limit,
    total,
    items: Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, index) =>
      row(`${prefix} ${offset + index + 1}`),
    ),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function show(
  overrides: Partial<FortnoxExportListProps> = {},
  onRender: ProfilerOnRenderCallback = () => undefined,
) {
  // Globala defaults får inte föra över föregående sida till ett nytt scope/urval.
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, placeholderData: (previous: unknown) => previous },
      mutations: { retry: false },
    },
  })
  clients.push(client)
  const props: FortnoxExportListProps = {
    group: 'NEEDS_REVIEW',
    title: 'Att stämma av',
    sendingEnabled: false,
    onChanged: changed,
    ...overrides,
  }
  const view = render(
    <QueryClientProvider client={client}>
      <Profiler id="fortnox-export-list" onRender={onRender}>
        <FortnoxExportList {...props} />
      </Profiler>
    </QueryClientProvider>,
  )
  return { ...view, client, props }
}

async function clickPage(name: string) {
  await waitFor(() =>
    expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false),
  )
  fireEvent.click(screen.getByRole('button', { name }))
}

describe('FortnoxExportList', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    setScope()
    mocks.list.mockImplementation(async (query) => page(query, 4))
  })

  afterEach(() => {
    cleanup()
    clients.splice(0).forEach((client) => client.clear())
    useAuthStore.setState({ user: null, organization: null, isAuthenticated: false })
    localStorage.clear()
  })

  it('hämtar alla datum från början så fyra äldre problem syns utan automatisk åtgärd', async () => {
    const states = ['UNKNOWN', 'REJECTED', 'RECEIPT_MISMATCH', 'RECEIPT_IDENTIFIED'] as const
    mocks.list.mockResolvedValue({
      items: states.map((state, index) => row(`Export ${index + 1}`, state)),
      total: 4,
      offset: 0,
      limit: 50,
    })
    show()
    expect(await screen.findByRole('heading', { name: 'Att stämma av (4)' })).toBeTruthy()
    expect(screen.getByText('Skäl: Export 1')).toBeTruthy()
    expect(screen.getByText('Skäl: Export 4')).toBeTruthy()
    expect(
      screen.getAllByRole('listitem').map((item) => item.getAttribute('data-export-state')),
    ).toEqual([...states])
    expect(screen.getByText('Datumfiltret gäller verifikationsdatum.')).toBeTruthy()
    expect(screen.getByText('Visar 1–4 av 4 överföringar.')).toBeTruthy()
    expect(mocks.list).toHaveBeenCalledTimes(1)
    expect(mocks.list).toHaveBeenCalledWith({ group: 'NEEDS_REVIEW', offset: 0, limit: 50 })
    for (const action of [
      mocks.send,
      mocks.verify,
      mocks.reconcile,
      mocks.scan,
      mocks.release,
      changed,
    ]) {
      expect(action).not.toHaveBeenCalled()
    }
  })

  it('hämtar bara vald sida och når nästa, sista samt föregående av 125 överföringar', async () => {
    mocks.list.mockImplementation(async (query) => page(query, 125))
    show()
    expect(await screen.findByText('Visar 1–50 av 125 överföringar.')).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(50)
    expect(mocks.list).toHaveBeenCalledTimes(1)
    await clickPage('Nästa')
    expect(await screen.findByText('Visar 51–100 av 125 överföringar.')).toBeTruthy()
    expect(screen.queryByText('Skäl: Export 1')).toBeNull()
    await clickPage('Sista sidan')
    expect(await screen.findByText('Visar 101–125 av 125 överföringar.')).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(25)
    expect((screen.getByRole('button', { name: 'Nästa' }) as HTMLButtonElement).disabled).toBe(true)
    await clickPage('Föregående')
    expect(await screen.findByText('Visar 51–100 av 125 överföringar.')).toBeTruthy()
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(4))
    expect(mocks.list.mock.calls.map(([query]) => query.offset)).toEqual([0, 50, 100, 50])
    expect(mocks.list.mock.calls.every(([query]) => query.limit === 50)).toBe(true)
  })

  it('visar inte föregående sidas rader medan nästa sida hämtas', async () => {
    const next = deferred<Page>()
    mocks.list.mockImplementation((query) =>
      query.offset ? next.promise : Promise.resolve(page(query, 100)),
    )
    show()
    await screen.findByText('Skäl: Export 1')
    await clickPage('Nästa')
    expect(screen.queryByText('Skäl: Export 1')).toBeNull()
    expect(screen.getByText('Hämtar överföringar…')).toBeTruthy()
    await act(async () => next.resolve(page({ offset: 50 }, 100)))
    expect(await screen.findByText('Skäl: Export 51')).toBeTruthy()
  })

  it('datumfilter och Alla datum återgår till första sidan utan att hämta mellanliggande sidor', async () => {
    mocks.list.mockImplementation(async (query) => page(query, query.from ? 2 : 125))
    show({ group: 'OTHER', title: 'Övriga överföringar' })
    await screen.findByText('Visar 1–50 av 125 överföringar.')
    await clickPage('Nästa')
    await screen.findByText('Visar 51–100 av 125 överföringar.')
    fireEvent.change(screen.getByLabelText('Från'), { target: { value: '2025-01-01' } })
    fireEvent.change(screen.getByLabelText('Till'), { target: { value: '2025-12-31' } })
    expect(mocks.list).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Visa period' }))
    expect(await screen.findByText('Visar 1–2 av 2 överföringar.')).toBeTruthy()
    expect(mocks.list).toHaveBeenLastCalledWith({
      group: 'OTHER',
      offset: 0,
      limit: 50,
      from: '2025-01-01',
      to: '2025-12-31',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Alla datum' }))
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith({ group: 'OTHER', offset: 0, limit: 50 }),
    )
    expect((screen.getByLabelText('Från') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Till') as HTMLInputElement).value).toBe('')
    expect(screen.getByText('Visar alla datum.')).toBeTruthy()
  })

  it('delat schema stoppar om Från är efter Till och behåller den tidigare listan', async () => {
    show()
    await screen.findByText('Skäl: Export 1')
    fireEvent.change(screen.getByLabelText('Från'), { target: { value: '2026-02-01' } })
    fireEvent.change(screen.getByLabelText('Till'), { target: { value: '2026-01-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Visa period' }))
    expect(screen.getByRole('alert').textContent).toBeTruthy()
    expect(mocks.list).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Skäl: Export 1')).toBeTruthy()
  })

  it('förklarar tomt urval och håller sidknapparna avstängda', async () => {
    mocks.list.mockImplementation(async (query) => page(query, 0))
    show({ group: 'ALL', title: 'Alla överföringar' })
    expect(await screen.findByText('Inga överföringar i urvalet.')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Alla överföringar (0)' })).toBeTruthy()
    expect(screen.getByText('Visar 0–0 av 0 överföringar.')).toBeTruthy()
    for (const name of ['Föregående', 'Nästa', 'Sista sidan']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    }
  })

  it('visar läsfel utan rå servertext och kan hämta igen efter ett uttryckligt klick', async () => {
    mocks.list.mockRejectedValueOnce(new Error('PRIVATE_SERVER_DETAILS'))
    show()
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Överföringarna kunde inte läsas.',
    )
    expect(screen.queryByText(/PRIVATE_SERVER_DETAILS/)).toBeNull()
    expect(mocks.list).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Försök igen' }))
    expect(await screen.findByText('Skäl: Export 4')).toBeTruthy()
    expect(mocks.list).toHaveBeenCalledTimes(2)
  })

  it('bevarar historiken vid avstängd sändning och lämnar sändningsbekräftelsen till radkomponenten', async () => {
    mocks.list.mockResolvedValue({
      items: [row('Redo', 'DRY_RUN_READY')],
      total: 1,
      offset: 0,
      limit: 50,
    })
    const view = show()
    expect(await screen.findByText('Skäl: Redo')).toBeTruthy()
    expect(screen.getByText('Sändning till Fortnox är inte aktiverad.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Skicka till Fortnox' })).toBeNull()
    view.rerender(
      <QueryClientProvider client={view.client}>
        <FortnoxExportList {...view.props} sendingEnabled />
      </QueryClientProvider>,
    )
    expect(
      (screen.getByRole('button', { name: 'Skicka till Fortnox' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it.each([
    ['organisation', 'org-b', 'user-a', 'OWNER'],
    ['användare', 'org-a', 'user-b', 'OWNER'],
    ['roll', 'org-a', 'user-a', 'ADMIN'],
  ] as const)(
    'byte av %s nollställer sida/utkast och visar aldrig den sena gamla responsen',
    async (_, org, user, role) => {
      const old = deferred<Page>()
      let newScope = false
      mocks.list.mockImplementation((query) => {
        if (newScope) return Promise.resolve(page(query, 1, 'Nytt scope'))
        return query.offset ? old.promise : Promise.resolve(page(query, 100, 'Gammalt scope'))
      })
      const { client } = show()
      await screen.findByText('Skäl: Gammalt scope 1')
      await clickPage('Nästa')
      await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))
      fireEvent.change(screen.getByLabelText('Från'), { target: { value: '2020-01-01' } })
      act(() => {
        newScope = true
        setScope(org, user, role)
      })
      expect(await screen.findByText('Skäl: Nytt scope 1')).toBeTruthy()
      expect((screen.getByLabelText('Från') as HTMLInputElement).value).toBe('')
      expect(mocks.list).toHaveBeenLastCalledWith({ group: 'NEEDS_REVIEW', offset: 0, limit: 50 })
      const oldResult = page({ offset: 50 }, 100, 'Sent gammalt scope')
      await act(async () => old.resolve(oldResult))
      await waitFor(() =>
        expect(
          client.getQueryData([
            'fortnox',
            'exports-page',
            'org-a',
            'user-a',
            'OWNER',
            { group: 'NEEDS_REVIEW', offset: 50, limit: 50 },
          ]),
        ).toEqual(oldResult),
      )
      expect(screen.queryByText(/Skäl: Sent gammalt scope/)).toBeNull()
      expect(screen.getByText('Skäl: Nytt scope 1')).toBeTruthy()
    },
  )

  it('döljer data och hämtar inget för en roll utan behörighet', async () => {
    show()
    await screen.findByText('Skäl: Export 1')
    act(() => setScope('org-a', 'user-a', 'MANAGER'))
    expect(screen.queryByRole('region', { name: 'Att stämma av' })).toBeNull()
    expect(mocks.list).toHaveBeenCalledTimes(1)
  })

  it('visar omläsning, aldrig falskt tomt, när sista sidan försvinner och nästa svar väntar', async () => {
    const reloaded = deferred<Page>()
    let changedSelection = false
    mocks.list.mockImplementation((query) => {
      if (changedSelection && query.offset === 0) return reloaded.promise
      return Promise.resolve(page(query, changedSelection ? 50 : 51))
    })
    // Profiler läser DOM vid varje commit, före passive effects. Även ett kort
    // falskt tomläge före den automatiska sidjusteringen blir därmed synligt för provet.
    const committedText: string[] = []
    const { client } = show({}, () => {
      committedText.push(document.body.textContent ?? '')
    })
    await screen.findByText('Visar 1–50 av 51 överföringar.')
    await clickPage('Sista sidan')
    await screen.findByText('Visar 51–51 av 51 överföringar.')
    changedSelection = true
    try {
      await act(async () => {
        await client.invalidateQueries({ queryKey: ['fortnox', 'exports-page'] })
      })
      expect(await screen.findByText('Urvalet har ändrats. Hämtar aktuell sida…')).toBeTruthy()
      // Omläsningstexten visas före effekten som byter querynyckel. Vänta på
      // det faktiska nästa anropet medan svaret fortfarande hålls öppet.
      await waitFor(() =>
        expect(mocks.list.mock.calls.map(([query]) => query.offset)).toEqual([0, 50, 50, 0]),
      )
      expect(screen.queryByText('Visar 1–50 av 51 överföringar.')).toBeNull()
      expect(screen.queryByText('Inget att stämma av i urvalet.')).toBeNull()
      expect(screen.queryByText('Visar 0–0 av 50 överföringar.')).toBeNull()
      expect(committedText.some((text) => text.includes('Inget att stämma av i urvalet.'))).toBe(
        false,
      )
      expect(committedText.some((text) => text.includes('Visar 0–0 av 50 överföringar.'))).toBe(
        false,
      )
      await act(async () => reloaded.resolve(page({ offset: 0 }, 50)))
      expect(await screen.findByText('Visar 1–50 av 50 överföringar.')).toBeTruthy()
    } finally {
      reloaded.resolve(page({ offset: 0 }, 50))
    }
  })

  it('kallar inte en tom sida med positiv total tomt urval utan erbjuder en ny läsning', async () => {
    mocks.list.mockResolvedValueOnce({ items: [], total: 4, offset: 0, limit: 50 })
    show()
    expect(
      await screen.findByText('Urvalet har ändrats. Uppdatera listan för att se aktuell sida.'),
    ).toBeTruthy()
    expect(screen.queryByText('Inget att stämma av i urvalet.')).toBeNull()
    expect(screen.queryByText('Visar 0–0 av 4 överföringar.')).toBeNull()
    expect(mocks.list).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Uppdatera listan' }))
    expect(await screen.findByText('Visar 1–4 av 4 överföringar.')).toBeTruthy()
    expect(mocks.list).toHaveBeenCalledTimes(2)
  })

  it('kallar inte ett svar med rader men noll i total tomt urval', async () => {
    // Sida och total läses separat: en rad kan tillkomma mellan de två DB-frågorna.
    mocks.list.mockResolvedValueOnce({ items: [row('Ny rad')], total: 0, offset: 0, limit: 50 })
    show()
    expect(
      await screen.findByText('Urvalet har ändrats. Uppdatera listan för att se aktuell sida.'),
    ).toBeTruthy()
    expect(screen.queryByText('Inget att stämma av i urvalet.')).toBeNull()
    expect(screen.queryByText('Visar 1–1 av 0 överföringar.')).toBeNull()
    expect(screen.queryByText('Skäl: Ny rad')).toBeNull()
    expect(mocks.list).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Uppdatera listan' }))
    expect(await screen.findByText('Visar 1–4 av 4 överföringar.')).toBeTruthy()
    expect(mocks.list).toHaveBeenCalledTimes(2)
  })
})
