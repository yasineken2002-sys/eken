/**
 * Riktig byggd portal, Chromium, HTTP, service worker och CacheStorage.
 * API/bank/dokument är syntetiska svar från en lokal HTTP-server; ingen route
 * uppfyller nät- eller workersvar. Bevisar inte livebackend eller OS-installation
 * på iPhone. V2 byter bara versionsnamn i den byggda produktionsworkern.
 */
import { errors, expect, test, type APIRequestContext, type Page } from '@playwright/test'

const PORT = Number(process.env.PWA_TEST_PORT ?? 4179)
const ORIGIN = `http://127.0.0.1:${PORT}`
const EXTERNAL_ORIGIN = `http://127.0.0.1:${PORT + 1}`
const CACHE = 'eveno-portal-offline-v1'
const FALLBACK = '/offline-v1.html'
const PRIVATE = /PRIVATE_|SyntheticPassword|@example\.invalid|signature=/i

type Counters = {
  posts: string[]
  privateReads: { actor: string; path: string }[]
  documentReads: string[]
  offlineRequests: number
}

async function configure(request: APIRequestContext, settings: Record<string, unknown>) {
  const response = await request.post('/__fixture/configure', { data: settings })
  expect(response.status()).toBe(200)
}

async function counters(request: APIRequestContext): Promise<Counters> {
  const response = await request.get('/__fixture/state')
  expect(response.status()).toBe(200)
  return response.json()
}

async function cacheSnapshot(page: Page) {
  return page.evaluate(async () => {
    const result = []
    for (const name of await caches.keys()) {
      const cache = await caches.open(name)
      const entries = []
      for (const request of await cache.keys()) {
        const response = await cache.match(request)
        entries.push({
          url: request.url,
          method: request.method,
          requestHeaders: [...request.headers.entries()],
          responseHeaders: response ? [...response.headers.entries()] : [],
          body: response ? await response.text() : null,
        })
      }
      result.push({ name, entries })
    }
    return result
  })
}

async function expectOnlyPublicCache(page: Page) {
  const snapshot = await cacheSnapshot(page)
  expect(snapshot.map((entry) => entry.name)).toEqual([CACHE])
  expect(snapshot[0]?.entries).toHaveLength(1)
  expect(snapshot[0]?.entries[0]?.url).toBe(`${ORIGIN}${FALLBACK}`)
  expect(snapshot[0]?.entries[0]?.method).toBe('GET')
  expect(snapshot[0]?.entries[0]?.body).toContain('Du är offline')
  expect(JSON.stringify(snapshot)).not.toMatch(PRIVATE)
  return snapshot
}

async function acceptCookies(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Cookies' })
  if (await dialog.isVisible()) {
    await dialog.getByRole('button', { name: 'Endast nödvändiga' }).click()
    await expect(dialog).toBeHidden()
  }
}

async function openControlled(page: Page) {
  await page.goto('/login')
  await expect(page.getByRole('button', { name: 'Logga in', exact: true })).toBeVisible()
  await acceptCookies(page)
  await expect
    .poll(() =>
      page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state),
    )
    .toBe('activated')
  // Första install gör ingen clients.claim. En verklig ny navigation ska ge
  // controller innan ett enda offlinepåstående görs.
  await page.reload()
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL))
    .toBe(`${ORIGIN}/portal-sw.js`)
}

async function login(page: Page, actor: 'a' | 'b') {
  await page.getByLabel('E-postadress').fill(`${actor}@example.invalid`)
  await page.getByLabel('Lösenord', { exact: true }).fill('SyntheticPassword123!')
  await page.getByRole('button', { name: 'Logga in', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(
    page.getByText(actor === 'a' ? /PRIVATE_ALPHA/ : /PRIVATE_BETA/).first(),
  ).toBeVisible()
}

test.beforeEach(async ({ context, request }) => {
  expect((await request.post('/__fixture/reset')).status()).toBe(200)
  // Endast blockering, aldrig fulfill. SW:s verkliga nätväg går till vår
  // loopbackserver. Även byggd telemetri/externt API får inte lämna riggen.
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin === ORIGIN || url.origin === EXTERNAL_ORIGIN) await route.continue()
    else await route.abort('blockedbyclient')
  })
})

test('manifest, ikoner och worker levereras som verkliga statiska resurser med rätt format', async ({
  page,
  request,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 })
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: 'Portalen på din enhet' })).toBeVisible()
  await acceptCookies(page)
  await page.locator('summary').filter({ hasText: 'Så lägger du till portalen' }).click()
  await expect(page.getByText(/På iPhone eller iPad/)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  await testInfo.attach('installation-hjalp-320', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  })
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href')
  expect(manifestHref).toBe('/manifest.webmanifest')
  const response = await request.get('/manifest.webmanifest')
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toContain('application/manifest+json')
  expect(response.headers()['cache-control']).toContain('must-revalidate')
  const manifest = await response.json()
  expect(manifest).toMatchObject({
    name: 'Eveno Hyresgästportal',
    short_name: 'Eveno',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    lang: 'sv',
  })
  expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i)
  expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i)
  expect(JSON.stringify(manifest)).not.toMatch(PRIVATE)
  for (const size of [192, 512]) {
    const icon = manifest.icons.find(
      (candidate: { sizes: string }) => candidate.sizes === `${size}x${size}`,
    )
    expect(icon).toBeDefined()
    const png = await request.get(icon.src)
    expect(png.status()).toBe(200)
    expect(png.headers()['content-type']).toBe('image/png')
    const dimensions = await page.evaluate(async (src: string) => {
      const image = new Image()
      image.src = src
      await image.decode()
      return [image.naturalWidth, image.naturalHeight]
    }, icon.src)
    expect(dimensions).toEqual([size, size])
  }
  const apple = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href')
  expect(apple).toBeTruthy()
  const appleDimensions = await page.evaluate(async (src) => {
    if (!src) throw new Error('Apple-ikon saknas')
    const image = new Image()
    image.src = src
    await image.decode()
    return [image.naturalWidth, image.naturalHeight]
  }, apple)
  expect(appleDimensions).toEqual([180, 180])
  const worker = await request.get('/portal-sw.js')
  expect(worker.status()).toBe(200)
  expect(worker.headers()['content-type']).toContain('javascript')
  expect(worker.headers()['cache-control']).toContain('must-revalidate')
  for (const missing of ['/missing.js', '/icons/missing.png', '/unknown-route']) {
    const result = await request.get(missing)
    expect(result.status()).toBe(404)
    expect(result.headers()['content-type']).not.toContain('text/html')
  }
})

test('login A, privata API/dokument, logout och login B lämnar endast offentlig fallback i CacheStorage', async ({
  page,
  request,
}, testInfo) => {
  await openControlled(page)
  await expectOnlyPublicCache(page)
  for (const actor of ['a', 'b'] as const) {
    await login(page, actor)
    await page.getByRole('link', { name: 'Dokument', exact: true }).click()
    await expect(
      page.getByText(`PRIVATE_DOCUMENT_${actor.toUpperCase()}`, { exact: true }),
    ).toBeVisible()
    if (actor === 'b') await expect(page.locator('body')).not.toContainText('PRIVATE_DOCUMENT_A')
    // Privata HTTP-bytes hämtas faktiskt i den kontrollerade browsern. Detta
    // testar SW/cachegränsen, inte operativsystemets PDF-nedladdningsdialog.
    const document = await page.evaluate(async (who) => {
      const token = who === 'a' ? 'PRIVATE_SESSION_ALPHA' : 'PRIVATE_SESSION_BETA'
      const result = await fetch(`/api/portal/documents/doc-${who}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const { data } = await result.json()
      const pdf = await fetch(data.url)
      return {
        apiStatus: result.status,
        status: pdf.status,
        type: pdf.headers.get('content-type'),
        body: await pdf.text(),
      }
    }, actor)
    expect(document).toMatchObject({ apiStatus: 200, status: 200, type: 'application/pdf' })
    expect(document.body).toContain(actor === 'a' ? 'PRIVATE_PDF_ALPHA' : 'PRIVATE_PDF_BETA')
    await expectOnlyPublicCache(page)
    if (actor === 'a') {
      await page.getByRole('button', { name: 'Logga ut', exact: true }).click()
      await expect(page).toHaveURL(/\/login$/)
    }
  }
  const seen = await counters(request)
  expect(seen.posts).toEqual([
    '/tenant-portal/login/resolve',
    '/tenant-portal/logout',
    '/tenant-portal/login/resolve',
  ])
  for (const actor of ['a', 'b'])
    expect(seen.privateReads).toContainEqual({ actor, path: '/portal/documents' })
  expect(seen.documentReads).toEqual(['/private/document-a.pdf', '/private/document-b.pdf'])
  await testInfo.attach('cache-efter-kontobyte', {
    body: JSON.stringify(await expectOnlyPublicCache(page), null, 2),
    contentType: 'application/json',
  })
})

test('verkligt offline ger fallback bara för tillåtna navigationer, aldrig API, PDF, token eller extern origin', async ({
  page,
  context,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openControlled(page)
  const appProbe = await context.newPage()
  // Fetch måste utgå från redan laddad app, inte offentlig offline-HTML vars
  // avsiktliga default-src 'none' annars ensam skulle neka samtliga anrop.
  const probeFetches = () =>
    appProbe.evaluate(async (external) => {
      const results = []
      for (const url of [
        '/api/portal/dashboard',
        '/v1/portal/dashboard',
        '/private/document-a.pdf?signature=PRIVATE_SIGNED_A',
        external,
      ]) {
        const headers =
          url.startsWith('/api/portal/') || url.startsWith('/v1/portal/')
            ? { Authorization: 'Bearer PRIVATE_SESSION_ALPHA' }
            : undefined
        try {
          const response = await fetch(url, headers ? { headers } : {})
          results.push({ url, status: response.status })
        } catch {
          results.push({ url, failed: true })
        }
      }
      try {
        const response = await fetch('/api/tenant-portal/forgot-password', {
          method: 'POST',
          body: '{}',
        })
        results.push({ url: 'POST', status: response.status })
      } catch {
        results.push({ url: 'POST', failed: true })
      }
      return results
    }, EXTERNAL_ORIGIN)
  try {
    await openControlled(appProbe)
    const onlineResults = await probeFetches()
    expect(onlineResults).toHaveLength(5)
    for (const result of onlineResults) expect(result).toHaveProperty('status', 200)
    await context.setOffline(true)
    for (const path of ['/login', '/dashboard', '/documents']) {
      const response = await page.goto(path)
      expect(response?.status()).toBe(503)
      expect(response?.fromServiceWorker()).toBe(true)
      await expect(page.getByRole('heading', { name: 'Du är offline' })).toBeVisible()
      expect(await page.content()).not.toMatch(PRIVATE)
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
    await testInfo.attach('offentlig-offline-390', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    })
    const fetchResults = await probeFetches()
    expect(fetchResults).toHaveLength(5)
    for (const result of fetchResults) expect(result).toHaveProperty('failed', true)
    for (const path of [
      '/api/portal/dashboard',
      '/private/document-a.pdf?signature=PRIVATE_SIGNED_A',
      '/activate?token=PRIVATE_ACTIVATION',
      '/reset-password?token=PRIVATE_RESET',
      '/login?next=PRIVATE_QUERY',
      '/unknown-route',
      `${EXTERNAL_ORIGIN}/documents`,
    ]) {
      const probe = await context.newPage()
      try {
        const result = await probe.goto(path.startsWith('http') ? path : `${ORIGIN}${path}`).then(
          (response) => ({ response, error: null }),
          (error: Error) => ({ response: null, error: error.message }),
        )
        expect(result.response, path).toBeNull()
        expect(result.error, path).toMatch(/ERR_INTERNET_DISCONNECTED|ERR_FAILED/)
      } finally {
        await probe.close()
      }
    }
  } finally {
    await context.setOffline(false)
    await appProbe.close()
  }
})

test('riktiga HTTP500 från navigation och API bevaras och cachas inte som offlineframgång', async ({
  page,
  request,
}) => {
  await openControlled(page)
  await configure(request, { navigation500: true })
  const response = await page.goto('/documents')
  expect(response?.status()).toBe(500)
  await expect(page.locator('body')).toContainText('REAL_NAVIGATION_500')
  await expect(page.getByRole('heading', { name: 'Du är offline' })).toHaveCount(0)
  const api = await page.evaluate(async () => {
    const response = await fetch('/api/portal/failure')
    return { status: response.status, body: await response.json() }
  })
  expect(api).toEqual({ status: 500, body: { sentinel: 'REAL_HTTP_500' } })
  await expectOnlyPublicCache(page)
})

test('kontrollerad portal behåller offlineutkast och återanslutning gör inga automatiska POST', async ({
  page,
  context,
  request,
}) => {
  await openControlled(page)
  await page.goto('/forgot-password')
  await page.getByLabel('E-postadress').fill('draft@example.invalid')
  await context.setOffline(true)
  try {
    await page.getByRole('button', { name: 'Skicka återställningslänk' }).click()
    await expect(page.locator('form').getByRole('alert')).toContainText(
      /offline|internetanslutning/i,
    )
    await expect(page.getByLabel('E-postadress')).toHaveValue('draft@example.invalid')
    await expect(page.getByLabel('E-postadress')).toBeEnabled()
    expect((await counters(request)).posts).toEqual([])
    const automaticPost = page
      .waitForRequest((req) => req.method() === 'POST', { timeout: 1000 })
      .then(
        () => true,
        (error: unknown) => {
          if (!(error instanceof errors.TimeoutError)) throw error
          return false
        },
      )
    await context.setOffline(false)
    expect(await automaticPost).toBe(false)
    expect((await counters(request)).posts).toEqual([])
    await page.getByRole('button', { name: 'Skicka återställningslänk' }).click()
    await expect(page.getByRole('heading', { name: 'Mejl skickat' })).toBeVisible()
    expect((await counters(request)).posts).toEqual(['/tenant-portal/forgot-password'])
    await expectOnlyPublicCache(page)
  } finally {
    await context.setOffline(false)
  }
})

for (const fallback of ['404', 'mime', 'tamper'] as const) {
  test(`installation nekas när den offentliga offlinefilen har ${fallback}`, async ({
    page,
    request,
  }) => {
    await configure(request, { fallback })
    await page.goto('/login')
    await expect(page.getByRole('button', { name: 'Logga in', exact: true })).toBeVisible()
    // Observera att ett verkligt installationsförsök nått HTTP-servern innan
    // frånvaron av aktiv worker får räknas som bevis på nekad installation.
    await expect.poll(async () => (await counters(request)).offlineRequests).toBeGreaterThan(0)
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const registrations = await navigator.serviceWorker.getRegistrations()
          return registrations.some(
            (registration) =>
              registration.installing || registration.waiting || registration.active,
          )
        }),
      )
      .toBe(false)
    expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull()
    const snapshot = await cacheSnapshot(page)
    expect(snapshot.flatMap((cache) => cache.entries)).toEqual([])
    await acceptCookies(page)
    await login(page, 'a') // Installationsfel får inte slå ut onlineportalen.
  })
}

test('V2 väntar utan omladdning eller utkastförlust och rensar bara äldre egna cacheversioner', async ({
  page,
  context,
  request,
}) => {
  await openControlled(page)
  await page.getByLabel('E-postadress').fill('draft@example.invalid')
  await page.getByLabel('Lösenord', { exact: true }).fill('SyntheticPassword123!')
  await page.evaluate(async () => {
    Reflect.set(window, '__pwaDocumentIdentity', 'original-open-form')
    const cache = await caches.open('another-app-test-cache')
    await cache.put('/another-app-public-resource', new Response('FOREIGN_PUBLIC_SENTINEL'))
  })
  await configure(request, { version: 2 })
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration()
    if (!registration) throw new Error('Registrering saknas')
    await registration.update()
  })
  await expect
    .poll(() =>
      page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state),
    )
    .toBe('installed')
  expect(await page.evaluate(() => Reflect.get(window, '__pwaDocumentIdentity'))).toBe(
    'original-open-form',
  )
  await expect(page.getByLabel('E-postadress')).toHaveValue('draft@example.invalid')
  await expect(page.getByLabel('Lösenord', { exact: true })).toHaveValue('SyntheticPassword123!')
  expect((await cacheSnapshot(page)).map((entry) => entry.name)).toEqual(
    expect.arrayContaining([CACHE, 'eveno-portal-offline-v2', 'another-app-test-cache']),
  )
  await page.close() // Naturlig livscykel: alla gamla kontrollerade flikar stängs.
  const next = await context.newPage()
  await openControlled(next)
  await expect
    .poll(async () => (await cacheSnapshot(next)).map((entry) => entry.name).sort())
    .toEqual(['another-app-test-cache', 'eveno-portal-offline-v2'])
  const snapshot = await cacheSnapshot(next)
  const foreign = snapshot.find((entry) => entry.name === 'another-app-test-cache')
  expect(foreign?.entries[0]?.body).toBe('FOREIGN_PUBLIC_SENTINEL')
  const own = snapshot.find((entry) => entry.name === 'eveno-portal-offline-v2')
  expect(own?.entries.map((entry) => entry.url)).toEqual([`${ORIGIN}/offline-v2.html`])
  expect(JSON.stringify(own)).not.toMatch(PRIVATE)
})
