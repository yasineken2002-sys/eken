import { act, render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
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
  const view = (selected: number, open = true) => (
    <QueryClientProvider client={client}>
      <GenerateModal
        open={open}
        month={selected}
        year={2026}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    </QueryClientProvider>
  )
  return { ...render(view(month)), view, onClose, onSuccess, client }
}
beforeEach(() => {
  vi.clearAllMocks()
  api.preview.mockReset()
  api.generate.mockReset()
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
  it('en period före brytdatum visar serverns skäl, inte bara 0', async () => {
    const skal =
      'Perioden ligger före organisationens brytdatum 2026-10-01 — den är fakturerad i tidigare system och skapas inte i Eveno.'
    api.preview.mockResolvedValueOnce({
      ...result,
      month: 9,
      toCreate: 0,
      dueDates: [],
      existingDueDates: [],
      beforeCutover: skal,
    })
    setup(9)
    await screen.findByText('0 nya avier att skapa')
    expect(screen.getByText(skal)).toBeDefined()
    expect(
      (screen.getByRole('button', { name: 'Generera avier' }) as HTMLButtonElement).disabled,
    ).toBe(true)
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

type GenerateReply = {
  created: number
  skipped: number
  failed: number
  notices: []
  beforeCutover: null
  blockedByOpening: number
  blockedReason?: string | null
}
function reply(overrides: Partial<GenerateReply> = {}): GenerateReply {
  return {
    created: 0,
    skipped: 1,
    failed: 0,
    notices: [],
    beforeCutover: null,
    blockedByOpening: 2,
    ...overrides,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function confirmGeneration() {
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Generera avier' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Generera avier' }))
}
function expectCounts(
  alert: HTMLElement,
  created: number,
  skipped: number,
  blocked: number,
  failed: number,
) {
  for (const text of [
    `Skapade: ${created}`,
    `Överhoppade: ${skipped}`,
    `Blockerade: ${blocked}`,
    `Misslyckade: ${failed}`,
  ])
    expect(within(alert).getByText(text)).toBeDefined()
}
function previewSelectedPeriod() {
  api.preview.mockImplementation(async (month: number, year: number) => ({
    ...result,
    month,
    year,
    dueDates: [{ dueDate: month === 10 ? '2026-09-30' : '2026-10-30', count: 2 }],
  }))
}

describe('genereringsutfall och dialogens livstid', () => {
  it('behåller helt blockerad generering synlig med serverns skäl och exakta antal', async () => {
    const reason = 'Organisationen har ett ofärdigt öppningspaket för aktuellt brytdatum.'
    api.generate.mockResolvedValueOnce(reply({ blockedReason: reason }))
    const page = setup()
    await screen.findByText('2026-09-30')
    await confirmGeneration()
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText(reason)).toBeDefined()
    expectCounts(alert, 0, 1, 2, 0)
    expect(screen.getByRole('dialog', { name: 'Generera hyresavier' })).toBeDefined()
    expect(api.generate).toHaveBeenCalledOnce()
    expect(api.generate).toHaveBeenCalledWith(10, 2026)
    expect(page.onSuccess).not.toHaveBeenCalled()
    expect(page.onClose).not.toHaveBeenCalled()
  })

  it('visar både skapade och blockerade avier utan att stänga ett delvis lyckat försök', async () => {
    const reason = 'Ett öppningspaket hann ändras under genereringen.'
    api.generate.mockResolvedValueOnce(
      reply({ created: 1, blockedByOpening: 1, blockedReason: reason }),
    )
    const page = setup()
    await screen.findByText('2026-09-30')
    await confirmGeneration()
    const alert = await screen.findByRole('alert')
    expectCounts(alert, 1, 1, 1, 0)
    expect(within(alert).getByText(reason)).toBeDefined()
    expect(page.onSuccess).not.toHaveBeenCalled()
    expect(page.onClose).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'utelämnat', fields: {} },
    { name: 'null', fields: { blockedReason: null } },
  ])('ger begripligt öppningspaketsskäl när serverns skäl är $name', async ({ fields }) => {
    api.generate.mockResolvedValueOnce(reply(fields))
    const page = setup()
    await screen.findByText('2026-09-30')
    await confirmGeneration()
    const alert = await screen.findByRole('alert')
    expectCounts(alert, 0, 1, 2, 0)
    expect(within(alert).getByText(/ofärdigt öppningspaket/i)).toBeDefined()
    expect(alert.textContent).not.toMatch(/undefined|null/)
    expect(page.onSuccess).not.toHaveBeenCalled()
    expect(page.onClose).not.toHaveBeenCalled()
  })

  it('visar misslyckat antal även när API-anropet lyckas och några avier skapades', async () => {
    api.generate.mockResolvedValueOnce(reply({ created: 1, failed: 1, blockedByOpening: 0 }))
    const page = setup()
    await screen.findByText('2026-09-30')
    await confirmGeneration()
    const alert = await screen.findByRole('alert')
    expectCounts(alert, 1, 1, 0, 1)
    expect(within(alert).getByText(/generering.*misslyck|kunde inte.*skapas/i)).toBeDefined()
    expect(page.onSuccess).not.toHaveBeenCalled()
    expect(page.onClose).not.toHaveBeenCalled()
  })

  it('rensar gammalt besked vid periodbyte och när samma period stängs och öppnas igen', async () => {
    previewSelectedPeriod()
    const octoberReason = 'Oktobers öppningspaket behöver hanteras.'
    const novemberReason = 'Novembers öppningspaket behöver hanteras.'
    api.generate.mockResolvedValueOnce(reply({ blockedReason: octoberReason }))
    const page = setup()
    await screen.findByText('2026-09-30')
    await confirmGeneration()
    await screen.findByText(octoberReason)
    page.rerender(page.view(11))
    await screen.findByText('2026-10-30')
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.queryByText(octoberReason)).toBeNull()
    })
    api.generate.mockResolvedValueOnce(reply({ blockedReason: novemberReason }))
    await confirmGeneration()
    await screen.findByText(novemberReason)
    expect(api.generate).toHaveBeenNthCalledWith(2, 11, 2026)
    fireEvent.click(screen.getByRole('button', { name: 'Stäng' }))
    expect(page.onClose).toHaveBeenCalledOnce()
    page.rerender(page.view(11, false))
    expect(screen.queryByRole('dialog')).toBeNull()
    page.rerender(page.view(11))
    await screen.findByText('2026-10-30')
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.queryByText(novemberReason)).toBeNull()
    })
    expect(page.onSuccess).not.toHaveBeenCalled()
    expect(page.onClose).toHaveBeenCalledOnce()
    expect(api.generate).toHaveBeenCalledTimes(2)
  })

  it.each(['periodbyte', 'stängning och återöppning'] as const)(
    'ett sent lyckat svar efter %s får inte stänga den nya dialogen eller ge dess successbesked',
    async (boundary) => {
      previewSelectedPeriod()
      const old = deferred<GenerateReply>()
      api.generate.mockReturnValueOnce(old.promise)
      const page = setup()
      try {
        await screen.findByText('2026-09-30')
        await confirmGeneration()
        await waitFor(() => {
          expect(api.generate).toHaveBeenCalledOnce()
          expect(api.generate).toHaveBeenCalledWith(10, 2026)
          expect(page.client.isMutating()).toBe(1)
        })
        const currentMonth = boundary === 'periodbyte' ? 11 : 10
        if (boundary === 'stängning och återöppning') {
          // Parent-driven close is possible while pending even if this dialog's
          // own close control is disabled. The same props object stays mounted.
          page.rerender(page.view(10, false))
          expect(screen.queryByRole('dialog')).toBeNull()
        }
        page.rerender(page.view(currentMonth))
        await screen.findByText(currentMonth === 11 ? '2026-10-30' : '2026-09-30')
        expect(page.client.isMutating()).toBe(1)
        await act(async () => {
          old.resolve(reply({ created: 2, blockedByOpening: 0 }))
          await old.promise
          await waitFor(() => expect(page.client.isMutating()).toBe(0))
        })
        await waitFor(() =>
          expect(
            (screen.getByRole('button', { name: 'Generera avier' }) as HTMLButtonElement).disabled,
          ).toBe(false),
        )
        expect(screen.getByRole('dialog', { name: 'Generera hyresavier' })).toBeDefined()
        expect(screen.queryByRole('alert')).toBeNull()
        expect(page.onSuccess).not.toHaveBeenCalled()
        expect(page.onClose).not.toHaveBeenCalled()
        // The new dialog can still make its own successful, explicitly requested call.
        api.generate.mockResolvedValueOnce(reply({ created: 1, blockedByOpening: 0 }))
        await confirmGeneration()
        await waitFor(() => {
          expect(page.onSuccess).toHaveBeenCalledOnce()
          expect(page.onSuccess).toHaveBeenCalledWith(1)
        })
        expect(page.onClose).toHaveBeenCalledOnce()
        expect(api.generate).toHaveBeenNthCalledWith(2, currentMonth, 2026)
      } finally {
        await act(async () => {
          old.resolve(reply({ created: 2, blockedByOpening: 0 }))
          await old.promise
          await waitFor(() => expect(page.client.isMutating()).toBe(0))
        })
      }
    },
  )
})
