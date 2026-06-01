import { test, expect } from '@playwright/test'
import { seedActiveLease, type SeededOrg } from './helpers/seed'

/**
 * Kritiskt hyresvärds-flöde, hela kedjan (webbläsare → API → databas):
 *
 *   logga in → generera hyresavi → markera betald → verifiera "Betald" i UI
 *
 * Förutsättningarna (org, fastighet, enhet, aktivt kontrakt) sås via API i
 * beforeAll så att UI-testet fokuserar på själva avi-flödet. Se helpers/seed.ts.
 *
 * Perioden ligger två månader bak → avin är förfallen (FÖRSENAD) direkt, vilket
 * gör att "Markera betald" går att klicka utan den asynkrona skicka-vägen.
 */

let org: SeededOrg

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext()
  org = await seedActiveLease(request)
  await request.dispose()
})

test('hyresvärd: logga in → skapa avi → markera betald → syns som betald', async ({ page }) => {
  // ── 1. Logga in ──────────────────────────────────────────────────────────
  await page.goto('/login')
  await page.getByLabel('E-postadress').fill(org.email)
  await page.locator('input[autocomplete="current-password"]').fill(org.password)
  await page.getByRole('button', { name: 'Logga in' }).click()

  // Inloggning lyckades → vi lämnar /login. Gå till avisering.
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 })
  await page.goto('/avisering')
  await expect(page.getByRole('heading', { name: 'Hyresavier' })).toBeVisible()

  // Välj samma period som seed-kontraktet (två månader bak). Två select:er —
  // månad (value 1-12) och år (value = årtal).
  await page.locator('select').first().selectOption(String(org.periodMonth))
  await page.locator('select').nth(1).selectOption(String(org.periodYear))

  // ── 2. Generera avi ────────────────────────────────────────────────────────
  await page.getByRole('button', { name: 'Generera avier' }).first().click()
  await expect(page.getByRole('heading', { name: 'Generera hyresavier' })).toBeVisible()
  // Bekräfta-knappen i modalen delar text med header-knappen → modalen
  // renderas sist i DOM, så .last() träffar modalens knapp.
  await page.getByRole('button', { name: 'Generera avier' }).last().click()

  // Avin dyker upp (förfallen period → FÖRSENAD) — query invalideras automatiskt.
  const row = page.getByRole('row').filter({ hasText: 'Test Hyresgäst' })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row.getByText('Försenad', { exact: true })).toBeVisible()

  // ── 3. Markera betald ────────────────────────────────────────────────────────
  await row.getByTitle('Markera betald').click()
  await expect(page.getByRole('heading', { name: 'Markera som betald' })).toBeVisible()
  // Enda number-fältet på sidan finns i denna modal.
  await page.locator('input[type="number"]').fill(String(org.monthlyRent))
  await page.getByRole('button', { name: 'Bekräfta betalning' }).click()

  // ── 4. Verifiera "Betald" (PAID) i UI ────────────────────────────────────────
  const paidRow = page.getByRole('row').filter({ hasText: 'Test Hyresgäst' })
  await expect(paidRow.getByText('Betald', { exact: true })).toBeVisible({ timeout: 15_000 })

  // Och att den syns under fliken "Betalda".
  await page.getByRole('button', { name: 'Betalda', exact: true }).click()
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: 'Test Hyresgäst' })
      .getByText('Betald', { exact: true }),
  ).toBeVisible()
})
