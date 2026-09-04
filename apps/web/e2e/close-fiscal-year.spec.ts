import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'

/**
 * #704 PR 3 — browser-bevis för årsstängningen.
 *
 * Kedjan som mäts, hela vägen:
 *   kortet är READY → dialogen visar det FÖRESLAGNA verifikatet rad för rad →
 *   bekräftelse kräver att årtalet skrivs → POST → verifikatet finns i
 *   verifikationslistan → kortet är stängt och bär verifikationsnumret.
 *
 * ── LOCATORS ÄR PINNADE, OCH DET ÄR EN LÄRDOM (#722) ──────────────────────
 *
 * Ett tidigare prov använde `getByRole('button', { name: 'Stäng' })` inne i en
 * modal. Den matchar TVÅ element — kryssikonen i huvudet och knappen i foten —
 * och den ena renderas först när en asynkron fråga landat. Provet var grönt
 * lokalt (långsam maskin, foten hann inte fram) och föll på CI. Skillnaden var
 * inte styrka utan VILKET TILLSTÅND som mättes.
 *
 * Därför går varje val här via `data-testid`, som är unikt per element och inte
 * beror på om något hunnit renderas. **Ingen `.first()` används i den här filen**
 * — behövs den någonsin ska skälet stå på raden, inte i en commit-text.
 *
 * ── VARFÖR RÄKENSKAPSÅRET SEEDAS I DET FÖRFLUTNA ──────────────────────────
 *
 * Ett år kan bara stängas när månad 1–11 är stängda och månad 12 öppen. Ett
 * FÖRFLUTET år gör provet oberoende av vilket datum det körs: `FISCAL_YEAR` är
 * innevarande år minus ett, härlett vid körning i stället för hårdkodat, så
 * provet inte tystnar vid ett årsskifte.
 */

const API = 'http://localhost:3000/v1'

/** Innevarande kalenderår minus ett — alltid ett helt förflutet räkenskapsår. */
const FISCAL_YEAR = new Date().getUTCFullYear() - 1

/**
 * `psql` med TVÅ saker som inte är valfria — båda uppmätta, båda fällde det
 * här provet innan de var på plats.
 *
 * `ON_ERROR_STOP=1`: utan den returnerar psql exit 0 ÄVEN när satsen fallerade.
 * En trasig INSERT blir då tom utdata i stället för ett fel, och felet dyker upp
 * långt senare som en främmande nyckel som inte går ihop.
 *
 * FÖRSTA RADEN: `-tAc` med `RETURNING id` skriver TVÅ rader — värdet, och sedan
 * kommandotaggen. Mätt:
 *
 *     6bf3ae65-0ca7-4c17-87c7-9447653d9a76
 *     INSERT 0 1
 *
 * Ett rakt `.trim()` ger alltså `"<uuid>\nINSERT 0 1"`, vilket är ett ogiltigt
 * uuid som FK:n avvisar. Att ta första raden är inte kosmetik.
 */
function sql(query: string): string {
  const ut = execFileSync(
    'psql',
    ['-h', 'localhost', '-U', 'eken', '-d', 'eken_dev', '-v', 'ON_ERROR_STOP=1', '-tAc', query],
    { env: { ...process.env, PGPASSWORD: 'eken' }, encoding: 'utf8' },
  )
  return (ut.split('\n')[0] ?? '').trim()
}

const q = (v: string) => `'${v.replace(/'/g, "''")}'`

test('årsstängning: förhandsvisning, bekräftelse med årtal, verifikat och låst kort', async ({
  page,
  request,
}) => {
  const stamp = Date.now()
  const email = `e2e.closeyear+${stamp}@eveno.test`
  const password = 'TestE2e123!'

  // ── Seed: organisation + kontoplan via det riktiga API:t ──────────────────
  const reg = await request.post(`${API}/auth/register`, {
    data: {
      email,
      password,
      firstName: 'E2E',
      lastName: 'Bokslut',
      organizationName: `E2E Bokslut ${stamp}`,
      acceptTerms: true,
    },
  })
  expect(reg.ok()).toBeTruthy()

  const login = await request.post(`${API}/auth/login`, { data: { email, password } })
  const token = ((await login.json()) as { data: { accessToken: string } }).data.accessToken
  const headers = { Authorization: `Bearer ${token}` }

  const seed = await request.post(`${API}/accounting/accounts/seed`, { headers })
  expect(seed.ok()).toBeTruthy()

  const accountsRes = await request.get(`${API}/accounting/accounts`, { headers })
  const accounts = ((await accountsRes.json()) as { data: Array<{ id: string; number: number }> })
    .data
  const orgId = sql(`select "organizationId" from "Account" where id = ${q(accounts[0]!.id)}`)
  const kontoId = (nummer: number): string => {
    const konto = accounts.find((a) => a.number === nummer)
    if (!konto) throw new Error(`Konto ${nummer} saknas i seedad plan`)
    return konto.id
  }

  // ── Seed: en intäkt och en kostnad i räkenskapsåret ───────────────────────
  //
  // Direkt i databasen, som `consumption-charge-confirm.spec.ts` gör för sin
  // config: det finns ingen endpoint för ett manuellt verifikat, och att gå via
  // en faktura hade fört in en helt annan kedja i beviset.
  const bokför = (
    ver: number,
    datum: string,
    rader: Array<[number, 'debit' | 'credit', number]>,
  ) => {
    const entryId = sql(
      `insert into "JournalEntry"
         ("id","organizationId","date","description","source","sourceId","fiscalYear","series","verNumber")
       values (gen_random_uuid(), ${q(orgId)}, ${q(datum)}::date, ${q(`E2E fixtur ${datum}`)},
               'MANUAL', ${q(`e2e-fixtur:${stamp}:${ver}`)}, ${FISCAL_YEAR}, 'A', ${ver})
       returning id`,
    )
    for (const [nummer, sida, belopp] of rader) {
      sql(
        `insert into "JournalEntryLine" ("id","journalEntryId","accountId","${sida}","description")
         values (gen_random_uuid(), ${q(entryId)}, ${q(kontoId(nummer))}, ${belopp}, 'E2E')`,
      )
    }
  }
  bokför(1, `${FISCAL_YEAR}-06-15`, [
    [1510, 'debit', 30000],
    [3911, 'credit', 30000],
  ])
  bokför(2, `${FISCAL_YEAR}-08-10`, [
    [5010, 'debit', 12000],
    [1930, 'credit', 12000],
  ])
  // Sekvensen måste stå på samma tal som fixturerna, annars krockar
  // årsavslutets `allocate` med verNumber 1.
  sql(
    `insert into "JournalEntrySequence" ("organizationId","fiscalYear","series","lastNumber","updatedAt")
     values (${q(orgId)}, ${FISCAL_YEAR}, 'A', 2, now())`,
  )

  // ── Seed: månad 1–11 stängda, månad 12 ÖPPEN ──────────────────────────────
  for (let m = 1; m <= 11; m++) {
    const close = await request.post(`${API}/accounting/periods/${FISCAL_YEAR}/${m}/close`, {
      headers,
    })
    expect(close.ok(), `månad ${m} skulle gå att stänga`).toBeTruthy()
  }

  // ── Logga in i webben ─────────────────────────────────────────────────────
  await page.goto('/login')
  await page.getByLabel('E-postadress').fill(email)
  await page.locator('input[autocomplete="current-password"]').fill(password)
  await page.getByRole('button', { name: 'Logga in', exact: true }).click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 })

  await page.goto('/accounting')
  await page.getByRole('button', { name: 'Perioder' }).click()

  // ── 1. Kortet är klart att stängas ────────────────────────────────────────
  const kort = page.getByTestId(`fiscal-year-card-${FISCAL_YEAR}`)
  await expect(kort).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId(`fiscal-year-badge-${FISCAL_YEAR}`)).toHaveText('Klart att stänga')

  // ── 2. Dialogen visar det föreslagna verifikatet ──────────────────────────
  await page.getByTestId(`fiscal-year-close-${FISCAL_YEAR}`).click()

  // Tre rader: nollställning av 3911 och 5010, plus resultatet mot 2099.
  const rader = page.getByTestId('year-end-line')
  await expect(rader).toHaveCount(3, { timeout: 15_000 })
  await expect(rader.filter({ hasText: '3911' })).toBeVisible()
  await expect(rader.filter({ hasText: '5010' })).toBeVisible()
  await expect(rader.filter({ hasText: '2099' })).toBeVisible()

  // 30 000 − 12 000 = 18 000 vinst. Formateringen är svensk, så jämför på
  // siffrorna och inte på tecknet mellan dem.
  await expect(page.getByTestId('year-end-result')).toContainText('18')

  // ── 3. Bekräftelsen kräver årtalet ────────────────────────────────────────
  const submit = page.getByTestId('fiscal-year-close-submit')
  await expect(submit).toBeDisabled()

  await page.getByTestId('fiscal-year-confirm').fill(String(FISCAL_YEAR - 1))
  await expect(submit, 'fel årtal får inte låsa upp knappen').toBeDisabled()

  await page.getByTestId('fiscal-year-confirm').fill(String(FISCAL_YEAR))
  await expect(submit).toBeEnabled()
  await submit.click()

  // ── 4. Kortet är stängt och bär verifikationsnumret ───────────────────────
  await expect(page.getByTestId(`fiscal-year-badge-${FISCAL_YEAR}`)).toHaveText('Stängt', {
    timeout: 20_000,
  })
  const verifikat = page.getByTestId(`fiscal-year-entry-${FISCAL_YEAR}`)
  await expect(verifikat).toBeVisible()
  // Serie A, och numret efter de två fixturerna.
  await expect(verifikat).toHaveText('A3')

  // Knappen ska vara borta — ett stängt år går inte att stänga igen.
  await expect(page.getByTestId(`fiscal-year-close-${FISCAL_YEAR}`)).toHaveCount(0)

  // ── 5. Verifikatet finns i verifikationslistan ────────────────────────────
  await page.getByRole('button', { name: 'Verifikationer' }).click()
  await expect(
    page.getByText(`Bokslut: resultatavräkning räkenskapsåret ${FISCAL_YEAR}`),
  ).toBeVisible({ timeout: 15_000 })
})
