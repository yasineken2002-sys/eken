import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
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
  const originalTZ = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'America/Los_Angeles'
    expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/Los_Angeles')
    expect(new Date('2026-07-01T00:00:00Z').getDate()).toBe(30)
  })
  afterAll(() => {
    if (originalTZ === undefined) delete process.env.TZ
    else process.env.TZ = originalTZ
  })
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
    ['OVERDUE', -100], // Defensivt komponentprov; API:s mapper klampar restskulden vid noll.
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
      expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/Los_Angeles')
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

/**
 * 2026-09-25 (portal-mobil) — DEPOSITION OCH HYRESAVI SAMMA MÅNAD, BÅDA BETALDA.
 *
 * Före ändringen var de två korten identiska ("September 2026 · 0 kr"): kunden kunde inte
 * se vilken avi som var depositionen. Provet binder varje korts synliga typ till AVINS
 * id via nedladdningen (onDownload får kortets id) — en etikett på fel kort fäller det,
 * inte bara en saknad etikett. Beloppet är restskulden och ska vara märkt som sådan.
 */
describe('avins typ och restskuldens etikett', () => {
  const bas = {
    ...AVI_DELBETALD,
    month: 9,
    year: 2026,
    payableTotal: 0,
    paid: 0,
    status: 'PAID' as const,
    paidAt: '2026-09-25T00:00:00.000Z',
  }
  const DEPOSITION = {
    ...bas,
    id: 'rn-dep',
    noticeNumber: 'AVI-2026-09-0001',
    type: 'DEPOSIT' as const,
    totalAmount: 5000,
    nominalTotal: 5000,
    paid: 5000,
  }
  const HYRA = {
    ...bas,
    id: 'rn-hyra',
    noticeNumber: 'AVI-2026-09-0002',
    type: 'RENT' as const,
    totalAmount: 9500,
    nominalTotal: 9500,
    paid: 9500,
  }

  beforeEach(() => {
    api.fetchRentNotices.mockResolvedValue([DEPOSITION, HYRA])
    api.downloadRentNoticePdf.mockResolvedValue(undefined)
  })

  it('varje kort bär sin EGEN typ — bunden till avins id via kortets nedladdning', async () => {
    rendera()
    const knappar = await screen.findAllByRole('button', { name: /Ladda ned PDF/ })
    expect(knappar).toHaveLength(2)
    const parningar: Array<[string, string]> = []
    for (const knapp of knappar) {
      // Kortet = närmaste förfader som rymmer hela avikortet (OCR-raden ingår).
      let kort = knapp.parentElement as HTMLElement
      while (kort && !/OCR-nummer/i.test(kort.textContent ?? ''))
        kort = kort.parentElement as HTMLElement
      api.downloadRentNoticePdf.mockClear()
      fireEvent.click(knapp)
      await waitFor(() => expect(api.downloadRentNoticePdf).toHaveBeenCalledTimes(1))
      const id = api.downloadRentNoticePdf.mock.calls[0]![0] as string
      const typ = /Deposition/.test(kort.textContent ?? '')
        ? 'Deposition'
        : /Hyresavi/.test(kort.textContent ?? '')
          ? 'Hyresavi'
          : 'ingen'
      parningar.push([id, typ])
    }
    expect(Object.fromEntries(parningar)).toEqual({ 'rn-dep': 'Deposition', 'rn-hyra': 'Hyresavi' })
  })

  it('0 kr är märkt som kvar att betala, och avins belopp står bara med egen etikett', async () => {
    rendera()
    await screen.findAllByRole('button', { name: /Ladda ned PDF/ })
    expect(screen.getAllByText('Kvar att betala')).toHaveLength(2)
    expect(screen.getByText(/Avins belopp\s+5\s000\s+kr/)).toBeTruthy()
    expect(screen.getByText(/Avins belopp\s+9\s500\s+kr/)).toBeTruthy()
  })

  it('saknas typ i svaret gissas den inte — neutral etikett', async () => {
    const utanTyp: Partial<typeof HYRA> = { ...HYRA }
    delete utanTyp.type
    api.fetchRentNotices.mockResolvedValue([utanTyp])
    rendera()
    await screen.findAllByRole('button', { name: /Ladda ned PDF/ })
    expect(screen.queryByText('Hyresavi')).toBeNull()
    expect(screen.queryByText('Deposition')).toBeNull()
    expect(screen.getByText('Avi')).toBeTruthy()
  })
})

/** Oberoende beloppsfacit: riktig sida/formatterare, bara befintlig API-gräns mockas. */
describe('öresprecision i betalningskort och debiteringar', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(new Date('2026-09-21T12:00:00Z'))
    api.downloadRentNoticePdf.mockResolvedValue(undefined)
    api.downloadInvoicePdf.mockResolvedValue(undefined)
  })

  function kortMed(ankare: string) {
    // OCR/fakturanummer respektive debiteringsbeskrivning sitter två nivåer in i kortet.
    // Facit begränsas till just det kortet, inte en matchande summa någon annanstans i vyn.
    const kort = screen.getByText(ankare, { exact: true }).parentElement?.parentElement
    if (!kort) throw new Error(`Kort saknas för ${ankare}`)
    return within(kort)
  }

  it.each([
    {
      rest: 0.29,
      nominellt: 100,
      betalt: 99.71,
      belopp: '0,29 kr',
      förklaring: 'Kvar av 100 kr — 99,71 kr betalt',
    },
    {
      rest: 0.01,
      nominellt: 100,
      betalt: 99.99,
      belopp: '0,01 kr',
      förklaring: 'Kvar av 100 kr — 99,99 kr betalt',
    },
    {
      rest: 1234.56,
      nominellt: 1334.27,
      betalt: 99.71,
      belopp: '1 234,56 kr',
      förklaring: 'Kvar av 1 334,27 kr — 99,71 kr betalt',
    },
  ])(
    'visar rest $rest exakt i både avi och faktura, med rätt filter och PDF-ID',
    async ({ rest, nominellt, betalt, belopp, förklaring }) => {
      const avi = {
        ...AVI_DELBETALD,
        id: 'rn-precision',
        noticeNumber: 'A-ORE-1',
        ocrNumber: '71111111111',
        amount: nominellt,
        totalAmount: nominellt,
        nominalTotal: nominellt,
        paid: betalt,
        payableTotal: rest,
      }
      const regleradAvi = {
        ...AVI_DELBETALD,
        id: 'rn-precision-paid',
        ocrNumber: '72222222222',
        status: 'PAID' as const,
        paid: 9000,
        payableTotal: 0,
        paidAt: '2026-09-20T12:00:00Z',
      }
      const faktura = {
        ...FAKTURA_DELBETALD,
        id: 'inv-precision',
        invoiceNumber: 'F-ORE-1',
        total: nominellt,
        paid: betalt,
        outstanding: rest,
      }
      api.fetchRentNotices.mockResolvedValue([avi, regleradAvi])
      api.fetchInvoices.mockResolvedValue([faktura, FAKTURA_BETALD])
      rendera()
      await screen.findByText(avi.ocrNumber)
      const avikort = kortMed(avi.ocrNumber)
      // Exakta bokstavliga tal; Testing Library normaliserar endast blanksteg (inklusive NBSP).
      expect(avikort.getByText(belopp, { exact: true })).toBeTruthy()
      expect(avikort.getByText('Kvar att betala', { exact: true })).toBeTruthy()
      expect(avikort.getByText(förklaring, { exact: true })).toBeTruthy()
      expect(avikort.getByText('Skickad', { exact: true })).toBeTruthy()
      fireEvent.click(screen.getByText('Inte registrerade som betalda'))
      expect(screen.getByText(avi.ocrNumber)).toBeTruthy()
      expect(screen.queryByText(regleradAvi.ocrNumber)).toBeNull()
      const aviPdf = avikort.getByRole('button', { name: 'Ladda ned PDF' })
      fireEvent.click(aviPdf)
      await waitFor(() => expect(api.downloadRentNoticePdf).toHaveBeenCalledTimes(1))
      expect(api.downloadRentNoticePdf).toHaveBeenCalledWith('rn-precision', 'A-ORE-1')
      await waitFor(() => expect(aviPdf).toBeEnabled())
      fireEvent.click(screen.getByText('Registrerade som betalda'))
      expect(screen.getByText(regleradAvi.ocrNumber)).toBeTruthy()
      expect(screen.queryByText(avi.ocrNumber)).toBeNull()

      fireEvent.click(screen.getByRole('tab', { name: 'Fakturor' }))
      await screen.findByText(faktura.invoiceNumber)
      const fakturakort = kortMed(faktura.invoiceNumber)
      expect(fakturakort.getByText(belopp, { exact: true })).toBeTruthy()
      expect(fakturakort.getByText(förklaring, { exact: true })).toBeTruthy()
      expect(fakturakort.getByText('Delvis betald', { exact: true })).toBeTruthy()
      fireEvent.click(screen.getByText('Inte registrerade som betalda'))
      expect(screen.getByText(faktura.invoiceNumber)).toBeTruthy()
      expect(screen.queryByText(FAKTURA_BETALD.invoiceNumber)).toBeNull()
      const fakturaPdf = fakturakort.getByRole('button', { name: 'Ladda ned PDF' })
      fireEvent.click(fakturaPdf)
      await waitFor(() => expect(api.downloadInvoicePdf).toHaveBeenCalledTimes(1))
      expect(api.downloadInvoicePdf).toHaveBeenCalledWith('inv-precision', 'F-ORE-1')
      await waitFor(() => expect(fakturaPdf).toBeEnabled())
      fireEvent.click(screen.getByText('Registrerade som betalda'))
      expect(screen.getByText(FAKTURA_BETALD.invoiceNumber)).toBeTruthy()
      expect(screen.queryByText(faktura.invoiceNumber)).toBeNull()
    },
  )

  it('skiljer verklig nollskuld från nominellt belopp och behåller hela kronor utan pålagda ören', async () => {
    api.fetchRentNotices.mockResolvedValue([
      {
        ...AVI_DELBETALD,
        id: 'rn-zero',
        ocrNumber: '73333333333',
        amount: 100,
        totalAmount: 100,
        nominalTotal: 100,
        paid: 100,
        payableTotal: 0,
        status: 'PAID',
        paidAt: '2026-09-20T12:00:00Z',
      },
      {
        ...AVI_DELBETALD,
        id: 'rn-whole',
        ocrNumber: '74444444444',
        amount: 1234,
        totalAmount: 1234,
        nominalTotal: 1234,
        paid: 0,
        payableTotal: 1234,
      },
    ] satisfies PortalRentNotice[])
    api.fetchInvoices.mockResolvedValue([
      {
        ...FAKTURA_BETALD,
        id: 'inv-zero',
        invoiceNumber: 'F-ZERO',
        total: 100,
        paid: 100,
        outstanding: 0,
      },
      {
        ...FAKTURA_DELBETALD,
        id: 'inv-whole',
        invoiceNumber: 'F-WHOLE',
        status: 'SENT',
        total: 1234,
        paid: 0,
        outstanding: 1234,
      },
    ])
    rendera()
    await screen.findByText('73333333333')
    const nollAvi = kortMed('73333333333')
    expect(nollAvi.getByText('0 kr', { exact: true })).toBeTruthy()
    expect(nollAvi.getByText('Kvar att betala', { exact: true })).toBeTruthy()
    expect(nollAvi.getByText('Avins belopp 100 kr', { exact: true })).toBeTruthy()
    expect(nollAvi.getByText('Betald', { exact: true })).toBeTruthy()
    expect(nollAvi.queryByText(/^Kvar av /)).toBeNull()
    expect(kortMed('74444444444').getByText('1 234 kr', { exact: true })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Fakturor' }))
    await screen.findByText('F-ZERO')
    const nollFaktura = kortMed('F-ZERO')
    expect(nollFaktura.getByText('0 kr', { exact: true })).toBeTruthy()
    expect(nollFaktura.getByText('Kvar av 100 kr — 100 kr betalt', { exact: true })).toBeTruthy()
    expect(nollFaktura.getByText('Betald', { exact: true })).toBeTruthy()
    expect(kortMed('F-WHOLE').getByText('1 234 kr', { exact: true })).toBeTruthy()
  })

  it('visar debiteringens total med ören, även en enda decimal, utan att visa nettot som total', async () => {
    api.fetchMiscCharges.mockResolvedValue([
      {
        id: 'mc-29',
        description: 'Syntetisk debitering 29',
        incidentDate: '2026-09-01',
        netAmount: 0.24,
        vatAmount: 0.05,
        totalAmount: 0.29,
      },
      {
        id: 'mc-10',
        description: 'Syntetisk debitering 10',
        incidentDate: '2026-09-01',
        netAmount: 0.08,
        vatAmount: 0.02,
        totalAmount: 0.1,
      },
      {
        id: 'mc-large',
        description: 'Syntetisk större debitering',
        incidentDate: '2026-09-01',
        netAmount: 987.65,
        vatAmount: 246.91,
        totalAmount: 1234.56,
      },
    ])
    rendera()
    fireEvent.click(screen.getByRole('tab', { name: 'Debiteringar' }))
    await screen.findByText('Syntetisk debitering 29')
    expect(kortMed('Syntetisk debitering 29').getByText('0,29 kr', { exact: true })).toBeTruthy()
    expect(kortMed('Syntetisk debitering 10').getByText('0,1 kr', { exact: true })).toBeTruthy()
    expect(
      kortMed('Syntetisk större debitering').getByText('1 234,56 kr', { exact: true }),
    ).toBeTruthy()
  })
})
