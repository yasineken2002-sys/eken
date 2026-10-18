/**
 * Byggd portal/CSS och riktiga pekarklick över mobilnavigationen.
 * Sessionslagring och GET-data är syntetiska; inga backend-/samtyckesjuridiska bevis.
 */
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test'

const ORIGIN = `http://127.0.0.1:${Number(process.env.PWA_TEST_PORT ?? 4179)}`
const CONSENT = 'eveno-portal-cookies-consent'
const TOKEN = 'PRIVATE_SESSION_ALPHA'
const CHOICES = [
  { label: 'Godkänn', value: 'accepted' },
  { label: 'Endast nödvändiga', value: 'necessary-only' },
] as const
const SCOPES = [
  { label: 'autentiserad mobilnav', path: '/maintenance', width: 320, authenticated: true },
  { label: 'autentiserad mobilnav', path: '/maintenance', width: 430, authenticated: true },
  { label: 'login utan mobilnav', path: '/login', width: 320, authenticated: false },
] as const

test.use({ serviceWorkers: 'block' })

async function prepare(context: BrowserContext, page: Page, authenticated: boolean) {
  const unexpected: string[] = []
  const writes: string[] = []
  const pageErrors: string[] = []
  const inFlight = new Set<Promise<void>>()
  page.on('pageerror', (error) => pageErrors.push(error.message))
  if (authenticated) {
    // Samma browserlagring som förra fokusriggen; verklig store-parser/rehydrering.
    await context.addInitScript((token) => {
      localStorage.setItem(
        'tenant_session',
        JSON.stringify({
          state: {
            sessionToken: token,
            tenant: {
              id: '11111111-1111-4111-8111-111111111111',
              type: 'INDIVIDUAL',
              firstName: 'PRIVATE_ALPHA',
              email: 'a@example.invalid',
            },
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            isAuthenticated: true,
          },
          version: 0,
        }),
      )
    }, TOKEN)
  }
  const handle = async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const api = url.pathname.replace(/^\/(api|v1)/, '')
    const isApi = /^\/(api|v1)\//.test(url.pathname)
    const label = `${request.method()} ${url.origin}${url.pathname}`
    if (!['GET', 'HEAD'].includes(request.method())) {
      writes.push(label)
      await route.abort('blockedbyclient')
      return
    }
    if (url.origin !== ORIGIN) {
      unexpected.push(label)
      await route.abort('blockedbyclient')
      return
    }
    if (request.method() === 'GET' && api === '/public/config') {
      await route.fulfill({ json: { success: true, data: { features: { bankId: false } } } })
      return
    }
    if (authenticated && request.method() === 'GET' && api === '/portal/maintenance') {
      if (request.headers()['authorization'] !== `Bearer ${TOKEN}`) {
        unexpected.push('Fel syntetisk Bearer i maintenance-GET')
        await route.abort('blockedbyclient')
      } else {
        await route.fulfill({ json: { success: true, data: [] } })
      }
      return
    }
    if (isApi || ['xhr', 'fetch'].includes(request.resourceType())) {
      unexpected.push(label)
      await route.abort('blockedbyclient')
      return
    }
    await route.continue()
  }
  await context.route('**/*', async (route) => {
    const work = handle(route)
    inFlight.add(work)
    try {
      await work
    } finally {
      inFlight.delete(work)
    }
  })
  return async () => {
    await Promise.all([...inFlight])
    expect(writes, 'Cookieval ska inte göra API-/nätverksskrivningar').toEqual([])
    expect(unexpected, 'Oväntade API-/externa anrop').toEqual([])
    expect(pageErrors, 'Browserfel').toEqual([])
    // Nätspärren ligger kvar tills den färska Playwright-kontexten stängs.
  }
}

for (const scope of SCOPES) {
  for (const choice of CHOICES) {
    test(`${scope.label}: ${choice.label} kan pekarklickas vid ${scope.width}px`, async ({
      page,
      context,
    }, testInfo) => {
      await page.setViewportSize({ width: scope.width, height: 740 })
      const finish = await prepare(context, page, scope.authenticated)
      try {
        await page.goto(scope.path)
        const dialog = page.getByRole('dialog', { name: 'Cookies', exact: true })
        await expect(dialog).toBeVisible()
        const navigation = page.getByRole('navigation', { name: 'Navigering', exact: true })
        if (scope.authenticated) {
          await expect(page.getByText('Inga felanmälningar', { exact: true })).toBeVisible()
          await expect(navigation).toBeVisible()
        } else {
          await expect(page.getByRole('button', { name: 'Logga in', exact: true })).toBeVisible()
          await expect(navigation).toHaveCount(0)
        }
        await page.evaluate(() => document.fonts.ready.then(() => undefined))
        const before = await page.evaluate(
          (key) => ({
            consent: localStorage.getItem(key),
            at: localStorage.getItem(`${key}-at`),
            session: localStorage.getItem('tenant_session'),
          }),
          CONSENT,
        )
        expect(before.consent).toBeNull()
        expect(before.at).toBeNull()
        const initialUrl = page.url()
        const button = dialog.getByRole('button', { name: choice.label, exact: true })
        await expect(button).toBeVisible()
        await expect(button).toBeEnabled()
        // DOM-hit-test av den verkliga klickpunkten, inte CSS-zindexfacit eller
        // force-click. Ger ett direkt, snabbt fel med faktisk överlagrande nod.
        const hit = await button.evaluate((element) => {
          const rect = element.getBoundingClientRect()
          const x = rect.left + rect.width / 2
          const y = rect.top + rect.height / 2
          const top = document.elementFromPoint(x, y)
          return {
            x,
            y,
            width: innerWidth,
            height: innerHeight,
            targetHit: !!top && (top === element || element.contains(top)),
            topTag: top?.tagName ?? null,
            topLabel: top?.closest('[aria-label]')?.getAttribute('aria-label') ?? null,
          }
        })
        await testInfo.attach('cookie-pointer-hit-test', {
          body: JSON.stringify(hit, null, 2),
          contentType: 'application/json',
        })
        if (scope.authenticated && choice.value === 'accepted') {
          await testInfo.attach(`cookie-mobilnav-${scope.width}`, {
            body: await page.screenshot(),
            contentType: 'image/png',
          })
        }
        expect(hit.x).toBeGreaterThan(0)
        expect(hit.x).toBeLessThan(hit.width)
        expect(hit.y).toBeGreaterThan(0)
        expect(hit.y).toBeLessThan(hit.height)
        expect(hit.targetHit, `Klickpunkten träffade ${hit.topTag}/${hit.topLabel}`).toBe(true)
        const earliest = await page.evaluate(() => Date.now())
        await button.click()
        await expect(dialog).toHaveCount(0)
        const after = await page.evaluate(
          (key) => ({
            consent: localStorage.getItem(key),
            at: localStorage.getItem(`${key}-at`),
            session: localStorage.getItem('tenant_session'),
            now: Date.now(),
          }),
          CONSENT,
        )
        expect(after.consent).toBe(choice.value)
        if (!after.at) throw new Error('Cookievalets tidsstämpel saknas')
        const timestamp = Date.parse(after.at)
        expect(Number.isFinite(timestamp)).toBe(true)
        expect(new Date(timestamp).toISOString()).toBe(after.at)
        expect(timestamp).toBeGreaterThanOrEqual(earliest)
        expect(timestamp).toBeLessThanOrEqual(after.now)
        expect(after.session).toBe(before.session)
        await expect(page).toHaveURL(initialUrl)
      } finally {
        await finish()
      }
    })
  }
}

test('cookieval ligger under öppen felanmälans backdrop vid 1024px', async ({
  page,
  context,
}, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 900 })
  const finish = await prepare(context, page, true)
  try {
    await page.goto('/maintenance')
    await expect(page.getByText('Inga felanmälningar', { exact: true })).toBeVisible()
    const cookies = page.getByRole('dialog', { name: 'Cookies', exact: true })
    await expect(cookies).toBeVisible()
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    const initialUrl = page.url()
    const consentBefore = await page.evaluate(
      (key) => ({
        value: localStorage.getItem(key),
        at: localStorage.getItem(`${key}-at`),
      }),
      CONSENT,
    )
    expect(consentBefore).toEqual({ value: null, at: null })
    await page.getByRole('button', { name: 'Ny felanmälan', exact: true }).click()
    const sheet = page.getByRole('dialog', { name: 'Ny felanmälan', exact: true })
    await expect(sheet).toBeVisible()
    const button = cookies.getByRole('button', { name: 'Godkänn', exact: true })
    const point = await button.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const x = rect.left + rect.width / 2
      const y = rect.top + rect.height / 2
      const top = document.elementFromPoint(x, y)
      return {
        x,
        y,
        cookieHit: !!top && (top === element || element.contains(top)),
        topTag: top?.tagName ?? null,
        topLabel: top?.closest('[aria-label]')?.getAttribute('aria-label') ?? null,
      }
    })
    const bounds = await sheet.boundingBox()
    if (!bounds) throw new Error('Öppna panelens verkliga bounds saknas')
    await testInfo.attach('cookie-under-sheet-backdrop', {
      body: JSON.stringify({ point, sheet: bounds }, null, 2),
      contentType: 'application/json',
    })
    expect(
      point.x < bounds.x || point.x > bounds.x + bounds.width,
      'Cookiepunkt ska ligga utanför panelen, inte döljas av själva panelen',
    ).toBe(true)
    expect(point.x).toBeGreaterThan(0)
    expect(point.x).toBeLessThan(1024)
    expect(point.y).toBeGreaterThan(0)
    expect(point.y).toBeLessThan(900)
    expect(point.cookieHit, 'Öppen panels backdrop ska få pekarträffen').toBe(false)
    // Verklig muspunkt: ingen DOM-click/force eller z-indexförväntning.
    await page.mouse.click(point.x, point.y)
    await expect(sheet).toHaveCount(0)
    await expect(cookies).toBeVisible()
    expect(
      await page.evaluate(
        (key) => ({
          value: localStorage.getItem(key),
          at: localStorage.getItem(`${key}-at`),
        }),
        CONSENT,
      ),
    ).toEqual({ value: null, at: null })
    const earliest = await page.evaluate(() => Date.now())
    await button.click()
    await expect(cookies).toHaveCount(0)
    const selected = await page.evaluate(
      (key) => ({
        value: localStorage.getItem(key),
        at: localStorage.getItem(`${key}-at`),
        now: Date.now(),
      }),
      CONSENT,
    )
    expect(selected.value).toBe('accepted')
    if (!selected.at) throw new Error('Cookievalets tidsstämpel saknas')
    const timestamp = Date.parse(selected.at)
    expect(Number.isFinite(timestamp)).toBe(true)
    expect(new Date(timestamp).toISOString()).toBe(selected.at)
    expect(timestamp).toBeGreaterThanOrEqual(earliest)
    expect(timestamp).toBeLessThanOrEqual(selected.now)
    await expect(page).toHaveURL(initialUrl)
  } finally {
    await finish()
  }
})
