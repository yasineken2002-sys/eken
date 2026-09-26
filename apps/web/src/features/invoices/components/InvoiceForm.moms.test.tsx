/**
 * FAKTURAFORMULÄRETS MOMSFÖRVAL MOT AVTALETS UPPLÅTELSE (#925 A1/A2)
 *
 * ── VAD SOM PRÖVAS ──────────────────────────────────────────────────────────
 *
 * #925 lät formuläret läsa samma `vatRateForRent` som servern kräver, men
 * beteendet var bara mätt i en lokal webbläsarrigg — och bara för bostad och
 * kund. Här prövas det i CI, för varje upplåtelse regeln skiljer på:
 *
 *   bostad                          → 0 %   (även med frivillig beskattning satt)
 *   lokal MED frivillig beskattning → 25 %
 *   lokal UTAN frivillig beskattning→ 0 %
 *   parkering                       → 25 %
 *   byte av avtal                   → orörda rader följer det nya avtalet
 *
 * Förväntan skrivs som tal OCH jämförs med `vatRateForRent` — talen är
 * regelns egen tabell (packages/shared/src/utils/vat-rate-for-rent.ts), inte en
 * ny skatteregel. Byts regeln ska provet fällas och läsas om, inte tyst följa.
 *
 * ── AVTALSUNDERLAGET ────────────────────────────────────────────────────────
 *
 * Avtalen har formen GET /leases faktiskt svarar med (`INCLUDE` i
 * leases.service.ts: `unit: { include: { property: true } }`), med hela
 * enheten — `type` och `voluntaryTaxLiability` inräknade, decimaler som
 * strängar. De når formuläret genom de VERKLIGA hookarna (`useLeases`,
 * `useCustomers`, `useOrganization`) via en ersatt axios-adapter, så provet
 * mäter samma väg som en webbläsare, bara utan nät.
 *
 * ── VAD PROVET INTE KAN SE ─────────────────────────────────────────────────
 *
 * Att servern avvisar en fel sats ägs av `accounting.moms.spec.ts` och
 * `t2-fakturakontrakt.db.spec.ts`. Här mäts bara att formuläret föreslår och
 * kräver samma sats — alltså att ett korrekt ifyllt formulär inte blir ett
 * 400.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { vatRateForRent, type CreateInvoiceInput, type UnitType } from '@eken/shared'
import { api } from '@/lib/api'
import { InvoiceForm } from './InvoiceForm'

// ─── Avtalsunderlag i API:ts form ────────────────────────────────────────────

const ORG = 'org-1'

function avtal(
  id: string,
  unitNumber: string,
  type: UnitType,
  voluntaryTaxLiability: boolean | undefined,
  hyresgast: string,
) {
  const unit: Record<string, unknown> = {
    id: `unit-${id}`,
    propertyId: 'prop-1',
    name: `Objekt ${unitNumber}`,
    unitNumber,
    type,
    status: 'OCCUPIED',
    area: '72.00',
    floor: 1,
    rooms: 2,
    monthlyRent: '9500.00',
    hasBalcony: false,
    hasStorage: false,
    storageNumber: null,
    parkingSpaceNumber: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    property: {
      id: 'prop-1',
      organizationId: ORG,
      name: 'Ekens Gård 1',
      propertyDesignation: 'Eken 1:1',
      type: 'RESIDENTIAL',
      street: 'Storgatan 1',
      city: 'Stockholm',
      postalCode: '111 22',
      totalArea: '1000.00',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  }
  // Fältet UTELÄMNAS i stället för att sättas till undefined när ett prov vill
  // mäta ett svar som saknar det — så ser ett sådant svar ut över nätet.
  if (voluntaryTaxLiability !== undefined) unit['voluntaryTaxLiability'] = voluntaryTaxLiability
  return {
    id,
    organizationId: ORG,
    unitId: `unit-${id}`,
    tenantId: `tenant-${id}`,
    status: 'ACTIVE',
    leaseType: 'INDEFINITE',
    startDate: '2026-01-01T00:00:00.000Z',
    endDate: null,
    monthlyRent: '9500.00',
    depositAmount: '0.00',
    noticePeriodMonths: 3,
    indexClause: false,
    contractNumber: `KONT-2026-0000${id.slice(-1)}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    unit,
    tenant: {
      id: `tenant-${id}`,
      organizationId: ORG,
      type: 'COMPANY',
      companyName: hyresgast,
      email: `${id}@exempel.invalid`,
    },
  }
}

const BOSTAD = avtal('11111111-1111-4111-8111-000000000001', '1101', 'APARTMENT', false, 'Bostad AB')
// Frivillig beskattning får aldrig avse bostad — regeln ger 0 % ändå. Provet
// finns för att ett formulär som läste FLAGGAN i stället för regeln skulle
// föreslå 25 % här.
const BOSTAD_FLAGGAD = avtal('11111111-1111-4111-8111-000000000002', '1102', 'APARTMENT', true, 'Bostad Flagga AB')
const LOKAL_MED = avtal('11111111-1111-4111-8111-000000000003', '0101', 'OFFICE', true, 'Kontor Moms AB')
const LOKAL_UTAN = avtal('11111111-1111-4111-8111-000000000004', '0102', 'RETAIL', false, 'Butik Momsfri AB')
const PARKERING = avtal('11111111-1111-4111-8111-000000000005', 'P-7', 'PARKING', false, 'Parkering AB')
const UTAN_UPPGIFT = avtal('11111111-1111-4111-8111-000000000006', '0103', 'OFFICE', undefined, 'Okänd AB')

const KUND = {
  id: '22222222-2222-4222-8222-000000000001',
  organizationId: ORG,
  type: 'COMPANY',
  firstName: null,
  lastName: null,
  companyName: 'Extern Kund AB',
  orgNumber: '556000-0001',
  isActive: true,
  _count: { invoices: 0 },
}

// ─── Rigg: verkliga hookar, ersatt transport ─────────────────────────────────

let avtalslista: unknown[] = []
const anrop: string[] = []
const ursprungligAdapter = api.defaults.adapter

function svar(config: InternalAxiosRequestConfig, data: unknown, status = 200): AxiosResponse {
  return { data: { success: true, data }, status, statusText: String(status), headers: {}, config }
}

beforeEach(() => {
  avtalslista = [BOSTAD, BOSTAD_FLAGGAD, LOKAL_MED, LOKAL_UTAN, PARKERING, UTAN_UPPGIFT]
  anrop.length = 0
  api.defaults.adapter = async (config) => {
    const metod = (config.method ?? 'get').toUpperCase()
    anrop.push(`${metod} ${config.url}`)
    // Kopia per svar: React Query ska se ett NYTT objekt vid varje omhämtning,
    // som över nätet. Annars kan en omrendering aldrig bli "irrelevant".
    if (metod === 'GET' && config.url === '/leases')
      return svar(config, JSON.parse(JSON.stringify(avtalslista)))
    if (metod === 'GET' && config.url === '/customers') return svar(config, [KUND])
    if (metod === 'GET' && config.url === '/organizations/me')
      return svar(config, { id: ORG, name: 'Test AB', bankgiro: '5050-1055' })
    throw new AxiosError(
      `ej riggat: ${metod} ${config.url}`,
      'ERR_BAD_REQUEST',
      config,
      null,
      svar(config, null, 404),
    )
  }
})

afterEach(() => {
  api.defaults.adapter = ursprungligAdapter
  cleanup()
})

function rendera(props: Partial<Parameters<typeof InvoiceForm>[0]> = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const onSubmit = vi.fn<(d: CreateInvoiceInput) => void>()
  render(
    <QueryClientProvider client={qc}>
      <InvoiceForm onSubmit={onSubmit} onCancel={vi.fn()} {...props} />
    </QueryClientProvider>,
  )
  return { qc, onSubmit }
}

/** Radernas momsväljare — de enda select-fälten med formulärets fyra satser. */
function momsfalt(): HTMLSelectElement[] {
  return (screen.getAllByRole('combobox') as HTMLSelectElement[]).filter(
    (s) => [...s.options].map((o) => o.value).join(',') === '0,6,12,25',
  )
}
const momsvarden = () => momsfalt().map((s) => s.value)

async function avtalsfalt(): Promise<HTMLSelectElement> {
  const falt = (await screen.findByLabelText('Hyresavtal')) as HTMLSelectElement
  // Vänta tills avtalen FAKTISKT laddats — "Laddar avtal…" är också ett alternativ.
  await waitFor(() => expect(falt.disabled).toBe(false))
  return falt
}

async function valjAvtal(id: string) {
  fireEvent.change(await avtalsfalt(), { target: { value: id } })
}

function fyllRad(idx: number, beskrivning: string, pris: number) {
  const beskr = screen.getAllByPlaceholderText('Beskrivning')[idx]!
  const apris = screen.getAllByPlaceholderText('À-pris (kr)')[idx]!
  fireEvent.change(beskr, { target: { value: beskrivning } })
  fireEvent.change(apris, { target: { value: String(pris) } })
}

const skicka = () => fireEvent.click(screen.getByRole('button', { name: 'Skapa faktura' }))

// ─── Förval per upplåtelse ───────────────────────────────────────────────────

describe('momsförvalet följer avtalets upplåtelse (vatRateForRent)', () => {
  const fall = [
    { namn: 'bostad', avtal: BOSTAD, sats: 0 },
    { namn: 'bostad med flaggan satt', avtal: BOSTAD_FLAGGAD, sats: 0 },
    { namn: 'lokal med frivillig beskattning', avtal: LOKAL_MED, sats: 25 },
    { namn: 'lokal utan frivillig beskattning', avtal: LOKAL_UTAN, sats: 0 },
    { namn: 'parkering', avtal: PARKERING, sats: 25 },
  ] as const

  it.each(fall)('$namn → $sats %, samma tal som regeln', async ({ avtal: a, sats }) => {
    // Förväntan står som tal; att den är regelns tal kontrolleras här, så en
    // ändrad regel fäller provet i stället för att tyst bli ny förväntan.
    const u = a.unit as { type: UnitType; voluntaryTaxLiability: boolean }
    expect(vatRateForRent(u.type, u.voluntaryTaxLiability)).toBe(sats)

    rendera()
    await valjAvtal(a.id)
    await waitFor(() => expect(momsvarden()).toEqual([String(sats)]))
  })

  it.each(fall)(
    '$namn: ett korrekt ifyllt formulär skickas med $sats % på alla rader',
    async ({ avtal: a, sats }) => {
      const { onSubmit } = rendera()
      await valjAvtal(a.id)
      await waitFor(() => expect(momsvarden()).toEqual([String(sats)]))
      fireEvent.click(screen.getByRole('button', { name: /Lägg till rad/ }))
      // En rad som läggs till EFTER avtalsvalet får också avtalets sats.
      expect(momsvarden()).toEqual([String(sats), String(sats)])
      fyllRad(0, 'Hyra oktober', 9500)
      fyllRad(1, 'Tillägg', 100)
      skicka()
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
      const data = onSubmit.mock.calls[0]![0]
      expect(data.leaseId).toBe(a.id)
      expect(data.lines.map((l) => l.vatRate)).toEqual([sats, sats])
    },
  )

  it('kundfaktura utan avtal: förvalet står kvar på 25 % och alla satser går att spara', async () => {
    const { onSubmit } = rendera()
    fireEvent.click(screen.getByRole('button', { name: 'Extern kund' }))
    const kund = (await screen.findByLabelText('Kund')) as HTMLSelectElement
    await waitFor(() => expect(kund.disabled).toBe(false))
    fireEvent.change(kund, { target: { value: KUND.id } })
    expect(momsvarden()).toEqual(['25'])
    fireEvent.change(momsfalt()[0]!, { target: { value: '12' } })
    fyllRad(0, 'Konsulttimme', 800)
    skicka()
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]![0].lines[0]!.vatRate).toBe(12)
  })

  it('svar utan uppgift om frivillig beskattning: inget gissas, förvalet står kvar', async () => {
    rendera()
    await valjAvtal(BOSTAD.id)
    await waitFor(() => expect(momsvarden()).toEqual(['0']))
    await valjAvtal(UTAN_UPPGIFT.id)
    // Regeln kan inte läsas — orörd rad behåller det den hade. Inget tvingas in.
    expect(momsvarden()).toEqual(['0'])
  })
})

// ─── Byte av avtal ───────────────────────────────────────────────────────────

describe('byte av avtal', () => {
  it('orörda rader följer varje nytt avtal: bostad → parkering → lokal utan → lokal med', async () => {
    rendera()
    fireEvent.click(await screen.findByRole('button', { name: /Lägg till rad/ }))
    const kedja = [
      [BOSTAD, '0'],
      [PARKERING, '25'],
      [LOKAL_UTAN, '0'],
      [LOKAL_MED, '25'],
      [BOSTAD, '0'],
    ] as const
    for (const [a, sats] of kedja) {
      await valjAvtal(a.id)
      await waitFor(() => expect(momsvarden()).toEqual([sats, sats]))
    }
  })

  it('en rad användaren själv ändrat skrivs inte över vid avtalsbyte — fel sats stoppas på raden', async () => {
    const { onSubmit } = rendera()
    await valjAvtal(BOSTAD.id)
    await waitFor(() => expect(momsvarden()).toEqual(['0']))
    fireEvent.click(screen.getByRole('button', { name: /Lägg till rad/ }))
    // Rad 0: eget val 0 % (giltigt för bostaden). Rad 1: orörd.
    fireEvent.change(momsfalt()[0]!, { target: { value: '0' } })
    // Eget val SOM SKILJER SIG från radens utgångsvärde, så RHF räknar det som
    // ändrat: sätt 6 och sedan 0 igen.
    fireEvent.change(momsfalt()[0]!, { target: { value: '6' } })
    fireEvent.change(momsfalt()[0]!, { target: { value: '0' } })

    await valjAvtal(PARKERING.id)
    await waitFor(() => expect(momsvarden()).toEqual(['0', '25']))

    fyllRad(0, 'Hyra', 1200)
    fyllRad(1, 'Hyra', 1200)
    skicka()
    // Formuläret skickar INTE ett värde servern avvisar; felet står på raden,
    // på svenska, och nämner satsen som gäller.
    expect(await screen.findByText('Upplåtelsen är momspliktig — välj 25 %.')).toBeTruthy()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('eget förbjudet val på bostad ger fältfel på raden, inget anrop', async () => {
    const { onSubmit } = rendera()
    await valjAvtal(BOSTAD.id)
    await waitFor(() => expect(momsvarden()).toEqual(['0']))
    fireEvent.change(momsfalt()[0]!, { target: { value: '12' } })
    fyllRad(0, 'Hyra', 9500)
    skicka()
    expect(await screen.findByText('Bostadshyra är momsfri — välj 0 %.')).toBeTruthy()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(momsvarden()).toEqual(['12'])
  })

  it('lokal utan frivillig beskattning: fel sats ger lokalens text, inte bostadens', async () => {
    const { onSubmit } = rendera()
    await valjAvtal(LOKAL_UTAN.id)
    await waitFor(() => expect(momsvarden()).toEqual(['0']))
    fireEvent.change(momsfalt()[0]!, { target: { value: '25' } })
    fyllRad(0, 'Hyra', 9500)
    skicka()
    expect(
      await screen.findByText('Upplåtelsen saknar frivillig beskattning och är momsfri — välj 0 %.'),
    ).toBeTruthy()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

// ─── Irrelevant omrendering ──────────────────────────────────────────────────

describe('ett eget giltigt val står kvar vid omrendering som inte byter avtal', () => {
  it('bostad: eget 0 % överlever skrivning, ny rad, omhämtad avtalslista och lägesväxling utan byte', async () => {
    const { qc, onSubmit } = rendera()
    await valjAvtal(BOSTAD.id)
    await waitFor(() => expect(momsvarden()).toEqual(['0']))
    // Eget val (via ett annat värde, så det räknas som ändrat) — tillbaka till 0.
    fireEvent.change(momsfalt()[0]!, { target: { value: '6' } })
    fireEvent.change(momsfalt()[0]!, { target: { value: '0' } })

    // 1. skrivning i andra fält
    fyllRad(0, 'Hyra oktober', 9500)
    fireEvent.change(screen.getAllByPlaceholderText('Antal')[0]!, { target: { value: '2' } })
    // 2. omhämtad avtalslista — nya objekt, samma innehåll (som efter fönsterfokus)
    const fore = anrop.filter((a) => a === 'GET /leases').length
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['leases'] })
    })
    await waitFor(() =>
      expect(anrop.filter((a) => a === 'GET /leases').length).toBeGreaterThan(fore),
    )
    // 3. ny rad
    fireEvent.click(screen.getByRole('button', { name: /Lägg till rad/ }))
    fyllRad(1, 'Tillägg', 100)

    expect(momsvarden()).toEqual(['0', '0'])
    skicka()
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]![0].lines.map((l) => l.vatRate)).toEqual([0, 0])
  })

  it('kundfaktura: eget 6 % överlever skrivning och omhämtning', async () => {
    const { qc } = rendera()
    fireEvent.click(screen.getByRole('button', { name: 'Extern kund' }))
    const kund = (await screen.findByLabelText('Kund')) as HTMLSelectElement
    await waitFor(() => expect(kund.disabled).toBe(false))
    fireEvent.change(kund, { target: { value: KUND.id } })
    fireEvent.change(momsfalt()[0]!, { target: { value: '6' } })
    fyllRad(0, 'Tjänst', 500)
    await act(async () => {
      await qc.invalidateQueries()
    })
    expect(momsvarden()).toEqual(['6'])
  })

  it('redigering av en sparad bostadsfaktura: radernas 0 % står kvar när avtalen laddats', async () => {
    const { onSubmit } = rendera({
      submitLabel: 'Spara ändringar',
      defaultValues: {
        type: 'RENT',
        leaseId: BOSTAD.id,
        issueDate: '2026-10-01',
        dueDate: '2026-10-31',
        lines: [{ description: 'Hyra oktober', quantity: 1, unitPrice: 9500, vatRate: 0 }],
      },
    })
    await avtalsfalt()
    expect(momsvarden()).toEqual(['0'])
    fireEvent.click(screen.getByRole('button', { name: 'Spara ändringar' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]![0].lines[0]!.vatRate).toBe(0)
  })
})
