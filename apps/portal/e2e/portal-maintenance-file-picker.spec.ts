/**
 * Verklig Tab/Enter/Space och browserns filechooser-event i byggd portal.
 * Filer levereras syntetiskt via FileChooser, inte genom en fysisk OS-dialog.
 */
import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test'

const ORIGIN = `http://127.0.0.1:${Number(process.env.PWA_TEST_PORT ?? 4179)}`
const TOKEN = 'PRIVATE_SESSION_ALPHA'
const TITLE = 'Syntetiskt bildutkast'
const DESCRIPTION = 'Titel och beskrivning bevaras genom bildval och återöppning.'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9J8AAAAASUVORK5CYII=',
  'base64',
)
const firstFiles = [1, 2].map((n) => ({
  name: `forsta-${n}.png`,
  mimeType: 'image/png',
  buffer: PNG,
}))
const replacementFiles = [1, 2, 3, 4, 5, 6].map((n) => ({
  name: `ersattning-${n}.png`,
  mimeType: 'image/png',
  buffer: PNG,
}))

test.use({ serviceWorkers: 'block' })

async function prepare(context: BrowserContext, page: Page) {
  const unexpected: string[] = []
  const writes: string[] = []
  const pageErrors: string[] = []
  const inFlight = new Set<Promise<void>>()
  page.on('pageerror', (error) => pageErrors.push(error.message))
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
  const handle = async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const api = url.pathname.replace(/^\/(api|v1)/, '')
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
    if (request.method() === 'GET' && api === '/portal/maintenance') {
      if (request.headers()['authorization'] !== `Bearer ${TOKEN}`) {
        unexpected.push('Fel syntetisk Bearer i maintenance-GET')
        await route.abort('blockedbyclient')
      } else {
        await route.fulfill({ json: { success: true, data: [] } })
      }
      return
    }
    if (/^\/(api|v1)\//.test(url.pathname) || ['xhr', 'fetch'].includes(request.resourceType())) {
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
    expect(writes, 'Filval får inte skapa ärenden eller ladda upp bilder').toEqual([])
    expect(unexpected, 'Oväntade API-/externa anrop').toEqual([])
    expect(pageErrors, 'Browserfel').toEqual([])
    // Behåll nätspärren tills testets egen context stängs.
  }
}

async function tabToPicker(page: Page, dialog: Locator, text: string) {
  // Textankaret hittar även den befintliga labeln före fixen. Ett nytt rollkrav
  // får inte ersätta beviset att verklig Tab faktiskt når kontrollen.
  const control = dialog.getByText(text, { exact: true })
  await expect(control).toHaveCount(1)
  await expect(control).toBeVisible()
  const trace: string[] = []
  for (let step = 0; step < 16; step += 1) {
    await page.keyboard.press('Tab')
    const reached = await control.evaluate((element) => element === document.activeElement)
    if (reached) return control
    trace.push(
      await page.evaluate(() => {
        const active = document.activeElement
        return `${active?.tagName ?? 'null'}:${active?.id ?? ''}:${active?.textContent?.trim().slice(0, 40) ?? ''}`
      }),
    )
    expect(
      await dialog.evaluate((element) => element.contains(document.activeElement)),
      'Tab lämnade den öppna panelen',
    ).toBe(true)
  }
  expect(false, `Bildväljaren nåddes inte genom 16 verkliga Tab: ${trace.join(' → ')}`).toBe(true)
  throw new Error('Onåbar bildväljare')
}

async function openChooser(page: Page, dialog: Locator, key: 'Enter' | 'Space') {
  // Registrera före native tangentbordsaktivering; inga input.click/focus-anrop.
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press(key)])
  const input = dialog.locator('input[type="file"]')
  await expect(input).toHaveCount(1)
  expect(await input.evaluate((element, actual) => element === actual, chooser.element())).toBe(
    true,
  )
  expect(chooser.isMultiple()).toBe(true)
  expect(await chooser.element().getAttribute('accept')).toBe('image/*')
  return chooser
}

async function fileNames(dialog: Locator) {
  return dialog
    .locator('input[type="file"]')
    .evaluate((input) =>
      Array.from((input as HTMLInputElement).files ?? []).map((file) => file.name),
    )
}

for (const width of [320, 430]) {
  test(`bildväljaren nås med Tab och öppnas med Enter/Space vid ${width}px`, async ({
    page,
    context,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 740 })
    const finish = await prepare(context, page)
    let chooserEvents = 0
    page.on('filechooser', () => {
      chooserEvents += 1
    })
    try {
      await page.goto('/maintenance')
      const cookies = page.getByRole('dialog', { name: 'Cookies', exact: true })
      await expect(cookies).toBeVisible()
      await cookies.getByRole('button', { name: 'Endast nödvändiga', exact: true }).click()
      await expect(cookies).toHaveCount(0)
      await expect(page.getByText('Inga felanmälningar', { exact: true })).toBeVisible()
      const trigger = page.getByRole('button', { name: 'Ny felanmälan', exact: true })
      // Enda explicita fokusflytten gäller panelens faktiska öppningskontroll.
      await trigger.focus()
      await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog', { name: 'Ny felanmälan', exact: true })
      await expect(dialog).toBeVisible()
      const title = dialog.getByLabel('Rubrik *', { exact: true })
      const description = dialog.getByLabel('Beskrivning *', { exact: true })
      await title.fill(TITLE)
      await description.fill(DESCRIPTION)
      const picker = await tabToPicker(page, dialog, '+ Lägg till bilder')
      await expect(picker).toBeFocused()
      const focusStyle = await picker.evaluate((element) => {
        const style = getComputedStyle(element)
        return { outlineStyle: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth) }
      })
      await testInfo.attach(`bildval-tangentbordsfokus-${width}`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      })
      expect(focusStyle.outlineStyle).not.toBe('none')
      expect(focusStyle.outlineWidth).toBeGreaterThan(0)
      // Föreversionen ska falla ovan; filechooser-väntan är då aldrig startad.
      const first = await openChooser(page, dialog, 'Enter')
      await first.setFiles(firstFiles)
      await expect(dialog.getByText('2 bild(er) valda', { exact: true })).toBeVisible()
      await expect(dialog.locator('img')).toHaveCount(2)
      expect(await fileNames(dialog)).toEqual(['forsta-1.png', 'forsta-2.png'])
      expect(chooserEvents).toBe(1)
      await expect(title).toHaveValue(TITLE)
      await expect(description).toHaveValue(DESCRIPTION)
      const firstPreviews = await dialog
        .locator('img')
        .evaluateAll((images) => images.map((image) => image.getAttribute('src')))
      expect(firstPreviews).toEqual([
        expect.stringMatching(/^blob:/),
        expect.stringMatching(/^blob:/),
      ])
      expect(new Set(firstPreviews).size).toBe(2)

      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(trigger).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(dialog).toBeVisible()
      await expect(title).toHaveValue(TITLE)
      await expect(description).toHaveValue(DESCRIPTION)
      expect(await fileNames(dialog)).toEqual(['forsta-1.png', 'forsta-2.png'])
      expect(
        await dialog
          .locator('img')
          .evaluateAll((images) => images.map((image) => image.getAttribute('src'))),
      ).toEqual(firstPreviews)
      await tabToPicker(page, dialog, '2 bild(er) valda')
      const replacement = await openChooser(page, dialog, 'Space')
      await replacement.setFiles(replacementFiles)
      await expect(dialog.getByText('5 bild(er) valda', { exact: true })).toBeVisible()
      await expect(dialog.locator('img')).toHaveCount(5)
      // Browserinputen tog emot sex; sidans verkliga onChange begränsar UI till fem.
      expect(await fileNames(dialog)).toEqual(replacementFiles.map((file) => file.name))
      const nextPreviews = await dialog
        .locator('img')
        .evaluateAll((images) => images.map((image) => image.getAttribute('src')))
      expect(nextPreviews.every((url) => typeof url === 'string' && url.startsWith('blob:'))).toBe(
        true,
      )
      expect(new Set(nextPreviews).size).toBe(5)
      expect(nextPreviews.some((url) => firstPreviews.includes(url))).toBe(false)
      expect(chooserEvents).toBe(2)
      await expect(title).toHaveValue(TITLE)
      await expect(description).toHaveValue(DESCRIPTION)
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(trigger).toBeFocused()
      await expect(page).toHaveURL(`${ORIGIN}/maintenance`)
    } finally {
      await finish()
    }
  })
}
