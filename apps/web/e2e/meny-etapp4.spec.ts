import { test, expect } from '@playwright/test'
import type { APIRequestContext, Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { API, registerOrg, sqlValue } from './helpers/seed'

/**
 * MENY-ETAPP 4 (201) — menyn följer organisationens BESTÄNDIGA huvudboksval.
 *
 * Bara en organisation som verifierat har Fortnox som huvudbok får den nya
 * posten "Överföring och avstämning" i Ekonomi; Bokföring finns då kvar som
 * "Bokföringsarkiv". En EVENO-organisation ser exakt dagens meny. Provet mäter
 * det användaren ser i en verklig webbläsare, på desktop och 390 px, och att
 * servern fortfarande nekar fria verifikat (409 EXTERN_HUVUDBOK) — menyn är
 * aldrig spärren.
 *
 * ── Den syntetiska FORTNOX-fixturen ──────────────────────────────────────────
 * Huvudboksvalet görs i produkten mot en aktiv kundaktivering, som kräver en
 * riktig Fortnox-anslutning. Den finns inte i CI och ska inte finnas. Fixturen
 * skriver därför en syntetisk aktiveringsrad och organisationens bindning direkt
 * i test-DB:n (samma psql-väg som övriga e2e-hjälpare), med hela bindningen som
 * Organization_ledgerOwner_bindning_check kräver. Ingen Fortnox-kontakt sker:
 * provet klickar aldrig på anslut eller återläs.
 */

const IDAG = [
  ['Fakturor', '/invoices'],
  ['Hyresavier', '/avisering'],
  ['Efterdebitering', '/backfill'],
  ['Förbrukning', '/consumption'],
  ['Depositioner', '/deposits'],
  ['Hyreshöjningar', '/rent-increases'],
  ['Bokföring', '/accounting'],
  ['Rapporter', '/reports'],
  ['Bankavstämning', '/reconciliation'],
  ['Inkasso', '/collections'],
]
const FORTNOX = [
  ['Fakturor', '/invoices'],
  ['Hyresavier', '/avisering'],
  ['Efterdebitering', '/backfill'],
  ['Förbrukning', '/consumption'],
  ['Depositioner', '/deposits'],
  ['Hyreshöjningar', '/rent-increases'],
  ['Överföring och avstämning', '/fortnox/overforing'],
  ['Bokföringsarkiv', '/accounting'],
  ['Rapporter', '/reports'],
  ['Bankavstämning', '/reconciliation'],
  ['Inkasso', '/collections'],
]

const MOBIL = { width: 390, height: 844 }

async function apiLogin(request: APIRequestContext, email: string, password: string) {
  const res = await request.post(`${API}/auth/login`, { data: { email, password } })
  expect(res.ok()).toBe(true)
  const body = (await res.json()) as { data: { accessToken: string } }
  return body.data.accessToken
}

async function uiLogin(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByLabel('E-postadress').fill(email)
  await page.locator('input[autocomplete="current-password"]').fill(password)
  await page.getByRole('button', { name: 'Logga in', exact: true }).click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 })
}

/** Syntetisk FORTNOX-bindning för organisationen som `email` äger (se kommentaren ovan). */
function sattFortnoxSomHuvudbok(email: string): { orgId: string } {
  const rad = sqlValue(
    `SELECT "organizationId" || '|' || id FROM "User" WHERE email = '${email}'`,
  ).split('|')
  const [orgId, userId] = [rad[0]!, rad[1]!]
  const aktivering = randomUUID()
  sqlValue(`
    INSERT INTO "FortnoxCustomerActivation" (
      id, "organizationId", status, "connectionId", "connectionGeneration",
      "fortnoxDatabaseNumber", "fortnoxOrgNumber", "financialYearId", "financialYearFrom",
      "financialYearTo", "voucherSeries", "financialYearAccountingMethod", "mappingSha256",
      "openingPackageId", "fortnoxReadRunId", "consequencesText", "consequencesSha256",
      "approvedById", "updatedAt")
    VALUES ('${aktivering}', '${orgId}', 'ACTIVE', 'e2e-syntetisk-anslutning', 1,
      990001, '559999-0001', 1, '2026-01-01', '2026-12-31', 'A', 'ACCRUAL',
      repeat('0', 64), 'e2e-syntetiskt-paket', 'e2e-syntetisk-lasning',
      'Syntetisk e2e-aktivering', repeat('0', 64), '${userId}', now());
    UPDATE "Organization" SET "ledgerOwner" = 'FORTNOX',
      "ledgerOwnerActivationId" = '${aktivering}', "ledgerOwnerFortnoxDatabaseNumber" = 990001,
      "ledgerOwnerFortnoxOrgNumber" = '559999-0001', "ledgerOwnerSetAt" = now(),
      "ledgerOwnerSetById" = '${userId}'
    WHERE id = '${orgId}';`)
  expect(sqlValue(`SELECT "ledgerOwner" FROM "Organization" WHERE id = '${orgId}'`)).toBe('FORTNOX')
  return { orgId }
}

async function ekonomi(page: Page): Promise<string[][]> {
  const grupp = page.getByTestId('nav-grupp-ekonomi')
  await expect(grupp).toBeVisible()
  return grupp
    .getByRole('link')
    .evaluateAll((as) => as.map((a) => [a.textContent?.trim() ?? '', a.getAttribute('href') ?? '']))
}

async function oppnaMobilmeny(page: Page) {
  await page.getByRole('button', { name: 'Öppna meny' }).click()
  await expect(page.getByTestId('nav-grupp-ekonomi')).toBeInViewport()
}

test.describe('meny-etapp 4: Ekonomi följer det beständiga huvudboksvalet', () => {
  test('M1 desktop: EVENO ser exakt dagens Ekonomi-meny', async ({ page, request }) => {
    const { email, password } = await registerOrg(request)
    await uiLogin(page, email, password)
    await expect.poll(() => ekonomi(page)).toEqual(IDAG)
    await expect(page.getByRole('link', { name: 'Överföring och avstämning' })).toHaveCount(0)
  })

  test('M1 390px: EVENO ser exakt dagens Ekonomi-meny i mobilmenyn', async ({ page, request }) => {
    await page.setViewportSize(MOBIL)
    const { email, password } = await registerOrg(request)
    await uiLogin(page, email, password)
    await oppnaMobilmeny(page)
    await expect.poll(() => ekonomi(page)).toEqual(IDAG)
  })

  test('M2 desktop: FORTNOX får överföringsvyn i stället för Bokföring', async ({
    page,
    request,
  }) => {
    const { email, password } = await registerOrg(request)
    sattFortnoxSomHuvudbok(email)
    await uiLogin(page, email, password)
    await expect.poll(() => ekonomi(page)).toEqual(FORTNOX)

    await page.getByTestId('nav-grupp-ekonomi').getByText('Överföring och avstämning').click()
    await expect(page).toHaveURL(/\/fortnox\/overforing$/)
    await expect(page.getByRole('heading', { name: 'Överföring och avstämning' })).toBeVisible()
    // Den syntetiska organisationen har ingen anslutning: banderollen ska säga det.
    await expect(page.getByTestId('anslutning-bruten')).toBeVisible()
    await expect(page.getByTestId('att-stamma-av')).toBeVisible()
    await expect(page.getByTestId('huvudbok-okand')).toHaveCount(0)
  })

  test('M2 390px: FORTNOX når överföringsvyn från mobilmenyn', async ({ page, request }) => {
    await page.setViewportSize(MOBIL)
    const { email, password } = await registerOrg(request)
    sattFortnoxSomHuvudbok(email)
    await uiLogin(page, email, password)
    await oppnaMobilmeny(page)
    await expect.poll(() => ekonomi(page)).toEqual(FORTNOX)
    await page.getByTestId('nav-grupp-ekonomi').getByText('Överföring och avstämning').click()
    await expect(page.getByRole('heading', { name: 'Överföring och avstämning' })).toBeVisible()
    const rubrik = await page
      .getByRole('heading', { name: 'Överföring och avstämning' })
      .boundingBox()
    expect(rubrik!.x + rubrik!.width).toBeLessThanOrEqual(MOBIL.width)
  })

  test('M3/M4/M8 FORTNOX: gamla direktlänkar läsbara, servern nekar fria verifikat', async ({
    page,
    request,
  }) => {
    const { email, password } = await registerOrg(request)
    const token = await apiLogin(request, email, password)
    // Kontoplanen läggs medan organisationen är EVENO, så att nekandet nedan
    // bevisligen kommer från huvudboksgrinden och inte från saknade konton.
    const seed = await request.post(`${API}/accounting/accounts/seed`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(seed.ok()).toBe(true)
    const { orgId } = sattFortnoxSomHuvudbok(email)

    // M4: fritt verifikat nekas av servern, oavsett meny, och ingenting bokförs.
    const antal = () =>
      sqlValue(`SELECT count(*) FROM "JournalEntry" WHERE "organizationId" = '${orgId}'`)
    const fore = antal()
    const nekad = await request.post(`${API}/accounting/journal-entries`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        date: '2026-03-10',
        description: 'e2e fritt verifikat under Fortnox',
        lines: [
          { accountNumber: 6110, debit: 100 },
          { accountNumber: 1930, credit: 100 },
        ],
      },
    })
    expect(nekad.status()).toBe(409)
    expect(((await nekad.json()) as { error?: { code?: string } }).error?.code).toBe(
      'EXTERN_HUVUDBOK',
    )
    expect(antal()).toBe(fore)

    await uiLogin(page, email, password)

    // M3/M8: bokföringen är ett läsbart arkiv utan fria skrivknappar.
    await page.goto('/accounting')
    await expect(page.getByRole('heading', { name: 'Bokföring' })).toBeVisible()
    await expect(page.getByTestId('extern-huvudbok')).toBeVisible()
    await expect(page.getByTestId('new-journal-entry')).toHaveCount(0)
    await expect(page.getByTestId('record-expense')).toHaveCount(0)
    await expect(page.getByTestId('new-supplier-invoice')).toHaveCount(0)
    await page.getByRole('button', { name: 'Verifikationer' }).click()
    await page.getByTestId('lank-overforing').click()
    await expect(page.getByRole('heading', { name: 'Överföring och avstämning' })).toBeVisible()

    await page.goto('/reports')
    await expect(page.getByRole('heading', { name: 'Rapporter' })).toBeVisible()

    await page.goto('/settings/fortnox')
    await expect(page.getByRole('heading', { name: 'Inställningar' })).toBeVisible()
    await expect(page.getByTestId('lank-overforing')).toBeVisible()

    await page.goto('/settings/kundstart')
    await expect(page.getByRole('heading', { name: 'Inställningar' })).toBeVisible()

    await page.goto('/fortnox/overforing')
    await expect(page.getByRole('heading', { name: 'Överföring och avstämning' })).toBeVisible()
    await expect(page.getByTestId('anslutning-bruten')).toBeVisible()
  })
})
