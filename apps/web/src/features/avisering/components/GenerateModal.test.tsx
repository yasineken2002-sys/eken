import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerateNoticesPreview } from '@eken/shared'
import { GenerateModal } from './GenerateModal'

const api = vi.hoisted(() => ({ preview: vi.fn(), generate: vi.fn() }))
vi.mock('../api/avisering.api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  previewGenerateNotices: api.preview,
  generateNotices: api.generate,
}))
const result: GenerateNoticesPreview = {
  month: 10,
  year: 2026,
  toCreate: 2,
  skipped: 1,
  dueDates: [{ dueDate: '2026-09-30', count: 2 }],
  existingDueDates: [{ dueDate: '2026-10-15', count: 1 }],
}
function setup(month = 10) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onClose = vi.fn()
  const onSuccess = vi.fn()
  const view = (selected: number) => (
    <QueryClientProvider client={client}>
      <GenerateModal open month={selected} year={2026} onClose={onClose} onSuccess={onSuccess} />
    </QueryClientProvider>
  )
  return { ...render(view(month)), view, onClose, onSuccess }
}
beforeEach(() => {
  vi.clearAllMocks()
  api.preview.mockResolvedValue(result)
})
afterEach(cleanup)

describe('serverns förfallodatum i genereringsdialogen', () => {
  it('visar nya och befintliga aviers olika datum separat', async () => {
    setup()
    await screen.findByText('2026-09-30')
    expect(screen.getByText('2026-10-15')).toBeDefined()
    expect(screen.getByText('2 nya avier att skapa')).toBeDefined()
    expect(screen.queryByText(/25:e/)).toBeNull()
    expect(api.preview).toHaveBeenCalledWith(10, 2026)
  })
  it('hämtfel stoppar bekräftelsen och kan försöka igen', async () => {
    api.preview.mockRejectedValueOnce(new Error('offline'))
    setup()
    await screen.findByRole('alert')
    expect(
      (screen.getByRole('button', { name: 'Generera avier' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Försök igen' }))
    await screen.findByText('2026-09-30')
    expect(
      (screen.getByRole('button', { name: 'Generera avier' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })
  it('periodbyte visar inga gamla datum medan nästa underlag hämtas', async () => {
    const page = setup()
    await screen.findByText('2026-09-30')
    let resolve!: (value: GenerateNoticesPreview) => void
    api.preview.mockReturnValueOnce(
      new Promise<GenerateNoticesPreview>((done) => {
        resolve = done
      }),
    )
    page.rerender(page.view(11))
    await screen.findByRole('status')
    expect(screen.queryByText('2026-09-30')).toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Generera avier' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    resolve({ ...result, month: 11, dueDates: [{ dueDate: '2026-10-30', count: 2 }] })
    await screen.findByText('2026-10-30')
  })
  it('bekräftar visad period och behåller genereringsfel synligt', async () => {
    api.generate
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce({ created: 2 })
    const page = setup()
    await screen.findByText('2026-09-30')
    fireEvent.click(screen.getByRole('button', { name: 'Generera avier' }))
    await screen.findByText('Generering misslyckades. Försök igen.')
    expect(page.onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Generera avier' }))
    await waitFor(() => expect(page.onSuccess).toHaveBeenCalledWith(2))
    expect(api.generate).toHaveBeenCalledWith(10, 2026)
    expect(page.onClose).toHaveBeenCalledOnce()
  })
  it('en period utan nya avier går inte att bekräfta', async () => {
    api.preview.mockResolvedValueOnce({ ...result, toCreate: 0, dueDates: [] })
    setup()
    await screen.findByText('0 nya avier att skapa')
    expect(
      (screen.getByRole('button', { name: 'Generera avier' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })
})
