import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { InboxItem, InboxPage as InboxPageSvar, InboxSummary } from './api/inbox.api'

/**
 * INKORGENS SIDA — renderad, inte resonerad.
 *
 * ── VARFÖR API-LAGRET MOCKAS OCH INTE HTTP ──────────────────────────────────
 *
 * Proven mäter SIDAN: att KPI-korten läser summary, att flikarna filtrerar, att
 * modalen visar planens fem fält och att Godkänn utan bekräftelse inte anropar
 * något. Att endpointen svarar rätt ägs av `inbox-api.db.spec.ts` mot riktig
 * Postgres. Att mocka fetch hade prövat två saker samtidigt och gjort ett fel i
 * endera till ett rött prov i båda.
 *
 * ── VAR BESLUTSFLÖDET PRÖVAS, OCH VARFÖR INTE HÄR ───────────────────────────
 *
 * Att det ANDRA klicket faktiskt beslutar, och att avslagsskälet följer med,
 * ägs av `components/InboxDetailModal.test.tsx`. Modalen äger bekräftelsen; den
 * här filen äger att sidan KOPPLAR IN den. Uppdelningen är inte kosmetisk: ett
 * prov som går genom React Querys mutation för att mäta en knapptryckning mäter
 * två saker, och när det faller vet man inte vilken.
 *
 * Sidprovet behåller den ena halvan av kravet — att Godkänn UTAN bekräftelse
 * inte anropar något — därför att det är en egenskap hos kopplingen: sidan får
 * inte kunna besluta förbi modalens bekräftelsesteg.
 *
 * ── VAD PROVEN INTE KAN SE ──────────────────────────────────────────────────
 *
 * Att rutten `/inkorg` är kopplad och att sidomenyposten finns — det ägs av
 * router-goldenfilen och av `AppLayout`. Ett renderat prov på en komponent
 * bevisar inte att någon kan nå den.
 */

const hamtaLista = vi.fn()
const hamtaSummary = vi.fn()
const beslutaMock = vi.fn()
const kanDelegeraMock = vi.fn()
const delegeraMock = vi.fn()

vi.mock('./api/inbox.api', () => ({
  fetchInbox: (...a: unknown[]) => hamtaLista(...a),
  fetchInboxSummary: (...a: unknown[]) => hamtaSummary(...a),
  decideInboxItem: (...a: unknown[]) => beslutaMock(...a),
  // "Gör alltid så här" (etapp 7). Mocken måste vara FULLSTÄNDIG: vitest kastar
  // på en export som saknas, och det är rätt — en halvmockad modul hade gett
  // ett fel som ser ut att handla om sidan i stället för om provets rigg.
  fetchKanDelegera: (...a: unknown[]) => kanDelegeraMock(...a),
  skapaDelegationUrForslag: (...a: unknown[]) => delegeraMock(...a),
}))

// Importen står EFTER `vi.mock` med flit. Vitest hissar `vi.mock`, men ordningen
// i källan är den som läses av nästa person — och den ska visa att mocken gäller
// modulen sidan drar in.
import { InboxPage } from './InboxPage'

const forslag = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: 'a1',
  shadow: true,
  toolName: 'update_maintenance_status',
  toolInput: { ticketId: 'T-1' },
  title: 'Förslag för ärende T-1',
  reasoning: 'Beskrivningen pekar på en läcka som redan anmälts en gång i höstas.',
  consequence: 'SKUGGLÄGE: ingenting utförs. Ett godkännande betyder att förslaget var rätt.',
  undoHint: 'Inget att ångra — ingen effekt har inträffat.',
  evidence: [{ entityType: 'UNIT', entityId: 'u1', label: '7 historikhändelser' }],
  confidence: 0.72,
  prediction: { category: 'PLUMBING' },
  outcome: null,
  status: 'AWAITING_APPROVAL',
  statusReason: null,
  deadline: '2026-09-12T00:00:00.000Z',
  decidedAt: null,
  createdAt: '2026-09-05T03:00:00.000Z',
  ...over,
})

const sida = (rader: InboxItem[]): InboxPageSvar => ({
  rader,
  total: rader.length,
  limit: 25,
  offset: 0,
})

const summary = (over: Partial<InboxSummary> = {}): InboxSummary => ({
  status: { AWAITING_APPROVAL: 3, APPROVED: 2, REJECTED: 1, EXPIRED: 0 },
  traffgrad: {},
  ...over,
})

function rendera() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <InboxPage />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  hamtaLista.mockReset()
  hamtaSummary.mockReset()
  beslutaMock.mockReset()
  kanDelegeraMock.mockReset()
  delegeraMock.mockReset()
  kanDelegeraMock.mockResolvedValue({ kan: false, skäl: 'inte än', utförareFinns: false })
  hamtaLista.mockResolvedValue(sida([forslag()]))
  hamtaSummary.mockResolvedValue(summary())
})

describe('KPI-korten läser summary', () => {
  it('visar väntande, godkända och avvisade', async () => {
    rendera()
    expect(await screen.findByText('3')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy()
  })

  it('träffgraden visar TANKSTRECK tills facit finns — inte 0 %', async () => {
    // Det här är kortets hela poäng: en fungerande agent ska inte se trasig ut
    // sin första dag, innan någon hunnit avsluta ett enda ärende.
    rendera()
    expect(await screen.findByText('Träffgrad')).toBeTruthy()
    expect(screen.getByText('—')).toBeTruthy()
  })

  it('med facit visar den procenten', async () => {
    hamtaSummary.mockResolvedValue(
      summary({ traffgrad: { category: { besvarade: 2, traffar: 1, andel: 0.5 } } }),
    )
    rendera()
    expect(await screen.findByText('50 %')).toBeTruthy()
  })
})

describe('filterflikarna', () => {
  it('första hämtningen är VÄNTANDE, inte alla', async () => {
    rendera()
    await screen.findByText('Förslag för ärende T-1')
    expect(hamtaLista).toHaveBeenCalledWith({ status: 'AWAITING_APPROVAL' })
  })

  it('ett klick på Alla hämtar UTAN statusfilter', async () => {
    rendera()
    await screen.findByText('Förslag för ärende T-1')
    fireEvent.click(screen.getByRole('button', { name: 'Alla' }))
    expect(hamtaLista).toHaveBeenLastCalledWith({})
  })

  it('ett klick på Avvisade filtrerar på REJECTED', async () => {
    rendera()
    await screen.findByText('Förslag för ärende T-1')
    // `getByRole` och inte `getByText`: "Avvisade" finns både som flik och som
    // statusmärke på en rad. En tvetydig fråga är ett prov som mäter fel sak.
    fireEvent.click(screen.getByRole('button', { name: 'Avvisade' }))
    expect(hamtaLista).toHaveBeenLastCalledWith({ status: 'REJECTED' })
  })
})

describe('detaljmodalen — planens fem fält', () => {
  it('visar alla fem, i planens ordning', async () => {
    rendera()
    fireEvent.click(await screen.findByText('Förslag för ärende T-1'))

    const rubriker = [
      'Vad agenten hade gjort',
      'Varför',
      'Vilken information den använde',
      'Hur säker den var',
      'Vad som hade krävt godkännande',
    ]
    for (const r of rubriker) expect(screen.getByText(r)).toBeTruthy()

    // Ordningen är inte kosmetisk: handling → motivering → underlag är den
    // ordning man behöver för att kunna säga emot.
    const text = document.body.textContent ?? ''
    const positioner = rubriker.map((r) => text.indexOf(r))
    expect(positioner).toEqual([...positioner].sort((a, b) => a - b))
  })

  it('visar verktyget, skälet, kontexten och konfidensen', async () => {
    rendera()
    fireEvent.click(await screen.findByText('Förslag för ärende T-1'))
    expect(screen.getAllByText('update_maintenance_status').length).toBeGreaterThan(0)
    expect(screen.getByText(/läcka/)).toBeTruthy()
    expect(screen.getByText('7 historikhändelser')).toBeTruthy()
    expect(screen.getAllByText('0,72').length).toBeGreaterThan(0)
  })
})

describe('beslutet kräver en bekräftelse', () => {
  it('Godkänn UTAN bekräftelse anropar ingenting', async () => {
    rendera()
    fireEvent.click(await screen.findByText('Förslag för ärende T-1'))
    fireEvent.click(screen.getByRole('button', { name: 'Godkänn' }))
    // Första klicket öppnar bara bekräftelsesteget.
    expect(beslutaMock).not.toHaveBeenCalled()
  })

  it('bekräftelsen säger att INGENTING utförs', async () => {
    rendera()
    fireEvent.click(await screen.findByText('Förslag för ärende T-1'))
    fireEvent.click(screen.getByRole('button', { name: 'Godkänn' }))
    // Texten står på TVÅ ställen med flit — i `consequence` på varje rad och i
    // bekräftelsen. Provet frågar därför på den senare formuleringen, som bara
    // bekräftelsen har.
    expect(screen.getByText(/facit, inte en åtgärd/)).toBeTruthy()
  })
})

describe('tomt tillstånd', () => {
  it('säger att förslag dyker upp när funktionen är påslagen', async () => {
    hamtaLista.mockResolvedValue(sida([]))
    rendera()
    expect(await screen.findByText('Inga förslag än')).toBeTruthy()
    expect(screen.getByText(/påslagen för din organisation/)).toBeTruthy()
  })
})
