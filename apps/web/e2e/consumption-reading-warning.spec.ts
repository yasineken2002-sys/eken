import { test, expect } from '@playwright/test'

/**
 * IMD Etapp 1, PR 1.4 — browser-bevis för den mjuka rimlighetsvarningen.
 *
 * Bevisar att amber-rutan FAKTISKT renderas och syns när en hög avläsning matas
 * in (> 3× föregående periods förbrukning), OCH att spara-knappen förblir aktiv
 * (varningen blockerar aldrig). Den hårda spärren ligger kvar i backend och
 * berörs inte här.
 *
 * Seedar förutsättningarna via det riktiga API:t (färsk org per körning):
 *   org → fastighet → enhet → elmätare → två baslinje-avläsningar (1000, 1100)
 * så att föregående periods förbrukning = 100. En ny avläsning på 1700 ger
 * delta 600 = 6× → varningen ska trigga.
 */

const API = 'http://localhost:3000/v1'

test('mjuk rimlighetsvarning: amber-rutan syns och blockerar inte', async ({ page, request }) => {
  const stamp = Date.now()
  const email = `e2e.imd+${stamp}@eveno.test`
  const password = 'TestE2e123!'

  // ── Seed via API ───────────────────────────────────────────────────────────
  const reg = await request.post(`${API}/auth/register`, {
    data: {
      email,
      password,
      firstName: 'E2E',
      lastName: 'IMD',
      organizationName: `E2E IMD ${stamp}`,
      acceptTerms: true,
    },
  })
  expect(reg.ok()).toBeTruthy()

  const login = await request.post(`${API}/auth/login`, { data: { email, password } })
  const token = ((await login.json()) as { data: { accessToken: string } }).data.accessToken
  const headers = { Authorization: `Bearer ${token}` }

  async function post<T>(path: string, data: unknown): Promise<T> {
    const r = await request.post(`${API}${path}`, { headers, data })
    const b = (await r.json()) as { success?: boolean; data?: T; error?: unknown }
    if (!r.ok() || b.success === false) throw new Error(`${path}: ${JSON.stringify(b)}`)
    return b.data as T
  }

  const property = await post<{ id: string }>('/properties', {
    name: 'IMD-bevisfastighet',
    propertyDesignation: 'Eken 4:4',
    type: 'RESIDENTIAL',
    address: { street: 'Bevisgatan 4', city: 'Stockholm', postalCode: '11122', country: 'Sverige' },
    totalArea: 300,
  })
  const unit = await post<{ id: string }>('/units', {
    propertyId: property.id,
    name: 'Lgh 4001',
    unitNumber: '4001',
    type: 'APARTMENT',
    area: 60,
    monthlyRent: 11000,
  })
  const meter = await post<{ id: string }>('/consumption/meters', {
    unitId: unit.id,
    type: 'ELECTRICITY',
    unitOfMeasure: 'kWh',
  })
  // Två baslinje-avläsningar → föregående periods förbrukning = 1100 − 1000 = 100.
  await post('/consumption/readings', {
    meterId: meter.id,
    value: 1000,
    readingType: 'CUMULATIVE',
    source: 'MANUAL',
    readingDate: '2026-01-31',
    periodStart: '2026-01-01',
    periodEnd: '2026-01-31',
  })
  await post('/consumption/readings', {
    meterId: meter.id,
    value: 1100,
    readingType: 'CUMULATIVE',
    source: 'MANUAL',
    readingDate: '2026-02-28',
    periodStart: '2026-02-01',
    periodEnd: '2026-02-28',
  })

  // ── Logga in i UI:t ────────────────────────────────────────────────────────
  await page.goto('/login')
  await page.getByLabel('E-postadress').fill(email)
  await page.locator('input[autocomplete="current-password"]').fill(password)
  await page.getByRole('button', { name: 'Logga in' }).click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 })

  // ── Förbrukning → Avläsningar → Ny avläsning ───────────────────────────────
  await page.goto('/consumption')
  await expect(page.getByRole('heading', { name: 'Förbrukning' })).toBeVisible()
  await page.getByRole('button', { name: 'Avläsningar' }).click()
  await page.getByRole('button', { name: 'Ny avläsning' }).click()
  await expect(page.getByRole('heading', { name: 'Ny avläsning' })).toBeVisible()

  const modal = page.locator('div.flex.w-full.flex-col', { hasText: 'Ny avläsning' })
  await modal.getByLabel('Enhet').selectOption(unit.id)
  await modal.getByLabel('Mätare').selectOption(meter.id)
  await modal.getByLabel('Period fr.o.m.').fill('2026-03-01')
  await modal.getByLabel('Period t.o.m.').fill('2026-03-31')
  // Hög avläsning: 1700 → delta 600 mot föregående delta 100 = 6× (> 3×).
  await modal.getByLabel(/Mätarställning/).fill('1700')

  // ── Bevis 1: amber-rutan renderas och syns ─────────────────────────────────
  const note = page.getByRole('note')
  await expect(note).toBeVisible()
  await expect(note).toContainText('Ovanligt hög förbrukning')

  // ── Bevis 2: spara-knappen förblir AKTIV (varningen blockerar inte) ─────────
  const submit = modal.getByRole('button', { name: 'Registrera avläsning' })
  await expect(submit).toBeEnabled()

  // Visuellt bevis: scrolla in amber-rutan + spara-knappen och fota dem ihop så
  // att bilden visar att varningen syns OCH att knappen är aktiv samtidigt.
  await submit.scrollIntoViewIfNeeded()
  await note.screenshot({ path: 'test-results/imd-amber-warning-box.png' })
  await modal.screenshot({ path: 'test-results/imd-amber-warning.png' })

  // ── Kontroll: en RIMLIG avläsning ska INTE visa varningen ──────────────────
  // 1150 → delta 50 < 100 → ingen varning, knappen fortsatt aktiv.
  await modal.getByLabel(/Mätarställning/).fill('1150')
  await expect(page.getByRole('note')).toHaveCount(0)
  await expect(submit).toBeEnabled()
})
