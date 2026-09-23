import { test, expect, type Page } from '@playwright/test'
import { registerOrg, sqlValue, type RegisteredOrg } from './helpers/seed'

/**
 * K1 — EN NY KUND SKA KUNNA SKAPA, VÄLJA OCH TRÄFFA RÄTT IMPORTKONTO.
 *
 * ── VARFÖR DEN HÄR SPECEN FINNS ─────────────────────────────────────────────
 *
 * Kundprovet 2026-09-23 fastnade på att en ny organisation öppnade "Importera
 * kontoutdrag", fick beskedet att inget bankkonto var upplagt — och inte hade
 * någon väg att lägga upp det. Provet tvingades skapa kontot via ett API-anrop
 * vid sidan av webben och redovisade steget som ett MISSLYCKAT UI-steg
 * (UI 0079–0081, checkpoint 07).
 *
 * ── VAD RÄTTNING-1 LADE TILL, OCH VARFÖR ────────────────────────────────────
 *
 * Granskningen av #918 visade att den första versionen bevisade FÖR LITE: den
 * skapade ett enda konto, gjorde aldrig ett `selectOption`, och kontrollerade
 * aldrig vilket konto raden faktiskt hamnade på. Den kunde alltså inte se att
 * målet kunde bytas under operatörens fötter (G1) eller att ett avvecklat konto
 * passerade webbens grind (G2).
 *
 * Specen kräver nu: TVÅ konton skapade i UI:t, att ett flerkontoläge VÄGRAR
 * gissa, ett uttryckligt val, en verklig import — och att den sparade raden
 * tillhör det valda kontot. Kontotillhörigheten läses ur databasen, eftersom
 * avstämningsvyn med flit inte exponerar `bankAccountId`; ett grönt importsvar
 * säger ingenting om vilket konto raden hör till.
 *
 * Mobilprovet stannade tidigare när kontot hade skapats. Det går nu hela vägen
 * genom val, fil och import, och mäter effekten.
 */

let org: RegisteredOrg
/** Unikt per test, så kontonamnen inte kan krocka mellan körningar. */
let stämpel: string

// EN FÄRSK ORGANISATION PER TEST, inte per fil. Med `beforeAll` hade ett omförsök
// (retries = 2 i CI) kört om testet mot en organisation som redan HAR kontot —
// och då fallit på dubblettnamnet i stället för på det som gick fel. Priset är en
// registrering till; den ligger långt under throttlern.
test.beforeEach(async ({ playwright }) => {
  const request = await playwright.request.newContext()
  org = await registerOrg(request)
  stämpel = String(Date.now())
  await request.dispose()
})

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('E-postadress').fill(org.email)
  await page.locator('input[autocomplete="current-password"]').fill(org.password)
  await page.getByRole('button', { name: 'Logga in', exact: true }).click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 })
}

const KONTONUMMER = '5492-1234567'
const importknapp = (page: Page) => page.getByRole('button', { name: 'Importera', exact: true })

/** Minimal bank-CSV i det generiska formatet (se DATE_KEYS/AMOUNT_KEYS/REF_KEYS). */
function csv(beskrivning: string, belopp: string) {
  // Filens BYTES måste skilja sig mellan importerna: filnivåns idempotens
  // (#F034b) spelar annars upp den första körningen i stället för att skapa nya
  // rader, och då mäter provet uppspelning i stället för import.
  const rader = ['Datum;Beskrivning;Belopp;Referens', `2026-03-02;${beskrivning};${belopp},00;`]
  return {
    name: `${beskrivning.replace(/\s+/g, '-')}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from(rader.join('\n'), 'utf8'),
  }
}

/** Skapar ett konto via hanteringskortets modal och väntar in listan. */
async function skapaKontoViaKortet(page: Page, namn: string) {
  await page.getByTestId('lagg-till-bankkonto').click()
  await page.getByLabel('Namn på kontot').fill(namn)
  await page.getByRole('button', { name: 'Spara konto' }).click()
  await expect(page.getByTestId('bank-accounts-card')).toContainText(namn, { timeout: 15_000 })
}

/** Kontot som en sparad banktransaktion faktiskt hör till. */
function kontotFörRaden(beskrivning: string): string {
  return sqlValue(
    `SELECT COALESCE(ba.name, '(inget konto)')
       FROM "BankTransaction" bt
       LEFT JOIN "BankAccount" ba ON ba.id = bt."bankAccountId"
      WHERE bt.description = '${beskrivning}'`,
  )
}

test('ny organisation: skapa två konton i UI → flerkontoval krävs → rätt konto får raden', async ({
  page,
}) => {
  const KONTO_A = `Företagskonto SEB ${stämpel}`
  const KONTO_B = `Klientmedelskonto ${stämpel}`
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
  // TVÅ knappar heter 'Importera kontoutdrag': sidhuvudets och tomt-lägets CTA.
  // Playwright är strikt och vägrar klicka på en tvetydig träff — mätt i första
  // riggkörningen. Sidhuvudets står först i DOM:en och finns i BÅDA lägena.
  await page.getByRole('button', { name: 'Importera kontoutdrag' }).first().click()
  await expect(page.getByRole('heading', { name: 'Importera kontoutdrag' })).toBeVisible()
  await expect(page.getByText('Organisationen har inget bankkonto upplagt')).toBeVisible()

  // DET HÄR VAR KUNDPROVETS STOPP: knappen fanns inte alls.
  const laggUpp = page.getByTestId('import-lagg-upp-forsta-kontot')
  await expect(laggUpp).toBeVisible()
  await laggUpp.click()

  // ── 3. Skapa kontot inuti importmodalen, utan att tappa flödet ────────────
  await page.getByLabel('Namn på kontot').fill(KONTO_A)
  await page.getByLabel('Kontonummer (valfritt)').fill(KONTONUMMER)
  await page.getByRole('button', { name: 'Spara konto' }).click()

  // Kontot är valt, utan sidladdning. Att skapa ett konto i panelen ÄR ett
  // uttryckligt val (RÄTTNING-1), så det ska ligga kvar.
  const valjare = page.locator('#bankkonto')
  await expect(valjare).toHaveValue(/.+/, { timeout: 15_000 })
  await expect(valjare.locator('option:checked')).toHaveText(`${KONTO_A} (${KONTONUMMER})`)
  await expect(page.getByLabel('Namn på kontot')).toBeHidden()

  // ── 4. Första importen går till A ─────────────────────────────────────────
  const RAD_A = `E2E inbetalning A ${stämpel}`
  await page.locator('input[type="file"]').setInputFiles(csv(RAD_A, '1234'))
  await importknapp(page).click()
  await expect(page.getByText('1 transaktioner importerade')).toBeVisible({ timeout: 30_000 })
  // Två knappar heter 'Stäng': modalens kryss (aria-label) och foten.
  await page.getByRole('button', { name: 'Stäng', exact: true }).last().click()
  await expect(page.getByText(RAD_A).first()).toBeVisible({ timeout: 15_000 })
  await expect(kontokort).toContainText(KONTO_A)
  await expect(kontokort).toContainText(KONTONUMMER)

  // ── 5. ANDRA kontot, och därmed en verklig valsituation ───────────────────
  await skapaKontoViaKortet(page, KONTO_B)
  await expect(kontokort).toContainText('2 aktiva konton')

  // Ny sida = ny importomgång utan tidigare beslut. Det är så en kund som
  // kommer tillbaka nästa dag möter flerkontoläget.
  await page.reload()
  await page.getByRole('button', { name: 'Importera kontoutdrag' }).first().click()
  await expect(page.getByRole('heading', { name: 'Importera kontoutdrag' })).toBeVisible()

  // ── 6. FLERA KONTON GISSAR INTE ───────────────────────────────────────────
  await expect(valjare).toHaveValue('')
  await expect(page.getByTestId('import-kontobesked')).toContainText(
    'Välj vilket bankkonto importen gäller',
  )
  const RAD_B = `E2E inbetalning B ${stämpel}`
  await page.locator('input[type="file"]').setInputFiles(csv(RAD_B, '2345'))
  // Fil vald men inget konto: importen är spärrad. Det är hela poängen —
  // systemet får inte välja åt operatören när det finns mer än ett svar.
  await expect(importknapp(page)).toBeDisabled()

  // ── 7. Uttryckligt val av AVSETT konto, sedan import ──────────────────────
  await valjare.selectOption({ label: `${KONTO_A} (${KONTONUMMER})` })
  await expect(importknapp(page)).toBeEnabled()
  await importknapp(page).click()
  await expect(page.getByText('1 transaktioner importerade')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Stäng', exact: true }).last().click()
  await expect(page.getByText(RAD_B).first()).toBeVisible({ timeout: 15_000 })

  // ── 8. KONTOTILLHÖRIGHETEN I DET SPARADE RESULTATET ───────────────────────
  // Ett grönt importsvar och en synlig rad säger inte vilket konto raden hör
  // till. Avstämningsvyn projicerar bort `bankAccountId`, så frågan ställs mot
  // lagringen.
  expect(kontotFörRaden(RAD_B)).toBe(KONTO_A)
  expect(kontotFörRaden(RAD_A)).toBe(KONTO_A)
  // Och ingenting hamnade på det andra kontot.
  expect(
    sqlValue(
      `SELECT count(*) FROM "BankTransaction" bt
         JOIN "BankAccount" ba ON ba.id = bt."bankAccountId"
        WHERE ba.name = '${KONTO_B}'`,
    ),
  ).toBe('0')

  // ── 9. DUBBLETT: samma namn en gång till avvisas ──────────────────────────
  //
  // VILKET LAGER SOM SVARAR — mätt, inte antaget. Specen krävde först ett
  // `role="alert"`, alltså SERVERNS 409-text. Det elementet kom aldrig, och
  // skälet är att den lokala dubblettkontrollen (`bankkontoFältfel`) hinner
  // först och renderar ett FÄLTFEL. Så är det byggt: det unika villkoret bor i
  // Postgres och är spärren, men formuläret slipper en tur till servern för ett
  // svar det redan kan ge. Meningen är ordagrant densamma i båda lagren.
  //
  // Serverns 409-väg prövas därför inte här utan i `bankkonto.test.tsx`
  // ("409 från servern visas som SERVERNS text"), där felet kan matas in.
  await page.getByTestId('lagg-till-bankkonto').click()
  await page.getByLabel('Namn på kontot').fill(KONTO_A)
  await page.getByRole('button', { name: 'Spara konto' }).click()
  await expect(page.getByText(`Det finns redan ett konto som heter "${KONTO_A}".`)).toBeVisible()

  // Inget tredje konto skapades.
  await page.getByRole('button', { name: 'Avbryt' }).click()
  await expect(kontokort.getByText(KONTO_A, { exact: true })).toHaveCount(1)
})

test('mobil 390px: skapa konto → välj → importera → mätt effekt', async ({ page }) => {
  // 390 px är iPhone-bredden i kundprovets mobilgranskning. Provet stannade
  // tidigare när kontot hade skapats, vilket granskningen påpekade: titeln
  // lovade hela vägen men assertions nådde bara första steget. Nu går det
  // genom val, fil och import, och mäter kontotillhörigheten.
  const MOBIL_A = `Mobilkonto A ${stämpel}`
  const MOBIL_B = `Mobilkonto B ${stämpel}`
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
  await namn.fill(MOBIL_A)
  const spara = page.getByRole('button', { name: 'Spara konto' })
  // INGEN HORISONTELL SCROLL: en knapp som ligger utanför 390 px är synlig för
  // Playwright men inte för en tumme.
  const ruta = await spara.boundingBox()
  expect(ruta).not.toBeNull()
  expect(ruta!.x + ruta!.width).toBeLessThanOrEqual(390)
  await spara.click()
  await expect(kontokort).toContainText(MOBIL_A, { timeout: 15_000 })

  // Två konton också på mobil, så att provet mäter ett VAL och inte en bindning.
  await skapaKontoViaKortet(page, MOBIL_B)

  await page.getByRole('button', { name: 'Importera kontoutdrag' }).first().click()
  await expect(page.getByRole('heading', { name: 'Importera kontoutdrag' })).toBeVisible()

  const valjare = page.locator('#bankkonto')
  await expect(valjare).toHaveValue('')
  const RAD = `E2E mobil ${stämpel}`
  await page.locator('input[type="file"]').setInputFiles(csv(RAD, '999'))
  await expect(importknapp(page)).toBeDisabled()

  await valjare.selectOption({ label: MOBIL_B })
  const importruta = await importknapp(page).boundingBox()
  expect(importruta).not.toBeNull()
  expect(importruta!.x + importruta!.width).toBeLessThanOrEqual(390)
  await importknapp(page).click()

  await expect(page.getByText('1 transaktioner importerade')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Stäng', exact: true }).last().click()
  await expect(page.getByText(RAD).first()).toBeVisible({ timeout: 15_000 })

  // MÄTT EFFEKT, inte bara en synlig rad: raden hör till det konto som valdes.
  expect(kontotFörRaden(RAD)).toBe(MOBIL_B)
})
