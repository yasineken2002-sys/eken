/**
 * Visningsbevis: riktig Chromium, portalens DOM/CSS och tangentbordsbeteende.
 * API-svaren och kontona är syntetiska. Detta bevisar varken lösenordskontroll,
 * Redis-kvoter, behörighet eller sessioner i backend; de mäts i API-proven.
 * Endast lokal Vite/statik och de två uttryckligen stubbade API-vägarna tillåts.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'

const PORTAL = 'http://localhost:5174'
const EMAIL = 'Syntetisk.Hyresgast@example.invalid'
const PASSWORD = 'Syntetiskt-Visningsprov-123!'
const CANDIDATES = [
  {
    organizationId: '2f5295ba-7240-49fe-8d05-57680c2b3211',
    organizationName:
      'Stiftelsen Norra Skärgårdens och Roslagens långsiktiga bostadsförvaltning för hyresgäster i Norrtälje, Österåker, Vaxholm och angränsande kommuner — syntetisk visningsvärd',
  },
  {
    organizationId: 'f7ce2517-6ed9-4f3b-91ed-60d6c9987dd2',
    organizationName:
      'StockholmsNordvästraFastighetsförvaltningOchBostadsutvecklingFörHyresrätterIBrommaSolnaSundbybergKistaOchJärfällaAktiebolagSyntetiskVisningsvärd',
  },
] as const

test.use({ serviceWorkers: 'block' })

async function noHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
          window.innerWidth,
      ),
    )
    .toBeLessThanOrEqual(0)
}

async function reachableTouchTarget(target: Locator, page: Page): Promise<void> {
  await target.scrollIntoViewIfNeeded()
  await expect(target).toBeVisible()
  // Verklig hit-testing: inget överlägg får blockera kontrollen.
  await target.click({ trial: true })
  const box = await target.boundingBox()
  if (!box) throw new Error('Kontrollens renderade yta saknas')
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('Provets viewport saknas')
  expect(box.width).toBeGreaterThanOrEqual(44)
  expect(box.height).toBeGreaterThanOrEqual(44)
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 0.5)
}

for (const viewport of [
  { name: 'mobil 320×740', width: 320, height: 740 },
  { name: 'dator 1280×900', width: 1280, height: 900 },
]) {
  test(`portalens hyresvärdsval: ${viewport.name}, långa namn och tangentbord`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    const requests: unknown[] = []
    const unexpectedRequests: string[] = []
    const pageErrors: string[] = []
    let featureRequests = 0
    page.on('pageerror', (error) => pageErrors.push(error.message))

    await page.route('**/*', async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const featureEndpoint = /^\/(?:api|v1)\/public\/config$/.test(url.pathname)
      const loginEndpoint = /^\/(?:api|v1)\/tenant-portal\/login\/resolve$/.test(url.pathname)
      const headers = {
        'access-control-allow-origin': PORTAL,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'Content-Type, X-Dev-Tenant-Id',
      }
      if ((featureEndpoint || loginEndpoint) && request.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers })
        return
      }
      if (featureEndpoint && request.method() === 'GET') {
        featureRequests += 1
        await route.fulfill({
          status: 200,
          headers,
          json: { success: true, data: { features: { bankId: false } } },
        })
        return
      }
      if (loginEndpoint && request.method() === 'POST') {
        const payload: unknown = request.postDataJSON()
        requests.push(payload)
        const selected =
          payload !== null && typeof payload === 'object' && 'organizationId' in payload
        await route.fulfill({
          status: selected ? 401 : 200,
          headers,
          json: selected
            ? {
                success: false,
                error: { code: 'UNAUTHORIZED', message: 'Felaktig e-post eller lösenord' },
              }
            : { success: true, data: { status: 'choose', candidates: CANDIDATES } },
        })
        return
      }
      if (
        url.origin !== PORTAL ||
        ['xhr', 'fetch'].includes(request.resourceType()) ||
        /^\/(?:api|v1)\//.test(url.pathname)
      ) {
        unexpectedRequests.push(`${request.method()} ${url.origin}${url.pathname}`)
        await route.abort('blockedbyclient')
        return
      }
      await route.continue()
    })

    await page.goto(`${PORTAL}/login`)
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    const cookies = page.getByRole('dialog', { name: 'Cookies', exact: true })
    await expect(cookies).toBeVisible()
    await cookies.getByRole('button', { name: 'Endast nödvändiga', exact: true }).click()
    await expect(cookies).toBeHidden()
    await expect.poll(() => featureRequests).toBeGreaterThan(0)
    await expect(page.getByRole('button', { name: /Logga in med BankID/ })).toHaveCount(0)
    await page.getByLabel('E-postadress', { exact: true }).fill(EMAIL)
    await page.getByLabel('Lösenord', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Logga in', exact: true }).click()

    const choices = page.getByRole('group', { name: 'Välj hyresvärd', exact: true })
    const first = page.getByRole('radio', { name: CANDIDATES[0].organizationName, exact: true })
    const second = page.getByRole('radio', { name: CANDIDATES[1].organizationName, exact: true })
    const proceed = page.getByRole('button', { name: 'Fortsätt', exact: true })
    const back = page.getByRole('button', { name: 'Tillbaka', exact: true })
    await expect(choices).toBeVisible()
    await expect(choices).toBeFocused()
    await expect(choices.getByRole('radio')).toHaveCount(2)
    await expect(first).not.toBeChecked()
    await expect(second).not.toBeChecked()
    await expect(proceed).toBeDisabled()
    await noHorizontalOverflow(page)

    // Native radio ger piltangentsval; ingen direkt setChecked eller DOM-mutation.
    await page.keyboard.press('Tab')
    await expect(first).toBeFocused()
    await page.keyboard.press('Space')
    await expect(first).toBeChecked()
    await page.keyboard.press('ArrowDown')
    await expect(second).toBeFocused()
    await expect(second).toBeChecked()
    await expect(first).not.toBeChecked()
    await page.keyboard.press('ArrowUp')
    await expect(first).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(second).toBeChecked()
    await page.keyboard.press('Tab')
    await expect(proceed).toBeFocused()
    await expect(proceed).toBeEnabled()

    for (const radio of [first, second]) {
      const label = page.locator('label').filter({ has: radio })
      await reachableTouchTarget(label, page)
      const textFits = await label.evaluate((element) => element.scrollWidth <= element.clientWidth)
      expect(textFits).toBe(true)
    }
    await reachableTouchTarget(proceed, page)
    await reachableTouchTarget(back, page)
    await noHorizontalOverflow(page)
    await testInfo.attach(`Hyresvärdsval ${viewport.name}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    })

    // Tillbaka får inte skicka det gamla valet eller behålla lösenordet.
    await back.click()
    await expect(choices).toHaveCount(0)
    await expect(page.getByLabel('E-postadress', { exact: true })).toHaveValue(EMAIL)
    await expect(page.getByLabel('Lösenord', { exact: true })).toHaveValue('')
    await expect(page.getByLabel('Lösenord', { exact: true })).toBeFocused()
    await expect(page.getByRole('button', { name: 'Logga in', exact: true })).toBeDisabled()
    expect(requests).toEqual([{ email: EMAIL.toLowerCase(), password: PASSWORD }])

    await page.getByLabel('Lösenord', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Logga in', exact: true }).click()
    await expect(choices).toBeFocused()
    await expect(second).not.toBeChecked()
    await expect(proceed).toBeDisabled()
    await page.keyboard.press('Tab')
    await expect(first).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(second).toBeFocused()
    await expect(second).toBeChecked()
    await proceed.click()

    const error = page.getByRole('alert')
    await expect(error).toHaveText('Felaktig e-post eller lösenord.')
    await expect(error).toBeFocused()
    await expect(choices).toHaveCount(0)
    await expect(page.getByLabel('Lösenord', { exact: true })).toHaveValue('')
    await expect(page.getByRole('button', { name: 'Logga in', exact: true })).toBeDisabled()
    await expect(page.getByRole('link', { name: 'Glömt lösenord?', exact: true })).toBeVisible()
    await expect(page).toHaveURL(`${PORTAL}/login`)
    expect(requests).toEqual([
      { email: EMAIL.toLowerCase(), password: PASSWORD },
      { email: EMAIL.toLowerCase(), password: PASSWORD },
      {
        email: EMAIL.toLowerCase(),
        password: PASSWORD,
        organizationId: CANDIDATES[1].organizationId,
      },
    ])
    await noHorizontalOverflow(page)
    expect(unexpectedRequests).toEqual([])
    expect(pageErrors).toEqual([])
  })
}
