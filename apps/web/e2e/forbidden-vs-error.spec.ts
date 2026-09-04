/**
 * ETT HAVERI ÄR INTE ETT NEKANDE (#442).
 *
 * Fem ytor använde `isError` som om det betydde 403. Vid ett 500 påstod de "Din
 * roll får inte se …" om ett rent haveri — samma familj av falskt påstående som
 * hela #442 handlar om, och det skickar användaren till fel åtgärd: att be om
 * behörighet hen redan har i stället för att rapportera ett fel.
 *
 * ── VARFÖR BÅDA UTFALLEN TESTAS ─────────────────────────────────────────────
 *
 * Ett test som bara täcker 403 kan inte falla på det som var fel här. Den gamla
 * koden var GRÖN på 403-fallet — det var 500-fallet som ljög. Testerna nedan
 * kräver därför för varje yta att rätt text visas OCH att den andra INTE gör det.
 *
 * ── VARFÖR page.route ───────────────────────────────────────────────────────
 *
 * Första användningen av request-interception i den här sviten. Ett 500 går inte
 * att framkalla i en riktig backend utan att sabotera den, och ett 403 kräver en
 * VIEWER-org (det finns redan i viewer-403-honest-view.spec.ts). Att stubba
 * svaret gör båda utfallen deterministiska och testar exakt det som ändrades:
 * gränssnittets tolkning av statuskoden.
 */
import { test, expect, type Page } from '@playwright/test'
import { registerOrg } from './helpers/seed'

/** Ytorna som drivs från en egen URL. Panelerna i Inställningar delar kod-form. */
const YTOR = [
  {
    namn: 'bankavstämningen',
    path: '/reconciliation',
    endpoint: '**/v1/reconciliation/transactions*',
    nekandeText: 'Du har inte behörighet',
    felText: 'Något gick fel',
  },
  {
    namn: 'inkassoöversikten',
    path: '/collections',
    endpoint: '**/v1/collections/overdue-status*',
    nekandeText: 'Du har inte behörighet',
    felText: 'Något gick fel',
  },
  {
    namn: 'importhistoriken',
    path: '/import',
    endpoint: '**/v1/import/jobs*',
    nekandeText: 'Din roll får inte se importhistoriken',
    felText: 'kunde inte hämtas — det beror inte på din behörighet',
  },
]

async function loggaIn(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByLabel('E-postadress').fill(email)
  await page.locator('input[autocomplete="current-password"]').fill(password)
  await page.getByRole('button', { name: 'Logga in', exact: true }).click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 20_000 })
}

test('403 ger nekandetexten — inte feltexten', async ({ page, request }) => {
  const org = await registerOrg(request)
  await loggaIn(page, org.email, org.password)

  for (const yta of YTOR) {
    await page.route(yta.endpoint, (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Otillräcklig behörighet' },
        }),
      }),
    )
    await page.goto(yta.path)

    await expect(page.getByText(yta.nekandeText).first()).toBeVisible({ timeout: 20_000 })
    // Och INTE feltexten — annars säger vyn två saker samtidigt.
    await expect(page.getByText(yta.felText)).toHaveCount(0)

    await page.unroute(yta.endpoint)
  }
})

test('500 ger feltexten — inte nekandetexten', async ({ page, request }) => {
  const org = await registerOrg(request)
  await loggaIn(page, org.email, org.password)

  for (const yta of YTOR) {
    await page.route(yta.endpoint, (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          error: { code: 'INTERNAL', message: 'Internal server error' },
        }),
      }),
    )
    await page.goto(yta.path)

    await expect(page.getByText(yta.felText).first()).toBeVisible({ timeout: 20_000 })
    // DET HÄR ÄR TESTET SOM FÖRR HADE FALLIT: den gamla koden visade
    // nekandetexten här, om ett fel som inte hade med behörighet att göra.
    await expect(page.getByText(yta.nekandeText)).toHaveCount(0)

    await page.unroute(yta.endpoint)
  }
})
