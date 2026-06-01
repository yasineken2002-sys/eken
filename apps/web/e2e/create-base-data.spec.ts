import { test, expect, type Page } from '@playwright/test'
import { registerOrg, type RegisteredOrg } from './helpers/seed'

/**
 * Kärnflödet en hyresvärd gör allra först — all grunddata skapas via UI:t,
 * verifierat genom hela kedjan (webbläsare → API → databas):
 *
 *   logga in → skapa fastighet → skapa enhet → skapa hyresgäst + kontrakt
 *   → verifiera att kontraktet syns som AKTIVT
 *
 * Org:en registreras tom via API i beforeAll (samma isolerade-org-mönster som
 * avi-flödet); allt annat byggs upp genom att klicka i appen.
 *
 * Not om datamodellen: i Eveno kan en hyresgäst inte existera utan ett kontrakt
 * mot en enhet — därför skapas hyresgäst + kontrakt i ETT formulär ("Nytt
 * kontrakt"). "🚀 Skapa & aktivera direkt" gör övergången DRAFT → ACTIVE
 * synkront (välkomstmejl/PDF köas i bakgrunden och påverkar inte statusen),
 * vilket gör "syns som aktivt" deterministiskt utan att vänta på någon worker.
 */

const PROPERTY_NAME = 'E2E Storgatan 1'
const UNIT_NAME = 'Lägenhet 1A'
const UNIT_NUMBER = '1001'
const TENANT_FIRST = 'Test'
const TENANT_LAST = 'Hyresgäst'

let org: RegisteredOrg

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext()
  org = await registerOrg(request)
  await request.dispose()
})

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('E-postadress').fill(org.email)
  await page.locator('input[autocomplete="current-password"]').fill(org.password)
  await page.getByRole('button', { name: 'Logga in' }).click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 })
}

test('hyresvärd: skapa fastighet → enhet → hyresgäst → kontrakt → syns aktivt', async ({
  page,
}) => {
  await login(page)

  // ── 1. Skapa fastighet ───────────────────────────────────────────────────
  await page.goto('/properties')
  await page.getByRole('button', { name: 'Ny fastighet' }).first().click()
  await expect(page.getByRole('heading', { name: 'Ny fastighet' })).toBeVisible()
  await page.getByLabel('Fastighetsnamn').fill(PROPERTY_NAME)
  await page.getByLabel('Fastighetsbeteckning').fill('Stockholm E2E 1:1')
  await page.getByLabel('Typ').selectOption('RESIDENTIAL')
  await page.getByLabel('Gatuadress').fill('Storgatan 1')
  await page.getByLabel('Postnummer').fill('111 22')
  await page.getByLabel('Stad').fill('Stockholm')
  await page.getByLabel('Total yta (m²)').fill('500')
  // Submit-knappen scopas till modalens <form> — texten delas med tomt-läge-CTA.
  await page.locator('form').getByRole('button', { name: 'Skapa fastighet' }).click()

  // Modalen stänger och fastigheten dyker upp i listan.
  await expect(page.getByRole('heading', { name: 'Ny fastighet' })).toBeHidden()
  await expect(page.getByText(PROPERTY_NAME).first()).toBeVisible({ timeout: 15_000 })

  // ── 2. Skapa enhet ──────────────────────────────────────────────────────────
  await page.goto('/units')
  await page.getByRole('button', { name: 'Nytt objekt' }).first().click()
  await expect(page.getByRole('heading', { name: 'Nytt objekt' })).toBeVisible()
  await page.getByLabel('Fastighet').selectOption({ label: PROPERTY_NAME })
  await page.getByLabel('Enhetsnamn').fill(UNIT_NAME)
  await page.getByLabel('Enhetsnummer').fill(UNIT_NUMBER)
  await page.getByLabel('Typ').selectOption('APARTMENT')
  await page.getByLabel('Status').selectOption('VACANT')
  await page.getByLabel('Area (m²)').fill('65')
  await page.getByLabel('Månadshyra (kr)').fill('10000')
  await page.locator('form').getByRole('button', { name: 'Skapa objekt' }).click()

  await expect(page.getByRole('heading', { name: 'Nytt objekt' })).toBeHidden()
  await expect(page.getByText(UNIT_NAME).first()).toBeVisible({ timeout: 15_000 })

  // ── 3. Skapa hyresgäst + kontrakt (och aktivera direkt) ──────────────────────
  await page.goto('/leases')
  await page.getByRole('button', { name: 'Nytt kontrakt' }).first().click()
  await expect(page.getByRole('heading', { name: 'Nytt hyresavtal' })).toBeVisible()

  // LeaseForm använder råa <select> (ej label-kopplade) → scopa till formuläret.
  // Ordning: [0] Fastighet, [1] Enhet, [2] Indexklausul.
  const form = page.locator('form')
  await form.locator('select').nth(0).selectOption({ label: PROPERTY_NAME })

  // Enhets-select fylls async (useUnits) efter att fastighet valts — vänta in
  // optionen innan vi väljer den.
  const unitSelect = form.locator('select').nth(1)
  await expect(unitSelect.locator('option', { hasText: UNIT_NAME })).toHaveCount(1, {
    timeout: 15_000,
  })
  await unitSelect.selectOption({ label: `${UNIT_NAME} (${UNIT_NUMBER})` })

  // Ny hyresgäst (Privatperson) är default — fyll namn + e-post. Månadshyran
  // förifylls från enheten, startdatum defaultar till idag.
  await page.getByLabel('Förnamn').fill(TENANT_FIRST)
  await page.getByLabel('Efternamn').fill(TENANT_LAST)
  await page.getByLabel('E-post').fill(`e2e.tenant+${Date.now()}@eveno.test`)

  await page.getByRole('button', { name: /Skapa & aktivera direkt/ }).click()

  // ── 4. Verifiera att kontraktet syns som AKTIVT ──────────────────────────────
  await expect(page.getByRole('heading', { name: 'Nytt hyresavtal' })).toBeHidden({
    timeout: 15_000,
  })
  const row = page.getByRole('row').filter({ hasText: `${TENANT_FIRST} ${TENANT_LAST}` })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row.getByText('Aktivt', { exact: true })).toBeVisible()
})
