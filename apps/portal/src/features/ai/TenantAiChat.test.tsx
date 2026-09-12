import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TenantChatSchema } from '@eken/shared'
import { confirmAiAction, sendAiMessage, type TenantAiChatResponse } from '@/api/portal.api'
import { TenantAiChat } from './TenantAiChat'

vi.mock('@/api/portal.api', () => ({
  sendAiMessage: vi.fn(),
  confirmAiAction: vi.fn(),
}))

const skickat = vi.mocked(sendAiMessage)
const bekräftat = vi.mocked(confirmAiAction)
const klienter: QueryClient[] = []
const scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')

beforeAll(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  })
})

afterAll(() => {
  if (scrollDescriptor) {
    Object.defineProperty(Element.prototype, 'scrollIntoView', scrollDescriptor)
  } else {
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  }
})

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(() => {
  cleanup()
  klienter.splice(0).forEach((klient) => klient.clear())
})

function visa(initialMessage?: string) {
  const klient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  klienter.push(klient)
  return render(
    <QueryClientProvider client={klient}>
      <TenantAiChat
        open
        onClose={vi.fn()}
        {...(initialMessage !== undefined ? { initialMessage } : {})}
      />
    </QueryClientProvider>,
  )
}

function skriv(text: string) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } })
}

function skicka() {
  fireEvent.click(screen.getByRole('button', { name: 'Skicka' }))
}

function väntandeSvar() {
  let resolve!: (value: TenantAiChatResponse) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<TenantAiChatResponse>((ja, nej) => {
    resolve = ja
    reject = nej
  })
  return { promise, resolve, reject }
}

const svar: TenantAiChatResponse = {
  conversationId: 'konversation-1',
  reply: 'Beskriv var det läcker.',
}

describe('TenantAiChat — utkast och kontrakt före skick', () => {
  it.each(['Nätverksfel', 'HTTP 503: assistenten är inte tillgänglig'])(
    'behåller felanmälan vid %s och tömmer den först efter lyckat återförsök',
    async (fel) => {
      skickat.mockRejectedValueOnce(new Error(fel)).mockResolvedValueOnce(svar)
      visa()
      const text = 'Det läcker under diskbänken sedan i morse.'
      skriv(text)
      skicka()

      expect(await screen.findByRole('alert')).toHaveTextContent(fel)
      expect(screen.getByRole('textbox')).toHaveValue(text)
      expect(skickat).toHaveBeenCalledTimes(1)
      // Felet får inte framställas som ett skickat meddelande i historiken.
      expect(screen.queryByText(text, { selector: 'div' })).not.toBeInTheDocument()

      skicka()
      expect(await screen.findByText(svar.reply)).toBeInTheDocument()
      expect(skickat).toHaveBeenNthCalledWith(2, text, undefined)
      expect(screen.getByRole('textbox')).toHaveValue('')
      expect(screen.getByText(text, { selector: 'div' })).toBeInTheDocument()
    },
  )

  it('behåller texten under pågående anrop och spärrar dubbla skick', async () => {
    const väntande = väntandeSvar()
    skickat.mockReturnValue(väntande.promise)
    visa()
    const text = 'Kranen läcker i köket.'
    skriv(text)
    skicka()
    skicka()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })

    await waitFor(() => expect(skickat).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('textbox')).toHaveValue(text)
    expect(screen.getByRole('textbox')).toBeDisabled()
    await act(async () => väntande.resolve(svar))
    expect(await screen.findByText(svar.reply)).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveValue('')
  })

  it('behåller ett misslyckat förslagsmeddelande i fältet för återförsök', async () => {
    skickat.mockRejectedValueOnce(new Error('Nätverksfel')).mockResolvedValueOnce(svar)
    visa()
    fireEvent.click(screen.getByRole('button', { name: 'Skapa felanmälan' }))

    await screen.findByRole('alert')
    expect(screen.getByRole('textbox')).toHaveValue('Skapa felanmälan')
    skicka()
    await screen.findByText(svar.reply)
    expect(skickat).toHaveBeenNthCalledWith(2, 'Skapa felanmälan', undefined)
    expect(screen.getByRole('textbox')).toHaveValue('')
  })

  it('behåller initialMessage vid fel utan automatiska återförsök', async () => {
    const text = 'Min kyl fungerar inte.'
    skickat.mockRejectedValueOnce(new Error('HTTP 503')).mockResolvedValueOnce(svar)
    visa(text)

    await screen.findByRole('alert')
    expect(screen.getByRole('textbox')).toHaveValue(text)
    expect(skickat).toHaveBeenCalledTimes(1)
    skicka()
    await screen.findByText(svar.reply)
    expect(skickat).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('textbox')).toHaveValue('')
  })

  it.each(['ny text', 'samma text'])(
    'låter ett sent lyckat svar behålla ett nyare redigerat utkast: %s',
    async (läge) => {
      const väntande = väntandeSvar()
      skickat.mockReturnValue(väntande.promise)
      visa()
      const text = 'Kranen läcker i köket.'
      skriv(text)
      skicka()
      await waitFor(() => expect(skickat).toHaveBeenCalledTimes(1))

      // Simulerar en redigeringshändelse efter submit. Även identisk text kan
      // vara ett nytt utkast; därför räcker inte en strängjämförelse som skydd.
      const nytt = läge === 'ny text' ? 'Det gäller också badrummet.' : text
      if (läge === 'samma text') skriv('Tillfällig redigering')
      skriv(nytt)
      await act(async () => väntande.resolve(svar))

      await screen.findByText(svar.reply)
      expect(screen.getByRole('textbox')).toHaveValue(nytt)
    },
  )

  it('låter ett sent fel behålla ett nyare utkast', async () => {
    const väntande = väntandeSvar()
    skickat.mockReturnValue(väntande.promise)
    visa()
    skriv('Kranen läcker i köket.')
    skicka()
    await waitFor(() => expect(skickat).toHaveBeenCalledTimes(1))
    skriv('Ny beskrivning av felet.')
    await act(async () => väntande.reject(new Error('Nätverksfel')))

    await screen.findByRole('alert')
    expect(screen.getByRole('textbox')).toHaveValue('Ny beskrivning av felet.')
  })

  it('härleder fältgränsen från schemat och stoppar för lång input före API-anrop', async () => {
    const max = TenantChatSchema.shape.message.maxLength!
    visa()
    expect(screen.getByRole('textbox')).toHaveAttribute('maxlength', String(max))
    // Programmatisk inmatning kan gå förbi HTML-gränsen; schemat måste också gälla.
    const text = 'x'.repeat(max + 1)
    skriv(text)
    skicka()

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(skickat).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox')).toHaveValue(text)
  })

  it('stoppar för lång initialMessage och låter hyresgästen rätta den utan textförlust', async () => {
    const max = TenantChatSchema.shape.message.maxLength!
    const text = 'x'.repeat(max + 1)
    skickat.mockResolvedValue(svar)
    visa(text)

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(skickat).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox')).toHaveValue(text)
    const rättat = 'x'.repeat(max)
    skriv(rättat)
    skicka()
    await screen.findByText(svar.reply)
    expect(skickat).toHaveBeenCalledTimes(1)
    expect(skickat).toHaveBeenCalledWith(rättat, undefined)
  })

  it('tömmer ett lyckat förslag men behåller bekräftelsegrinden och rätt konversation', async () => {
    const pendingAction = {
      toolName: 'create_maintenance_ticket',
      toolInput: { title: 'Läckande kran', description: 'Kranen läcker i köket.' },
      confirmationMessage: 'Skapa felanmälan: Läckande kran',
      details: { Titel: 'Läckande kran' },
    }
    skickat.mockResolvedValue({ conversationId: 'konversation-1', reply: '', pendingAction })
    bekräftat.mockResolvedValue({ conversationId: 'konversation-1', reply: 'Felanmälan skapad.' })
    visa()
    skriv('Kranen läcker i köket.')
    skicka()

    const knapp = await screen.findByRole('button', { name: 'Bekräfta' })
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(screen.getByRole('textbox')).toBeDisabled()
    expect(bekräftat).not.toHaveBeenCalled()
    fireEvent.click(knapp)

    await screen.findByText('Felanmälan skapad.')
    expect(bekräftat).toHaveBeenCalledWith({
      toolName: pendingAction.toolName,
      toolInput: pendingAction.toolInput,
      conversationId: 'konversation-1',
      confirmed: true,
    })
    expect(screen.getByRole('textbox')).toBeEnabled()
  })
})
