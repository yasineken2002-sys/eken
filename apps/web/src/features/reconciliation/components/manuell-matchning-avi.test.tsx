/**
 * G19 (FORTNOX-100): Matcha-dialogen ska kunna koppla en omatchad bankbetalning till en
 * HYRESAVI (inte bara till en kommersiell faktura). Proven kör mot mockade hooks i jsdom;
 * hela kedjan i riktig webbläsare mot byggd Nest mäts i 100-lägenhetsriggen
 * (FORTNOX-100-LAGENHETER-20261003/CLAUDE1/rigg/webb-g19.mjs).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BankTransaction } from '@eken/shared'
import type { RentNotice } from '@/features/avisering/api/avisering.api'

const matchMutate = vi.fn()
let matchFel: unknown = null
let avier: RentNotice[] = []
const fetchNotices = vi.fn(async (_f?: unknown) => avier)

vi.mock('../hooks/useReconciliation', () => ({
  useManualMatch: () => ({ mutate: matchMutate, isPending: false, error: matchFel }),
}))
vi.mock('@/features/invoices/hooks/useInvoiceQueries', () => ({
  useInvoices: () => ({ data: [], isLoading: false }),
}))
vi.mock('@/lib/api', () => ({
  extractApiError: (e: { response?: { data?: { error?: { message?: string } } } }, f: string) =>
    e.response?.data?.error?.message ?? f,
}))
vi.mock('@/features/avisering/api/avisering.api', () => ({
  fetchNotices: (f?: unknown) => fetchNotices(f),
}))

import { ManualMatchModal } from './ManualMatchModal'

function avi(o: Partial<RentNotice> & { id: string }): RentNotice {
  return {
    organizationId: 'org',
    tenantId: 't1',
    leaseId: 'l1',
    noticeNumber: `AVI-2026-11-${o.id}`,
    ocrNumber: '1000000011',
    month: 11,
    year: 2026,
    amount: 6037,
    vatAmount: 0,
    totalAmount: 6037,
    payableTotal: 6037,
    dueDate: '2026-10-31',
    paidAt: null,
    paidAmount: null,
    paymentMethod: null,
    status: 'SENT',
    sentAt: null,
    sentTo: null,
    sendError: null,
    createdAt: '',
    updatedAt: '',
    tenant: { id: 't1', type: 'INDIVIDUAL', firstName: 'Hyresgäst', lastName: 'Nr1', email: 'x' },
    lease: { id: 'l1', unit: { id: 'u', name: 'Lgh 1001', property: { id: 'p', name: 'Eken A' } } },
    ...o,
  }
}

const tx: BankTransaction = {
  id: 'tx-1',
  organizationId: 'org',
  date: '2026-11-02',
  description: 'BgMax inbetalning (OCR 1000000011)',
  amount: 6037,
  rawOcr: '1000000011',
  status: 'UNMATCHED',
  createdAt: '',
}

function rendera(t: BankTransaction = tx) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ManualMatchModal transaction={t} onClose={() => undefined} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  matchMutate.mockReset()
  matchFel = null
  fetchNotices.mockClear()
  avier = []
})
afterEach(cleanup)

describe('ManualMatchModal — hyresavier (G19)', () => {
  it('söker hyresavier på betalarens OCR och visar hyresgäst, period, objekt och restskuld', async () => {
    avier = [avi({ id: 'nov' }), avi({ id: 'dec', month: 12, dueDate: '2026-11-30' })]
    rendera()
    await screen.findAllByText('Hyresgäst Nr1')
    expect(fetchNotices).toHaveBeenCalledWith({ search: '1000000011' })
    expect(screen.getByText(/AVI-2026-11-nov · nov 2026 · Lgh 1001, Eken A/)).toBeTruthy()
    expect(screen.getByText(/AVI-2026-11-dec · dec 2026/)).toBeTruthy()
  })

  it('väljer ingenting åt operatören och skickar rentNoticeId för den valda avin', async () => {
    avier = [avi({ id: 'nov' }), avi({ id: 'dec', month: 12 })]
    rendera()
    await screen.findAllByText('Hyresgäst Nr1')
    const matcha = screen.getByRole('button', { name: /Matcha/ })
    expect((matcha as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByText(/AVI-2026-11-dec/))
    fireEvent.click(matcha)
    expect(matchMutate).toHaveBeenCalledWith(
      { transactionId: 'tx-1', rentNoticeId: 'dec' },
      expect.anything(),
    )
  })

  it('visar bara betalbara avier: PAID och CANCELLED utelämnas, FAILED syns med märkning', async () => {
    avier = [
      avi({ id: 'betald', status: 'PAID', payableTotal: 0 }),
      avi({ id: 'makulerad', status: 'CANCELLED' }),
      avi({ id: 'misslyckad', status: 'FAILED' }),
    ]
    rendera()
    await screen.findByText('Utskick misslyckades')
    expect(screen.queryByText(/AVI-2026-11-betald/)).toBeNull()
    expect(screen.queryByText(/AVI-2026-11-makulerad/)).toBeNull()
    expect(screen.getByText(/AVI-2026-11-misslyckad/)).toBeTruthy()
  })

  it('fel OCR: inget hittas på OCR, operatören söker på namn och kan matcha', async () => {
    rendera({ ...tx, rawOcr: '99999999999999' })
    await screen.findByText(/Inga obetalda hyresavier/)
    avier = [avi({ id: 'n92', tenant: { ...avi({ id: 'x' }).tenant, lastName: 'Nr92' } })]
    fireEvent.change(screen.getByLabelText('Sök hyresavi'), { target: { value: 'Nr92' } })
    await screen.findByText('Hyresgäst Nr92')
    await waitFor(() => expect(fetchNotices).toHaveBeenLastCalledWith({ search: 'Nr92' }))
  })

  it('delbetalning syns före matchning med kvarvarande restskuld', async () => {
    avier = [avi({ id: 'nov', payableTotal: 10000 })]
    rendera({ ...tx, amount: 4000 })
    fireEvent.click(await screen.findByText(/AVI-2026-11-nov/))
    expect(screen.getByText(/registreras som en delbetalning/).textContent).toMatch(/6[\s ]?000/)
  })

  it('API:ts avvisning (t.ex. överbetalning) visas ordagrant, inte som statuskod', async () => {
    matchFel = {
      response: {
        data: {
          error: {
            message:
              'Kunde inte matcha transaktionen mot avin: beloppet överstiger avins restskuld',
          },
        },
      },
    }
    avier = [avi({ id: 'nov' })]
    rendera()
    expect((await screen.findByRole('alert')).textContent).toMatch(/överstiger avins restskuld/)
  })

  it('deposition märks så att operatören ser vad pengarna avser', async () => {
    avier = [avi({ id: 'dep', type: 'DEPOSIT', payableTotal: 12074 })]
    rendera()
    await screen.findByText('Deposition')
  })
})
