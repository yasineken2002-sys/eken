import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * F-046-1 (TESTKUND-047): AI-sidans konversationspanel ska nås när sidopanelen är dold (mobil, under md).
 *
 * Provet renderar SIDAN och gör kundens handlingar: öppna «Konversationer», växla till ett tidigare samtal, starta
 * ett nytt, radera (med befintlig bekräftelse) och öppna portföljanalysen. Det faller om knappen eller panelen
 * saknas. jsdom tillämpar ingen CSS, så det som mäts är kopplingen — att kontrollen finns och gör rätt. Att den
 * faktiskt syns och fungerar vid 390 px (och att desktop är oförändrad) mäts i verklig webbläsare
 * (rigg-100/kedja-mobil.mjs). API-lagret mockas på hook-nivå; endpoints ägs av API-proven.
 */

const tvaSamtal = [
  {
    id: 'c-1',
    organizationId: 'o',
    userId: 'u',
    title: 'Saldo kundfordringar',
    createdAt: '2026-10-10',
    updatedAt: '2026-10-10',
    messages: [],
  },
  {
    id: 'c-2',
    organizationId: 'o',
    userId: 'u',
    title: 'Momsen i oktober',
    createdAt: '2026-10-10',
    updatedAt: '2026-10-10',
    messages: [],
  },
]
const innehall: Record<string, string> = {
  'c-1': 'Fråga om kundfordringar 1510',
  'c-2': 'Fråga om momsen',
}
const raderaMock = vi.fn().mockResolvedValue(undefined)

vi.mock('./hooks/useAi', () => ({
  useConversations: () => ({ data: tvaSamtal, isLoading: false }),
  useConversation: (id: string | null) => ({
    data: id
      ? {
          ...tvaSamtal.find((c) => c.id === id)!,
          messages: [
            {
              id: `${id}-m`,
              conversationId: id,
              role: 'user',
              content: innehall[id],
              createdAt: '2026-10-10',
            },
          ],
        }
      : undefined,
  }),
  useSendMessage: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useConfirmAction: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteConversation: () => ({ mutateAsync: raderaMock, isPending: false }),
  useToolCatalog: () => ({ data: [] }),
}))
vi.mock('./hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({ isListening: false, start: vi.fn(), stop: vi.fn() }),
}))
vi.mock('./hooks/useAttachments', () => ({
  useAttachments: () => ({
    attachments: [],
    addFiles: vi.fn(),
    remove: vi.fn(),
    blockingReason: null,
    clear: vi.fn(),
  }),
}))
vi.mock('./components/AnalysisModal', () => ({
  AnalysisModal: ({ open }: { open: boolean }) => (open ? <div>PORTFÖLJANALYS ÖPPEN</div> : null),
}))

import { AiPage } from './AiPage'

const rendera = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AiPage />
    </QueryClientProvider>,
  )
const oppnaPanel = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Konversationer' }))
  return screen.getByRole('dialog', { name: 'Konversationer' })
}

// jsdom saknar scrollIntoView (sidan rullar till senaste meddelandet).
Element.prototype.scrollIntoView = vi.fn()

describe('F-046-1: konversationspanelen via knappen «Konversationer»', () => {
  beforeEach(() => raderaMock.mockClear())

  it('knappen finns och öppnar panelen med båda samtalen, ny konversation och portföljanalys', () => {
    rendera()
    const knapp = screen.getByRole('button', { name: 'Konversationer' })
    expect([knapp.getAttribute('aria-expanded'), knapp.getAttribute('aria-controls')]).toEqual([
      'false',
      'ai-konversationspanel',
    ])
    const panel = oppnaPanel()
    expect(knapp.getAttribute('aria-expanded')).toBe('true')
    expect(panel.querySelector('#ai-konversationspanel')).not.toBeNull()
    expect(within(panel).getByText('Saldo kundfordringar')).toBeTruthy()
    expect(within(panel).getByText('Momsen i oktober')).toBeTruthy()
    expect(within(panel).getByRole('button', { name: /Ny konversation/ })).toBeTruthy()
    expect(within(panel).getByRole('button', { name: /Analysera portfölj/ })).toBeTruthy()
  })

  it('val av ett tidigare samtal stänger panelen och visar just det samtalets innehåll', async () => {
    rendera()
    fireEvent.click(within(oppnaPanel()).getByText('Momsen i oktober'))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Konversationer' })).toBeNull())
    expect(screen.getByText('Fråga om momsen')).toBeTruthy()
    fireEvent.click(within(oppnaPanel()).getByText('Saldo kundfordringar'))
    await waitFor(() => expect(screen.getByText('Fråga om kundfordringar 1510')).toBeTruthy())
    expect(screen.queryByText('Fråga om momsen')).toBeNull()
  })

  it('ny konversation medan ett samtal pågår stänger panelen och ger tomt läge', async () => {
    rendera()
    fireEvent.click(within(oppnaPanel()).getByText('Saldo kundfordringar'))
    await waitFor(() => expect(screen.getByText('Fråga om kundfordringar 1510')).toBeTruthy())
    fireEvent.click(within(oppnaPanel()).getByRole('button', { name: /Ny konversation/ }))
    await waitFor(() => expect(screen.queryByText('Fråga om kundfordringar 1510')).toBeNull())
    expect(screen.queryByRole('dialog', { name: 'Konversationer' })).toBeNull()
  })

  it('radering kräver bekräftelse: Nej raderar inget, Ja raderar exakt det valda samtalet', async () => {
    rendera()
    const panel = oppnaPanel()
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Ta bort konversation Momsen i oktober' }),
    )
    fireEvent.click(within(panel).getByRole('button', { name: 'Nej' }))
    expect(raderaMock).not.toHaveBeenCalled()
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Ta bort konversation Momsen i oktober' }),
    )
    fireEvent.click(within(panel).getByRole('button', { name: 'Ja' }))
    await waitFor(() => expect(raderaMock).toHaveBeenCalledTimes(1))
    expect(raderaMock).toHaveBeenCalledWith('c-2')
  })

  it('portföljanalys stänger panelen och öppnar analysen', async () => {
    rendera()
    fireEvent.click(within(oppnaPanel()).getByRole('button', { name: /Analysera portfölj/ }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Konversationer' })).toBeNull())
    expect(screen.getByText('PORTFÖLJANALYS ÖPPEN')).toBeTruthy()
  })
})
