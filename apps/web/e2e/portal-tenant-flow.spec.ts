import { test, expect, type Page } from '@playwright/test'
import { seedPortalTenant, type PortalTenant } from './helpers/seed'

/**
 * Hyresgäst-portalen (apps/portal, :5174) — där riktiga hyresgäster befinner sig.
 * Verifierar hela kedjan (webbläsare → API → databas):
 *
 *   logga in → se sin hyresavi → göra en kärnhandling (felanmälan) → logga ut
 *
 * Portalen autentiserar annorlunda än admin (token-aktivering, inte lösenord
 * vid skapande). Seedningen löser det deterministiskt — se helpers/seed.ts
 * (seedPortalTenant): den aktiverar portal-kontot och sår en BETALD avi som
 * därmed syns i portalen.
 *
 * Verifierar särskilt de nyligen fixade sakerna:
 *   - logout-knappen ("Logga ut") loggar faktiskt ut → tillbaka till /login
 *   - error-card visar INTE "under uppbyggnad" vid normal drift (PR #47/#48)
 *
 * Portalen körs på egen origin (:5174) — vi navigerar dit med absolut URL;
 * efterföljande klick i appen är client-side och stannar kvar på portalen.
 */

const PORTAL = 'http://localhost:5174'

let tenant: PortalTenant

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext()
  tenant = await seedPortalTenant(request)
  await request.dispose()
})

// Felanmälan om "under uppbyggnad" inte ska synas någonstans vid normal drift.
async function expectNoUnderConstruction(page: Page) {
  await expect(page.getByText(/under uppbyggnad/i)).toHaveCount(0)
}

test('hyresgäst-portal: logga in → se avi → felanmälan → logga ut', async ({ page }) => {
  // ── 1. Logga in ──────────────────────────────────────────────────────────
  await page.goto(`${PORTAL}/login`)
  await page.locator('#email').fill(tenant.email)
  await page.locator('#password').fill(tenant.password)
  await page.getByRole('button', { name: 'Logga in' }).click()

  // Inloggad → lämnar /login, layouten (med Avier-fliken) renderas.
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 })
  await expect(page.getByRole('link', { name: 'Avier' })).toBeVisible({ timeout: 15_000 })
  await expectNoUnderConstruction(page)

  // ── 2. Se sin hyresavi ───────────────────────────────────────────────────────
  await page.getByRole('link', { name: 'Avier' }).click()
  await expect(page.getByRole('heading', { name: 'Avier & fakturor' })).toBeVisible()
  // Den seedade (betalda) avin syns — OCR-etikett finns bara på ett avi-kort,
  // och tomt-läget ("Inga avier att visa") ska INTE synas.
  await expect(page.getByText('OCR-nummer').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Inga avier att visa')).toHaveCount(0)
  await expectNoUnderConstruction(page)

  // ── 3. Kärnhandling: skicka en felanmälan ────────────────────────────────────
  await page.getByRole('link', { name: 'Felanmälan' }).click()
  await expect(page.getByRole('heading', { name: 'Felanmälningar' })).toBeVisible()
  await expectNoUnderConstruction(page)

  await page.getByRole('button', { name: 'Ny felanmälan', exact: true }).click()
  const ticketTitle = `E2E Droppande kran ${Date.now()}`
  await page.locator('#mt-title').fill(ticketTitle)
  await page.locator('#mt-desc').fill('Kranen i köket droppar konstant och behöver lagas.')
  await page.getByRole('button', { name: 'Skicka felanmälan' }).click()

  // Ärendet dyker upp i listan (sheet:en stänger, listan refetchas).
  await expect(page.getByText(ticketTitle)).toBeVisible({ timeout: 15_000 })

  // ── 4. Logga ut (nyligen fixad knapp) ────────────────────────────────────────
  await page.getByRole('button', { name: 'Logga ut' }).click()
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 })
  await expect(page.getByRole('button', { name: 'Logga in' })).toBeVisible()
})
