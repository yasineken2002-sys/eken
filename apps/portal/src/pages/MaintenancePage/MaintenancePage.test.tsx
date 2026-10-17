import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { onlineManager, useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  AxiosError,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { MemoryRouter } from 'react-router-dom'
import { portalApi } from '@/api/portal.api'
import { SessionBoundary } from '@/components/SessionBoundary'
import { useSessionStore } from '@/store/session.store'
import type { PortalMaintenanceTicket, PortalTenant } from '@/types/portal.types'
import { MaintenancePage } from './MaintenancePage'

const notifications = vi.hoisted(() => ({
  error: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  dismiss: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: notifications }))

// Verklig sida, sessiongräns, QueryClient, API-funktioner och Axios-interceptorer.
// Endast transportens leveranstid/svar, toast och objectURL-presentation ersätts.
const URL_PATH = '/portal/maintenance'
const TOKEN = 'synthetic-maintenance-session'
const TENANT: PortalTenant = {
  id: '70000000-0000-4000-8000-000000000001',
  type: 'INDIVIDUAL',
  firstName: 'Syntetisk hyresgäst',
  email: 'maintenance@synthetic.invalid',
}
const A = {
  title: 'Kranen läcker',
  description: 'Syntetiskt första utkast vid kökskranen.',
  category: 'PLUMBING',
}
const B = {
  title: 'Lampan fungerar inte',
  description: 'Syntetiskt senare utkast vid taklampan.',
  category: 'ELECTRICAL',
}
const TICKET_A: PortalMaintenanceTicket = {
  id: '71000000-0000-4000-8000-000000000001',
  ticketNumber: 'TEST-1',
  ...A,
  status: 'NEW',
  priority: 'NORMAL',
  createdAt: '2026-10-17T10:00:00.000Z',
  scheduledDate: null,
  property: { name: 'Syntetiska huset' },
  unit: { name: 'Syntetisk lägenhet' },
  comments: [],
}
const COMMENT_A = 'Första kommentarens syntetiska text.'
const COMMENT_B = 'Ett senare, ännu inte inskickat meddelande.'

interface Write {
  config: InternalAxiosRequestConfig
  payload: unknown
  promise: Promise<AxiosResponse>
  respond: (data: unknown) => void
  abandon: () => void
  settled: boolean
}
const writes: Write[] = []
const clients = new Set<QueryClient>()
const originalAdapter = portalApi.defaults.adapter
const originalOnline = Object.getOwnPropertyDescriptor(window.navigator, 'onLine')
const originalObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
let managerWasOnline = true
let serverTickets: PortalMaintenanceTicket[] = []
let reads = 0

function response(config: InternalAxiosRequestConfig, data: unknown): AxiosResponse {
  return { config, status: 200, statusText: 'OK', headers: {}, data: { success: true, data } }
}

const adapter: AxiosAdapter = (config) => {
  if (config.method === 'get' && config.url === URL_PATH) {
    reads += 1
    return Promise.resolve(response(config, serverTickets))
  }
  if (
    config.method !== 'post' ||
    ![
      URL_PATH,
      `${URL_PATH}/${TICKET_A.id}/images`,
      `${URL_PATH}/${TICKET_A.id}/comment`,
      `${URL_PATH}/71000000-0000-4000-8000-000000000002/images`,
    ].includes(config.url ?? '')
  ) {
    return Promise.reject(new Error('Oväntad testtransport'))
  }
  let resolve!: (value: AxiosResponse) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<AxiosResponse>((yes, no) => {
    resolve = yes
    reject = no
  })
  // Även en bruten assertion ska kunna städa ett ännu väntande transportsvar.
  void promise.catch(() => undefined)
  const write: Write = {
    config,
    payload: config.data as unknown,
    promise,
    settled: false,
    respond(data) {
      write.settled = true
      resolve(response(config, data))
    },
    abandon() {
      if (write.settled) return
      write.settled = true
      reject(new AxiosError('Testtransport avslutad', 'ERR_CANCELED', config))
    },
  }
  writes.push(write)
  return promise
}

function ObserveClient() {
  const client = useQueryClient()
  useEffect(() => {
    clients.add(client)
  }, [client])
  return null
}

async function show(tickets: PortalMaintenanceTicket[] = []) {
  serverTickets = tickets
  useSessionStore
    .getState()
    .setSession(TOKEN, TENANT, new Date(Date.now() + 3_600_000).toISOString())
  render(
    <MemoryRouter>
      <SessionBoundary>
        <ObserveClient />
        <MaintenancePage />
      </SessionBoundary>
    </MemoryRouter>,
  )
  await waitFor(() => {
    expect(reads).toBe(1)
    expect(clients.size).toBe(1)
    for (const client of clients) expect(client.isFetching()).toBe(0)
  })
}

async function pending(path: string, index = 0): Promise<Write> {
  await waitFor(() => expect(writes.filter((w) => w.config.url === path).length).toBe(index + 1))
  const write = writes.filter((w) => w.config.url === path)[index]
  if (!write) throw new Error('Testets väntande skrivning saknas')
  expect(write.config.headers.Authorization).toBe(`Bearer ${TOKEN}`)
  expect(write.settled).toBe(false)
  return write
}

function jsonPayload(write: Write): unknown {
  if (typeof write.payload !== 'string') throw new Error('Förväntade faktiskt JSON-kodad transport')
  return JSON.parse(write.payload) as unknown
}

function expectImage(write: Write, expected: File) {
  if (!(write.payload instanceof FormData)) throw new Error('Förväntade faktisk multipart-form')
  expect(Array.from(write.payload.keys())).toEqual(['images'])
  const file = write.payload.get('images')
  if (!(file instanceof File)) throw new Error('Förväntade bildfil i transporten')
  expect({ name: file.name, size: file.size, type: file.type }).toEqual({
    name: expected.name,
    size: expected.size,
    type: expected.type,
  })
}

function chooseImage(file: File) {
  const input = document.querySelector('input[type="file"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('Bildväljaren saknas')
  fireEvent.change(input, { target: { files: [file] } })
}

function fillDraft(draft: typeof A, categoryLabel: string, image: File) {
  fireEvent.change(screen.getByLabelText('Rubrik *'), { target: { value: draft.title } })
  fireEvent.change(screen.getByLabelText('Beskrivning *'), { target: { value: draft.description } })
  fireEvent.click(screen.getByRole('button', { name: categoryLabel }))
  chooseImage(image)
}

// Panelen är alltid monterad; fältvärden och fireEvent bevisar inte att den är
// öppen. Detta kontrollerar komponentens verkliga transform-tillstånd, inte
// layout, geometri eller tillgänglighet i en riktig webbläsare.
function expectSheetOpen(open: boolean) {
  const heading = screen.getByRole('heading', { name: 'Ny felanmälan' })
  const sheet = heading.parentElement?.parentElement
  if (!(sheet instanceof HTMLElement)) throw new Error('Felanmälans panel saknas')
  expect(sheet.style.transform).toBe(
    open ? 'translateX(-50%) translateY(0)' : 'translateX(-50%) translateY(100%)',
  )
}

async function respond(write: Write, data: unknown) {
  await act(async () => {
    write.respond(data)
    await write.promise
  })
}

// Inte bara adapter-promise: "Skickar..." måste ha funnits medan sista POST
// väntade och försvinna efter dess svar. Det är sidans finally efter hela kedjan
// (för kommentar även await invalidateQueries). Verklig refetch måste också landa.
// isMutating() vore ingen barriär här: sidan använder egna async-handlers.
async function finish(write: Write, data: unknown, tickets: PortalMaintenanceTicket[]) {
  expect(screen.getByRole('button', { name: 'Skickar...' })).toBeDisabled()
  const before = reads
  serverTickets = tickets
  await respond(write, data)
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: 'Skickar...' })).not.toBeInTheDocument()
    expect(reads).toBeGreaterThan(before)
    for (const client of clients) expect(client.isFetching()).toBe(0)
  })
  expect(notifications.error).not.toHaveBeenCalled()
  expect(notifications.warning).not.toHaveBeenCalled()
}

beforeEach(() => {
  writes.length = 0
  clients.clear()
  reads = 0
  serverTickets = []
  managerWasOnline = onlineManager.isOnline()
  onlineManager.setOnline(true)
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true })
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:synthetic-maintenance-preview'),
  })
  localStorage.clear()
  useSessionStore.getState().clearSession()
  portalApi.defaults.adapter = adapter
  vi.clearAllMocks()
})

afterEach(async () => {
  cleanup()
  await act(async () => {
    useSessionStore.getState().clearSession()
    for (const write of writes) write.abandon()
    await Promise.allSettled(writes.map((write) => write.promise))
  })
  for (const client of clients) client.clear()
  if (originalAdapter === undefined) delete portalApi.defaults.adapter
  else portalApi.defaults.adapter = originalAdapter
  if (originalOnline) Object.defineProperty(window.navigator, 'onLine', originalOnline)
  else Reflect.deleteProperty(window.navigator, 'onLine')
  if (originalObjectURL) Object.defineProperty(URL, 'createObjectURL', originalObjectURL)
  else Reflect.deleteProperty(URL, 'createObjectURL')
  onlineManager.setOnline(managerWasOnline)
  localStorage.clear()
})

describe('MaintenancePage – senare utkast under pågående inskick', () => {
  it.each([
    { mode: 'create', label: 'sent create-svar efter stäng/öppna bevarar det nya utkastet' },
    { mode: 'image', label: 'sent bildsvar bevarar ny text, kategori och bild' },
    { mode: 'image-only', label: 'enbart nytt bildval räcker för att bevara utkastet' },
  ] as const)('$label', async ({ mode }) => {
    await show()
    const imageA = new File(['image-A'], 'forsta.png', { type: 'image/png' })
    const imageB = new File(['new-image-B-longer'], 'senare.png', { type: 'image/png' })
    fireEvent.click(screen.getByRole('button', { name: 'Ny felanmälan' }))
    fillDraft(A, 'VVS', imageA)
    fireEvent.click(screen.getByRole('button', { name: 'Skicka felanmälan' }))
    const createA = await pending(URL_PATH)
    expect(jsonPayload(createA)).toEqual(A)

    let imageRequestA: Write | undefined
    if (mode !== 'create') {
      await respond(createA, TICKET_A)
      imageRequestA = await pending(`${URL_PATH}/${TICKET_A.id}/images`)
    }
    const nextDraft = mode === 'image-only' ? A : B
    if (mode === 'create') {
      fireEvent.click(screen.getByRole('button', { name: 'Avbryt' }))
      fireEvent.click(screen.getByRole('button', { name: 'Ny felanmälan' }))
    }
    if (mode === 'image-only') chooseImage(imageB)
    else fillDraft(B, 'El', imageB)
    expect(screen.getByRole('button', { name: 'Skickar...' })).toBeDisabled()
    if (mode === 'create') {
      await respond(createA, TICKET_A)
      imageRequestA = await pending(`${URL_PATH}/${TICKET_A.id}/images`)
    }
    if (!imageRequestA) throw new Error('Den första bilduppladdningen saknas')
    expectImage(imageRequestA, imageA)
    expectSheetOpen(true)
    // A:s ursprungliga bildkedja fullföljs, men nytt B-utkast skickas inte automatiskt.
    await finish(imageRequestA, [{ id: 'image-a', storageUrl: '/synthetic/image-a' }], [TICKET_A])
    expect(writes).toHaveLength(2)
    expectSheetOpen(true)
    expect(screen.getByLabelText('Rubrik *')).toHaveValue(nextDraft.title)
    expect(screen.getByLabelText('Beskrivning *')).toHaveValue(nextDraft.description)
    expect(screen.getByText('1 bild(er) valda')).toBeInTheDocument()
    expect(screen.getByText(TICKET_A.title)).toBeInTheDocument()

    // Ett nytt uttryckligt klick bevisar bevarad kategori och faktiskt bildB-val,
    // inte bara att texten "1 bild(er) valda" finns kvar eller en CSS-klass stämmer.
    fireEvent.click(screen.getByRole('button', { name: 'Skicka felanmälan' }))
    const createB = await pending(URL_PATH, 1)
    expect(jsonPayload(createB)).toEqual(nextDraft)
    const ticketB: PortalMaintenanceTicket = {
      ...TICKET_A,
      ...nextDraft,
      id: '71000000-0000-4000-8000-000000000002',
      ticketNumber: 'TEST-2',
    }
    await respond(createB, ticketB)
    const imageRequestB = await pending(`${URL_PATH}/${ticketB.id}/images`)
    expectImage(imageRequestB, imageB)
    await finish(
      imageRequestB,
      [{ id: 'image-b', storageUrl: '/synthetic/image-b' }],
      [TICKET_A, ticketB],
    )
    expect(writes).toHaveLength(4)
    expectSheetOpen(false)
    expect(screen.getByLabelText('Rubrik *')).toHaveValue('')
    expect(screen.getByLabelText('Beskrivning *')).toHaveValue('')
    expect(screen.queryByText('1 bild(er) valda')).not.toBeInTheDocument()
  })

  it.each([
    { label: 'ändrad kommentar A→B', edits: [COMMENT_B], expected: COMMENT_B },
    {
      label: 'kommentar A→B→A är ett nyare utkast trots samma text',
      edits: [COMMENT_B, COMMENT_A],
      expected: COMMENT_A,
    },
  ])('$label bevaras efter gammalt svar', async ({ edits, expected }) => {
    await show([TICKET_A])
    fireEvent.click(screen.getByText(TICKET_A.title))
    const input = screen.getByPlaceholderText('Lägg till ett meddelande...')
    fireEvent.change(input, { target: { value: COMMENT_A } })
    fireEvent.click(screen.getByRole('button', { name: 'Skicka' }))
    const commentA = await pending(`${URL_PATH}/${TICKET_A.id}/comment`)
    expect(jsonPayload(commentA)).toEqual({ content: COMMENT_A })
    for (const text of edits) fireEvent.change(input, { target: { value: text } })
    const updated: PortalMaintenanceTicket = {
      ...TICKET_A,
      comments: [
        { id: 'comment-a', content: COMMENT_A, createdAt: TICKET_A.createdAt, isInternal: false },
      ],
    }
    await finish(commentA, updated, [updated])
    expect(writes).toHaveLength(1)
    expect(screen.getByPlaceholderText('Lägg till ett meddelande...')).toHaveValue(expected)
    expect(screen.getByText(COMMENT_A, { selector: 'p' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Skicka' })).toBeEnabled()
  })

  it('rensar oförändrat formulär först efter både create och bildsvaret', async () => {
    await show()
    const image = new File(['unchanged-image'], 'oforandrad.png', { type: 'image/png' })
    fireEvent.click(screen.getByRole('button', { name: 'Ny felanmälan' }))
    fillDraft(A, 'VVS', image)
    fireEvent.click(screen.getByRole('button', { name: 'Skicka felanmälan' }))
    const create = await pending(URL_PATH)
    expect(jsonPayload(create)).toEqual(A)
    await respond(create, TICKET_A)
    const upload = await pending(`${URL_PATH}/${TICKET_A.id}/images`)
    expectImage(upload, image)
    expectSheetOpen(true)
    expect(screen.getByLabelText('Rubrik *')).toHaveValue(A.title)
    expect(screen.getByText('1 bild(er) valda')).toBeInTheDocument()
    await finish(upload, [{ id: 'image-a', storageUrl: '/synthetic/image-a' }], [TICKET_A])
    expect(writes).toHaveLength(2)
    expectSheetOpen(false)
    expect(screen.getByLabelText('Rubrik *')).toHaveValue('')
    expect(screen.getByLabelText('Beskrivning *')).toHaveValue('')
    expect(screen.queryByText('1 bild(er) valda')).not.toBeInTheDocument()
    expect(screen.getByText(TICKET_A.title)).toBeInTheDocument()
  })

  it('rensar oförändrad kommentar och visar serverns nya kommentar efter refetch', async () => {
    await show([TICKET_A])
    fireEvent.click(screen.getByText(TICKET_A.title))
    fireEvent.change(screen.getByPlaceholderText('Lägg till ett meddelande...'), {
      target: { value: COMMENT_A },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Skicka' }))
    const comment = await pending(`${URL_PATH}/${TICKET_A.id}/comment`)
    expect(jsonPayload(comment)).toEqual({ content: COMMENT_A })
    const updated: PortalMaintenanceTicket = {
      ...TICKET_A,
      comments: [
        { id: 'comment-a', content: COMMENT_A, createdAt: TICKET_A.createdAt, isInternal: false },
      ],
    }
    await finish(comment, updated, [updated])
    expect(writes).toHaveLength(1)
    expect(screen.getByPlaceholderText('Lägg till ett meddelande...')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Skicka' })).toBeDisabled()
    expect(screen.getByText(COMMENT_A, { selector: 'p' })).toBeInTheDocument()
  })
})
