import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'

/**
 * IMD Etapp 1, PR 1.5 — browser-bevis för förbrukningsposter (charges).
 *
 * Detta är PR:n som BOKFÖR — beviset visar renderat att handläggaren ser att en
 * bekräftelse bokför, och att en separatfaktura-post inte går att agera på:
 *   1. DRAFT-charge: "Bekräfta och bokför"-knappen + amber-bokföringsnoten syns.
 *   2. SEPARATE_INVOICE-charge: badge + info-text, INGEN faktura-knapp.
 *   3. Belopp visas (från verifikatet) utan frontend-omräkning.
 *
 * Seedar en debiterbar kedja via det riktiga API:t (färsk org per körning):
 *   org → fastighet → enhet → hyresgäst+lease (aktiveras) → elmätare → tariff →
 *   avläsning (PERIOD_VOLUME) → DRAFT-charge. En andra lease får leveranssätt
 *   SEPARATE_INVOICE (via DB, som motorns config-väg) → SEPARATE_INVOICE-charge.
 */

const API = 'http://localhost:3000/v1'

function sql(query: string): void {
  execFileSync('psql', ['-h', 'localhost', '-U', 'eken', '-d', 'eken_dev', '-tAc', query], {
    env: { ...process.env, PGPASSWORD: 'eken' },
  })
}

test('charges: bokföringsnot på DRAFT + SEPARATE_INVOICE utan faktura-knapp + belopp', async ({
  page,
  request,
}) => {
  const stamp = Date.now()
  const email = `e2e.charge+${stamp}@eveno.test`
  const password = 'TestE2e123!'

  // ── Seed via API ───────────────────────────────────────────────────────────
  const reg = await request.post(`${API}/auth/register`, {
    data: {
      email,
      password,
      firstName: 'E2E',
      lastName: 'Charge',
      organizationName: `E2E Charge ${stamp}`,
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
    name: 'Chargebevisfastighet',
    propertyDesignation: 'Eken 6:6',
    type: 'RESIDENTIAL',
    address: { street: 'Bevisgatan 6', city: 'Stockholm', postalCode: '11122', country: 'Sverige' },
    totalArea: 300,
  })
  // Två enheter → två leases (en RENT_NOTICE_LINE, en SEPARATE_INVOICE).
  async function makeUnitLease(unitNumber: string): Promise<{ unitId: string; leaseId: string }> {
    const unit = await post<{ id: string }>('/units', {
      propertyId: property.id,
      name: `Lgh ${unitNumber}`,
      unitNumber,
      type: 'APARTMENT',
      area: 60,
      monthlyRent: 11000,
      status: 'VACANT',
    })
    await post('/tenants', {
      type: 'INDIVIDUAL',
      firstName: 'Test',
      lastName: `Hyresgäst${unitNumber}`,
      email: `t-${unitNumber}-${stamp}@test.se`,
      lease: { unitId: unit.id, startDate: '2026-01-01', monthlyRent: 11000 },
    })
    return { unitId: unit.id, leaseId: '' }
  }

  const u1 = await makeUnitLease('6001')
  const u2 = await makeUnitLease('6002')
  // Aktivera båda kontrakten (DRAFT → ACTIVE), som e2e-seed-mönstret.
  sql(`UPDATE "Lease" SET status='ACTIVE' WHERE "unitId" IN ('${u1.unitId}','${u2.unitId}');`)
  // Lease 2 → leveranssätt SEPARATE_INVOICE (motorns config-väg).
  sql(
    `UPDATE "Lease" SET "consumptionBillingMode"='SEPARATE_INVOICE' WHERE "unitId"='${u2.unitId}';`,
  )

  // Tariff (org-bred) + en elmätare per enhet + en avläsning per mätare.
  await post('/consumption/tariffs', {
    scope: 'ORGANIZATION',
    meterType: 'ELECTRICITY',
    pricePerUnit: 2.5,
    validFrom: '2026-01-01',
  })
  for (const u of [u1, u2]) {
    const meter = await post<{ id: string }>('/consumption/meters', {
      unitId: u.unitId,
      type: 'ELECTRICITY',
      unitOfMeasure: 'kWh',
    })
    await post('/consumption/readings', {
      meterId: meter.id,
      value: 100,
      readingType: 'PERIOD_VOLUME',
      source: 'MANUAL',
      readingDate: '2026-02-28',
      periodStart: '2026-02-01',
      periodEnd: '2026-02-28',
    })
  }

  // ── Logga in i UI:t ────────────────────────────────────────────────────────
  await page.goto('/login')
  await page.getByLabel('E-postadress').fill(email)
  await page.locator('input[autocomplete="current-password"]').fill(password)
  await page.getByRole('button', { name: 'Logga in' }).click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 })

  // ── Förbrukning → Förbrukningsposter ───────────────────────────────────────
  await page.goto('/consumption')
  await expect(page.getByRole('heading', { name: 'Förbrukning' })).toBeVisible()
  await page.getByRole('button', { name: 'Förbrukningsposter' }).click()

  // Två DRAFT-charges i listan (en per lease).
  const rows = page.getByRole('row')
  await expect(rows.filter({ hasText: 'Utkast' }).first()).toBeVisible()

  const modal = page.locator('div.flex.w-full.flex-col', { hasText: 'Belopp (från verifikatet)' })

  // ── Bevis 1: DRAFT (RENT_NOTICE_LINE) → bokföringsnot + "Bekräfta och bokför" ─
  await rows.filter({ hasText: 'Rad på hyresavi' }).first().click()
  await expect(modal.getByText('Att bekräfta innebär att bokföra')).toBeVisible()
  await expect(modal.getByText(/periodiserat verifikat skapas.*kundfordran 1510/i)).toBeVisible()
  const confirmBtn = modal.getByRole('button', { name: 'Bekräfta och bokför' })
  await expect(confirmBtn).toBeVisible()
  await expect(confirmBtn).toBeEnabled()

  // ── Bevis 3: belopp visas (från verifikatet), 100 kWh × 2,50 = 250 kr ───────
  await expect(modal.getByText('Belopp (från verifikatet)')).toBeVisible()
  await expect(modal.getByText('Att betala')).toBeVisible()
  await expect(modal.getByText(/250/).first()).toBeVisible()

  await modal.screenshot({ path: 'test-results/imd-charge-draft-confirm.png' })

  // Stäng modalen (Escape) och öppna SEPARATE_INVOICE-posten.
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)

  // ── Bevis 2: SEPARATE_INVOICE → badge + info-text, INGEN faktura-knapp ──────
  await rows.filter({ hasText: 'Separat faktura' }).first().click()
  await expect(modal.getByText('Separat faktura').first()).toBeVisible()
  await expect(modal.getByText(/Fakturan genereras i ett kommande steg/i)).toBeVisible()
  // Det får inte finnas någon faktura-/skapa-knapp i modalen.
  await expect(modal.getByRole('button', { name: /faktura/i })).toHaveCount(0)
  await expect(modal.getByRole('button', { name: /generera|skapa faktura/i })).toHaveCount(0)
  // DRAFT → "Bekräfta och bokför" finns (bokföring är tillåtet), men ingen fakturering.
  await expect(modal.getByRole('button', { name: 'Bekräfta och bokför' })).toBeVisible()

  await modal.screenshot({ path: 'test-results/imd-charge-separate-invoice.png' })
})
