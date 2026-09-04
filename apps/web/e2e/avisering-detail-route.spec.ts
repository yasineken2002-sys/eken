import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { seedActiveLease, API, type SeededOrg } from './helpers/seed'

/**
 * Djuplänken till EN avi: rutten `/avisering/$noticeId` (#719, ur #648).
 *
 * Bakgrunden är #718: kravtrappan larmar om en avi som stått stilla i en vecka,
 * och notisen bär avins id i BÅDA sina fält. Webben kastade bort id:t och
 * landade på listsidan, alltså på en yta som inte svarar på frågan notisen
 * ställer. Provet nedan mäter att URL:en numera bär hela vägen fram.
 *
 * VAD PROVET TÄCKER — och vad det inte gör. Det mäter RUTTEN: att en URL med ett
 * id öppnar detaljmodalen, och att ett okänt id inte lämnar användaren i en tom
 * modal över en lögnaktig adress. Det mäter INTE `notification-link.ts`
 * (funktionerna som bygger URL:en) — de är rena funktioner utan körare i
 * `apps/web`, vilket är exakt vad #719 handlar om. Blir den körarna byggd hör
 * `entityTypeToPath`/`notificationLinkToPath` hemma i ett enhetstest, inte här.
 *
 * Avin sås via API:t i beforeAll, av samma skäl som avi-paid-flow: UI-vägen dit
 * är redan bevisad där, och att gå den igen gör provet långsammare utan att mäta
 * något nytt.
 */

let org: SeededOrg
let noticeId: string
let noticeNumber: string

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext()
  org = await seedActiveLease(request)

  const loginRes = await request.post(`${API}/auth/login`, {
    data: { email: org.email, password: org.password },
  })
  const loginBody = (await loginRes.json()) as { data?: { accessToken?: string } }
  const token = loginBody.data?.accessToken
  if (!token) throw new Error(`Inloggning via API misslyckades (${loginRes.status()})`)
  const headers = { Authorization: `Bearer ${token}` }

  const genRes = await request.post(`${API}/avisering/generate`, {
    headers,
    data: { month: org.periodMonth, year: org.periodYear },
  })
  if (!genRes.ok()) throw new Error(`Generera avi misslyckades (${genRes.status()})`)

  const listRes = await request.get(
    `${API}/avisering?month=${org.periodMonth}&year=${org.periodYear}`,
    { headers },
  )
  const listBody = (await listRes.json()) as {
    data?: Array<{ id: string; noticeNumber: string }>
  }
  const notice = listBody.data?.[0]
  if (!notice) throw new Error('Ingen avi genererades för det sådda kontraktet')
  noticeId = notice.id
  noticeNumber = notice.noticeNumber

  await request.dispose()
})

async function loggaIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('E-postadress').fill(org.email)
  await page.locator('input[autocomplete="current-password"]').fill(org.password)
  await page.getByRole('button', { name: 'Logga in' }).click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 })
}

test('djuplänk /avisering/:id öppnar avins detaljmodal ovanpå listan', async ({ page }) => {
  await loggaIn(page)

  // Gå direkt på URL:en — INTE via ett klick i listan. Det är hela poängen:
  // notisen (och ett mejl) levererar adressen utan att appen först varit på
  // listsidan, så modalen måste kunna öppnas från kallstart.
  await page.goto(`/avisering/${noticeId}`)

  const modal = page.getByRole('dialog')
  await expect(modal).toBeVisible({ timeout: 15_000 })
  await expect(modal.getByRole('heading', { name: `Avi ${noticeNumber}` })).toBeVisible()

  // Listsidan ligger kvar under modalen — rutten renderar listan, inte en egen
  // sida. Faller den här assertionen har rutten blivit en helsida.
  await expect(page.getByRole('heading', { name: 'Hyresavier' })).toBeVisible()

  // Stängning ska städa URL:en. Står adressen kvar på avin öppnas modalen igen
  // vid omladdning, och bakåtknappen beter sig fel.
  await modal.getByRole('button', { name: 'Stäng' }).click()
  await expect(modal).toBeHidden()
  await expect(page).toHaveURL(/\/avisering$/)
})

test('okänt avi-id faller tillbaka på listan i stället för en tom modal', async ({ page }) => {
  await loggaIn(page)

  // Ett välformat men obefintligt UUID: hämtningen svarar 404, och sidan ska
  // då navigera tillbaka. Utan den grenen blir utfallet en modal som aldrig
  // öppnas över en URL som påstår att avin finns — alltså en tyst återvändsgränd.
  await page.goto('/avisering/00000000-0000-4000-8000-000000000000')

  await expect(page).toHaveURL(/\/avisering$/, { timeout: 15_000 })
  await expect(page.getByRole('heading', { name: 'Hyresavier' })).toBeVisible()
  await expect(page.getByRole('dialog')).toBeHidden()
})
