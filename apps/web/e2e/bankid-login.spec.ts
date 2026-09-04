import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { registerOrg } from './helpers/seed'

/**
 * BANKID: ANSLUT, LOGGA UT, LOGGA IN — genom webbläsaren, mot Mock-providern.
 *
 * ── VARFÖR DET HÄR GÅR ATT KÖRA ALLS ──────────────────────────────────────
 *
 * Före #745 PR 3 fanns ingen väg att välja Mock-providern utanför jest, och
 * BankID-ytan svarade 503 i varje miljö utom ett prov. CI-jobbet sätter numera
 * `BANKID_ENABLED=true` och `BANKID_PROVIDER=mock`, och kontrollerar i loggen att
 * valet nådde API-processen INNAN någon spec körs — annars hade en 503 sett ut
 * som en flakig spec. Se `bankid-provider-mode.ts` för varför kombinationen
 * `mock` + `NODE_ENV=production` gör att appen vägrar starta.
 *
 * ── VARFÖR ANSLUTNINGEN MÅSTE SKE FÖRST ───────────────────────────────────
 *
 * DISKRIMINERANDE DATA, samma resonemang som i viewer-403-provet. Mocken intygar
 * alltid samma testpersonnummer, men en inloggning kan bara lyckas om det finns
 * en `UserBankIdIdentity` med motsvarande blindindex. Utan anslutningssteget hade
 * inloggningen gett 401 — och provet kunde inte skilja "inloggningen fungerar
 * inte" från "det finns inget konto att logga in på". Kedjan bevisar båda
 * riktningarna: 401-vägen prövas först, och lyckas först EFTER anslutningen.
 *
 * ── RIGGEN SKAPAR SIN EGEN FÖRUTSÄTTNING ──────────────────────────────────
 *
 * Steg 1 påstår "inget konto är kopplat". Det påståendet är inte riggens att
 * anta: Mock-providern intygar ETT fast testpersonnummer, så VARJE tidigare
 * anslutning i samma databas — en annan körning, en utvecklares egen — gör
 * påståendet falskt. Utfallet blir inte ett tydligt fel utan att steg 1 loggar in
 * i stället för att neka, alltså ett prov som mäter omgivningen.
 *
 * UPPMÄTT, inte befarat: första körningen föll här därför att en tidigare
 * curl-verifiering lämnat en identitet i eken_dev, och Playwrights omförsök föll
 * likadant på den identitet försöket före just hade skapat.
 *
 * Därför nollställs tabellen före OCH efter. HELA tabellen, inte ett filter på
 * e2e-adresser: mocken intygar en enda person, så vilken rad som helst kan matcha
 * — och ett filter som missar återinför precis den defekt raden finns för att
 * stänga. Tabellen existerar bara i miljöer där BankID är mockat; i produktion
 * kan providern inte vara en mock (appen vägrar starta).
 *
 * ── LOCATORS ──────────────────────────────────────────────────────────────
 *
 * Pinnade på `data-testid` genomgående, ingen `.first()`. Lärdomen från #722: en
 * ospecificerad locator som råkar träffa rätt element i dag är ett prov som
 * slutar mäta den dag layouten får ett syskon till.
 */

const NY_ORG_TIMEOUT = 30_000

const DB = { host: 'localhost', user: 'eken', database: 'eken_dev', password: 'eken' }

function runSql(sql: string): void {
  execFileSync(
    'psql',
    ['-h', DB.host, '-U', DB.user, '-d', DB.database, '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { env: { ...process.env, PGPASSWORD: DB.password }, stdio: 'pipe' },
  )
}

const NOLLSTALL = 'DELETE FROM "UserBankIdIdentity"'

test.beforeEach(() => runSql(NOLLSTALL))
test.afterEach(() => runSql(NOLLSTALL))

test('BankID: 401 utan koppling, anslut i inställningar, logga sedan in med BankID', async ({
  page,
  request,
}) => {
  const { email, password } = await registerOrg(request)

  // ── 1. UTAN KOPPLING: identifieringen lyckas, men inget konto matchar ─────
  await page.goto('/login')
  const bankIdKnapp = page.getByTestId('bankid-login-button')
  await expect(bankIdKnapp).toBeVisible({ timeout: NY_ORG_TIMEOUT })
  await bankIdKnapp.click()

  // Mocken fullbordar direkt, så svaret blir 401 → "inget konto". Att det står
  // just den texten och inte serverns neutrala mening är avsiktligt: den som
  // legitimerat sig med SITT EGET BankID får veta att det inte är kopplat.
  await expect(page.getByTestId('bankid-error')).toHaveText(
    'Inget konto är kopplat till detta BankID',
    { timeout: NY_ORG_TIMEOUT },
  )
  await page.keyboard.press('Escape')

  // ── 2. LOGGA IN MED LÖSENORD OCH KOPPLA BANKID ───────────────────────────
  await page.getByLabel('E-postadress').fill(email)
  await page.locator('input[autocomplete="current-password"]').fill(password)
  await page.locator('button[type="submit"]').click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: NY_ORG_TIMEOUT })

  await page.goto('/settings')
  await page.getByRole('button', { name: 'Säkerhet', exact: true }).click()

  const kopplaKnapp = page.getByTestId('bankid-connect')
  await expect(kopplaKnapp).toBeVisible({ timeout: NY_ORG_TIMEOUT })
  await kopplaKnapp.click()

  // Anslutningen fullbordas utan att någon loggas in — modalen stänger sig och
  // raden dyker upp. Att raden FINNS är beviset; datumet i den kommer från
  // servern och asserteras inte (den vore en tidszon-fälla utan värde här).
  await expect(page.getByTestId('bankid-identity')).toHaveCount(1, { timeout: NY_ORG_TIMEOUT })
  await expect(page.getByTestId('bankid-disconnect')).toBeVisible()

  // ── 3. LOGGA UT OCH LOGGA IN IGEN — MED BANKID ───────────────────────────
  await page.evaluate(() => window.localStorage.removeItem('eken-auth'))
  await page.goto('/login')

  const bankIdIgen = page.getByTestId('bankid-login-button')
  await expect(bankIdIgen).toBeVisible({ timeout: NY_ORG_TIMEOUT })
  await bankIdIgen.click()

  // Nu SKA det fungera. Samma nyttolast som lösenordsinloggningen, så samma
  // navigering: bort från /login.
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: NY_ORG_TIMEOUT })
  await expect(page.getByTestId('bankid-error')).toHaveCount(0)
})
