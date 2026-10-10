import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  details: vi.fn(),
  adjust: vi.fn(),
  undo: vi.fn(),
}))
vi.mock('../api/accounting.api', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getSupplierInvoiceDetails: mocks.details,
  adjustSupplierInvoiceVat: mocks.adjust,
  undoSupplierPayment: mocks.undo,
}))

import { LeverantorsfakturaDetalj } from './LeverantorsfakturaDetalj'

const bas = {
  id: 'f1',
  supplierName: 'Bygg & Co AB',
  description: 'Reparation',
  invoiceDate: '2026-08-10',
  dueDate: '2026-09-10',
  expenseAccount: 5070,
  netAmount: 1000,
  vatRate: 25,
  vatAmount: 250,
  totalAmount: 1250,
  paidAt: '2026-08-15',
  cancelledAt: null,
  status: 'PAID',
  overdue: false,
  createdAt: '2026-08-10',
  vatTreatment: 'INGET_AVDRAG',
  vatTreatmentCurrent: 'HELT_AVDRAG',
  vatTreatmentDecidedById: 'u1',
  vatTreatmentDecidedAt: '2026-08-10T10:00:00Z',
  momsvalAngivet: true,
  justeringar: [
    {
      id: 'j1',
      seq: 1,
      fran: 'INGET_AVDRAG',
      till: 'HELT_AVDRAG',
      belopp: 250,
      datum: '2026-08-20',
      skal: 'Fel val',
      beslutadAv: 'u1',
      roll: 'OWNER',
      beslutadVid: '2026-08-20T10:00:00Z',
      journalEntryId: 'je-j1',
      exportStatus: 'DRY_RUN_READY',
    },
  ],
  betalningsled: [
    {
      k: 1,
      journalEntryId: 'je-b1',
      verifikat: 'A2',
      datum: '2026-08-15',
      gallande: true,
      exportStatus: 'CONFIRMED',
      angring: null,
    },
  ],
  betalningshistorikFel: null,
}

function visa() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <LeverantorsfakturaDetalj id="f1" onClose={() => undefined} />
    </QueryClientProvider>,
  )
}

describe('TESTKUND-041 LeverantorsfakturaDetalj', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('visar ursprungligt och gällande val, justeringen med exportstatus, och betalningsledet', async () => {
    mocks.details.mockResolvedValue(bas)
    visa()
    expect(await screen.findByTestId('momsval-ursprung')).toBeTruthy()
    expect(screen.getByTestId('momsval-gallande').textContent).toMatch(
      /Moms dras av – inte exporterad/,
    )
    expect(screen.getByTestId('momsjusteringar').textContent).toMatch(
      /Moms dras inte av → Moms dras av.*Fel val.*inte exporterad/,
    )
    expect(screen.getByTestId('betalningsled').textContent).toMatch(
      /A2.*exporterad till Fortnox.*gällande/,
    )
  })

  it('ångra skickar EXAKT det gällande ledets verifikat och skälet', async () => {
    mocks.details.mockResolvedValue(bas)
    mocks.undo.mockResolvedValue({})
    visa()
    fireEvent.change(await screen.findByTestId('angra-skal'), {
      target: { value: 'Fel betalningsdatum' },
    })
    fireEvent.click(screen.getByTestId('angra-betalning-submit'))
    await vi.waitFor(() => expect(mocks.undo).toHaveBeenCalled())
    expect(mocks.undo.mock.calls[0]![0]).toEqual({
      id: 'f1',
      journalEntryId: 'je-b1',
      reason: 'Fel betalningsdatum',
    })
  })

  it('justering föreslår motsatsen till gällande val och skickar en klientnyckel', async () => {
    mocks.details.mockResolvedValue(bas)
    mocks.adjust.mockResolvedValue({})
    visa()
    expect((await screen.findByTestId('momsjustering-form')).textContent).toMatch(
      /Ändra till: Moms 250\s?kr dras inte av/,
    )
    fireEvent.change(screen.getByTestId('momsjustering-skal'), { target: { value: 'Rättat val' } })
    fireEvent.click(screen.getByTestId('momsjustering-submit'))
    await vi.waitFor(() => expect(mocks.adjust).toHaveBeenCalled())
    expect(mocks.adjust.mock.calls[0]![0]).toMatchObject({
      id: 'f1',
      till: 'INGET_AVDRAG',
      reason: 'Rättat val',
      clientKey: expect.any(String),
    })
  })

  it('äldre faktura utan val: ingen justering, tydlig text', async () => {
    mocks.details.mockResolvedValue({
      ...bas,
      vatTreatment: null,
      vatTreatmentCurrent: null,
      momsvalAngivet: false,
      justeringar: [],
    })
    visa()
    expect((await screen.findByTestId('momsval-ej-angivet')).textContent).toMatch(
      /ej angiven \(äldre, bokförd som avdragsgill\)/,
    )
    expect(screen.queryByTestId('momsjustering-form')).toBeNull()
  })
})
