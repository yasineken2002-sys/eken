import { test, expect } from '@playwright/test'
import { registerOrg } from './helpers/seed'

test('uppföljning: djuplänk, ägarens reglage, omladdning och notis tillbaka till granskningen', async ({
  page,
  request,
}) => {
  const { email, password } = await registerOrg(request)
  await page.goto('/login')
  await page.getByLabel('E-postadress').fill(email)
  await page.locator('input[autocomplete="current-password"]').fill(password)
  await page.locator('button[type="submit"]').click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 })
  await page.goto('/consumption?tab=review')
  const followUp = page.getByRole('region', { name: 'Automatisk uppföljning' })
  await expect(followUp.getByText('Automatisk uppföljning är avstängd.')).toBeVisible()
  await followUp.getByRole('button', { name: 'Slå på automatisk uppföljning' }).click()
  await expect(
    followUp.getByRole('button', { name: 'Stäng av automatisk uppföljning' }),
  ).toBeVisible()
  await page.reload()
  await expect(
    followUp.getByRole('button', { name: 'Stäng av automatisk uppföljning' }),
  ).toBeVisible()
  await followUp.getByRole('button', { name: 'Stäng av automatisk uppföljning' }).click()
  await expect(followUp.getByText('Automatisk uppföljning är avstängd.')).toBeVisible()

  // Bara notislistan är attrapp: cronets skrivning bevisas separat mot Postgres.
  // Här prövas den verkliga klickvägen, routern och flikvalet.
  await page.route(
    (url) => url.pathname === '/v1/notifications',
    async (route) => {
      await route.fulfill({
        json: {
          success: true,
          data: [
            {
              id: 'reading-review-test',
              type: 'SYSTEM',
              title: 'Avläsningar behöver bedömas',
              message: 'Öppna aktuell granskningskö.',
              read: true,
              createdAt: new Date().toISOString(),
              link: '/consumption?tab=review',
            },
          ],
        },
      })
    },
  )
  await page.goto('/notifications')
  await page.getByText('Avläsningar behöver bedömas', { exact: true }).click()
  await expect(page).toHaveURL(/\/consumption\?tab=review$/)
  await expect(page.getByRole('heading', { name: 'Avläsningar att kontrollera' })).toBeVisible()
  await page.getByRole('button', { name: 'Mätare', exact: true }).click()
  await expect(page).toHaveURL(/tab=meters/)
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Avläsningar att kontrollera' })).toBeVisible()
})
