import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  role: 'OWNER',
  oversikt: vi.fn(),
  catalog: vi.fn(),
  draft: vi.fn(),
  approve: vi.fn(),
}))

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { id: 'u1', role: mocks.role }, organization: { id: 'o1' } }),
}))
vi.mock('../api/fortnox-account-mapping.api', () => ({
  getFortnoxAccountMapping: mocks.oversikt,
  createFortnoxAccountMappingDraft: mocks.draft,
  approveFortnoxAccountMapping: mocks.approve,
}))
vi.mock('../api/fortnox.api', () => ({ getFortnoxCatalog: mocks.catalog }))
vi.mock('@/lib/api', () => ({ extractApiError: () => 'Serverfel' }))

import { FortnoxAccountMapping } from './FortnoxAccountMapping'

function renderIt() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <FortnoxAccountMapping />
    </QueryClientProvider>,
  )
}

const BEHOV = [
  {
    role: 'HYRESINTAKT',
    vatTreatment: 'MOMSFRI',
    sourceAccountNumber: 3911,
    sourceAccountName: 'Hyresintäkter, bostäder',
    varfor: 'hyresavier för bostäder',
  },
]
const RAD = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  role: 'HYRESINTAKT',
  vatTreatment: 'MOMSFRI',
  sourceAccountNumber: 3911,
  sourceAccountName: 'Hyresintäkter, bostäder',
  targetAccountNumber: 3913,
  targetName: 'Frivilligt momspliktiga hyresintäkter',
  targetActive: true,
  targetVatCode: 'HFS',
  targetVatCodePresent: true,
  targetExists: true,
  technical: 'KONFLIKT',
  technicalReason: 'momskod HFS motsäger momsfri bostadshyra',
  approvable: false,
  hinder: 'momskod HFS motsäger momsfri bostadshyra',
  ...over,
})
const REV = (rows: unknown[], status = 'DRAFT') => ({
  id: 'rev1',
  revision: 1,
  status,
  fortnoxDatabaseNumber: 990016,
  financialYearId: 1,
  financialYearFrom: '2026-01-01',
  financialYearTo: '2026-12-31',
  contentSha256: 'a'.repeat(64),
  createdByRole: 'OWNER',
  createdAt: '2026-10-09T10:00:00.000Z',
  approvedByRole: null,
  approvedAt: null,
  supersededAt: null,
  rows,
})

describe('FortnoxAccountMapping', () => {
  beforeEach(() => {
    mocks.role = 'OWNER'
    mocks.catalog.mockImplementation(async (id: number | null) => ({
      financialYears: [{ id: 1, from: '2026-01-01', to: '2026-12-31' }],
      costAccounts:
        id === 1
          ? [
              { number: 3911, name: 'Hyresintäkter', selectable: true, reason: null },
              { number: 3915, name: 'Bostadshyror momsfria', selectable: true, reason: null },
            ]
          : [],
    }))
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('V8: inget förval av målkonto — inte heller samma nummer; spara kräver uttryckligt val', async () => {
    mocks.oversikt.mockResolvedValue({ behov: BEHOV, ejStodda: [], revisioner: [] })
    renderIt()
    fireEvent.change(await screen.findByLabelText('Räkenskapsår i Fortnox'), {
      target: { value: '1' },
    })
    const val = (await screen.findByLabelText(/Fortnox-konto för Eveno 3911/)) as HTMLSelectElement
    await waitFor(() => expect(val.options.length).toBe(3))
    expect(val.value).toBe('')
    expect((screen.getByTestId('km-spara') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(val, { target: { value: '3915' } })
    expect((screen.getByTestId('km-spara') as HTMLButtonElement).disabled).toBe(false)
    mocks.draft.mockResolvedValue({ id: 'rev1', revision: 1, contentSha256: 'a'.repeat(64) })
    fireEvent.click(screen.getByTestId('km-spara'))
    await waitFor(() =>
      expect(mocks.draft).toHaveBeenCalledWith({
        financialYearId: 1,
        rows: [
          {
            role: 'HYRESINTAKT',
            vatTreatment: 'MOMSFRI',
            sourceAccountNumber: 3911,
            targetAccountNumber: 3915,
          },
        ],
      }),
    )
  })

  it('V8: motsägelse eller ej belagd rad saknar godkännandeknapp; ingen text lovar startklarhet', async () => {
    mocks.oversikt.mockResolvedValue({
      behov: BEHOV,
      ejStodda: [
        'Hyra för enhetstyp PARKING (2 st) — bara momsfri bostadshyra stöds i denna version',
      ],
      revisioner: [REV([RAD()])],
    })
    renderIt()
    expect(await screen.findByTestId('km-kan-inte-godkannas')).toBeTruthy()
    expect(screen.queryByTestId('km-godkann')).toBeNull()
    expect(screen.getByTestId('km-ej-stodda').textContent).toMatch(/PARKING/)
    expect(screen.getByTestId('km-ingen').textContent).toMatch(/ingenting exporteras/)
    expect(document.body.textContent).not.toMatch(/startklar|klar att exportera/i)
  })

  it('kundtillgodoskuld har egen etikett och kräver ett uttryckligt kontoval före utkast', async () => {
    // Kontonumren är syntetiska val i provet, aldrig produktens förval.
    mocks.oversikt.mockResolvedValue({
      behov: [
        {
          role: 'KUNDTILLGODOSKULD',
          vatTreatment: 'EJ_TILLAMPLIG',
          sourceAccountNumber: 2998,
          sourceAccountName: 'Syntetiskt kundtillgodo',
          varfor: 'mottaget kundtillgodo',
        },
      ],
      ejStodda: [],
      revisioner: [],
    })
    mocks.catalog.mockResolvedValue({
      financialYears: [{ id: 1, from: '2026-01-01', to: '2026-12-31' }],
      costAccounts: [{ number: 2997, name: 'Syntetiskt målkonto', selectable: true, reason: null }],
    })
    renderIt()
    fireEvent.change(await screen.findByLabelText('Räkenskapsår i Fortnox'), {
      target: { value: '1' },
    })
    const val = (await screen.findByLabelText(
      'Fortnox-konto för Eveno 2998 (Kundtillgodoskuld)',
    )) as HTMLSelectElement
    await waitFor(() => expect(val.options.length).toBe(2))
    expect(val.value).toBe('')
    expect((screen.getByTestId('km-spara') as HTMLButtonElement).disabled).toBe(true)
    expect(mocks.draft).not.toHaveBeenCalled()
    fireEvent.change(val, { target: { value: '2997' } })
    mocks.draft.mockResolvedValue({ id: 'rev-credit', revision: 1, contentSha256: 'c'.repeat(64) })
    fireEvent.click(screen.getByTestId('km-spara'))
    await waitFor(() =>
      expect(mocks.draft).toHaveBeenCalledWith({
        financialYearId: 1,
        rows: [
          {
            role: 'KUNDTILLGODOSKULD',
            vatTreatment: 'EJ_TILLAMPLIG',
            sourceAccountNumber: 2998,
            targetAccountNumber: 2997,
          },
        ],
      }),
    )
    expect(mocks.approve).not.toHaveBeenCalled()
    expect(screen.getByTestId('km-ingen').textContent).toContain('Ingen godkänd kontomappning')
  })

  it('godkännande av en förenlig revision skickar exakt revisionens sha; texten säger att godkännandet avser innebörd', async () => {
    mocks.oversikt.mockResolvedValue({
      behov: BEHOV,
      ejStodda: [],
      revisioner: [
        REV([
          RAD({
            targetAccountNumber: 3915,
            targetName: 'Bostadshyror momsfria',
            targetVatCode: 'MF',
            technical: 'FORENLIG',
            technicalReason: 'momskod MF är tekniskt förenlig',
            approvable: true,
            hinder: null,
          }),
        ]),
      ],
    })
    mocks.approve.mockResolvedValue(undefined)
    renderIt()
    expect(await screen.findByText(/Godkännandet avser kontonas innebörd/)).toBeTruthy()
    expect(
      screen.getByText(/Eveno rekommenderar inget konto, ingen momskod och ingen sats/),
    ).toBeTruthy()
    fireEvent.click(screen.getByTestId('km-godkann'))
    await waitFor(() =>
      expect(mocks.approve).toHaveBeenCalledWith('rev1', { contentSha256: 'a'.repeat(64) }),
    )
  })

  it('ACCOUNTANT läser men kan inte välja eller godkänna; VIEWER ser ingenting', async () => {
    mocks.role = 'ACCOUNTANT'
    mocks.oversikt.mockResolvedValue({
      behov: BEHOV,
      ejStodda: [],
      revisioner: [REV([RAD({ approvable: true, technical: 'FORENLIG', hinder: null })])],
    })
    renderIt()
    expect(await screen.findByTestId('km-revision')).toBeTruthy()
    expect(screen.queryByTestId('km-val')).toBeNull()
    expect(screen.queryByTestId('km-godkann')).toBeNull()
    cleanup()
    mocks.role = 'VIEWER'
    renderIt()
    expect(mocks.oversikt).toHaveBeenCalledTimes(1)
    expect(screen.queryByLabelText('Kontomappning för export till Fortnox')).toBeNull()
  })
})
