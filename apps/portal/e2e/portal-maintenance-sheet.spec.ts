/**
 * Byggd portal och riktiga tangentbordshändelser i Chromium/WebKit.
 * Syntetisk lagrad session och API-fixture; inga backend-/persistensbevis.
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
const TITLE = 'Syntetiskt bevarat utkast'
const DESCRIPTION = 'Bilden och denna text ska finnas kvar efter att panelen stängts.'
const TICKET = {
  id: '33333333-3333-4333-8333-333333333333',
  ticketNumber: 'SYNTHETIC-1',
  title: TITLE,
  description: DESCRIPTION,
  category: 'OTHER',
  status: 'NEW',
  priority: 'NORMAL',
  createdAt: '2026-10-18T10:00:00.000Z',
  scheduledDate: null,
  property: { name: 'Syntetiskt hus' },
  unit: { name: 'Syntetisk lägenhet' },
  comments: [],
}
type HeldCreate = {
  route: Route
  payload: unknown
  answered: boolean
  release(status: number): void
}
const IMAGE = {
  name: 'syntetisk-pixel.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9J8AAAAASUVORK5CYII=',
    'base64',
  ),
}

test.use({ serviceWorkers: 'block' })

async function prepare(context: BrowserContext, page: Page, allowCreate = false) {
  const unexpected: string[] = []
  const writes: string[] = []
  const reads: string[] = []
  const pageErrors: string[] = []
  const inFlight = new Set<Promise<void>>()
  let heldCreate: HeldCreate | undefined
  let tickets: (typeof TICKET)[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  // Verkliga store-parsern/rehydreringen används. Detta intygar inte att en
  // lagrad token är servergiltig; GET-fixturen kontrollerar vår exakta sentinel.
  await context.addInitScript(
    ({ token }) => {
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
    },
    { token: TOKEN },
  )
  const handle = async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const label = `${request.method()} ${url.pathname}`
    if (url.origin !== ORIGIN) {
      unexpected.push(`${request.method()} ${url.origin}${url.pathname}`)
      await route.abort('blockedbyclient')
      return
    }
    const api = url.pathname.replace(/^\/(api|v1)/, '')
    if (/^\/(api|v1)\//.test(url.pathname) && !['GET', 'HEAD'].includes(request.method())) {
      writes.push(`${request.method()} ${api}`)
      if (
        allowCreate &&
        api === '/portal/maintenance' &&
        request.method() === 'POST' &&
        !heldCreate
      ) {
        if (request.headers()['authorization'] !== `Bearer ${TOKEN}`) {
          unexpected.push('Fel syntetisk Bearer i maintenance-POST')
          await route.abort('blockedbyclient')
          return
        }
        let deliver!: (status: number) => void
        const reply = new Promise<number>((resolve) => {
          deliver = resolve
        })
        const entry: HeldCreate = {
          route,
          payload: request.postDataJSON(),
          answered: false,
          release(status) {
            if (entry.answered) return
            entry.answered = true
            deliver(status)
          },
        }
        heldCreate = entry
        const status = await reply
        await route.fulfill({
          status,
          json:
            status === 200
              ? { success: true, data: TICKET }
              : { success: false, error: { message: 'Syntetisk teststädning' } },
        })
        return
      }
      unexpected.push(label)
      await route.abort('blockedbyclient')
      return
    }
    if (api === '/public/config' && request.method() === 'GET') {
      await route.fulfill({ json: { success: true, data: { features: { bankId: false } } } })
      return
    }
    if (api === '/portal/maintenance' && request.method() === 'GET') {
      const authorization = request.headers()['authorization'] ?? ''
      reads.push(authorization)
      if (authorization !== `Bearer ${TOKEN}`) {
        unexpected.push('Fel syntetisk Bearer i maintenance-GET')
        await route.abort('blockedbyclient')
        return
      }
      await route.fulfill({ json: { success: true, data: tickets } })
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
  return {
    async nextCreate() {
      await expect.poll(() => heldCreate !== undefined).toBe(true)
      if (!heldCreate) throw new Error('Syntetisk create saknas')
      expect(writes).toEqual(['POST /portal/maintenance'])
      expect(heldCreate.payload).toEqual({
        title: TITLE,
        description: DESCRIPTION,
        category: 'OTHER',
      })
      return heldCreate
    },
    async complete(entry: HeldCreate) {
      const before = reads.length
      const response = page.waitForResponse((value) => value.request() === entry.route.request())
      tickets = [TICKET]
      entry.release(200)
      const delivered = await response
      expect(delivered.status()).toBe(200)
      expect(await delivered.finished()).toBeNull()
      await expect.poll(() => reads.length).toBeGreaterThan(before)
      // React-/handler-slutet verifieras av listan/stängningen/fokus i fallet.
      expect(writes).toEqual(['POST /portal/maintenance'])
    },
    async finish() {
      heldCreate?.release(400)
      await Promise.all([...inFlight])
      // Routens nätspärr ligger kvar tills context-fixturen stängs.
      if (allowCreate) {
        expect(writes.length).toBeLessThanOrEqual(1)
        expect(writes.every((value) => value === 'POST /portal/maintenance')).toBe(true)
      } else {
        expect(writes, 'Rena fokus/utkast-fall får inte göra API-skrivningar').toEqual([])
      }
      expect(reads.length, 'Riktigt autentiserat GET från appen').toBeGreaterThan(0)
      expect(reads.every((value) => value === `Bearer ${TOKEN}`)).toBe(true)
      expect(unexpected, 'Oväntade API-/externa anrop').toEqual([])
      expect(pageErrors, 'Browserfel').toEqual([])
    },
  }
}

async function openMaintenance(page: Page) {
  await page.goto('/maintenance')
  const cookies = page.getByRole('dialog', { name: 'Cookies', exact: true })
  await expect(cookies).toBeVisible()
  // Mobilnavigationen kan skymma bannerns knapp för pekaren. Använd den
  // verkliga tangentbordsaktiveringen för förberedelsen, utan force-click.
  const necessary = cookies.getByRole('button', { name: 'Endast nödvändiga', exact: true })
  await necessary.focus()
  await page.keyboard.press('Enter')
  await expect(cookies).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Felanmälningar', exact: true })).toBeVisible()
  await expect(page.getByText('Inga felanmälningar', { exact: true })).toBeVisible()
}

function panel(page: Page) {
  // DOM-ankaret används före dialogroll-assertionen så det gamla fokusfelet
  // faktiskt provas, inte bara frånvaron av den nya rollen.
  return page
    .getByRole('heading', { name: 'Ny felanmälan', exact: true, includeHidden: true })
    .locator('..')
    .locator('..')
}

async function expectFocusInside(sheet: Locator) {
  await expect
    .poll(() =>
      sheet.evaluate((element) => {
        const active = document.activeElement
        return (
          !!active &&
          element.contains(active) &&
          !(active instanceof HTMLButtonElement && active.disabled)
        )
      }),
    )
    .toBe(true)
}

async function tabTo(page: Page, sheet: Locator, target: Locator) {
  for (let step = 0; step < 14; step += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return
    await page.keyboard.press('Tab')
    await expectFocusInside(sheet)
  }
  await expect(target).toBeFocused()
}

for (const width of [320, 430]) {
  test(`stängd felanmälanspanel är utanför tabbordningen och åtkomstträdet vid ${width}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 740 })
    const network = await prepare(context, page)
    try {
      await openMaintenance(page)
      const trigger = page.getByRole('button', { name: 'Ny felanmälan', exact: true })
      const sheet = panel(page)
      await expect(sheet).toHaveCount(1)
      // Enda explicita fokusflytten: börja på den riktiga öppningskontrollen.
      await trigger.focus()
      await expect(trigger).toBeFocused()
      for (const key of ['Tab', 'Shift+Tab']) {
        for (let step = 0; step < 20; step += 1) {
          await page.keyboard.press(key)
          expect(
            await sheet.evaluate((element) => element.contains(document.activeElement)),
            `Stängd panel tog fokus efter ${key}, steg ${step + 1}`,
          ).toBe(false)
        }
      }
      // Separat från geometri: inte heller normalt tillgängliga formkontroller.
      await expect(page.getByRole('textbox', { name: 'Rubrik *', exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Avbryt', exact: true })).toHaveCount(0)
    } finally {
      await network.finish()
    }
  })

  test(`öppen felanmälansdialog håller fokus och bevarar utkast efter Escape/Avbryt vid ${width}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 740 })
    const network = await prepare(context, page)
    try {
      await openMaintenance(page)
      const trigger = page.getByRole('button', { name: 'Ny felanmälan', exact: true })
      const sheet = panel(page)
      await trigger.focus()
      await expect(trigger).toBeFocused()
      await page.keyboard.press('Enter')
      await expectFocusInside(sheet)
      const dialog = page.getByRole('dialog', { name: 'Ny felanmälan', exact: true })
      await expect(dialog).toBeVisible()
      await expect(dialog).toHaveAttribute('aria-modal', 'true')
      const title = dialog.getByLabel('Rubrik *', { exact: true })
      const description = dialog.getByLabel('Beskrivning *', { exact: true })
      const cancel = dialog.getByRole('button', { name: 'Avbryt', exact: true })
      await title.fill(TITLE)
      await description.fill(DESCRIPTION)
      // Filval är bara ett utkastfacit; OS-filväljare/filuppladdning ingår inte.
      await dialog.locator('input[type="file"]').setInputFiles(IMAGE)
      await expect(dialog.getByText('1 bild(er) valda', { exact: true })).toBeVisible()
      await expect(dialog.locator('img')).toHaveCount(1)
      const preview = await dialog.locator('img').getAttribute('src')
      expect(preview).toMatch(/^blob:/)
      // Ingen DOM-focus här: från formulärets verkliga fokus ska båda riktningar
      // passera ändarna utan att lämna dialogen eller fastna på en enda kontroll.
      const seen = new Set<string>()
      for (const key of ['Tab', 'Shift+Tab']) {
        for (let step = 0; step < 14; step += 1) {
          await page.keyboard.press(key)
          await expectFocusInside(sheet)
          if (await title.evaluate((element) => element === document.activeElement))
            seen.add('title')
          if (await description.evaluate((element) => element === document.activeElement))
            seen.add('description')
          if (await cancel.evaluate((element) => element === document.activeElement))
            seen.add('cancel')
        }
      }
      expect([...seen].sort()).toEqual(['cancel', 'description', 'title'])
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(trigger).toBeFocused()
      await page.keyboard.press('Enter')
      await expectFocusInside(sheet)
      await expect(dialog).toBeVisible()
      await expect(title).toHaveValue(TITLE)
      await expect(description).toHaveValue(DESCRIPTION)
      await expect(dialog.getByText('1 bild(er) valda', { exact: true })).toBeVisible()
      expect(
        await dialog
          .locator('input[type="file"]')
          .evaluate((input) =>
            Array.from((input as HTMLInputElement).files ?? []).map((file) => file.name),
          ),
      ).toEqual([IMAGE.name])
      await expect(dialog.locator('img')).toHaveAttribute('src', preview!)
      await cancel.click()
      await expect(dialog).toHaveCount(0)
      await expect(trigger).toBeFocused()
      await page.keyboard.press('Enter')
      await expectFocusInside(sheet)
      await expect(title).toHaveValue(TITLE)
      await expect(description).toHaveValue(DESCRIPTION)
      await expect(dialog.getByText('1 bild(er) valda', { exact: true })).toBeVisible()
      await expect(dialog.locator('img')).toHaveAttribute('src', preview!)
      await page.keyboard.press('Escape')
      await expect(trigger).toBeFocused()
    } finally {
      await network.finish()
    }
  })

  test(`lyckat inskick från tomlistans trigger återför fokus till kvarvarande header vid ${width}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 740 })
    const network = await prepare(context, page, true)
    try {
      await openMaintenance(page)
      const emptyTrigger = page.getByRole('button', {
        name: '+ Ny felanmälan',
        exact: true,
        includeHidden: true,
      })
      const permanentTrigger = page.getByRole('button', { name: 'Ny felanmälan', exact: true })
      const sheet = panel(page)
      await emptyTrigger.focus()
      await expect(emptyTrigger).toBeFocused()
      await page.keyboard.press('Enter')
      // Föreversionen kan falla redan här; då har POST/fallback inte prövats.
      await expectFocusInside(sheet)
      const dialog = page.getByRole('dialog', { name: 'Ny felanmälan', exact: true })
      await dialog.getByLabel('Rubrik *', { exact: true }).fill(TITLE)
      await dialog.getByLabel('Beskrivning *', { exact: true }).fill(DESCRIPTION)
      const submit = dialog.getByRole('button', { name: 'Skicka felanmälan', exact: true })
      await expect(submit).toBeEnabled()
      await tabTo(page, sheet, submit)
      await page.keyboard.press('Enter')
      const create = await network.nextCreate()
      await expect(dialog.getByRole('button', { name: 'Skickar...', exact: true })).toBeDisabled()
      await expectFocusInside(sheet)
      await expect(emptyTrigger).toHaveCount(1)
      await network.complete(create)
      await expect(page.getByText(TITLE, { exact: true })).toBeVisible()
      await expect(emptyTrigger).toHaveCount(0)
      await expect(dialog).toHaveCount(0)
      await expect(permanentTrigger).toBeFocused()
    } finally {
      await network.finish()
    }
  })
}
