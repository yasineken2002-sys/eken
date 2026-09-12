import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { AiPage } from './AiPage'
import type { AiConversation, PendingAction } from './api/ai.api'

const api = vi.hoisted(() => ({
  fetchConversations: vi.fn(),
  fetchConversation: vi.fn(),
  fetchToolCatalog: vi.fn(),
  confirmAction: vi.fn(),
  sendMessage: vi.fn(),
  deleteConversation: vi.fn(),
}))
vi.mock('./api/ai.api', async (original) => ({
  ...(await original<typeof import('./api/ai.api')>()),
  ...api,
}))
vi.mock('@/components/ui/PageWrapper', () => ({
  PageWrapper: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('./components/AnalysisModal', () => ({ AnalysisModal: () => null }))
vi.mock('./components/WelcomeState', () => ({
  WelcomeGreeting: () => null,
  SuggestionChips: () => null,
}))
vi.mock('./components/Composer', () => ({
  Composer: ({
    value,
    onChange,
    onSubmit,
  }: {
    value: string
    onChange: (text: string) => void
    onSubmit: () => void
  }) => (
    <div>
      <input aria-label="Fråga" value={value} onChange={(event) => onChange(event.target.value)} />
      <button onClick={onSubmit}>Fråga assistenten</button>
    </div>
  ),
}))
vi.mock('./components/ConversationSidebar', () => ({
  ConversationSidebar: ({
    onNewConversation,
    onSelect,
  }: {
    onNewConversation: () => void
    onSelect: (id: string) => void
  }) => (
    <div>
      <button onClick={onNewConversation}>Nytt samtal</button>
      <button onClick={() => onSelect('annat-samtal')}>Annat samtal</button>
    </div>
  ),
}))
vi.mock('./hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({ isListening: false, start: vi.fn(), stop: vi.fn() }),
}))
vi.mock('./hooks/useAttachments', () => ({
  useAttachments: () => ({
    attachments: [],
    readyIds: [],
    blockingReason: null,
    clear: vi.fn(),
    remove: vi.fn(),
    add: vi.fn(),
    retry: vi.fn(),
  }),
}))

const explanation = 'Jag föreslår Björken. Kontrollera uppgifterna före bekräftelsen.'
const action: PendingAction & { conversationId: string } = {
  conversationId: 'samtal-1',
  toolName: 'create_property',
  toolInput: { name: 'Björken' },
  confirmationMessage: 'Vill du skapa fastigheten Björken?',
  details: { Namn: 'Björken' },
}
const conversation: AiConversation = {
  id: 'samtal-1',
  organizationId: 'org-1',
  userId: 'user-1',
  title: 'Fråga',
  createdAt: '2026-09-12T10:00:00Z',
  updatedAt: '2026-09-12T10:00:00Z',
  messages: [
    {
      id: 'user-message',
      conversationId: 'samtal-1',
      role: 'user',
      content: 'Kan du hjälpa mig?',
      createdAt: '2026-09-12T10:00:00Z',
    },
  ],
}
let queryClient: QueryClient
let transport: ReadableStreamDefaultController<Uint8Array>
const encoder = new TextEncoder()

beforeEach(() => {
  vi.resetAllMocks()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  })
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  api.fetchConversations.mockResolvedValue([])
  api.fetchConversation.mockResolvedValue(conversation)
  api.fetchToolCatalog.mockResolvedValue([])
  api.confirmAction.mockResolvedValue({ conversationId: action.conversationId, reply: '' })
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      transport = controller
    },
  })
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(body, {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    ),
  )
})
afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.unstubAllGlobals()
})

async function startQuestion() {
  render(
    <QueryClientProvider client={queryClient}>
      <AiPage />
    </QueryClientProvider>,
  )
  fireEvent.change(screen.getByLabelText('Fråga'), { target: { value: 'Kan du hjälpa mig?' } })
  fireEvent.click(screen.getByText('Fråga assistenten'))
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
  expect(api.sendMessage).not.toHaveBeenCalled()
}
function events(text = explanation) {
  return encoder.encode(
    'event: delta\ndata: ' +
      JSON.stringify({ text }) +
      '\n\n' +
      'event: pending_action\ndata: ' +
      JSON.stringify(action) +
      '\n\n',
  )
}
async function deliver(chunks: Uint8Array[]) {
  await act(async () => {
    for (const chunk of chunks) transport.enqueue(chunk)
    transport.close()
  })
  await screen.findByText('Bekräfta åtgärd')
}

describe('AiPage — bekräftelseförklaring genom den verkliga SSE-läsaren', () => {
  it.each(['samma läsning', 'delad JSON och UTF-8'])(
    'behåller texten exakt en gång genom %s och återhämtning av enbart user-historik',
    async (mode) => {
      await startQuestion()
      const bytes = events()
      // Dela mitt i ö:s två bytes och mitt i pending-payloadens JSON.
      const utf8 = bytes.indexOf(0xc3) + 1
      const json = bytes.length - 23
      await deliver(
        mode === 'samma läsning'
          ? [bytes]
          : [bytes.slice(0, utf8), bytes.slice(utf8, json), bytes.slice(json)],
      )
      expect(screen.getAllByText(explanation)).toHaveLength(1)
      expect(screen.getAllByText(action.confirmationMessage)).toHaveLength(1)
      await waitFor(() => expect(api.fetchConversation).toHaveBeenCalled())
      await act(async () => {
        await queryClient.refetchQueries({ queryKey: ['ai-conversation', action.conversationId] })
      })
      expect(api.fetchConversation.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(queryClient.getQueryData(['ai-conversation', action.conversationId])).toEqual(
        conversation,
      )
      expect(screen.getAllByText(explanation)).toHaveLength(1)
      expect(api.confirmAction).not.toHaveBeenCalled()
    },
  )

  it('behåller förklaringen mellan två bekräftelser och rensar efter slutligt svar', async () => {
    api.confirmAction.mockResolvedValueOnce({
      conversationId: action.conversationId,
      reply: '',
      pendingAction: { ...action, requiresDoubleConfirm: true },
    })
    await startQuestion()
    await deliver([events()])
    fireEvent.click(screen.getByText('Bekräfta och utför'))
    await screen.findByText('Hög risk — bekräfta igen')
    expect(screen.getAllByText(explanation)).toHaveLength(1)
    expect(api.confirmAction).toHaveBeenCalledTimes(1)
    expect(api.confirmAction.mock.calls.at(-1)?.[0]).toEqual({
      conversationId: action.conversationId,
      toolName: action.toolName,
      toolInput: action.toolInput,
      confirmed: true,
    })
    fireEvent.click(screen.getByText('Ja, jag är säker — utför ändå'))
    await waitFor(() => expect(screen.queryByText(explanation)).toBeNull())
    expect(api.confirmAction).toHaveBeenCalledTimes(2)
  })

  it.each(['Avbryt', 'Nytt samtal', 'Annat samtal'])(
    'låter inte förklaringen följa med efter %s',
    async (exit) => {
      await startQuestion()
      await deliver([events()])
      expect(screen.getAllByText(explanation)).toHaveLength(1)
      fireEvent.click(screen.getByText(exit))
      await waitFor(() => expect(screen.queryByText(explanation)).toBeNull())
      if (exit === 'Avbryt') {
        expect(api.confirmAction).toHaveBeenCalledTimes(1)
        expect(api.confirmAction.mock.calls[0]?.[0]).toEqual({
          conversationId: action.conversationId,
          toolName: action.toolName,
          toolInput: action.toolInput,
          confirmed: false,
        })
      } else {
        expect(api.confirmAction).not.toHaveBeenCalled()
      }
    },
  )
})
