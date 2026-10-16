import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { InstallPortal } from './InstallPortal'

// Webbläsarens installationshändelser är testgränsen. Ingen produkt-hook,
// lagring eller sessionsfunktion ersätts; JSDOM bevisar inte OS-installation.
function deferred() {
  let resolve!: (value: unknown) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

class BrowserInstallEvent extends Event {
  readonly prompt = vi.fn(async (): Promise<unknown> => undefined)
  constructor(readonly userChoice: Promise<unknown>) {
    super('beforeinstallprompt', { cancelable: true })
  }
}

const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia')
const originalStandalone = Object.getOwnPropertyDescriptor(navigator, 'standalone')
const choices: ReturnType<typeof deferred>[] = []
let media: EventTarget & { matches: boolean }

function browserOffer() {
  const choice = deferred()
  choices.push(choice)
  const event = new BrowserInstallEvent(choice.promise)
  act(() => {
    window.dispatchEvent(event)
  })
  return { choice, event }
}

beforeEach(() => {
  media = Object.assign(new EventTarget(), { matches: false })
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => media),
  })
  Object.defineProperty(navigator, 'standalone', { configurable: true, value: false })
  choices.length = 0
})

afterEach(async () => {
  cleanup()
  await act(async () => {
    choices.forEach((choice) => choice.resolve({ outcome: 'dismissed' }))
  })
  vi.restoreAllMocks()
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia)
  else Reflect.deleteProperty(window, 'matchMedia')
  if (originalStandalone) Object.defineProperty(navigator, 'standalone', originalStandalone)
  else Reflect.deleteProperty(navigator, 'standalone')
})

describe('InstallPortal med webbläsarens verkliga eventgräns', () => {
  it('visar neutral menyhjälp utan påhittad installationsknapp eller lagring', () => {
    const read = vi.spyOn(Storage.prototype, 'getItem')
    const write = vi.spyOn(Storage.prototype, 'setItem')
    render(<InstallPortal />)
    expect(screen.getByRole('region', { name: 'Portalen på din enhet' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Installera portalen' })).not.toBeInTheDocument()
    expect(screen.getByText(/Du behöver internetanslutning/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Så lägger du till portalen'))
    expect(screen.getByText(/Öppna webbläsarens meny eller delningsmeny/)).toBeVisible()
    expect(screen.getByText(/På iPhone eller iPad/)).toBeVisible()
    const malformed = new Event('beforeinstallprompt', { cancelable: true })
    act(() => {
      window.dispatchEvent(malformed)
    })
    expect(malformed.defaultPrevented).toBe(false)
    expect(screen.queryByRole('button', { name: 'Installera portalen' })).not.toBeInTheDocument()
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('öppnar erbjudandet endast vid klick, en gång, och likställer inte accepted med installerad', async () => {
    render(<InstallPortal />)
    const { choice, event } = browserOffer()
    expect(event.defaultPrevented).toBe(true)
    expect(event.prompt).not.toHaveBeenCalled()
    const button = screen.getByRole('button', { name: 'Installera portalen' })
    button.focus()
    expect(button).toHaveFocus()
    fireEvent.click(button)
    fireEvent.click(button)
    expect(event.prompt).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Väntar på webbläsaren…' })).toBeDisabled()
    await act(async () => choice.resolve({ outcome: 'accepted', platform: 'web' }))
    expect(screen.getByRole('status')).toHaveTextContent('Webbläsaren hanterar installationen.')
    expect(screen.getByRole('status')).not.toHaveTextContent(/har installerats|öppnad som app/)
    expect(screen.queryByRole('button', { name: 'Installera portalen' })).not.toBeInTheDocument()
    expect(event.prompt).toHaveBeenCalledTimes(1)
  })

  it('behåller menyhjälpen efter avbrutet val och kräver ett nytt erbjudande för nästa prompt', async () => {
    render(<InstallPortal />)
    const first = browserOffer()
    fireEvent.click(screen.getByRole('button', { name: 'Installera portalen' }))
    await act(async () => first.choice.resolve({ outcome: 'dismissed' }))
    expect(screen.getByRole('status')).toHaveTextContent('Installationen avbröts.')
    expect(screen.getByText('Så lägger du till portalen')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Installera portalen' })).not.toBeInTheDocument()
    const next = browserOffer()
    expect(next.event.prompt).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Installera portalen' }))
    await act(async () => next.choice.resolve({ outcome: 'accepted' }))
    expect(first.event.prompt).toHaveBeenCalledTimes(1)
    expect(next.event.prompt).toHaveBeenCalledTimes(1)
  })

  it.each(['prompt', 'userChoice'] as const)(
    'hanterar avvisad %s utan råfel eller falsk installationsbekräftelse',
    async (failure) => {
      render(<InstallPortal />)
      const { choice, event } = browserOffer()
      const raw = new Error('PRIVATE_BROWSER_DETAIL')
      if (failure === 'prompt') event.prompt.mockRejectedValue(raw)
      fireEvent.click(screen.getByRole('button', { name: 'Installera portalen' }))
      await act(async () => {
        if (failure === 'userChoice') choice.reject(raw)
        else choice.resolve({ outcome: 'accepted' })
      })
      expect(screen.getByRole('status')).toHaveTextContent(
        'Installationsdialogen kunde inte öppnas.',
      )
      expect(document.body.textContent).not.toContain('PRIVATE_BROWSER_DETAIL')
      expect(screen.getByRole('status')).not.toHaveTextContent('har installerats')
      expect(screen.getByText('Så lägger du till portalen')).toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Väntar på webbläsaren…' }),
      ).not.toBeInTheDocument()
    },
  )

  it.each(['appinstalled', 'standalone'] as const)(
    '%s stoppar erbjudandet och kan inte skrivas över av ett sent avbrutet val',
    async (confirmation) => {
      render(<InstallPortal />)
      const { choice } = browserOffer()
      fireEvent.click(screen.getByRole('button', { name: 'Installera portalen' }))
      act(() => {
        if (confirmation === 'appinstalled') window.dispatchEvent(new Event('appinstalled'))
        else {
          media.matches = true
          media.dispatchEvent(new Event('change'))
        }
      })
      const expected =
        confirmation === 'appinstalled'
          ? 'Webbläsaren har bekräftat att portalen har installerats.'
          : 'Portalen är öppnad som app.'
      expect(screen.getByRole('status')).toHaveTextContent(expected)
      await act(async () => choice.resolve({ outcome: 'dismissed' }))
      expect(screen.getByRole('status')).toHaveTextContent(expected)
      expect(screen.queryByRole('button')).not.toBeInTheDocument()
      expect(screen.queryByText('Så lägger du till portalen')).not.toBeInTheDocument()
      const extra = browserOffer()
      expect(extra.event.prompt).not.toHaveBeenCalled()
      expect(screen.queryByRole('button')).not.toBeInTheDocument()
    },
  )

  it.each(['display-mode', 'iOS-standalone'] as const)(
    'visar faktiskt appfönster via %s utan att erbjuda ny installation',
    (mode) => {
      if (mode === 'display-mode') media.matches = true
      else Object.defineProperty(navigator, 'standalone', { configurable: true, value: true })
      render(<InstallPortal />)
      expect(screen.getByRole('status')).toHaveTextContent('Portalen är öppnad som app.')
      const { event } = browserOffer()
      expect(event.prompt).not.toHaveBeenCalled()
      expect(screen.queryByRole('button')).not.toBeInTheDocument()
    },
  )

  it('tar bort båda fönsterlyssnarna och medielyssnaren samt ignorerar gamla val efter unmount', async () => {
    const added = vi.spyOn(window, 'addEventListener')
    const removed = vi.spyOn(window, 'removeEventListener')
    const mediaAdded = vi.spyOn(media, 'addEventListener')
    const mediaRemoved = vi.spyOn(media, 'removeEventListener')
    const view = render(<InstallPortal />)
    const first = browserOffer()
    fireEvent.click(screen.getByRole('button', { name: 'Installera portalen' }))
    view.unmount()
    for (const eventName of ['beforeinstallprompt', 'appinstalled']) {
      const listener = added.mock.calls.find(([name]) => name === eventName)?.[1]
      expect(listener).toBeDefined()
      expect(removed).toHaveBeenCalledWith(eventName, listener)
    }
    expect(mediaRemoved).toHaveBeenCalledWith('change', mediaAdded.mock.calls[0]?.[1])
    const unmountedOffer = browserOffer()
    expect(unmountedOffer.event.defaultPrevented).toBe(false)
    render(<InstallPortal />)
    await act(async () => first.choice.resolve({ outcome: 'accepted' }))
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(unmountedOffer.event.prompt).not.toHaveBeenCalled()
  })

  it('behåller exakt en fungerande erbjudandehanterare genom StrictMode', async () => {
    render(
      <StrictMode>
        <InstallPortal />
      </StrictMode>,
    )
    const { choice, event } = browserOffer()
    fireEvent.click(screen.getByRole('button', { name: 'Installera portalen' }))
    await act(async () => choice.resolve({ outcome: 'dismissed' }))
    expect(event.prompt).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status')).toHaveTextContent('Installationen avbröts.')
  })
})
