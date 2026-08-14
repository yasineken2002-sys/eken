import { test, expect } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { registerOrg } from './helpers/seed'

/**
 * #442 — ETT NEKANDE SKA SE UT SOM ETT NEKANDE, INTE SOM TOMHET.
 *
 * Bankavstämningssidan renderade sitt vanliga tomma tillstånd när
 * `GET /reconciliation/transactions` 403:ade: "Inga transaktioner — Importera
 * ett kontoutdrag för att komma igång", med en primärknapp som själv 403:ar.
 * Ett falskt sakpåstående om organisationens data plus en återvändsgränd.
 *
 * ── Varför testet måste gå genom webbläsaren ─────────────────────────────────
 *
 * Ett API-test hade bara visat att endpointen svarar 403 — vilket den gjorde
 * hela tiden. Defekten låg i vad SKÄRMEN sa om det svaret. Den frågan kan bara
 * ställas till en renderad sida.
 *
 * ── Varför transaktionerna seedas först ──────────────────────────────────────
 *
 * DISKRIMINERANDE DATA. Vore organisationen tom hade "Inga transaktioner" varit
 * SANT, och testet kunde inte skilja en fixad sida från en trasig. Därför
 * importeras ett kontoutdrag som OWNER först: när VIEWER sedan öppnar sidan
 * FINNS det rader, och varje påstående om tomhet är bevisligen falskt.
 *
 * Assertionen går åt båda hållen — nekandet ska synas OCH lögnen ska vara
 * borta. Bara den första hade passerat även om båda renderats samtidigt.
 */

const API = 'http://localhost:3000/v1'

async function unwrap<T>(
  res: { ok(): boolean; status(): number; json(): Promise<unknown> },
  vad: string,
): Promise<T> {
  const body = (await res.json()) as { success?: boolean; data?: T; error?: { message?: string } }
  if (!res.ok() || body?.success === false) {
    throw new Error(
      `${vad} misslyckades (${res.status()}): ${body?.error?.message ?? JSON.stringify(body)}`,
    )
  }
  return body.data as T
}

/**
 * Sätter en KÄND inbjudningstoken och returnerar råvärdet.
 *
 * Går inte att läsa ur DB: kolumnen bär sha256 av token sedan #456, och mejlet
 * är inte läsbart i test. Vi genererar därför råtoken själva och skriver in
 * HASHEN — exakt som portal-helpern gör för aktiveringstoken (seed.ts:336-339),
 * vars kolumn varit hashad hela tiden.
 *
 * Att den gamla varianten gick sönder av hashningen är i sig ett kvitto på att
 * den bet: den läste kolumnvärdet och postade det som råtoken, vilket nu ger
 * 400 "Ogiltig inbjudningslänk".
 */
function sättInvitationToken(email: string): string {
  const raw = randomBytes(32).toString('hex')
  const hash = createHash('sha256').update(raw).digest('hex')
  execFileSync(
    'psql',
    [
      '-h',
      'localhost',
      '-p',
      '5432',
      '-U',
      'eken',
      '-d',
      'eken_dev',
      '-t',
      '-A',
      '-c',
      `UPDATE "UserInvitation" SET token = '${hash}' WHERE "userId" = (SELECT id FROM "User" WHERE email = '${email}')`,
    ],
    { env: { ...process.env, PGPASSWORD: 'eken' }, encoding: 'utf-8' },
  )
  return raw
}

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const data = await unwrap<{ accessToken: string }>(
    await request.post(`${API}/auth/login`, { data: { email, password } }),
    'Inloggning',
  )
  return data.accessToken
}

test('VIEWER får ett ärligt nekande på bankavstämningen, inte "Inga transaktioner"', async ({
  page,
  request,
}) => {
  // ── 1. Färsk org + OWNER ───────────────────────────────────────────────────
  const owner = await registerOrg(request)
  const ownerToken = await login(request, owner.email, owner.password)
  const ownerHeaders = { Authorization: `Bearer ${ownerToken}` }

  // ── 2. OWNER importerar ett kontoutdrag → BankTransaction-rader finns ──────
  const csv = [
    'Datum;Beskrivning;Belopp;Referens',
    '2026-08-01;INBETALNING ANNA SVENSSON;7500,00;12345678',
    '2026-08-02;INBETALNING ERIK LIND;8200,00;87654321',
  ].join('\n')

  const imported = await unwrap<{ imported: number; errors: string[] }>(
    await request.post(`${API}/reconciliation/import`, {
      headers: ownerHeaders,
      multipart: {
        statement: {
          name: 'statement.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from(csv, 'utf-8'),
        },
      },
    }),
    'CSV-import',
  )
  // Utan rader vore "Inga transaktioner" sant och testet icke-diskriminerande.
  expect(imported.errors).toEqual([])
  expect(imported.imported).toBeGreaterThan(0)

  // ── 3. OWNER bjuder in en VIEWER, som accepterar ──────────────────────────
  const viewerEmail = `viewer.${Date.now()}@eken-test.se`
  const viewerPassword = 'ViewerTest123!'
  await unwrap(
    await request.post(`${API}/users/invite`, {
      headers: ownerHeaders,
      data: { email: viewerEmail, firstName: 'Vera', lastName: 'Viewer', role: 'VIEWER' },
    }),
    'Inbjudan',
  )
  await unwrap(
    await request.post(`${API}/auth/accept-invite`, {
      data: { token: sättInvitationToken(viewerEmail), newPassword: viewerPassword },
    }),
    'Acceptera inbjudan',
  )

  // ── 4. Kontrollera att grinden faktiskt nekar — annars mäter vi fel sak ────
  const viewerToken = await login(request, viewerEmail, viewerPassword)
  const nekad = await request.get(`${API}/reconciliation/transactions`, {
    headers: { Authorization: `Bearer ${viewerToken}` },
  })
  expect(nekad.status()).toBe(403)

  // ── 5. Det som räknas: vad står på SKÄRMEN? ───────────────────────────────
  await page.goto('/login')
  await page.getByLabel('E-postadress').fill(viewerEmail)
  await page.locator('input[autocomplete="current-password"]').fill(viewerPassword)
  await page.locator('button[type="submit"]').click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 })

  await page.goto('/reconciliation')

  // Nekandet syns, med rollen utskriven.
  await expect(page.getByText('Du har inte behörighet')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/VIEWER/)).toBeVisible()

  // Och lögnen är borta. Den här assertionen är den som faktiskt fångar
  // regressionen — nekandet kunde renderas samtidigt som det tomma tillståndet.
  await expect(page.getByText('Inga transaktioner')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Importera kontoutdrag/ })).toHaveCount(0)
})
