import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpeningEvidenceListView, OpeningEvidenceView } from '@eken/shared'

const mocks = vi.hoisted(() => ({
  role: 'OWNER' as string,
  userId: 'u-owner',
  fetchEvidence: vi.fn(),
  createEvidence: vi.fn(),
  reviewEvidence: vi.fn(),
}))

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({ user: { id: mocks.userId, role: mocks.role }, organization: { id: 'o1' } }),
}))
vi.mock('../api/kundstart.api', () => ({
  fetchEvidence: mocks.fetchEvidence,
  createEvidence: mocks.createEvidence,
  reviewEvidence: mocks.reviewEvidence,
  kr: (ore: number | null | undefined) =>
    ore === null || ore === undefined ? '–' : `${(ore / 100).toFixed(2)} kr`,
}))
vi.mock('@/lib/api', () => ({
  extractApiError: (e: unknown, f: string) => (e as Error)?.message ?? f,
}))

import { KundavstamningPanel, godkannandeHinder } from './KundavstamningPanel'

const SHA = 'a'.repeat(64)

function vy(over: Partial<OpeningEvidenceView> = {}): OpeningEvidenceView {
  return {
    id: 'e1',
    evidenceVersion: 1,
    packageVersion: 1,
    formatVersion: 'EVENO-RESKONTRA-1',
    mappingFormatVersion: 'EVENO-MAPPNING-1',
    sourceSystemProduct: 'SYNTETISK',
    sourceCompanyKey: 'GAMMALT-AB',
    sourceAsOfDate: '2026-10-31',
    scopeDeclaration: 'Hela kundreskontran',
    declaredSourceOrgNumber: '556677-8899',
    sourceExportedAt: '2026-11-01T08:00:00.000Z',
    scopeResponsible: 'Ekonomichef',
    sourceName: 'reskontra.csv',
    mappingName: 'mappning.csv',
    comparisonStatus: 'OK',
    counts: { dokumentKalla: 2, dokumentImport: 2, matchade: 2, avvikelser: 0, stopp: 0 },
    stopp: [],
    avvikelser: [],
    createdById: 'u-admin',
    createdAt: '2026-10-14T17:00:00.000Z',
    evidenceSha256: SHA,
    granskning: null,
    artefaktKontroll: { kallaOk: true, mappningOk: true },
    giltighet: { forGranskning: true, forGodkannande: false, skal: [] },
    ...over,
  }
}

const lista = (aktuell: OpeningEvidenceView | null, tidigare: OpeningEvidenceView[] = []) =>
  ({ packageId: 'p1', packageVersion: 1, aktuell, tidigare }) as OpeningEvidenceListView

// 191-fallet omkastat: lika totalsumma, fel kunder.
const OMKASTAD = vy({
  comparisonStatus: 'AVVIKELSE',
  counts: { dokumentKalla: 2, dokumentImport: 2, matchade: 0, avvikelser: 4, stopp: 0 },
  avvikelser: [
    {
      niva: 'DOKUMENT',
      typ: 'RECEIVABLE',
      nyckel: 'GAMMALT-AB/DOC-1/RECEIVABLE',
      kund: 'A',
      avtal: 'K-1',
      falt: 'kund',
      kalla: 'A',
      import: 'B',
      skal: 'Dokumentet ligger på fel kund i importen.',
    },
    {
      niva: 'KUND_AVTAL',
      typ: 'RECEIVABLE',
      nyckel: 'A/K-1',
      kund: 'A',
      avtal: 'K-1',
      falt: 'oppetOre',
      kalla: 600000,
      import: 400000,
      skal: 'Kundens öppna belopp skiljer sig.',
    },
  ],
  giltighet: { forGranskning: false, forGodkannande: false, skal: [] },
})

function renderIt(status: 'VALIDATED' | 'APPROVED' | 'EXECUTED' = 'VALIDATED') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <KundavstamningPanel packageId="p1" packageStatus={status} />
    </QueryClientProvider>,
  )
}

describe('godkannandeHinder (vyn påstår aldrig godkännbart utan serverns evidens)', () => {
  it('E22: utan evidens finns ett hinder', () => {
    expect(godkannandeHinder(lista(null), 'u-owner')).toHaveLength(1)
    expect(godkannandeHinder(undefined, 'u-owner')).toHaveLength(1)
  })
  it('E2: avvikelse trots lika totalsumma är ett hinder', () => {
    expect(godkannandeHinder(lista(OMKASTAD), 'u-owner').join(' ')).toContain('avvikelser')
  })
  it('ej granskad är ett hinder', () => {
    expect(godkannandeHinder(lista(vy()), 'u-owner').join(' ')).toContain('granskning')
  })
  it('E10: samma användare som granskat kan inte godkänna', () => {
    const a = vy({
      granskning: {
        reviewerUserId: 'u-owner',
        reviewerRole: 'ACCOUNTANT',
        reviewedAt: '2026-10-14',
      },
      giltighet: { forGranskning: false, forGodkannande: true, skal: [] },
    })
    expect(godkannandeHinder(lista(a), 'u-owner').join(' ')).toContain('annan användare')
  })
  it('granskad av annan, giltig och OK: inga hinder i vyn', () => {
    const a = vy({
      granskning: { reviewerUserId: 'u-acc', reviewerRole: 'ACCOUNTANT', reviewedAt: '2026-10-14' },
      giltighet: { forGranskning: false, forGodkannande: true, skal: [] },
    })
    expect(godkannandeHinder(lista(a), 'u-owner')).toEqual([])
  })
  it('E8: serverns giltighetsskäl visas när underlaget blivit inaktuellt', () => {
    const a = vy({
      granskning: { reviewerUserId: 'u-acc', reviewerRole: 'ACCOUNTANT', reviewedAt: '2026-10-14' },
      giltighet: {
        forGranskning: false,
        forGodkannande: false,
        skal: ['Paketet har en ny version sedan jämförelsen.'],
      },
    })
    expect(godkannandeHinder(lista(a), 'u-owner')).toEqual([
      'Paketet har en ny version sedan jämförelsen.',
    ])
  })
  it('artefakt som inte stämmer med kontrollsumman är ett hinder', () => {
    const a = vy({ artefaktKontroll: { kallaOk: false, mappningOk: true } })
    expect(godkannandeHinder(lista(a), 'u-owner').join(' ')).toContain('kontrollsummor')
  })
})

describe('KundavstamningPanel', () => {
  beforeEach(() => {
    mocks.role = 'OWNER'
    mocks.userId = 'u-owner'
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('K1/E2: visar källa, mappning och konkret differens per dokument och kund', async () => {
    mocks.fetchEvidence.mockResolvedValue(lista(OMKASTAD))
    renderIt()
    const status = await screen.findByTestId('evidens-status')
    expect(status.getAttribute('data-status')).toBe('AVVIKELSE')
    expect(screen.getByText(/SYNTETISK, företag GAMMALT-AB, per 2026-10-31/)).toBeTruthy()
    expect(screen.getByText('mappning.csv')).toBeTruthy()
    const tabell = screen.getByTestId('evidens-avvikelser')
    expect(within(tabell).getByText('Dokument GAMMALT-AB/DOC-1/RECEIVABLE, avtal K-1')).toBeTruthy()
    expect(within(tabell).getByText('6000.00 kr')).toBeTruthy()
    expect(within(tabell).getByText('4000.00 kr')).toBeTruthy()
    expect(screen.getByTestId('evidens-atgard').textContent).toContain('varje kund')
    // Ingen teknisk hash i det primära flödet (bara under "Teknisk identitet").
    expect(screen.getByTestId('evidens-aktuell').querySelector('details')).toBeTruthy()
  })

  it('E5: saknat värde visas som "saknas", aldrig som 0', async () => {
    mocks.fetchEvidence.mockResolvedValue(
      lista(
        vy({
          comparisonStatus: 'STOPP',
          avvikelser: [
            {
              niva: 'DOKUMENT',
              typ: 'RECEIVABLE',
              nyckel: 'GAMMALT-AB/DOC-3/RECEIVABLE',
              kund: 'A',
              avtal: 'K-1',
              falt: 'betaltOre',
              kalla: null,
              import: 0,
              skal: 'Betalt belopp saknas i källan.',
            },
          ],
          stopp: [
            {
              kod: 'SAKNAT_VARDE',
              fil: 'KALLA',
              rad: 3,
              nyckel: null,
              skal: 'Betalt belopp saknas.',
            },
          ],
        }),
      ),
    )
    renderIt()
    const tabell = await screen.findByTestId('evidens-avvikelser')
    expect(within(tabell).getByText('saknas')).toBeTruthy()
    expect(screen.getByTestId('evidens-stopp').textContent).toContain('källan rad 3')
  })

  it('ACCOUNTANT kan granska exakt den versionen, men ser ingen uppladdning', async () => {
    mocks.role = 'ACCOUNTANT'
    mocks.userId = 'u-acc'
    mocks.fetchEvidence.mockResolvedValue(lista(vy()))
    mocks.reviewEvidence.mockResolvedValue(vy())
    renderIt()
    const knapp = await screen.findByTestId('evidens-granska')
    expect(screen.queryByTestId('evidens-ladda')).toBeNull()
    fireEvent.click(knapp)
    await waitFor(() =>
      expect(mocks.reviewEvidence).toHaveBeenCalledWith('p1', 'e1', { evidenceSha256: SHA }),
    )
  })

  it('ACCOUNTANT: granskning spärrad när servern säger att versionen inte kan granskas', async () => {
    mocks.role = 'ACCOUNTANT'
    mocks.fetchEvidence.mockResolvedValue(lista(OMKASTAD))
    renderIt()
    const knapp = (await screen.findByTestId('evidens-granska')) as HTMLButtonElement
    expect(knapp.disabled).toBe(true)
  })

  it('OWNER/ADMIN ser uppladdning bara för VALIDATED; ingen granskningsknapp', async () => {
    mocks.fetchEvidence.mockResolvedValue(lista(null))
    renderIt('VALIDATED')
    await screen.findByTestId('evidens-saknas')
    expect(screen.getByTestId('evidens-ladda')).toBeTruthy()
    expect(screen.queryByTestId('evidens-granska')).toBeNull()
    cleanup()
    mocks.fetchEvidence.mockResolvedValue(lista(vy()))
    renderIt('EXECUTED')
    await screen.findByTestId('evidens-aktuell')
    expect(screen.queryByTestId('evidens-ladda')).toBeNull()
  })

  it.each(['MANAGER', 'VIEWER'])('%s får ingen skriv- eller granskningsmöjlighet', async (r) => {
    mocks.role = r
    mocks.fetchEvidence.mockResolvedValue(lista(vy()))
    renderIt()
    await screen.findByTestId('evidens-aktuell')
    expect(screen.queryByTestId('evidens-ladda')).toBeNull()
    expect(screen.queryByTestId('evidens-granska')).toBeNull()
  })

  it('K2: historiska versioner är läsbara', async () => {
    mocks.fetchEvidence.mockResolvedValue(
      lista(vy({ evidenceVersion: 2 }), [
        vy({ id: 'e0', evidenceVersion: 1, comparisonStatus: 'STOPP' }),
      ]),
    )
    renderIt('EXECUTED')
    const h = await screen.findByTestId('evidens-historik')
    expect(h.textContent).toContain('Version 1')
    expect(h.textContent).toContain('Stoppad')
  })

  it('uppladdning kräver alla deklarationer och båda filerna, och skickar exakt A2-fälten', async () => {
    mocks.fetchEvidence.mockResolvedValue(lista(null))
    mocks.createEvidence.mockResolvedValue(vy())
    renderIt('VALIDATED')
    const ladda = await screen.findByTestId('evidens-ladda')
    const knapp = within(ladda).getByRole('button', {
      name: 'Jämför och spara underlaget',
    }) as HTMLButtonElement
    const falt = (namn: RegExp, v: string) =>
      fireEvent.change(within(ladda).getByLabelText(namn), { target: { value: v } })
    falt(/^Tidigare system/, 'SYNTETISK')
    falt(/^Företag i tidigare system/, 'GAMMALT-AB')
    falt(/^Källföretagets organisationsnummer/, '556677-8899')
    falt(/^Avstämningsdag/, '2026-10-31')
    falt(/^När exporten togs ut/, '2026-11-01T08:00')
    falt(/^Ansvarig för att exporten/, 'Ekonomichef')
    falt(/^Omfattning/, 'Hela kundreskontran')
    expect(knapp.disabled).toBe(true)
    const fil = (namn: string, text: string) => new File([text], namn, { type: 'text/csv' })
    fireEvent.change(within(ladda).getByLabelText('Reskontra ur tidigare system'), {
      target: { files: [fil('reskontra.csv', 'kallforetag;kund')] },
    })
    fireEvent.change(within(ladda).getByLabelText('Mappning gammal kund och avtal till ny'), {
      target: { files: [fil('mappning.csv', 'kallforetag;kund')] },
    })
    await waitFor(() => expect(knapp.disabled).toBe(false))
    fireEvent.click(knapp)
    await waitFor(() => expect(mocks.createEvidence).toHaveBeenCalledTimes(1))
    const [id, body] = mocks.createEvidence.mock.calls[0] as [string, Record<string, string>]
    expect(id).toBe('p1')
    expect(Object.keys(body).sort()).toEqual(
      [
        'mappingContent',
        'mappingName',
        'scopeDeclaration',
        'scopeResponsible',
        'sourceAsOfDate',
        'sourceCompanyKey',
        'sourceContent',
        'sourceExportedAt',
        'sourceName',
        'sourceOrgNumber',
        'sourceSystemProduct',
      ].sort(),
    )
    expect(body.sourceExportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
    expect(body.sourceContent).toBe('kallforetag;kund')
    // Inga klientpåståenden om granskning eller status skickas.
    expect(body).not.toHaveProperty('reviewerId')
    expect(body).not.toHaveProperty('comparisonStatus')
  })

  it('serverns nekande av granskningen visas', async () => {
    mocks.role = 'ACCOUNTANT'
    mocks.fetchEvidence.mockResolvedValue(lista(vy()))
    mocks.reviewEvidence.mockRejectedValue(new Error('Din roll tillåter inte granskning.'))
    renderIt()
    fireEvent.click(await screen.findByTestId('evidens-granska'))
    expect((await screen.findByRole('alert')).textContent).toContain('Din roll tillåter inte')
  })
})
