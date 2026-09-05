import { expect, test } from '@playwright/test'
import { API, registerOrg } from './helpers/seed'

/**
 * BANKKOPPLING (PSD2): ANSLUT VIA MOCK, SE SAMTYCKET, OCH SE ATT SCOPE INTE LÄCKER.
 *
 * ── VARFÖR DET HÄR GÅR ATT KÖRA ALLS ──────────────────────────────────────
 *
 * Före #774 fanns ingen väg att välja Mock-providern utanför jest: factoryn
 * kände två utfall, Stub eller fail-fast, och hela ytan under
 * `/v1/reconciliation/psd2` svarade 503. CI-jobbet sätter numera
 * `PSD2_ENABLED=true`, `PSD2_PROVIDER=mock`, `PSD2_MOCK_SCENARIO=active` och en
 * PSD2_TOKEN_KEY med testvärde, och grepar `[psd2] aktivt — provider MOCK` i
 * API-loggen INNAN någon spec körs. Utan den kontrollen hade en 503 sett ut som
 * en flakig spec i stället för som en konfiguration som inte nådde processen.
 *
 * ── VAD PROVET BÄR SOM INGET ANNAT PROV KAN ───────────────────────────────
 *
 * `psd2.module.spec.ts` bygger en MINIMAL modul för att pröva factoryns fyra
 * utfall — den kan per konstruktion inte se att `psd2.module.ts` faktiskt
 * kopplar in `psd2ProviderFactory`. Filen säger det själv, och pekar hit. Det
 * här provet bootar HELA API:t: når vi Mock-providern genom HTTP-ytan har den
 * riktiga modulen läst den riktiga factoryn. Väljs Stub i stället svarar
 * `POST /consents` 503 och steg 2 faller.
 *
 * ── VARFÖR BANKENS SIDA ROUTAS, OCH INTE HOPPAS ÖVER ──────────────────────
 *
 * Mockens `beginConsent` returnerar `https://mock-bank.example/auth?state=…` —
 * en domän som inte finns, och sidan gör en HELSIDESNAVIGERING dit (bankens SCA
 * sker på bankens egen domän, inte i en fetch). Playwright fångar navigeringen
 * och svarar med 302:an banken skulle ha svarat med, till API:ets callback.
 *
 * Alternativet — att låta provet läsa `authUrl` ur svaret och `page.goto()` rakt
 * till callbacken — hade hoppat över `window.location.assign`, alltså precis den
 * rad som gör att en riktig bank kan skicka tillbaka användaren. Då hade provet
 * mätt API:t och inte flödet.
 *
 * `state` plockas ur den authUrl mocken byggde, inte ur en gissning: bindningen
 * är single-use och serverlagrad, så ett påhittat state ger 400 och en redirect
 * med `psd2=error`.
 *
 * ── NEGATIVKONTROLLEN ─────────────────────────────────────────────────────
 *
 * `SAFE_BANK_CONSENT_SELECT` utesluter `scope`, `accessTokenEnc`,
 * `refreshTokenEnc` och `syncCursor`. Mocken sätter `scope: 'accounts
 * transactions'` och tokens `mock-access-…`/`mock-refresh-…`, alltså finns
 * värdena PÅ RIKTIGT i databasen efter steg 2 — det är vad som gör kontrollen
 * till ett prov och inte till en tomhet. Utan anslutningen först hade "ingen
 * scope-text syns" varit sant om en tom sida.
 *
 * Två nivåer, med flit: DOM:en (det användaren ser) och svarskroppen (det som
 * ens lämnade backend). Bara DOM hade missat ett fält som kommer med i JSON men
 * inte råkar renderas i dag.
 *
 * ── RIGGEN SKAPAR SIN EGEN FÖRUTSÄTTNING ──────────────────────────────────
 *
 * `registerOrg` skapar en HELT FÄRSK organisation per körning, och samtycken är
 * scopade på `organizationId`. Till skillnad från BankID — där mocken intygar
 * ETT fast personnummer och tabellen därför måste nollställas — kan ingen
 * tidigare körning påverka utfallet här. Ingen DB-städning behövs, och den som
 * lägger till en vore ett filter som kan missa.
 */

const NY_ORG_TIMEOUT = 30_000

/**
 * Domänen mockens `beginConsent` pekar på. Existerar inte — den routas nedan.
 *
 * Ett PREDIKAT och inte ett glob-mönster: URL:en bär en query (`?state=…`), och
 * ett glob matchas mot hela strängen. `https://mock-bank.example/**` hade
 * fungerat i dag men är en tyst tvetydighet — en route som inte matchar ger
 * ingen varning, bara en navigering till en domän som inte finns.
 */
const arMockBanken = (url: URL) => url.hostname === 'mock-bank.example'

/** Värden mocken skriver i BankConsent och som ALDRIG får nå webbläsaren. */
const FAR_ALDRIG_SYNAS = ['accounts transactions', 'mock-access-', 'mock-refresh-']

test('PSD2: anslut bank via Mock, samtycket visas aktivt, och scope läcker inte', async ({
  page,
  request,
}) => {
  const { email, password } = await registerOrg(request)

  // ── 1. LOGGA IN SOM OWNER ────────────────────────────────────────────────
  // Rollen är lastbärande: PSD2-endpointsen bär @Roles('OWNER','ADMIN'), och
  // BankConnectionPage visar knapparna bara för de två. registerOrg gör
  // registreraren till OWNER.
  await page.goto('/login')
  await page.getByLabel('E-postadress').fill(email)
  await page.locator('input[autocomplete="current-password"]').fill(password)
  await page.locator('button[type="submit"]').click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: NY_ORG_TIMEOUT })

  // ── 2. ANSLUT BANKEN GENOM MOCKENS SCA-REDIRECT ──────────────────────────
  await page.goto('/reconciliation/settings')

  // Ingen bank ännu — och det påståendet är riggens egen förutsättning, inte en
  // dekoration: utan det kan steg 3 inte skilja "samtycket skapades" från "det
  // låg redan ett samtycke där".
  await expect(page.getByTestId('psd2-connect')).toBeVisible({ timeout: NY_ORG_TIMEOUT })
  await expect(page.getByTestId('bank-consent-0')).toHaveCount(0)

  // Bankens sida svarar det en riktig bank hade svarat efter godkänd SCA: en
  // 302 till API:ets callback, med samma `state` och en kod. Callbacken växlar
  // koden mot tokens hos mocken och redirectar vidare till
  // PSD2_APP_RETURN_URL?psd2=ok — alltså tillbaka hit.
  await page.route(arMockBanken, async (route) => {
    const state = new URL(route.request().url()).searchParams.get('state')
    if (!state) {
      await route.fulfill({ status: 400, body: 'mock-banken fick ingen state' })
      return
    }
    await route.fulfill({
      status: 302,
      headers: {
        location: `${API}/reconciliation/psd2/callback?state=${state}&code=e2e-mock-code`,
      },
    })
  })

  await page.getByTestId('psd2-connect').click()

  // Kvittensen kommer ur redirecten, inte ur en optimistisk uppdatering i
  // klienten. Att den syns är beviset för att hela kedjan gick runt:
  // begin → mock → callback → handleCallback → tillbaka till appen.
  await expect(page.getByText('Banken är ansluten')).toBeVisible({ timeout: NY_ORG_TIMEOUT })

  // ── 3. BADGEN VISAR ETT AKTIVT SAMTYCKE ──────────────────────────────────
  const kort = page.getByTestId('bank-consent-0')
  await expect(kort).toBeVisible({ timeout: NY_ORG_TIMEOUT })
  await expect(page.getByTestId('bank-consent-status-0')).toHaveText('Aktiv')
  // Providernamnet kommer från den provider som FAKTISKT injicerades i
  // Psd2ConsentService. Står det MOCK har den riktiga modulen läst den riktiga
  // factoryn — samma sak som CI:s loggkontroll säger, fast mätt genom HTTP.
  await expect(kort).toContainText('MOCK')

  // ── 4. NEGATIVKONTROLL: SCOPE OCH TOKENS SYNS INTE ───────────────────────
  // (a) I webbläsaren.
  const sidtext = await page.locator('body').innerText()
  for (const hemlighet of FAR_ALDRIG_SYNAS) {
    expect(sidtext).not.toContain(hemlighet)
  }
  expect(sidtext.toLowerCase()).not.toContain('scope')

  // (b) I svarskroppen — fältet får inte ens LÄMNA backend. Kroppen fångas ur
  // appens EGET anrop, inte ur ett vi konstruerar: ett eget `fetch` hade behövt
  // återskapa Bearer-token ur localStorage, och då hade provet mätt en request
  // vi själva byggt i stället för den appen faktiskt gör.
  const [svar] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/reconciliation/psd2/consents') && r.request().method() === 'GET',
      { timeout: NY_ORG_TIMEOUT },
    ),
    page.reload(),
  ])
  const kropp = await svar.text()
  // Kanariefågeln till kontrollen under: utan den kan "inget scope i kroppen"
  // lika gärna betyda att vi läste ett tomt eller felaktigt svar.
  expect(kropp).toContain('"status":"ACTIVE"')
  for (const fält of ['scope', 'accessTokenEnc', 'refreshTokenEnc', 'syncCursor']) {
    expect(kropp).not.toContain(fält)
  }

  // ── 5. AVSTÄMNINGSSIDANS KORT SPEGLAR SAMTYCKET ──────────────────────────
  // Kortet läser samma queryrymd (`['psd2','consents']`) men är en annan vy. Att
  // det ändrar text är beviset för att ingången på avstämningssidan berättar
  // sanningen om kopplingen, i stället för att bara vara en länk.
  await page.goto('/reconciliation')
  await expect(page.getByTestId('bank-connection-card')).toBeVisible({ timeout: NY_ORG_TIMEOUT })
  await expect(page.getByTestId('bank-connection-card-text')).toHaveText(
    '1 aktiv bankkoppling hämtar transaktioner automatiskt.',
    { timeout: NY_ORG_TIMEOUT },
  )
})
