import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  MutationCache,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JournalEntry, UserRole } from '@eken/shared'
import { useAuthStore } from '@/stores/auth.store'
import { extractApiError } from '@/lib/api'
import type { fetchJournalPage, JournalPage } from '../../accounting/api/accounting.api'
import type { FortnoxExportRow } from '../api/fortnox-export.api'
import { FortnoxJournalPicker } from './FortnoxJournalPicker'

type PageQuery = Parameters<typeof fetchJournalPage>[0]
const mocks = vi.hoisted(() => ({
  page: vi.fn<(query: PageQuery, signal?: AbortSignal) => Promise<JournalPage>>(),
  dryRun: vi.fn<(input: { journalEntryId: string }) => Promise<FortnoxExportRow>>(),
}))

vi.mock('../../accounting/api/accounting.api', () => ({ fetchJournalPage: mocks.page }))
vi.mock('../api/fortnox-export.api', () => ({ startFortnoxDryRun: mocks.dryRun }))

const clients: QueryClient[] = []
const changed = vi.fn<() => Promise<void>>()
const globalToast = vi.fn<(message: string) => void>()
const DEFAULT_QUERY = { offset: 0, limit: 50 }

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

function journalId(number: number): string {
  return `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
}

function journal(number: number, prefix = 'Historiskt verifikat'): JournalEntry {
  return {
    id: journalId(number),
    organizationId: useAuthStore.getState().organization?.id ?? 'org-a',
    date: '2020-02-29',
    description: `${prefix} ${number}`,
    source: 'MANUAL',
    lines: [],
    createdById: 'synthetic-user',
    createdAt: '2020-03-01T12:00:00Z',
    series: 'A',
    verNumber: number,
  }
}

function page(query: PageQuery, total: number, base = 0, prefix?: string): JournalPage {
  return {
    offset: query.offset,
    limit: query.limit,
    total,
    entries: Array.from(
      { length: Math.max(0, Math.min(query.limit, total - query.offset)) },
      (_, index) => journal(base + query.offset + index + 1, prefix),
    ),
  }
}

function result(journalEntryId: string, blockReason = 'RESULTAT_A'): FortnoxExportRow {
  return {
    id: 'synthetic-export',
    journalEntryId,
    state: 'BLOCKED',
    blockReason,
    updatedAt: '2026-01-01T12:00:00Z',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

/** Transportgränsen konsumerar den riktiga signalen, som Axios gör. */
function transport<T>(response: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'))
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    void response.then(
      (value) => {
        signal?.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal?.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

function show() {
  // Samma risk som webbens globala keepPreviousData: gammalt urval kan följa med
  // till nästa sida/scope om komponenten inte uttryckligen stänger den vägen.
  const client = new QueryClient({
    // Samma globala felväg som main.tsx. En lokal onError stoppar inte i sig
    // denna callback, och ett avmonterat mutationsförsök lever kvar i cachen.
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (mutation.meta?.['handlesOwnError']) return
        globalToast(extractApiError(error, 'Något gick fel'))
      },
    }),
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, placeholderData: (previous: unknown) => previous },
      mutations: { retry: false },
    },
  })
  clients.push(client)
  const view = render(
    <QueryClientProvider client={client}>
      <FortnoxJournalPicker onChanged={changed} />
    </QueryClientProvider>,
  )
  return { ...view, client }
}

function select() {
  return screen.getByLabelText('Verifikat', { exact: true }) as HTMLSelectElement
}

function visibleJournalIds(): string[] {
  const input = screen.queryByLabelText('Verifikat', { exact: true }) as HTMLSelectElement | null
  return input
    ? Array.from(input.options)
        .map((option) => option.value)
        .filter(Boolean)
    : []
}

function button(name: string) {
  return screen.getByRole('button', { name }) as HTMLButtonElement
}

async function expectJournal(number: number) {
  await waitFor(() => expect(visibleJournalIds()).toContain(journalId(number)))
}

async function choose(number: number) {
  await expectJournal(number)
  fireEvent.change(select(), { target: { value: journalId(number) } })
  expect(select().value).toBe(journalId(number))
}

async function clickPage(name: string) {
  await waitFor(() => expect(button(name).disabled).toBe(false))
  fireEvent.click(button(name))
}

describe('FortnoxJournalPicker', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    onlineManager.setOnline(true)
    setScope()
    mocks.page.mockImplementation(async (query) => page(query, 100))
    mocks.dryRun.mockImplementation(async ({ journalEntryId }) => result(journalEntryId))
    changed.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    clients.splice(0).forEach((client) => client.clear())
    onlineManager.setOnline(true)
    useAuthStore.setState({ user: null, organization: null, isAuthenticated: false })
    localStorage.clear()
  })

  it('når verifikat 2001 direkt via sista sidan med 50 per fråga och utan dold datumgräns', async () => {
    mocks.page.mockImplementation(async (query) => page(query, 2005))
    show()
    expect(screen.getByRole('region', { name: 'Välj verifikat för förhandskontroll' })).toBeTruthy()
    await expectJournal(1)
    expect(screen.getByText(/Visar 1–50 av 2005 verifikat/)).toBeTruthy()
    expect(visibleJournalIds()).toHaveLength(50)
    expect(mocks.page).toHaveBeenCalledTimes(1)
    expect(mocks.page).toHaveBeenCalledWith(DEFAULT_QUERY, expect.any(AbortSignal))
    expect((screen.getByLabelText('Verifikationsdatum från') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Verifikationsdatum till') as HTMLInputElement).value).toBe('')
    expect(select().value).toBe('')
    expect(mocks.dryRun).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()

    await clickPage('Sista sidan')
    await expectJournal(2001)
    expect(screen.getByText(/Visar 2001–2005 av 2005 verifikat/)).toBeTruthy()
    expect(visibleJournalIds()).toHaveLength(5)
    expect(mocks.page.mock.calls.map(([query]) => query)).toEqual([
      DEFAULT_QUERY,
      { offset: 2000, limit: 50 },
    ])
    expect(button('Nästa').disabled).toBe(true)
    expect(button('Sista sidan').disabled).toBe(true)
    expect(mocks.dryRun).not.toHaveBeenCalled()

    await choose(2001)
    fireEvent.click(button('Förhandskontrollera'))
    expect(await screen.findByText(/RESULTAT_A/)).toBeTruthy()
    expect(mocks.dryRun).toHaveBeenCalledTimes(1)
    expect(mocks.dryRun).toHaveBeenCalledWith({ journalEntryId: journalId(2001) })
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
    await clickPage('Föregående')
    await expectJournal(1951)
    expect(screen.getByText(/Visar 1951–2000 av 2005 verifikat/)).toBeTruthy()
    expect(select().value).toBe('')
    expect(screen.queryByText(/RESULTAT_A/)).toBeNull()
    expect(mocks.page).toHaveBeenLastCalledWith(
      { offset: 1950, limit: 50 },
      expect.any(AbortSignal),
    )
    expect(mocks.dryRun).toHaveBeenCalledTimes(1)
  })

  it('skickar datum och källa först vid Visa urval och återgår till första sidan', async () => {
    mocks.page.mockImplementation(async (query) => page(query, query.from ? 2 : 100))
    show()
    await choose(1)
    fireEvent.click(button('Förhandskontrollera'))
    await screen.findByText(/RESULTAT_A/)
    await clickPage('Nästa')
    await expectJournal(51)
    await choose(51)
    fireEvent.click(button('Förhandskontrollera'))
    await screen.findByText(/RESULTAT_A/)
    fireEvent.change(screen.getByLabelText('Verifikationsdatum från'), {
      target: { value: '2020-02-01' },
    })
    fireEvent.change(screen.getByLabelText('Verifikationsdatum till'), {
      target: { value: '2020-02-29' },
    })
    fireEvent.change(screen.getByLabelText('Källa'), { target: { value: 'MANUAL' } })
    expect(mocks.page).toHaveBeenCalledTimes(2)
    fireEvent.click(button('Visa urval'))
    await waitFor(() =>
      expect(mocks.page).toHaveBeenLastCalledWith(
        {
          offset: 0,
          limit: 50,
          from: '2020-02-01',
          to: '2020-02-29',
          source: 'MANUAL',
        },
        expect.any(AbortSignal),
      ),
    )
    await expectJournal(1)
    expect(visibleJournalIds()).toHaveLength(2)
    expect(select().value).toBe('')
    expect(screen.queryByText(/RESULTAT_A/)).toBeNull()
    expect(mocks.dryRun).toHaveBeenCalledTimes(2)
    fireEvent.click(button('Alla datum'))
    await waitFor(() => {
      const query = mocks.page.mock.lastCall?.[0]
      expect(query?.offset).toBe(0)
      expect(query?.limit).toBe(50)
      expect(query?.from).toBeUndefined()
      expect(query?.to).toBeUndefined()
    })
    expect((screen.getByLabelText('Verifikationsdatum från') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Verifikationsdatum till') as HTMLInputElement).value).toBe('')
  })

  it('nekar omvänt datumintervall före hämtning och före förhandskontroll', async () => {
    show()
    await expectJournal(1)
    fireEvent.change(screen.getByLabelText('Verifikationsdatum från'), {
      target: { value: '2026-03-01' },
    })
    fireEvent.change(screen.getByLabelText('Verifikationsdatum till'), {
      target: { value: '2026-02-28' },
    })
    fireEvent.click(button('Visa urval'))
    expect(screen.getByRole('alert').textContent).toBeTruthy()
    expect(mocks.page).toHaveBeenCalledTimes(1)
    expect(mocks.dryRun).not.toHaveBeenCalled()
  })

  it('döljer tidigare val under sidladdning och läsfel, och hämtar om bara efter Försök igen', async () => {
    const next = deferred<JournalPage>()
    mocks.page.mockImplementation((query) =>
      query.offset ? next.promise : Promise.resolve(page(query, 100)),
    )
    show()
    await choose(1)
    await clickPage('Nästa')
    expect(visibleJournalIds()).toEqual([])
    expect(button('Förhandskontrollera').disabled).toBe(true)
    await act(async () => next.reject(new Error('synthetic read failure')))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(visibleJournalIds()).toEqual([])
    expect(screen.queryByText(/Inga verifikat/)).toBeNull()
    expect(mocks.page).toHaveBeenCalledTimes(2)
    expect(mocks.dryRun).not.toHaveBeenCalled()
    mocks.page.mockImplementation(async (query) => page(query, 100))
    fireEvent.click(button('Försök igen'))
    await expectJournal(51)
    expect(select().value).toBe('')
    expect(mocks.page).toHaveBeenCalledTimes(3)
    expect(mocks.page).toHaveBeenLastCalledWith({ offset: 50, limit: 50 }, expect.any(AbortSignal))
  })

  it('visar ett verkligt tomt urval utan valbar rad eller automatisk POST', async () => {
    mocks.page.mockImplementation(async (query) => page(query, 0))
    show()
    expect(await screen.findByText(/Inga verifikat/)).toBeTruthy()
    expect(screen.getByText(/Visar 0–0 av 0 verifikat/)).toBeTruthy()
    expect(visibleJournalIds()).toEqual([])
    for (const name of ['Föregående', 'Nästa', 'Sista sidan', 'Förhandskontrollera']) {
      expect(button(name).disabled).toBe(true)
    }
    expect(mocks.dryRun).not.toHaveBeenCalled()
  })

  it('kallar inte en sida efter det nya slutet för tomt urval när totalen fortfarande är positiv', async () => {
    const last = deferred<JournalPage>()
    let shrunk = false
    mocks.page.mockImplementation((query) =>
      query.offset ? last.promise : Promise.resolve(page(query, shrunk ? 10 : 100)),
    )
    show()
    await expectJournal(1)
    await clickPage('Sista sidan')
    shrunk = true
    await act(async () => last.resolve({ entries: [], total: 10, offset: 50, limit: 50 }))
    await waitFor(() => {
      // Antingen har rätt sida hämtats, eller finns en uttrycklig väg att
      // korrigera urvalet. Ett evigt laddningstillstånd är inte ett godkänt svar.
      const corrected = visibleJournalIds().length === 10
      const actionable = Array.from(document.querySelectorAll('button')).some(
        (candidate) =>
          !candidate.disabled &&
          /Uppdatera|Försök igen|Föregående|Sista sidan/.test(candidate.textContent ?? ''),
      )
      expect(corrected || actionable).toBe(true)
    })
    expect(screen.queryByText(/Inga verifikat/)).toBeNull()
    expect(screen.queryByText(/Visar 51–50/)).toBeNull()
    // Både automatisk ompositionering och ett ärligt uppdateringsläge är giltiga.
    // En tom lista får däremot aldrig presenteras som att de tio verifikaten saknas.
    expect(mocks.dryRun).not.toHaveBeenCalled()
  })

  it('låter inte ett sent svar för förra sidans fråga ersätta det nya datumurvalet', async () => {
    const oldPage = deferred<JournalPage>()
    mocks.page.mockImplementation((query) => {
      if (query.from) return Promise.resolve(page(query, 1, 10000, 'Nytt urval'))
      return query.offset ? oldPage.promise : Promise.resolve(page(query, 100))
    })
    show()
    await expectJournal(1)
    await clickPage('Nästa')
    fireEvent.change(screen.getByLabelText('Verifikationsdatum från'), {
      target: { value: '2025-01-01' },
    })
    fireEvent.click(button('Visa urval'))
    await expectJournal(10001)
    await act(async () => oldPage.resolve(page({ offset: 50, limit: 50 }, 100)))
    expect(visibleJournalIds()).toEqual([journalId(10001)])
    expect(select().value).toBe('')
    expect(mocks.dryRun).not.toHaveBeenCalled()
  })

  it.each(['svar', 'fel'] as const)(
    'ett sent förhandskontrolls%s återupplivar inte valet efter nästa och tillbaka',
    async (outcome) => {
      const oldResult = deferred<FortnoxExportRow>()
      mocks.dryRun.mockReturnValue(oldResult.promise)
      show()
      await choose(1)
      fireEvent.click(button('Förhandskontrollera'))
      await waitFor(() => expect(mocks.dryRun).toHaveBeenCalledTimes(1))
      await clickPage('Nästa')
      await expectJournal(51)
      await clickPage('Föregående')
      await expectJournal(1)
      expect(select().value).toBe('')
      await act(async () => {
        if (outcome === 'svar') oldResult.resolve(result(journalId(1), 'SENT_GAMMALT_RESULTAT'))
        else oldResult.reject(new Error('SENT_GAMMALT_FEL'))
      })
      expect(screen.queryByText(/SENT_GAMMALT/)).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(select().value).toBe('')
      expect(button('Förhandskontrollera').disabled).toBe(true)
      expect(mocks.dryRun).toHaveBeenCalledTimes(1)
    },
  )

  it('byte av valt verifikat tar bort resultatet och ett nytt fel kan inte lämna en gammal framgång', async () => {
    mocks.dryRun.mockResolvedValueOnce({
      ...result(journalId(1)),
      state: 'DRY_RUN_READY',
      blockReason: null,
    })
    show()
    await choose(1)
    fireEvent.click(button('Förhandskontrollera'))
    await screen.findByText(/INTE skickat eller bokfört/)
    await choose(2)
    expect(screen.queryByText(/INTE skickat eller bokfört/)).toBeNull()
    mocks.dryRun.mockRejectedValueOnce(new Error('synthetic dry-run failure'))
    fireEvent.click(button('Förhandskontrollera'))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText(/INTE skickat eller bokfört/)).toBeNull()
    expect(mocks.dryRun).toHaveBeenLastCalledWith({ journalEntryId: journalId(2) })
  })

  it('visar aldrig ett svar som avser ett annat verifikat än det valda', async () => {
    mocks.dryRun.mockResolvedValue(result(journalId(2), 'FEL_VERIFIKAT_RESULTAT'))
    show()
    await choose(1)
    fireEvent.click(button('Förhandskontrollera'))
    await waitFor(() => expect(mocks.dryRun).toHaveBeenCalledTimes(1))
    await act(async () => undefined)
    expect(screen.queryByText(/FEL_VERIFIKAT_RESULTAT/)).toBeNull()
  })

  it.each([
    ['organisation', 'org-b', 'user-b', 'OWNER'],
    ['användare', 'org-a', 'user-b', 'OWNER'],
    ['behörig roll', 'org-a', 'user-a', 'ADMIN'],
  ] as const)(
    'isolerar val, resultat och cache vid byte av %s och tillbaka',
    async (_label, org, user, role) => {
      const late = deferred<FortnoxExportRow>()
      mocks.dryRun.mockReturnValue(late.promise)
      let nextScope = false
      mocks.page.mockImplementation(async (query) => page(query, 2, nextScope ? 10000 : 0))
      show()
      await choose(1)
      fireEvent.click(button('Förhandskontrollera'))
      await waitFor(() => expect(mocks.dryRun).toHaveBeenCalledTimes(1))
      nextScope = true
      act(() => setScope(org, user, role))
      expect(visibleJournalIds()).not.toContain(journalId(1))
      await expectJournal(10001)
      expect(select().value).toBe('')
      expect(mocks.page).toHaveBeenCalledTimes(2)
      await act(async () => late.resolve(result(journalId(1), 'RESULTAT_ANNAT_SCOPE')))
      expect(screen.queryByText(/RESULTAT_ANNAT_SCOPE/)).toBeNull()
      nextScope = false
      act(() => setScope())
      await expectJournal(1)
      expect(select().value).toBe('')
      expect(screen.queryByText(/RESULTAT_ANNAT_SCOPE/)).toBeNull()
      expect(button('Förhandskontrollera').disabled).toBe(true)
      expect(mocks.dryRun).toHaveBeenCalledTimes(1)
    },
  )

  it.each(['MANAGER', 'ACCOUNTANT', 'VIEWER'] as const)(
    'hämtar och erbjuder inget för rollen %s',
    (role) => {
      setScope('org-a', 'user-a', role)
      show()
      expect(
        screen.queryByRole('region', { name: 'Välj verifikat för förhandskontroll' }),
      ).toBeNull()
      expect(mocks.page).not.toHaveBeenCalled()
      expect(mocks.dryRun).not.toHaveBeenCalled()
    },
  )

  it('döljer redan laddade val när behörigheten tas bort och återställer inget val när den kommer tillbaka', async () => {
    show()
    await choose(1)
    fireEvent.click(button('Förhandskontrollera'))
    await screen.findByText(/RESULTAT_A/)
    act(() => setScope('org-a', 'user-a', 'VIEWER'))
    expect(screen.queryByRole('region', { name: 'Välj verifikat för förhandskontroll' })).toBeNull()
    expect(screen.queryByText(/RESULTAT_A/)).toBeNull()
    act(() => setScope())
    await expectJournal(1)
    expect(select().value).toBe('')
    expect(screen.queryByText(/RESULTAT_A/)).toBeNull()
    expect(mocks.dryRun).toHaveBeenCalledTimes(1)
  })

  it('återupptar inte en cachad A-fråga som pausades offline under B och lagrar aldrig B-svaret i A-cachen', async () => {
    const bResponse = deferred<JournalPage>()
    const aAgain = deferred<JournalPage>()
    const requestScopes: string[] = []
    let aRequests = 0
    mocks.page.mockImplementation((query, signal) => {
      const org = useAuthStore.getState().organization?.id ?? 'missing'
      requestScopes.push(org)
      if (org === 'org-b') return transport(bResponse.promise, signal)
      aRequests += 1
      return transport(aRequests === 1 ? Promise.resolve(page(query, 2)) : aAgain.promise, signal)
    })
    const { client } = show()
    await expectJournal(1)
    const aQuery = client.getQueryCache().getAll()[0]
    if (!aQuery) throw new Error('Den riktiga A-frågan ska finnas i cachen')
    expect(client.getQueryData<JournalPage>(aQuery.queryKey)?.entries[0]?.organizationId).toBe(
      'org-a',
    )

    act(() => onlineManager.setOnline(false))
    let refetch: Promise<void> = Promise.resolve()
    act(() => {
      refetch = client.invalidateQueries({ queryKey: ['accounting', 'journal'] })
    })
    await waitFor(() =>
      expect(aQuery.state.fetchStatus === 'paused' || aQuery.state.status === 'error').toBe(true),
    )
    act(() => setScope('org-b', 'user-b'))
    await waitFor(() => {
      const bQuery = client
        .getQueryCache()
        .getAll()
        .find((query) => query !== aQuery)
      expect(bQuery?.state.fetchStatus === 'paused' || bQuery?.state.status === 'error').toBe(true)
    })
    await act(async () => onlineManager.setOnline(true))
    const retry = screen.queryByRole('button', { name: 'Försök igen' })
    if (retry) fireEvent.click(retry)
    await waitFor(() => expect(requestScopes).toContain('org-b'))
    await act(async () => bResponse.resolve(page(DEFAULT_QUERY, 2, 10000)))
    await expectJournal(10001)
    await refetch
    expect(requestScopes.filter((org) => org === 'org-b')).toHaveLength(1)
    expect(
      client
        .getQueryData<JournalPage>(aQuery.queryKey)
        ?.entries.some((entry) => entry.organizationId === 'org-b'),
    ).not.toBe(true)

    act(() => setScope())
    expect(visibleJournalIds()).not.toContain(journalId(10001))
    await act(async () => aAgain.resolve(page(DEFAULT_QUERY, 2)))
    await expectJournal(1)
    expect(visibleJournalIds()).toEqual([journalId(1), journalId(2)])
    expect(mocks.dryRun).not.toHaveBeenCalled()
  })

  it('skickar queryns AbortSignal till transporten och avbryter pågående A-läsning vid scopebyte', async () => {
    const oldResponse = deferred<JournalPage>()
    const oldPage = page(DEFAULT_QUERY, 2, 90000, 'Sent A-svar')
    let oldSignal: AbortSignal | undefined
    mocks.page.mockImplementation((query, signal) => {
      if (useAuthStore.getState().organization?.id === 'org-a') {
        oldSignal = signal
        return transport(oldResponse.promise, signal)
      }
      return transport(Promise.resolve(page(query, 2, 10000)), signal)
    })
    show()
    await waitFor(() => expect(mocks.page).toHaveBeenCalledTimes(1))
    expect(oldSignal).toBeInstanceOf(AbortSignal)
    act(() => setScope('org-b', 'user-b'))
    await expectJournal(10001)
    expect(oldSignal?.aborted).toBe(true)
    await act(async () => oldResponse.resolve(oldPage))
    expect(visibleJournalIds()).toEqual([journalId(10001), journalId(10002)])
    expect(globalToast).not.toHaveBeenCalled()
  })

  it('ger begripligt offlinefel och kräver ett nytt klick innan förhandskontrollen får starta', async () => {
    const { client } = show()
    await choose(1)
    act(() => onlineManager.setOnline(false))
    fireEvent.click(button('Förhandskontrollera'))
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /offline|nät|uppkoppling|internet/i,
    )
    expect(
      client
        .getMutationCache()
        .getAll()
        .some((mutation) => mutation.state.isPaused),
    ).toBe(false)
    expect(mocks.dryRun).not.toHaveBeenCalled()
    await act(async () => {
      onlineManager.setOnline(true)
      await client.resumePausedMutations()
    })
    expect(mocks.dryRun).not.toHaveBeenCalled()
    fireEvent.click(button('Förhandskontrollera'))
    await screen.findByText(/RESULTAT_A/)
    expect(mocks.dryRun).toHaveBeenCalledTimes(1)
    expect(globalToast).not.toHaveBeenCalled()
  })

  it('binder offlinebeslutet till klicket även om nätet återkommer före nästa mikrotask', async () => {
    const { client } = show()
    await choose(1)
    act(() => {
      onlineManager.setOnline(false)
      fireEvent.click(button('Förhandskontrollera'))
      onlineManager.setOnline(true)
    })
    await act(async () => {
      await client.resumePausedMutations()
    })
    expect(mocks.dryRun).not.toHaveBeenCalled()
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /offline|nät|uppkoppling|internet/i,
    )
    fireEvent.click(button('Förhandskontrollera'))
    await screen.findByText(/RESULTAT_A/)
    expect(mocks.dryRun).toHaveBeenCalledTimes(1)
  })

  it.each(['sida', 'scope', 'avmontering'] as const)(
    'skickar aldrig ett offlineförsök efter %s och återanslutning',
    async (change) => {
      mocks.page.mockImplementation(async (query) =>
        page(query, 100, useAuthStore.getState().organization?.id === 'org-b' ? 10000 : 0),
      )
      const view = show()
      await choose(1)
      act(() => onlineManager.setOnline(false))
      fireEvent.click(button('Förhandskontrollera'))
      if (change === 'sida') fireEvent.click(button('Nästa'))
      else if (change === 'scope') act(() => setScope('org-b', 'user-b'))
      else view.unmount()
      await act(async () => {
        onlineManager.setOnline(true)
        await view.client.resumePausedMutations()
      })
      expect(mocks.dryRun).not.toHaveBeenCalled()
      expect(
        view.client
          .getMutationCache()
          .getAll()
          .some((mutation) => mutation.state.isPaused),
      ).toBe(false)
      expect(globalToast).not.toHaveBeenCalled()
      expect(screen.queryByText(/RESULTAT_A/)).toBeNull()
    },
  )

  it.each(['sida', 'scope'] as const)(
    'ett sent mutationsfel ger varken global toast eller lokalt fel efter byte av %s',
    async (change) => {
      const oldResult = deferred<FortnoxExportRow>()
      mocks.dryRun.mockReturnValue(oldResult.promise)
      mocks.page.mockImplementation(async (query) =>
        page(query, 100, useAuthStore.getState().organization?.id === 'org-b' ? 10000 : 0),
      )
      const { client } = show()
      await choose(1)
      fireEvent.click(button('Förhandskontrollera'))
      await waitFor(() => expect(mocks.dryRun).toHaveBeenCalledTimes(1))
      if (change === 'sida') {
        await clickPage('Nästa')
        await expectJournal(51)
      } else {
        act(() => setScope('org-b', 'user-b'))
        await expectJournal(10001)
      }
      await act(async () => oldResult.reject(new Error('GAMMALT_FEL_MED_ORG_A_DATA')))
      await waitFor(() =>
        expect(
          client
            .getMutationCache()
            .getAll()
            .some((mutation) => mutation.state.status === 'error'),
        ).toBe(true),
      )
      expect(globalToast).not.toHaveBeenCalled()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.queryByText(/GAMMALT_FEL_MED_ORG_A_DATA/)).toBeNull()
      expect(select().value).toBe('')
    },
  )

  it.each(['före', 'efter'] as const)(
    'ett mutationsfel som kommer %s omläsningen återupplivas inte när samma urval blir redo igen',
    async (timing) => {
      const oldResult = deferred<FortnoxExportRow>()
      const refreshed = deferred<JournalPage>()
      mocks.dryRun.mockReturnValue(oldResult.promise)
      const { client } = show()
      await choose(1)
      fireEvent.click(button('Förhandskontrollera'))
      await waitFor(() => expect(mocks.dryRun).toHaveBeenCalledTimes(1))
      if (timing === 'före') {
        await act(async () => oldResult.reject(new Error('GAMMALT_MUTATIONSFEL')))
        expect((await screen.findByRole('alert')).textContent).toContain('GAMMALT_MUTATIONSFEL')
      }
      mocks.page.mockImplementation((_query, signal) => transport(refreshed.promise, signal))
      let refetch: Promise<void> = Promise.resolve()
      act(() => {
        refetch = client.invalidateQueries({ queryKey: ['accounting', 'journal'] })
      })
      // Raderna försvinner i render; mutationsfelet rensas i en passiv effekt.
      // Observera båda innan nätresponsen släpps, inte ett mellanläge i DOM.
      await waitFor(() => {
        expect(visibleJournalIds()).toEqual([])
        expect(screen.queryByRole('alert')).toBeNull()
      })
      await act(async () => refreshed.resolve(page(DEFAULT_QUERY, 100)))
      await refetch
      await expectJournal(1)
      if (timing === 'efter')
        await act(async () => oldResult.reject(new Error('GAMMALT_MUTATIONSFEL')))
      await waitFor(() =>
        expect(
          client
            .getMutationCache()
            .getAll()
            .some((mutation) => mutation.state.status === 'error'),
        ).toBe(true),
      )
      expect(screen.queryByRole('alert')).toBeNull()
      expect(globalToast).not.toHaveBeenCalled()
      expect(select().value).toBe('')
      expect(mocks.dryRun).toHaveBeenCalledTimes(1)
    },
  )
})
