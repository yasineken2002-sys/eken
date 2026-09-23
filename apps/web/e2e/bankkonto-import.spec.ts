import { test, expect, type Page } from '@playwright/test'
import { registerOrg, type RegisteredOrg } from './helpers/seed'

/**
 * K1 — EN NY KUND SKA KUNNA SKAPA OCH VÄLJA IMPORTKONTOT I WEBBEN.
 *
 * ── VARFÖR DEN HÄR SPECEN FINNS ─────────────────────────────────────────────
 *
 * Kundprovet 2026-09-23 fastnade exakt här: en ny organisation öppnade
 * "Importera kontoutdrag", fick beskedet att inget bankkonto var upplagt — och
 * hade ingen väg att lägga upp det. Provet tvingades skapa kontot via ett
 * API-anrop vid sidan av webben för att kunna prova resten, och redovisade
 * steget som ett MISSLYCKAT UI-steg (UI 0079–0081).
 *
 * En regression här är alltså inte "en knapp försvann" utan "en ny kund kan inte
 * ta emot betalningar". Därför körs den genom hela kedjan — webbläsare → Vite →
 * NestJS → Postgres — och inte som ett komponentprov. `bankkonto.test.tsx` mäter
 * formulärets logik i jsdom och kan per konstruktion inte se att komponenterna
 * är monterade i sidan eller att servern accepterar nyttolasten.
 *
 * ── ORGANISATIONEN ÄR HELT NY ───────────────────────────────────────────────
 *
 * `registerOrg` skapar en färsk organisation utan fastigheter, avtal eller
 * konton. Det är förutsättningen som gör fyndet reproducerbart: en org som
 * redan HAR ett konto kan importera oavsett om skapa-vägen finns.
 */

let org: RegisteredOrg

// EN FÄRSK ORGANISATION PER TEST, inte per fil. Med `beforeAll` hade ett omförsök
// (retries = 2 i CI) kört om testet mot en organisation som redan HAR kontot —
// och då fallit på dubblettnamnet i stället för på det som gick fel. Priset är en
// registrering till; den ligger långt under throttlern.
test.beforeEach(async ({ playwright }) => {
  const request = await playwright.request.newContext()
  org = await registerOrg(request)
  await request.dispose()
})

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('E-postadress').fill(org.email)
  await page.locator('input[autocomplete="current-password"]').fill(org.password)
  await page.getByRole('button', { name: 'Logga in', exact: true }).click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 })
}

const KONTONAMN = 'Företagskonto SEB'
const KONTONUMMER = '5492-1234567'

/** Minimal bank-CSV i det generiska formatet (se DATE_KEYS/AMOUNT_KEYS/REF_KEYS). */
const CSV = ['Datum;Beskrivning;Belopp;Referens', '2026-03-02;E2E inbetalning;1234,00;'].join('\n')

test('ny organisation: skapa importkonto i UI → välj → importera kontoutdrag', async ({ page }) => {
  await login(page)
  await page.goto('/reconciliation')

  // ── 1. Utgångsläget: inget konto, och det SÄGS ────────────────────────────
  const kontokort = page.getByTestId('bank-accounts-card')
  await expect(kontokort).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('bank-accounts-tomt')).toContainText(
    'Importen av kontoutdrag kräver ett namngivet konto',
  )

  // Importkontot och PSD2-bankkopplingen är två olika saker, och kortet säger
  // det. Kundprovet gick till Bankkoppling när importen krävde ett konto.
  await expect(kontokort).toContainText('inte en bankkoppling (PSD2)')
  await expect(page.getByTestId('bank-connection-card')).toBeVisible()

  // ── 2. Importmodalen: beskedet OCH vägen framåt ───────────────────────────
  await page.getByRole('button', { name: 'Importera kontoutdrag' }).click()
  await expect(page.getByRole('heading', { name: 'Importera kontoutdrag' })).toBeVisible()
  await expect(page.getByText('Organisationen har inget bankkonto upplagt')).toBeVisible()

  // DET HÄR ÄR FYNDET: knappen fanns inte alls före den här ändringen.
  const laggUpp = page.getByTestId('import-lagg-upp-forsta-kontot')
  await expect(laggUpp).toBeVisible()
  await laggUpp.click()

  // ── 3. Skapa kontot — inuti importmodalen, utan att tappa flödet ──────────
  await page.getByLabel('Namn på kontot').fill(KONTONAMN)
  await page.getByLabel('Kontonummer (valfritt)').fill(KONTONUMMER)
  await page.getByRole('button', { name: 'Spara konto' }).click()

  // ── 4. Kontot är VALT, utan sidladdning ───────────────────────────────────
  const valjare = page.locator('#bankkonto')
  await expect(valjare).toHaveValue(/.+/, { timeout: 15_000 })
  await expect(valjare.locator('option:checked')).toHaveText(`${KONTONAMN} (${KONTONUMMER})`)
  // Formuläret är borta igen — panelen stängs när kontot sparats.
  await expect(page.getByLabel('Namn på kontot')).toBeHidden()

  // ── 5. Faktisk import mot det valda kontot ────────────────────────────────
  await page.locator('input[type="file"]').setInputFiles({
    name: 'e2e-kontoutdrag.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(CSV, 'utf8'),
  })
  await page.getByRole('button', { name: 'Importera', exact: true }).click()

  await expect(page.getByText('1 transaktioner importerade')).toBeVisible({ timeout: 30_000 })
  // Två knappar heter 'Stäng': modalens kryss (aria-label) och foten. Foten
  // står sist i DOM:en.
  await page.getByRole('button', { name: 'Stäng', exact: true }).last().click()

  // …och raden finns i tabellen. Ett 200-svar är inte samma sak som en synlig rad.
  await expect(page.getByText('E2E inbetalning').first()).toBeVisible({ timeout: 15_000 })

  // ── 6. Listan på sidan bär kontot, utan omladdning ────────────────────────
  await expect(kontokort).toContainText(KONTONAMN)
  await expect(kontokort).toContainText(KONTONUMMER)

  // ── 7. DUBBLETT: samma namn en gång till avvisas, av servern ──────────────
  // Den lokala kontrollen i formuläret är en artighet; det unika villkoret bor
  // i Postgres. Provet går via hanteringskortets modal, där listan redan är
  // laddad — och kräver att beskedet syns, inte bara att anropet misslyckas.
  await page.getByTestId('lagg-till-bankkonto').click()
  await page.getByLabel('Namn på kontot').fill(KONTONAMN)
  await page.getByRole('button', { name: 'Spara konto' }).click()
  await expect(page.getByRole('alert')).toContainText('redan ett konto som heter')

  // Inget andra konto skapades: exakt en förekomst av namnet i listan.
  await page.getByRole('button', { name: 'Avbryt' }).click()
  await expect(kontokort.getByText(KONTONAMN, { exact: true })).toHaveCount(1)
})

test('mobil 390px: samma väg går att gå', async ({ page }) => {
  // 390 px är iPhone-bredden i kundprovets mobilgranskning. En skapa-väg som
  // bara går att nå på skrivbordet är inte en väg för en hyresvärd som står i
  // trapphuset.
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await page.goto('/reconciliation')

  const kontokort = page.getByTestId('bank-accounts-card')
  await expect(kontokort).toBeVisible({ timeout: 15_000 })

  const knapp = page.getByTestId('lagg-till-bankkonto')
  await expect(knapp).toBeVisible()
  await knapp.click()

  const namn = page.getByLabel('Namn på kontot')
  await expect(namn).toBeVisible()
  await namn.fill('Mobilkonto')
  const spara = page.getByRole('button', { name: 'Spara konto' })
  // INGEN HORISONTELL SCROLL: en knapp som ligger utanför 390 px är synlig för
  // Playwright men inte för en tumme.
  const ruta = await spara.boundingBox()
  expect(ruta).not.toBeNull()
  expect(ruta!.x + ruta!.width).toBeLessThanOrEqual(390)
  await spara.click()

  await expect(kontokort).toContainText('Mobilkonto', { timeout: 15_000 })
})
