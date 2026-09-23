import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NoticesPage } from './NoticesPage'
import type { PortalRentNotice } from '@/types/portal.types'

/**
 * #913 — VAD FILTERTEXTEN FÅR PÅSTÅ.
 *
 * Chippen hette "Obetalda" och "Betalda". Mätningen före ändringen visade att
 * `UNPAID_INVOICE_STATUSES` innehåller PARTIAL, alltså att en DELBETALD faktura
 * låg under "Obetalda" samtidigt som kortet bredvid sa "Delvis betald" och
 * "Kvar av X — Y betalt". Vyn sa tre saker om samma rad.
 *
 * Det djupare skälet är det som G2 handlade om: appen känner REGISTRERINGAR.
 * Ett underlag som inte matchats bevisar inte att hyresgästen låtit bli att
 * betala. Texten ska därför säga vad Eveno vet, inte vad hyresgästen gjort.
 *
 * Proven nedan mäter texterna och att MÄNGDERNA inte ändrats med dem: en rad
 * som låg under filtret före ska ligga där efter. Byter någon ut urvalet för
 * att passa en formulering faller `delbetald ligger kvar`-provet.
 *
 * Det här är jsdom, inte en webbläsare. Det säger ingenting om layout eller om
 * chippen får plats på en telefon; den frågan hör till webbläsarprovet.
 */

const api = vi.hoisted(() => ({
  fetchInvoices: vi.fn(),
  fetchRentNotices: vi.fn(),
  fetchMiscCharges: vi.fn(),
  downloadInvoicePdf: vi.fn(),
  downloadRentNoticePdf: vi.fn(),
}))

vi.mock('@/api/portal.api', () => ({
  ...api,
  extractApiError: (_err: unknown, fallback = 'Något gick fel') => fallback,
}))

const FAKTURA_DELBETALD = {
  id: 'inv-partial',
  invoiceNumber: 'F-1001',
  type: 'RENT',
  status: 'PARTIAL' as const,
  total: 10000,
  paid: 4000,
  outstanding: 6000,
  dueDate: '2026-10-01T00:00:00.000Z',
  issueDate: '2026-09-01T00:00:00.000Z',
  paidAt: null,
  propertyName: 'Eken 1',
  unitName: 'Lgh 1001',
}

const FAKTURA_BETALD = {
  ...FAKTURA_DELBETALD,
  id: 'inv-paid',
  invoiceNumber: 'F-1002',
  status: 'PAID' as const,
  paid: 10000,
  outstanding: 0,
  paidAt: '2026-09-15T00:00:00.000Z',
}

const AVI_DELBETALD = {
  id: 'rn-partial',
  noticeNumber: 'A-2001',
  ocrNumber: '1234567890',
  month: 10,
  year: 2026,
  amount: 9000,
  vatAmount: 0,
  consumptionAmount: 0,
  miscChargeAmount: 0,
  totalAmount: 9000,
  payableTotal: 5000,
  nominalTotal: 9000,
  paid: 4000,
  dueDate: '2026-10-01T00:00:00.000Z',
  paidAt: null,
  status: 'SENT' as const,
  sentAt: '2026-09-20T00:00:00.000Z',
  propertyName: 'Eken 1',
  unitName: 'Lgh 1001',
}

function rendera() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <NoticesPage />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  api.fetchInvoices.mockResolvedValue([FAKTURA_DELBETALD, FAKTURA_BETALD])
  api.fetchRentNotices.mockResolvedValue([AVI_DELBETALD])
  api.fetchMiscCharges.mockResolvedValue([])
})

afterEach(() => vi.useRealTimers())

describe('hyresavins svenska förfallodag', () => {
  it.each([
    ['SENT', '2026-06-30T21:59:59Z', false],
    ['SENT', '2026-07-01T10:00:00Z', false],
    ['SENT', '2026-07-01T21:59:59Z', false],
    ['SENT', '2026-07-01T22:00:00Z', true],
    ['OVERDUE', '2026-06-30T21:59:59Z', false],
    ['OVERDUE', '2026-07-01T10:00:00Z', false],
    ['OVERDUE', '2026-07-01T21:59:59Z', false],
    ['OVERDUE', '2026-07-01T22:00:00Z', true],
  ] as const)('%s vid %s: förfallen=%s i både badge och datumrad', async (status, now, overdue) => {
    vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(new Date(now))
    api.fetchRentNotices.mockResolvedValue([
      { ...AVI_DELBETALD, status, dueDate: '2026-07-01T00:00:00Z' },
    ])
    rendera()
    await screen.findByText(AVI_DELBETALD.ocrNumber)
    expect(Boolean(screen.queryByText('Förfallen'))).toBe(overdue)
    expect(Boolean(screen.queryByText('⚠️ Förfallen'))).toBe(overdue)
    expect(Boolean(screen.queryByText('Skickad'))).toBe(!overdue)
    // Bevara restskuld, delbetalningsförklaring och filtret även för gammal OVERDUE.
    expect(screen.getByText(/Kvar av .* — .* betalt/)).toBeTruthy()
    fireEvent.click(screen.getByText('Inte registrerade som betalda'))
    expect(screen.getByText(AVI_DELBETALD.ocrNumber)).toBeTruthy()
  })

  it.each([
    ['PAID', 0],
    ['CANCELLED', 5000],
    ['PENDING', 5000],
    ['FAILED', 5000],
    ['SENT', 0],
    ['OVERDUE', 0],
    ['OVERDUE', -100],
  ] satisfies [PortalRentNotice['status'], number][])(
    '%s med payableTotal=%s märks aldrig förfallen',
    async (status, payableTotal) => {
      vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(new Date('2026-07-02T10:00:00Z'))
      api.fetchRentNotices.mockResolvedValue([
        { ...AVI_DELBETALD, status, payableTotal, dueDate: '2026-07-01T00:00:00Z' },
      ])
      rendera()
      await screen.findByText(AVI_DELBETALD.ocrNumber)
      expect(screen.queryByText(/Förfallen/)).toBeNull()
      if (status === 'PAID') expect(screen.getByText('Betald')).toBeTruthy()
      if (status === 'CANCELLED') expect(screen.getByText('Makulerad')).toBeTruthy()
    },
  )

  it.each(['2026-07-01T00:00:00Z', '2026-06-30T22:00:00Z'])(
    'visar 1 juli för %s även i en Los Angeles-process',
    async (dueDate) => {
      api.fetchRentNotices.mockResolvedValue([{ ...AVI_DELBETALD, dueDate }])
      rendera()
      expect(await screen.findByText('1 juli 2026')).toBeTruthy()
      expect(screen.queryByText('30 juni 2026')).toBeNull()
    },
  )
})

describe('#913 — filtertexten påstår inte mer än registreringen vet', () => {
  it('ORDET "Obetalda" FINNS INTE KVAR i vyn', async () => {
    rendera()
    await screen.findByText('Inte registrerade som betalda')
    // Hela poängen. Faller det här har någon skrivit tillbaka påståendet.
    expect(screen.queryByText('Obetalda')).toBeNull()
    expect(screen.queryByText('Betalda')).toBeNull()
  })

  it('chippen säger vad appen vet, inte vad hyresgästen gjort', async () => {
    rendera()
    expect(await screen.findByText('Inte registrerade som betalda')).toBeTruthy()
    expect(screen.getByText('Registrerade som betalda')).toBeTruthy()
    expect(screen.getByText('Alla')).toBeTruthy()
  })

  it('hjälptexten säger att en betalning kan vara gjord utan att synas', async () => {
    rendera()
    const hint = await screen.findByText(/Statusen visar vad som är registrerat hos hyresvärden/)
    expect(hint.textContent).toContain('kan vara gjord utan att ännu synas här')
  })

  it('EN DELBETALD FAKTURA LIGGER KVAR under filtret — mängden är orörd', async () => {
    rendera()
    fireEvent.click(await screen.findByRole('tab', { name: 'Fakturor' }))
    fireEvent.click(await screen.findByText('Inte registrerade som betalda'))

    // Raden syns...
    expect(await screen.findByText('F-1001')).toBeTruthy()
    // ...och kortet säger fortfarande att något ÄR betalt. Det är den
    // motsägelsen som fanns när filtret hette "Obetalda".
    expect(screen.getByText('Delvis betald')).toBeTruthy()
    expect(screen.getByText(/Kvar av .* — .* betalt/)).toBeTruthy()
    // Den betalda fakturan ska INTE ha följt med filtret.
    expect(screen.queryByText('F-1002')).toBeNull()
  })

  it('EN DELBETALD AVI ligger också kvar — avier saknar PARTIAL men har `paid`', async () => {
    rendera()
    fireEvent.click(await screen.findByText('Inte registrerade som betalda'))
    // Avikortet renderar aldrig `noticeNumber` — det visar månad, OCR och
    // adress. Första versionen av provet sökte på A-2001 och föll därför på
    // sin egen fixtur, inte på produkten.
    expect(await screen.findByText('1234567890')).toBeTruthy()
    expect(screen.getByText(/Kvar av .* — .* betalt/)).toBeTruthy()
  })

  it('MAKULERADE OCH INKASSO nämns bara på fakturafliken, där de kan finnas', async () => {
    rendera()
    // Avifliken: avier kan bara vara SENT/PAID/OVERDUE, så meningen vore falsk.
    const hint = await screen.findByText(/Statusen visar vad som är registrerat/)
    expect(hint.textContent).not.toContain('inkasso')

    fireEvent.click(screen.getByRole('tab', { name: 'Fakturor' }))
    await waitFor(() => {
      expect(screen.getByText(/Statusen visar vad som är registrerat/).textContent).toContain(
        'lämnats till inkasso visas bara under Alla',
      )
    })
  })

  it('"Betalda"-filtret visar bara den betalda raden', async () => {
    rendera()
    fireEvent.click(await screen.findByRole('tab', { name: 'Fakturor' }))
    fireEvent.click(await screen.findByText('Registrerade som betalda'))
    expect(await screen.findByText('F-1002')).toBeTruthy()
    expect(screen.queryByText('F-1001')).toBeNull()
  })
})
