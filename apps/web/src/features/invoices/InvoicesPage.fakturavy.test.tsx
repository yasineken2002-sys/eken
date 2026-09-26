/**
 * FAKTURAVYN EFTER EN HANDLING (#925 A1, A4)
 *
 * ── VAD SOM PRÖVAS ──────────────────────────────────────────────────────────
 *
 * #925 gjorde de tre mutationssvaren (PATCH /:id, PATCH /:id/status,
 * POST /:id/pay) till den fullständiga fakturan och lät sidan läsa om fakturan
 * när en handling fallerar. Beteendet var mätt i en lokal webbläsarrigg men
 * hade inget prov i CI — ett återfall i webbkoden hade gått igenom. Här:
 *
 *   1. efter "Skicka faktura", "Spara ändringar" och "Registrera betalning"
 *      visar vyn SAMMA faktura komplett: nummer, rad, belopp, ny status och
 *      nästa handling — och ingen felgräns
 *   2. när servern HAR utfört ändringen men svaret inte når fram läses
 *      fakturan om och visas som den sparades, och handlingen skickas EN gång
 *   3. (A4) byter användaren faktura — eller stänger den — medan svaret väntar,
 *      öppnar svaret inte den gamla fakturan igen
 *
 * ── RIGGEN ──────────────────────────────────────────────────────────────────
 *
 * Sidan körs med sina VERKLIGA hookar (useInvoiceQueries m.fl.), verklig
 * React Query och verkliga axios-hjälpare. Bara transporten är ersatt: en
 * adapter som håller fakturorna i minnet, UTFÖR ändringen innan den svarar,
 * och kan hålla inne eller ersätta svaret med 502. Det är samma snitt som
 * #925:s webbläsarrigg (`route.fetch()` + ersatt svar), fast i CI.
 *
 * Fakturorna har den form GET /invoices/:id svarar med (nyckelmängden i #925:s
 * sond `accept-3.jsonl`), med decimaler som strängar som över nätet.
 *
 * ── VAD PROVET INTE KAN SE ─────────────────────────────────────────────────
 *
 * Att API:t faktiskt svarar med hela fakturan ägs av
 * `invoices.controller.full-svar.spec.ts`. Här står serverns svar i riggen;
 * provet mäter vad WEBBEN gör med ett korrekt svar och med ett uteblivet.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatCurrency } from '@eken/shared'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth.store'

const toastInfo = vi.fn()
const toastError = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    info: (...a: unknown[]) => toastInfo(...a),
    error: (...a: unknown[]) => toastError(...a),
    success: vi.fn(),
    warning: vi.fn(),
  },
}))

// Efter vi.mock med flit — se InboxPage.test.tsx.
import { InvoicesPage } from './InvoicesPage'

// ─── Data i API:ts form ──────────────────────────────────────────────────────

const ORG = '99999999-9999-4999-8999-000000000001'
const HYRESGAST = '44444444-4444-4444-8444-000000000001'
const AVTAL = '11111111-1111-4111-8111-000000000001'
const A = '33333333-3333-4333-8333-00000000000a'
const B = '33333333-3333-4333-8333-00000000000b'
/** Ett andra UTKAST — H1 kräver en faktura som går att redigera medan A:s DELETE väntar. */
const C = '33333333-3333-4333-8333-00000000000c'

type Status = 'DRAFT' | 'SENT' | 'PAID' | 'VOID'
interface Rad {
  id: string
  description: string
  quantity: string
  unitPrice: string
  vatRate: number
  total: string
}
interface Lagrad {
  id: string
  invoiceNumber: string
  status: Status
  lines: Rad[]
  paidAt: string | null
  betalt: number
}

const pengar = (n: number) => n.toFixed(2)

function rad(id: string, description: string, belopp: number): Rad {
  return {
    id,
    description,
    quantity: '1.00',
    unitPrice: pengar(belopp),
    vatRate: 0,
    total: pengar(belopp),
  }
}

/** GET /invoices/:id — samma nycklar som `findOne` (accept-3.jsonl, sond "nycklar"). */
function fullFaktura(f: Lagrad) {
  const total = f.lines.reduce((s, l) => s + Number(l.total), 0)
  return {
    id: f.id,
    organizationId: ORG,
    invoiceNumber: f.invoiceNumber,
    type: 'RENT',
    status: f.status,
    tenantId: HYRESGAST,
    customerId: null,
    leaseId: AVTAL,
    lines: f.lines,
    subtotal: pengar(total),
    vatTotal: '0.00',
    total: pengar(total),
    dueDate: '2026-10-31T00:00:00.000Z',
    issueDate: '2026-10-01T00:00:00.000Z',
    paidAt: f.paidAt,
    ocrNumber: '1234567890',
    reference: null,
    notes: null,
    sendError: null,
    trackingToken: `spar-${f.id}`,
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z',
    actorKind: 'USER',
    bankTransactions: [],
    collectionExportKey: null,
    creditNotes: [],
    creditedInvoice: null,
    creditedInvoiceId: null,
    isCreditNote: false,
    customer: null,
    lease: { id: AVTAL },
    tenant: { id: HYRESGAST, type: 'INDIVIDUAL', firstName: 'Anna', lastName: 'Hyresgäst' },
    remindersPaused: false,
    remindersPausedAt: null,
    remindersPausedReason: null,
    rentPeriodMonth: 10,
    rentPeriodYear: 2026,
    sentToCollectionAt: null,
    outstanding: f.status === 'VOID' ? 0 : Math.max(0, total - f.betalt),
    overpaid: Math.max(0, f.betalt - total),
  }
}

// ─── Riggens server ──────────────────────────────────────────────────────────

type Vag = 'status' | 'update' | 'pay' | 'delete'
interface Anrop {
  metod: string
  url: string
  body: unknown
}

let fakturor: Map<string, Lagrad>
let anrop: Anrop[]
/** Vägar vars svar ersätts med 502 EFTER att ändringen utförts. */
let felEfterCommit: Set<Vag>
/** Vägar vars svar hålls inne tills provet släpper dem. */
let hallInne: Map<Vag, { slapp: () => void; vantar: Promise<void> }>

// Sätts alltid av axios (standardadaptrarna) — `!` i stället för att tyst
// återställa till undefined under exactOptionalPropertyTypes.
const ursprungligAdapter = api.defaults.adapter!

function svar(config: InternalAxiosRequestConfig, data: unknown, status = 200): AxiosResponse {
  return {
    data: status < 400 ? { success: true, data } : data,
    status,
    statusText: String(status),
    headers: {},
    config,
  }
}

function fel(config: InternalAxiosRequestConfig, status: number): never {
  throw new AxiosError(
    `Request failed with status code ${status}`,
    status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST',
    config,
    null,
    svar(
      config,
      { success: false, error: { code: 'BAD_GATEWAY', message: 'Bad Gateway' } },
      status,
    ),
  )
}

function spar(vag: Vag) {
  let slapp!: () => void
  const vantar = new Promise<void>((r) => (slapp = r))
  hallInne.set(vag, { slapp, vantar })
  return slapp
}

/** Efter en utförd ändring: håll inne, fallera eller svara med hela fakturan. */
async function avslutaMutation(
  config: InternalAxiosRequestConfig,
  vag: Vag,
  f: Lagrad,
  status = 200,
) {
  const sparr = hallInne.get(vag)
  if (sparr) await sparr.vantar
  if (felEfterCommit.has(vag)) fel(config, 502)
  return svar(config, fullFaktura(f), status)
}

beforeEach(() => {
  fakturor = new Map([
    [
      A,
      {
        id: A,
        invoiceNumber: 'F-2026-0001',
        status: 'DRAFT',
        lines: [rad('rad-a1', 'Hyra oktober lgh 1101', 1200)],
        paidAt: null,
        betalt: 0,
      },
    ],
    [
      B,
      {
        id: B,
        invoiceNumber: 'F-2026-0002',
        status: 'SENT',
        lines: [rad('rad-b1', 'Hyra oktober lgh 1102', 3400)],
        paidAt: null,
        betalt: 0,
      },
    ],
    [
      C,
      {
        id: C,
        invoiceNumber: 'F-2026-0003',
        status: 'DRAFT',
        lines: [rad('rad-c1', 'Hyra oktober lgh 1103', 2100)],
        paidAt: null,
        betalt: 0,
      },
    ],
  ])
  anrop = []
  felEfterCommit = new Set()
  hallInne = new Map()
  toastInfo.mockReset()
  toastError.mockReset()
  useAuthStore.setState({
    user: { id: 'u1', role: 'OWNER', email: 'agare@exempel.invalid' },
  } as never)

  api.defaults.adapter = async (config) => {
    const metod = (config.method ?? 'get').toUpperCase()
    const url = config.url ?? ''
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data
    anrop.push({ metod, url, body })
    const m = url.match(/^\/invoices\/([^/]+)(\/.*)?$/)
    const f = m ? fakturor.get(m[1]!) : undefined

    if (metod === 'GET' && url === '/invoices') {
      const s = (config.params as { status?: string } | undefined)?.status
      return svar(
        config,
        [...fakturor.values()].filter((x) => !s || x.status === s).map(fullFaktura),
      )
    }
    if (metod === 'GET' && f && !m![2]) return svar(config, fullFaktura(f))
    if (metod === 'GET' && f && m![2] === '/events') return svar(config, [])
    if (metod === 'GET' && f && m![2] === '/credit-note/preview')
      return svar(config, {
        invoiceId: f.id,
        invoiceNumber: f.invoiceNumber,
        total: 0,
        outstanding: 0,
        credited: 0,
        allowed: false,
        blockedReason: 'Ett utkast kan inte krediteras.',
        lines: [],
      })
    if (metod === 'GET' && url === '/tenants')
      return svar(config, [
        {
          id: HYRESGAST,
          organizationId: ORG,
          type: 'INDIVIDUAL',
          firstName: 'Anna',
          lastName: 'Hyresgäst',
          email: 'anna@exempel.invalid',
        },
      ])
    if (metod === 'GET' && url === '/organizations/me')
      return svar(config, { id: ORG, name: 'Test AB', bankgiro: '5050-1055' })
    if (metod === 'GET' && url === '/leases')
      return svar(config, [
        {
          id: AVTAL,
          organizationId: ORG,
          unitId: 'enhet-1',
          tenantId: HYRESGAST,
          status: 'ACTIVE',
          leaseType: 'INDEFINITE',
          startDate: '2026-01-01T00:00:00.000Z',
          monthlyRent: '1200.00',
          unit: {
            id: 'enhet-1',
            unitNumber: '1101',
            type: 'APARTMENT',
            voluntaryTaxLiability: false,
            property: { id: 'p1', name: 'Ekens Gård 1' },
          },
          tenant: { id: HYRESGAST, type: 'INDIVIDUAL', firstName: 'Anna', lastName: 'Hyresgäst' },
        },
      ])
    if (metod === 'GET' && url === '/customers') return svar(config, [])

    // ── Mutationerna: ändringen UTFÖRS först, sedan avgörs svaret ──
    if (metod === 'PATCH' && f && m![2] === '/status') {
      f.status = (body as { status: Status }).status
      return avslutaMutation(config, 'status', f)
    }
    if (metod === 'PATCH' && f && !m![2]) {
      const b = body as {
        lines?: Array<{ description: string; unitPrice: number; quantity: number }>
      }
      if (b.lines)
        f.lines = b.lines.map((l, i) =>
          rad(`${f.id}-r${i}`, l.description, Number(l.unitPrice) * Number(l.quantity)),
        )
      return avslutaMutation(config, 'update', f)
    }
    if (metod === 'POST' && f && m![2] === '/pay') {
      f.betalt += Number((body as { amount: number }).amount)
      f.status = 'PAID'
      f.paidAt = '2026-10-15T00:00:00.000Z'
      return avslutaMutation(config, 'pay', f, 201)
    }
    // DELETE /invoices/:id makulerar ett utkast (soft-delete, BFL) — samma
    // riggform: ändringen UTFÖRS, sedan hålls eller fälls svaret.
    if (metod === 'DELETE' && f && !m![2]) {
      f.status = 'VOID'
      const sparr = hallInne.get('delete')
      if (sparr) await sparr.vantar
      if (felEfterCommit.has('delete')) fel(config, 502)
      return svar(config, null)
    }
    fel(config, 404)
  }
})

afterEach(() => {
  api.defaults.adapter = ursprungligAdapter
  cleanup()
})

// ─── Hjälpare ────────────────────────────────────────────────────────────────

const kr = (n: number) => formatCurrency(n).replace(/\s+/g, ' ')
const antal = (metod: string, url: string) =>
  anrop.filter((a) => a.metod === metod && a.url === url).length

function rendera() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  // Samma fångst som main.tsx: en kastad renderingsfel ska synas som ETT FEL
  // i provet, inte som ett tyst tomt träd.
  const renderfel: unknown[] = []
  const lyssnare = (e: ErrorEvent) => renderfel.push(e.error)
  window.addEventListener('error', lyssnare)
  render(
    <QueryClientProvider client={qc}>
      <InvoicesPage />
    </QueryClientProvider>,
  )
  return { qc, renderfel, stang: () => window.removeEventListener('error', lyssnare) }
}

async function oppna(nummer: string) {
  fireEvent.click(await screen.findByText(nummer))
  return screen.findByRole('dialog', { name: nummer })
}

/** Detaljvyn visar fakturan KOMPLETT — det som föll på #924. */
async function arKomplett(dialog: HTMLElement, rad: string, belopp: number, status: string) {
  await within(dialog).findByText(rad)
  // Beloppet står både på raden och i totalen.
  expect(within(dialog).getAllByText(kr(belopp)).length).toBeGreaterThanOrEqual(2)
  expect(within(dialog).getByText(status)).toBeTruthy()
  expect(within(dialog).getByText('Fakturarader')).toBeTruthy()
}

const tickar = () => act(async () => new Promise((r) => setTimeout(r, 30)))

// ─── 1. Komplett faktura efter varje handling ────────────────────────────────

describe('efter en lyckad handling visar vyn samma faktura komplett', () => {
  it('"Skicka faktura": nummer, rad, belopp, Skickad och nästa handling — en PATCH', async () => {
    const { renderfel, stang } = rendera()
    const dialog = await oppna('F-2026-0001')
    await arKomplett(dialog, 'Hyra oktober lgh 1101', 1200, 'Utkast')

    fireEvent.click(within(dialog).getByRole('button', { name: /Skicka faktura/ }))

    await within(dialog).findByText('Skickad')
    const efter = screen.getByRole('dialog', { name: 'F-2026-0001' })
    await arKomplett(efter, 'Hyra oktober lgh 1101', 1200, 'Skickad')
    // Nästa steg går att ta direkt, utan omladdning.
    expect(within(efter).getByRole('button', { name: /Skicka via e-post/ })).toBeTruthy()
    expect(within(efter).getByRole('button', { name: /Registrera betalning/ })).toBeTruthy()
    expect(antal('PATCH', `/invoices/${A}/status`)).toBe(1)
    expect(renderfel).toEqual([])
    expect(toastInfo).not.toHaveBeenCalled()
    stang()
  })

  it('"Spara ändringar": den sparade raden syns i samma vy — en PATCH', async () => {
    const { renderfel, stang } = rendera()
    const dialog = await oppna('F-2026-0001')
    fireEvent.click(within(dialog).getByRole('button', { name: /Redigera/ }))

    const form = await screen.findByRole('dialog', { name: 'Redigera faktura' })
    const avtal = (await within(form).findByLabelText('Hyresavtal')) as HTMLSelectElement
    await waitFor(() => expect(avtal.value).toBe(AVTAL))
    fireEvent.change(within(form).getAllByPlaceholderText('Beskrivning')[0]!, {
      target: { value: 'Hyra oktober lgh 1101 (rättad)' },
    })
    fireEvent.change(within(form).getAllByPlaceholderText('À-pris (kr)')[0]!, {
      target: { value: '1350' },
    })
    fireEvent.click(within(form).getByRole('button', { name: 'Spara ändringar' }))

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Redigera faktura' })).toBeNull(),
    )
    const efter = screen.getByRole('dialog', { name: 'F-2026-0001' })
    await arKomplett(efter, 'Hyra oktober lgh 1101 (rättad)', 1350, 'Utkast')
    expect(antal('PATCH', `/invoices/${A}`)).toBe(1)
    // Momsen som skickades är avtalets (bostad → 0 %), inte formulärets 25 %.
    const kropp = anrop.find((a) => a.metod === 'PATCH' && a.url === `/invoices/${A}`)!.body as {
      lines: Array<{ vatRate: number }>
    }
    expect(kropp.lines.map((l) => l.vatRate)).toEqual([0])
    expect(renderfel).toEqual([])
    stang()
  })

  it('"Registrera betalning": Betald, betaldatum och raderna kvar — en POST', async () => {
    const { renderfel, stang } = rendera()
    const dialog = await oppna('F-2026-0002')
    await arKomplett(dialog, 'Hyra oktober lgh 1102', 3400, 'Skickad')
    fireEvent.click(within(dialog).getByRole('button', { name: /Registrera betalning/ }))

    const betalning = await screen.findByRole('dialog', { name: 'Registrera betalning' })
    // Restskulden förifylls från detaljsvaret (#349).
    const belopp = (await within(betalning).findByLabelText('Belopp (kr)')) as HTMLInputElement
    expect(belopp.value).toBe('3400')
    fireEvent.click(within(betalning).getByRole('button', { name: 'Registrera betalning' }))

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Registrera betalning' })).toBeNull(),
    )
    const efter = screen.getByRole('dialog', { name: 'F-2026-0002' })
    await arKomplett(efter, 'Hyra oktober lgh 1102', 3400, 'Betald')
    expect(within(efter).getByText(/^Betald \d/)).toBeTruthy()
    // En betald faktura erbjuder inte betalning igen.
    expect(within(efter).queryByRole('button', { name: /Registrera betalning/ })).toBeNull()
    expect(antal('POST', `/invoices/${B}/pay`)).toBe(1)
    expect(renderfel).toEqual([])
    stang()
  })
})

// ─── 2. Serverfel efter utförd ändring ───────────────────────────────────────

describe('servern utförde ändringen men svaret kom inte fram', () => {
  it('"Skicka faktura" → 502: vyn läses om och visar Skickad, ingen andra PATCH', async () => {
    felEfterCommit.add('status')
    const { renderfel, stang } = rendera()
    const dialog = await oppna('F-2026-0001')
    fireEvent.click(within(dialog).getByRole('button', { name: /Skicka faktura/ }))

    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith(
        'Fakturan har lästs om och visar det som faktiskt sparats.',
      ),
    )
    const efter = screen.getByRole('dialog', { name: 'F-2026-0001' })
    await arKomplett(efter, 'Hyra oktober lgh 1101', 1200, 'Skickad')
    // Omläsningen gick mot servern efter felet — inte mot en gammal cache.
    const felIndex = anrop.findIndex((a) => a.metod === 'PATCH')
    expect(
      anrop.slice(felIndex + 1).some((a) => a.metod === 'GET' && a.url === `/invoices/${A}`),
    ).toBe(true)
    await tickar()
    expect(antal('PATCH', `/invoices/${A}/status`)).toBe(1)
    expect(anrop.filter((a) => a.metod !== 'GET')).toHaveLength(1)
    expect(renderfel).toEqual([])
    stang()
  })

  it('"Registrera betalning" → 502: vyn visar Betald, ingen andra betalning', async () => {
    felEfterCommit.add('pay')
    const { renderfel, stang } = rendera()
    const dialog = await oppna('F-2026-0002')
    fireEvent.click(within(dialog).getByRole('button', { name: /Registrera betalning/ }))
    const betalning = await screen.findByRole('dialog', { name: 'Registrera betalning' })
    await within(betalning).findByLabelText('Belopp (kr)')
    fireEvent.click(within(betalning).getByRole('button', { name: 'Registrera betalning' }))

    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith(
        'Fakturan har lästs om och visar det som faktiskt sparats.',
      ),
    )
    const efter = screen.getByRole('dialog', { name: 'F-2026-0002' })
    await arKomplett(efter, 'Hyra oktober lgh 1102', 3400, 'Betald')
    await tickar()
    expect(antal('POST', `/invoices/${B}/pay`)).toBe(1)
    expect(anrop.filter((a) => a.metod !== 'GET')).toHaveLength(1)
    expect(fakturor.get(B)!.betalt).toBe(3400)
    expect(renderfel).toEqual([])
    stang()
  })

  it('"Spara ändringar" → 502: vyn visar den sparade raden, ingen andra PATCH', async () => {
    felEfterCommit.add('update')
    const { renderfel, stang } = rendera()
    const dialog = await oppna('F-2026-0001')
    fireEvent.click(within(dialog).getByRole('button', { name: /Redigera/ }))
    const form = await screen.findByRole('dialog', { name: 'Redigera faktura' })
    const avtal = (await within(form).findByLabelText('Hyresavtal')) as HTMLSelectElement
    await waitFor(() => expect(avtal.value).toBe(AVTAL))
    fireEvent.change(within(form).getAllByPlaceholderText('Beskrivning')[0]!, {
      target: { value: 'Sparad trots fel' },
    })
    fireEvent.click(within(form).getByRole('button', { name: 'Spara ändringar' }))

    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith(
        'Fakturan har lästs om och visar det som faktiskt sparats.',
      ),
    )
    const efter = screen.getByRole('dialog', { name: 'F-2026-0001' })
    await within(efter).findByText('Sparad trots fel')
    await tickar()
    expect(antal('PATCH', `/invoices/${A}`)).toBe(1)
    expect(renderfel).toEqual([])
    stang()
  })
})

// ─── 3. A4 — användaren har lämnat fakturan när svaret kommer ────────────────

describe('A4: svaret på en handling öppnar inte en faktura användaren lämnat', () => {
  async function skickaOchByt(utfall: 'fel' | 'lyckat') {
    if (utfall === 'fel') felEfterCommit.add('status')
    const slapp = spar('status')
    const r = rendera()
    const dialogA = await oppna('F-2026-0001')
    fireEvent.click(within(dialogA).getByRole('button', { name: /Skicka faktura/ }))
    await waitFor(() => expect(antal('PATCH', `/invoices/${A}/status`)).toBe(1))

    // Medan svaret väntar: stäng A och öppna B.
    fireEvent.click(within(dialogA).getByRole('button', { name: 'Stäng' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'F-2026-0001' })).toBeNull())
    await oppna('F-2026-0002')

    await act(async () => {
      slapp()
    })
    await tickar()
    return r
  }

  it('felsvar efter byte: B står kvar, A öppnas inte igen', async () => {
    const { renderfel, stang } = await skickaOchByt('fel')
    // Omläsningen av A har skett (servern tillfrågades) …
    await waitFor(() => expect(antal('GET', `/invoices/${A}`)).toBeGreaterThan(0))
    await tickar()
    // … men vyn är fortfarande den användaren valde.
    expect(screen.queryByRole('dialog', { name: 'F-2026-0001' })).toBeNull()
    const b = screen.getByRole('dialog', { name: 'F-2026-0002' })
    await arKomplett(b, 'Hyra oktober lgh 1102', 3400, 'Skickad')
    // Beskedet får inte påstå att DEN VISADE fakturan lästs om.
    expect(toastInfo).not.toHaveBeenCalledWith(
      'Fakturan har lästs om och visar det som faktiskt sparats.',
    )
    // … utan att tiga: beskedet nämner fakturan det gäller.
    expect(toastInfo).toHaveBeenCalledWith(
      'Faktura F-2026-0001 har lästs om. Öppna den för att se vad som faktiskt sparats.',
    )
    expect(antal('PATCH', `/invoices/${A}/status`)).toBe(1)
    expect(renderfel).toEqual([])
    stang()
  })

  it('lyckat svar efter byte: B står kvar, A öppnas inte igen', async () => {
    const { renderfel, stang } = await skickaOchByt('lyckat')
    await tickar()
    expect(screen.queryByRole('dialog', { name: 'F-2026-0001' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'F-2026-0002' })).toBeTruthy()
    expect(renderfel).toEqual([])
    stang()
  })

  it('felsvar efter stängning: ingen faktura öppnas', async () => {
    felEfterCommit.add('status')
    const slapp = spar('status')
    const { renderfel, stang } = rendera()
    const dialogA = await oppna('F-2026-0001')
    fireEvent.click(within(dialogA).getByRole('button', { name: /Skicka faktura/ }))
    await waitFor(() => expect(antal('PATCH', `/invoices/${A}/status`)).toBe(1))
    fireEvent.click(within(dialogA).getByRole('button', { name: 'Stäng' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await act(async () => {
      slapp()
    })
    await waitFor(() => expect(antal('GET', `/invoices/${A}`)).toBeGreaterThan(0))
    await tickar()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(renderfel).toEqual([])
    stang()
  })

  it('kontroll: utan byte öppnas omläsningen i samma vy som förut', async () => {
    felEfterCommit.add('status')
    const slapp = spar('status')
    const { stang } = rendera()
    const dialogA = await oppna('F-2026-0001')
    fireEvent.click(within(dialogA).getByRole('button', { name: /Skicka faktura/ }))
    await waitFor(() => expect(antal('PATCH', `/invoices/${A}/status`)).toBe(1))
    await act(async () => {
      slapp()
    })
    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith(
        'Fakturan har lästs om och visar det som faktiskt sparats.',
      ),
    )
    await arKomplett(
      screen.getByRole('dialog', { name: 'F-2026-0001' }),
      'Hyra oktober lgh 1101',
      1200,
      'Skickad',
    )
    stang()
  })
})

// ─── H1 — sent svar på "Ta bort utkast" ──────────────────────────────────────

describe('H1: ett sent DELETE-svar stänger inte en faktura användaren bytt till', () => {
  /** Tar bort A och håller svaret; returnerar släppet. */
  async function taBortAOchHall(utfall: 'lyckat' | 'fel' = 'lyckat') {
    if (utfall === 'fel') felEfterCommit.add('delete')
    const slapp = spar('delete')
    const r = rendera()
    const dialogA = await oppna('F-2026-0001')
    fireEvent.click(within(dialogA).getByRole('button', { name: /Ta bort/ }))
    const bekrafta = await screen.findByRole('dialog', { name: 'Ta bort utkast' })
    fireEvent.click(within(bekrafta).getByRole('button', { name: 'Ta bort utkast' }))
    await waitFor(() => expect(antal('DELETE', `/invoices/${A}`)).toBe(1))
    return { ...r, slapp, dialogA }
  }

  /** Medan svaret väntar: avbryt bekräftelsen, stäng A, öppna C och börja redigera. */
  async function bytTillCOchRedigera(dialogA: HTMLElement) {
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Ta bort utkast' })).getByRole('button', {
        name: 'Avbryt',
      }),
    )
    fireEvent.click(within(dialogA).getByRole('button', { name: 'Stäng' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'F-2026-0001' })).toBeNull())
    const dialogC = await oppna('F-2026-0003')
    fireEvent.click(within(dialogC).getByRole('button', { name: /Redigera/ }))
    const form = await screen.findByRole('dialog', { name: 'Redigera faktura' })
    const beskr = (await within(form).findAllByPlaceholderText('Beskrivning'))[0] as HTMLInputElement
    fireEvent.change(beskr, { target: { value: 'Osparad ändring på C' } })
    return beskr
  }

  it('lyckat svar efter byte: A makulerad, C och dess osparade fält står kvar', async () => {
    const { slapp, dialogA, renderfel, stang } = await taBortAOchHall()
    await bytTillCOchRedigera(dialogA)

    await act(async () => {
      slapp()
    })
    await tickar()

    expect(fakturor.get(A)!.status).toBe('VOID')
    expect(antal('DELETE', `/invoices/${A}`)).toBe(1)
    expect(screen.getByRole('dialog', { name: 'F-2026-0003' })).toBeTruthy()
    const form = screen.getByRole('dialog', { name: 'Redigera faktura' })
    const beskr = within(form).getAllByPlaceholderText('Beskrivning')[0] as HTMLInputElement
    expect(beskr.value).toBe('Osparad ändring på C')
    // Ingen sparning av C har skett av sig självt.
    expect(antal('PATCH', `/invoices/${C}`)).toBe(0)
    expect(renderfel).toEqual([])
    stang()
  })

  it('stängt läge förblir stängt när A-svaret kommer', async () => {
    const { slapp, dialogA, renderfel, stang } = await taBortAOchHall()
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Ta bort utkast' })).getByRole('button', {
        name: 'Avbryt',
      }),
    )
    fireEvent.click(within(dialogA).getByRole('button', { name: 'Stäng' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await act(async () => {
      slapp()
    })
    await tickar()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fakturor.get(A)!.status).toBe('VOID')
    expect(renderfel).toEqual([])
    stang()
  })

  it('stängt och sedan C öppnat (utan redigering): C står kvar', async () => {
    const { slapp, dialogA, stang } = await taBortAOchHall()
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Ta bort utkast' })).getByRole('button', {
        name: 'Avbryt',
      }),
    )
    fireEvent.click(within(dialogA).getByRole('button', { name: 'Stäng' }))
    await oppna('F-2026-0003')
    await act(async () => {
      slapp()
    })
    await tickar()
    expect(screen.getByRole('dialog', { name: 'F-2026-0003' })).toBeTruthy()
    stang()
  })

  it('felsvar för A efter byte: C och dess osparade fält står kvar', async () => {
    const { slapp, dialogA, renderfel, stang } = await taBortAOchHall('fel')
    await bytTillCOchRedigera(dialogA)
    await act(async () => {
      slapp()
    })
    await tickar()
    expect(screen.getByRole('dialog', { name: 'F-2026-0003' })).toBeTruthy()
    const form = screen.getByRole('dialog', { name: 'Redigera faktura' })
    expect(
      (within(form).getAllByPlaceholderText('Beskrivning')[0] as HTMLInputElement).value,
    ).toBe('Osparad ändring på C')
    expect(antal('DELETE', `/invoices/${A}`)).toBe(1)
    expect(renderfel).toEqual([])
    stang()
  })

  it('positiv kontroll: A fortfarande vald → A och bekräftelsen stängs som förut', async () => {
    const { slapp, stang } = await taBortAOchHall()
    await act(async () => {
      slapp()
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(fakturor.get(A)!.status).toBe('VOID')
    expect(antal('DELETE', `/invoices/${A}`)).toBe(1)
    stang()
  })
})
