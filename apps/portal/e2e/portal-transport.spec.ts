import { errors, expect, test, type BrowserContext } from '@playwright/test'

const PORT = Number(process.env.PWA_TEST_PORT ?? 4179)
const FIXTURE_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://127.0.0.1:${PORT + 1}`])

async function allowOnlyFixtureOrigins(context: BrowserContext) {
  // Endast blockering. Nät- och workersvar kommer från den riktiga testservern.
  await context.route('**/*', async (route) => {
    if (FIXTURE_ORIGINS.has(new URL(route.request().url()).origin)) await route.continue()
    else await route.abort('blockedbyclient')
  })
}

// Verkligt stängd TCP-respons från testservern, utan setOffline-emulering.
// Detta är ett serveravbrott och ersätter inte provet på offline-klient.
test('byggd worker visar offentlig 503 vid TCP-avbrott medan en klient utan worker får nätfel', async ({
  page,
  context,
  request,
  browser,
}, testInfo) => {
  expect((await request.post('/__fixture/reset')).status()).toBe(200)
  await allowOnlyFixtureOrigins(context)
  await page.goto('/login')
  await expect
    .poll(() =>
      page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state),
    )
    .toBe('activated')
  await page.reload()
  expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toContain(
    '/portal-sw.js',
  )
  const before = await page.evaluate(async () => {
    const names = await caches.keys()
    const cache = await caches.open('eveno-portal-offline-v1')
    return { names, keys: (await cache.keys()).map((entry) => new URL(entry.url).pathname) }
  })
  expect(before).toEqual({ names: ['eveno-portal-offline-v1'], keys: ['/offline-v1.html'] })
  let control: BrowserContext | undefined
  try {
    expect(
      (await request.post('/__fixture/configure', { data: { dropNavigation: true } })).status(),
    ).toBe(200)
    control = await browser.newContext({ serviceWorkers: 'block' })
    await allowOnlyFixtureOrigins(control)
    const plain = await control.newPage()
    const error = await plain.goto(new URL('/dashboard', page.url()).href).then(
      () => null,
      (value: unknown) => value,
    )
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(errors.TimeoutError)
    const response = await page.goto('/dashboard')
    expect(response?.status()).toBe(503)
    expect(response?.fromServiceWorker()).toBe(true)
    await expect(page.getByRole('heading', { name: 'Du är offline' })).toBeVisible()
    expect(await page.content()).not.toMatch(/PRIVATE_|SyntheticPassword|@example\.invalid/)
    await testInfo.attach('TCP-avbrott', {
      body: JSON.stringify(
        {
          withoutWorker: error instanceof Error ? error.message : null,
          withWorkerStatus: response?.status(),
          fromServiceWorker: response?.fromServiceWorker(),
          navigatorOnline: await page.evaluate(() => navigator.onLine),
          before,
        },
        null,
        2,
      ),
      contentType: 'application/json',
    })
  } finally {
    try {
      await control?.close()
    } finally {
      expect(
        (await request.post('/__fixture/configure', { data: { dropNavigation: false } })).status(),
      ).toBe(200)
    }
  }
})
