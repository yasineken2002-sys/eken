import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Delegation } from './api/delegationer.api'

/**
 * DELEGATIONSSIDAN — renderad, inte resonerad.
 *
 * ── VAD PROVEN MÄTER ────────────────────────────────────────────────────────
 *
 * Att sidan visar RÄTTIGHETEN i klartext och aldrig ett tekniskt namn, att
 * KPI-korten och flikarna räknar samma mängd, att varje radåtgärd går genom en
 * bekräftelse, och att bara återkallandet är farligt märkt.
 *
 * ── VAD DE INTE KAN SE ──────────────────────────────────────────────────────
 *
 * Att statusen är rätt beräknad — den räknas i API:t och ägs av
 * `delegation-lifecycle.db.spec.ts` mot riktig Postgres. Här matas den in.
 * Och att rutten `/delegationer` går att nå: det ägs av `router.tsx` och
 * `AppLayout`, och ett renderat komponentprov bevisar aldrig att någon kan nå
 * komponenten.
 *
 * `@tanstack/react-router` mockas därför att `<Link>` kräver en router i
 * kontexten. Provet mäter att LÄNKEN FINNS och vart den pekar, inte att
 * routern kan navigera dit — det senare är routerns eget ansvar.
 */
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    search,
    children,
    ...rest
  }: {
    to: string
    search?: Record<string, unknown>
    children: React.ReactNode
  }) => (
    <a
      href={search ? `${to}?${new URLSearchParams(search as Record<string, string>)}` : to}
      {...rest}
    >
      {children}
    </a>
  ),
}))

const hamta = vi.fn()
const pausaMock = vi.fn()
const atertaMock = vi.fn()
const forlangMock = vi.fn()
const aterkallaMock = vi.fn()

vi.mock('./api/delegationer.api', () => ({
  fetchDelegationer: (...a: unknown[]) => hamta(...a),
  pauseDelegation: (...a: unknown[]) => pausaMock(...a),
  resumeDelegation: (...a: unknown[]) => atertaMock(...a),
  extendDelegation: (...a: unknown[]) => forlangMock(...a),
  revokeDelegation: (...a: unknown[]) => aterkallaMock(...a),
  // MOCKEN MÅSTE VARA FULLSTÄNDIG: sidan renderar <Antaganden />, som drar in
  // samma modul. Vitest kastar på en export som saknas — och det är rätt, en
  // halvmockad modul hade gett ett fel som ser ut att handla om sidan i stället
  // för om provets rigg. Sektionens EGNA prov ligger i Antaganden.test.tsx.
  fetchAntaganden: async () => [],
  bekraftaAntagande: async () => undefined,
  avvisaAntagande: async () => undefined,
}))

// Importen står EFTER `vi.mock` med flit — vitest hissar mocken, men ordningen
// i källan är den nästa person läser.
import { DelegationerPage } from './DelegationerPage'

const delegation = (over: Partial<Delegation> = {}): Delegation => ({
  id: 'd1',
  toolName: 'create_maintenance_ticket',
  authorityScope: 'EGEN_ORG',
  villkor: { kategori: 'PLUMBING' },
  frekvensvillkor: { maxAntal: 3, periodDagar: 30 },
  expiresAt: '2026-12-04T00:00:00.000Z',
  createdAt: '2026-09-05T10:00:00.000Z',
  status: 'AKTIV',
  löperUtInomDagar: 89,
  createdByUserId: 'u1',
  createdByUser: { firstName: 'Anna', lastName: 'Ek' },
  bornFromAssignmentId: 'a1',
  bornFromAssignment: { id: 'a1', title: 'Förslag för ärende T-1' },
  skulleHaUtlöst: 0,
  ...over,
})

function rendera() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <DelegationerPage />
    </QueryClientProvider>,
  )
}

/**
 * Modalen och tabellen delar knappnamn — "Pausa" står på BÅDA. Ett prov som
 * plockar index 1 ur en global lista mäter DOM-ordningen, inte gränssnittet, och
 * går sönder den dag modalen renderas i en portal någon annanstans.
 */
const iModalen = () => within(screen.getByRole('dialog'))

/** KPI-korten och filterflikarna bär SAMMA ord ("Aktiva", "Pausade"). */
const iKpi = () => within(screen.getByTestId('delegationer-kpi'))

/** Visa alla statusar — standardfliken är "Aktiva". */
const visaAlla = () => fireEvent.click(screen.getByRole('button', { name: 'Alla' }))

beforeEach(() => {
  hamta.mockReset()
  pausaMock.mockReset()
  atertaMock.mockReset()
  forlangMock.mockReset()
  aterkallaMock.mockReset()
  pausaMock.mockResolvedValue({ ok: true })
  atertaMock.mockResolvedValue({ ok: true })
  forlangMock.mockResolvedValue({ expiresAt: '2027-03-04T00:00:00.000Z' })
  aterkallaMock.mockResolvedValue({ ok: true })
  hamta.mockResolvedValue([delegation()])
})

describe('rättigheten i klartext', () => {
  it('visar verktyget som en mening, ALDRIG det tekniska namnet', async () => {
    rendera()
    expect(await screen.findByText('lägga upp ett ärende')).toBeTruthy()
    expect(screen.queryByText('create_maintenance_ticket')).toBeNull()
  })

  it('avgränsningen och frekvensen skrivs ut, inte som råa fält', async () => {
    rendera()
    expect(await screen.findByText('Typ av ärende: PLUMBING')).toBeTruthy()
    expect(screen.getByText('Högst 3 per 30 dagar')).toBeTruthy()
  })

  it('EN TOM avgränsning sägs i klartext — den bredaste rätten får inte se ut som en detalj', async () => {
    hamta.mockResolvedValue([delegation({ villkor: null })])
    rendera()
    expect(await screen.findByText('Utan avgränsning — hela organisationen')).toBeTruthy()
  })

  it('avsaknad av tak SÄGS, den lämnas inte tom', async () => {
    hamta.mockResolvedValue([delegation({ frekvensvillkor: null })])
    rendera()
    expect(await screen.findByText('Inget tak')).toBeTruthy()
  })
})

describe('källan — rätten går att spåra tillbaka till sitt beslut', () => {
  it('länkar till DET ENSKILDA förslaget, inte bara till inkorgen', async () => {
    rendera()
    const länk = await screen.findByRole('link', { name: 'Förslag för ärende T-1' })
    expect(länk.getAttribute('href')).toBe('/inkorg?forslag=a1')
  })

  it('visar VEM som tryckte', async () => {
    rendera()
    expect(await screen.findByText(/Anna Ek/)).toBeTruthy()
  })

  it('en delegation UTAN förslag döljer inte att den saknar ursprung', async () => {
    hamta.mockResolvedValue([delegation({ bornFromAssignmentId: null, bornFromAssignment: null })])
    rendera()
    expect(await screen.findByText('Skapad utan förslag')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Förslag för ärende T-1' })).toBeNull()
  })
})

describe('KPI-korten och flikarna räknar samma mängd', () => {
  const fyra = [
    delegation({ id: 'd1', status: 'AKTIV', löperUtInomDagar: 89 }),
    delegation({ id: 'd2', status: 'PAUSAD', löperUtInomDagar: 5 }),
    delegation({ id: 'd3', status: 'ÅTERKALLAD', löperUtInomDagar: 40 }),
    delegation({ id: 'd4', status: 'UTGÅNGEN', löperUtInomDagar: -3 }),
  ]

  it('räknar aktiva, pausade, snart utgångna och återkallade', async () => {
    hamta.mockResolvedValue(fyra)
    rendera()
    // Vänta på DATAN, inte på en statisk rubrik: korten står där med 0 innan
    // svaret kommit, och ett prov som läser dem då mäter laddtillståndet.
    await screen.findByText('lägga upp ett ärende')
    // En rad per kort: 1 aktiv, 1 pausad, 1 som löper ut snart (den PAUSADE —
    // en pausad rätt löper fortfarande ut), 1 återkallad.
    for (const titel of ['Aktiva', 'Pausade', 'Löper ut inom 14 dagar', 'Återkallade']) {
      const rubrik = iKpi().getByText(titel)
      expect(rubrik.parentElement?.parentElement?.textContent).toContain('1')
    }
  })

  it('EN ÅTERKALLAD rad räknas ALDRIG som "löper ut snart" — det finns inget att göra åt den', async () => {
    hamta.mockResolvedValue([delegation({ status: 'ÅTERKALLAD', löperUtInomDagar: 2 })])
    rendera()
    await screen.findByText('Inga delegationer i den här vyn')
    const rubrik = iKpi().getByText('Löper ut inom 14 dagar')
    expect(rubrik.parentElement?.parentElement?.textContent).toContain('0')
  })

  it('fliken filtrerar på status', async () => {
    hamta.mockResolvedValue(fyra)
    rendera()
    expect(await screen.findByText('Aktiv')).toBeTruthy()
    expect(screen.queryByText('Pausad')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Pausade' }))
    expect(screen.getByText('Pausad')).toBeTruthy()
    expect(screen.queryByText('Aktiv')).toBeNull()
  })
})

describe('radåtgärderna går genom en bekräftelse', () => {
  it('ETT klick på Pausa anropar INGENTING — bekräftelsen är steg två', async () => {
    rendera()
    fireEvent.click(await screen.findByRole('button', { name: 'Pausa' }))
    expect(pausaMock).not.toHaveBeenCalled()
    expect(screen.getByText('Pausa delegationen')).toBeTruthy()
  })

  it('det ANDRA klicket pausar', async () => {
    rendera()
    fireEvent.click(await screen.findByRole('button', { name: 'Pausa' }))
    fireEvent.click(iModalen().getByRole('button', { name: 'Pausa' }))
    // `mutate` kör sin mutationFn i en mikrotask; en synkron assertion här hade
    // mätt att klicket hann före anropet, inte att anropet uteblev.
    await waitFor(() => expect(pausaMock).toHaveBeenCalled())
    // FÖRSTA argumentet, inte hela anropet: React Query skickar med en
    // kontext som andra argument, och en assertion på hela listan hade mätt
    // bibliotekets signatur i stället för att RÄTT rad pausas.
    expect(pausaMock.mock.calls[0]?.[0]).toBe('d1')
  })

  it('bekräftelsen visar rättigheten i klartext, inte radens id', async () => {
    rendera()
    fireEvent.click(await screen.findByRole('button', { name: 'Återkalla' }))
    expect(iModalen().getByText('lägga upp ett ärende')).toBeTruthy()
    expect(iModalen().queryByText('d1')).toBeNull()
  })

  it('ÅTERKALLA är DANGER — och de reversibla är det inte', async () => {
    rendera()
    fireEvent.click(await screen.findByRole('button', { name: 'Återkalla' }))
    expect(iModalen().getByRole('button', { name: 'Återkalla' }).className).toContain('bg-red-500')

    fireEvent.click(iModalen().getByRole('button', { name: 'Avbryt' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pausa' }))
    expect(iModalen().getByRole('button', { name: 'Pausa' }).className).not.toContain('bg-red-500')
  })

  it('skälet är FRIVILLIGT — utan text skickas inget skäl med', async () => {
    rendera()
    fireEvent.click(await screen.findByRole('button', { name: 'Återkalla' }))
    fireEvent.click(iModalen().getByRole('button', { name: 'Återkalla' }))
    await waitFor(() => expect(aterkallaMock).toHaveBeenCalledWith('d1', undefined))
  })

  it('ett ifyllt skäl följer med', async () => {
    rendera()
    fireEvent.click(await screen.findByRole('button', { name: 'Återkalla' }))
    fireEvent.change(screen.getByLabelText('Varför? (frivilligt)'), {
      target: { value: 'Vi sköter det manuellt igen.' },
    })
    fireEvent.click(iModalen().getByRole('button', { name: 'Återkalla' }))
    await waitFor(() =>
      expect(aterkallaMock).toHaveBeenCalledWith('d1', 'Vi sköter det manuellt igen.'),
    )
  })

  it('SKÄLET FÖLJER INTE MED till nästa rad', async () => {
    hamta.mockResolvedValue([
      delegation({ id: 'd1' }),
      delegation({ id: 'd2', bornFromAssignment: { id: 'a2', title: 'Ett annat förslag' } }),
    ])
    rendera()
    const knappar = await screen.findAllByRole('button', { name: 'Återkalla' })
    fireEvent.click(knappar[0] as HTMLElement)
    fireEvent.change(screen.getByLabelText('Varför? (frivilligt)'), {
      target: { value: 'Fel rad.' },
    })
    fireEvent.click(iModalen().getByRole('button', { name: 'Avbryt' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Återkalla' })[1] as HTMLElement)
    expect((screen.getByLabelText('Varför? (frivilligt)') as HTMLInputElement).value).toBe('')
  })

  it('serverns eget fel visas — inte en egen gissning', async () => {
    forlangMock.mockRejectedValue({
      response: { data: { error: { message: 'Delegationen förlängdes 2026-09-01.' } } },
    })
    rendera()
    fireEvent.click(await screen.findByRole('button', { name: 'Förläng' }))
    fireEvent.click(iModalen().getByRole('button', { name: 'Förläng 90 dagar' }))
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Delegationen förlängdes 2026-09-01.',
    )
  })
})

describe('vilka åtgärder som alls erbjuds', () => {
  it('en ÅTERKALLAD rad har inga åtgärder — det finns inget att ändra', async () => {
    hamta.mockResolvedValue([delegation({ status: 'ÅTERKALLAD' })])
    rendera()
    await screen.findByText('Inga delegationer i den här vyn')
    visaAlla()
    expect(screen.getByText('Återkallad')).toBeTruthy()
    for (const namn of ['Pausa', 'Återuppta', 'Förläng', 'Återkalla']) {
      expect(screen.queryByRole('button', { name: namn })).toBeNull()
    }
  })

  it('en UTGÅNGEN rad går att FÖRLÄNGA men inte att pausa', async () => {
    hamta.mockResolvedValue([delegation({ status: 'UTGÅNGEN', löperUtInomDagar: -3 })])
    rendera()
    await screen.findByText('Inga delegationer i den här vyn')
    visaAlla()
    expect(screen.getByRole('button', { name: 'Förläng' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pausa' })).toBeNull()
  })

  it('en PAUSAD rad erbjuder Återuppta, inte Pausa', async () => {
    hamta.mockResolvedValue([delegation({ status: 'PAUSAD' })])
    rendera()
    await screen.findByText('Inga delegationer i den här vyn')
    fireEvent.click(screen.getByRole('button', { name: 'Pausade' }))
    expect(screen.getByRole('button', { name: 'Återuppta' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pausa' })).toBeNull()
  })
})

describe('tomt är ett UTFALL, inte en tom tabell', () => {
  it('säger VÄGEN till en delegation i stället för att erbjuda en genväg', async () => {
    hamta.mockResolvedValue([])
    rendera()
    expect(await screen.findByText('Du har inte delegerat något än')).toBeTruthy()
    expect(screen.getByText(/Gör alltid så här/)).toBeTruthy()
    // INGEN "Ny delegation"-knapp. Vägen går genom inkorgen, och en genväg här
    // hade gått förbi hela mekanismen.
    expect(screen.queryByRole('button', { name: /Ny delegation/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Till inkorgen' })).toBeTruthy()
  })

  it('en TOM FLIK är inte samma sak som ingen delegation alls', async () => {
    hamta.mockResolvedValue([delegation({ status: 'AKTIV' })])
    rendera()
    await screen.findByText('Aktiv')
    fireEvent.click(screen.getByRole('button', { name: 'Återkallade' }))
    expect(screen.getByText('Inga delegationer i den här vyn')).toBeTruthy()
    expect(screen.queryByText('Du har inte delegerat något än')).toBeNull()
  })
})

describe('sidan är en läsyta för BEFOGENHETER — inte för preferenser', () => {
  it('inget preferenslager finns här', async () => {
    rendera()
    await screen.findByText('lägga upp ett ärende')
    // Planens Del 7 håller isär preferens, observation och befogenhet. Bara det
    // tredje lagret hör hemma på den här sidan, och provet gör den gränsen till
    // något som går att bryta i stället för något som står i en kommentar.
    for (const ord of [/Ton/, /Tilltal/, /Preferens/, /Hur agenten/]) {
      expect(screen.queryByText(ord)).toBeNull()
    }
  })
})
