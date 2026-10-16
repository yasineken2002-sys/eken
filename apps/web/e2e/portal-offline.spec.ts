/**
 * Riktig Chromium-offline via context.setOffline, inte ett konstruerat
 * online/offline-event eller ändring av navigator.onLine. DOM och formulär körs.
 * Online-API:t är syntetiskt: inget mejl, AI-anrop eller backendarbete sker.
 *
 * Playwright kan leverera route.fulfill även när Chromium är offline. Därför
 * avbryter API-stubben uttryckligen eventuella offline-anrop med
 * internetdisconnected. Browserns riktiga nätläge verifieras separat. Räknarna
 * skiljer browserns POST-försök från online-anrop som stubben har godkänt.
 */
import { expect, test, type Request } from '@playwright/test'

const PORTAL = 'http://localhost:5174'
const EMAIL = 'Syntetisk.Natkontroll@example.invalid'
const RESET_PATH = /^\/(?:api|v1)\/tenant-portal\/forgot-password$/
const isResetPost = (request: Request) =>
  request.method() === 'POST' && RESET_PATH.test(new URL(request.url()).pathname)

test.use({ serviceWorkers: 'block' })

test('portal: offline återställning behåller utkast och skickas först efter ett nytt aktivt klick', async ({
  page,
  context,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  let offline = false
  let blockedOfflinePosts = 0
  const browserPosts: Array<'offline' | 'online'> = []
  const acceptedOnlinePosts: unknown[] = []
  const unexpectedRequests: string[] = []
  const pageErrors: string[] = []

  page.on('request', (request) => {
    if (isResetPost(request)) browserPosts.push(offline ? 'offline' : 'online')
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const resetEndpoint = RESET_PATH.test(url.pathname)
    const configEndpoint = /^\/(?:api|v1)\/public\/config$/.test(url.pathname)
    const headers = {
      'access-control-allow-origin': PORTAL,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type, X-Dev-Tenant-Id',
    }
    if (resetEndpoint || configEndpoint) {
      if (offline) {
        if (isResetPost(request)) blockedOfflinePosts += 1
        await route.abort('internetdisconnected')
        return
      }
      if (request.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers })
        return
      }
      if (resetEndpoint && request.method() === 'POST') {
        const payload: unknown = request.postDataJSON()
        acceptedOnlinePosts.push(payload)
        await route.fulfill({
          status: 200,
          headers,
          json: {
            success: true,
            data: { message: 'Om kontot finns skickas återställningsinstruktioner.' },
          },
        })
        return
      }
      if (configEndpoint && request.method() === 'GET') {
        await route.fulfill({
          status: 200,
          headers,
          json: { success: true, data: { features: { bankId: false } } },
        })
        return
      }
    }
    // Vites egen lokala återanslutningskontroll är inte ett produkt-API.
    const vitePing =
      url.origin === PORTAL &&
      url.pathname === '/' &&
      request.headers()['accept'] === 'text/x-vite-ping'
    if (
      !vitePing &&
      (url.origin !== PORTAL ||
        ['xhr', 'fetch'].includes(request.resourceType()) ||
        /^\/(?:api|v1)\//.test(url.pathname))
    ) {
      unexpectedRequests.push(`${request.method()} ${url.origin}${url.pathname}`)
      await route.abort('blockedbyclient')
      return
    }
    await route.continue()
  })

  try {
    await page.goto(`${PORTAL}/forgot-password`)
    const cookies = page.getByRole('dialog', { name: 'Cookies', exact: true })
    await expect(cookies).toBeVisible()
    await cookies.getByRole('button', { name: 'Endast nödvändiga', exact: true }).click()
    await expect(cookies).toBeHidden()
    const form = page.locator('form')
    const email = form.getByLabel('E-postadress', { exact: true })
    const submit = form.getByRole('button', { name: 'Skicka återställningslänk', exact: true })
    await email.fill(EMAIL)

    offline = true
    await context.setOffline(true)
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false)
    await submit.click()

    // Baslinjen ska falla på pausad mutation/avsaknad av fel, före den nya bannern.
    await expect(form.getByRole('alert')).toContainText(/offline|internetanslutning/i)
    await expect(email).toBeEditable()
    await expect(email).toHaveValue(EMAIL)
    await expect(submit).toBeEnabled()
    await expect(page.getByRole('heading', { name: 'Mejl skickat', exact: true })).toHaveCount(0)
    const banner = page.getByRole('status').filter({ hasText: /Du är offline/i })
    await expect(banner).toBeVisible()
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0)
    await testInfo.attach('portal-offline-mobil', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    })
    expect(acceptedOnlinePosts).toEqual([])
    expect(browserPosts.filter((state) => state === 'online')).toEqual([])

    // Registrera före återanslutningen: även en omedelbart återupptagen mutation
    // fångas. Detta är ett avgränsat observationsfönster, inte ett evighetsbevis.
    const automaticPost = page.waitForRequest(isResetPost, { timeout: 1_000 }).then(
      () => true,
      (error: unknown) => {
        if (error instanceof Error && error.name === 'TimeoutError') return false
        throw error
      },
    )
    offline = false
    await context.setOffline(false)
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true)
    expect(await automaticPost).toBe(false)
    expect(acceptedOnlinePosts).toEqual([])
    expect(browserPosts.filter((state) => state === 'online')).toEqual([])
    await expect(banner).toBeHidden()
    await expect(email).toBeEditable()
    await expect(email).toHaveValue(EMAIL)
    await expect(submit).toBeEnabled()
    await expect(page.getByRole('heading', { name: 'Mejl skickat', exact: true })).toHaveCount(0)

    await submit.click()
    await expect(page.getByRole('heading', { name: 'Mejl skickat', exact: true })).toBeVisible()
    expect(browserPosts.filter((state) => state === 'online')).toEqual(['online'])
    expect(acceptedOnlinePosts).toEqual([{ email: EMAIL.toLowerCase() }])
    await expect(page).toHaveURL(`${PORTAL}/forgot-password`)
    expect(unexpectedRequests).toEqual([])
    expect(pageErrors).toEqual([])
  } finally {
    // Rensa bara testets browserläge. Inga lagringsvärden eller app-event ändras.
    offline = false
    await context.setOffline(false)
    await testInfo.attach('offline-HTTP-raknare', {
      body: JSON.stringify({ browserPosts, blockedOfflinePosts, acceptedOnlinePosts }, null, 2),
      contentType: 'application/json',
    })
  }
})
