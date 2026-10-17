/**
 * Verklig byggd portal/CSS/tangentbord i Chromium och WebKit. Bara API-svar är
 * syntetiska. Bevisar inte provider, fysisk telefon, BankID-app eller skärmläsare.
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
const PREFIX = '/tenant-portal/auth/bankid/'
const TENANT = {
  id: '11111111-1111-4111-8111-111111111111',
  firstName: 'PRIVATE_ALPHA',
  lastName: 'Syntetisk',
  companyName: null,
  email: 'a@example.invalid',
}
const TOKEN = 'PRIVATE_SESSION_ALPHA'
const ERROR = 'Syntetiskt valfel. Försök igen.'
const CANDIDATES = [
  { tenantId: TENANT.id, organizationName: 'Syntetisk hyresvärd Alfa', address: 'Testgatan 1' },
  {
    tenantId: '22222222-2222-4222-8222-222222222222',
    organizationName: 'Syntetisk hyresvärd Beta',
    address: 'Testgatan 2',
  },
]
const LONG_CANDIDATES = CANDIDATES.map((candidate, index) => ({
  ...candidate,
  organizationName: `${candidate.organizationName} ${'StockholmsNordvästraFastighetsförvaltningOchBostadsutvecklingFörHyresrätter'.repeat(8)} ${index + 1}`,
  address: `${'Syntetiska bostadsområdet med den mycket långa adressbeskrivningen, trapphus och port '.repeat(6)} ${index + 1}`,
}))
type Kind = 'start' | 'collect' | 'choose'
type Reply = { status: number; json: unknown }
type Held = {
  route: Route
  kind: Kind
  body: unknown
  answered: boolean
  release(reply: Reply): void
}

test.use({ serviceWorkers: 'block' })

async function transport(context: BrowserContext, page: Page) {
  const held: Held[] = []
  const unexpected: string[] = []
  const pageErrors: string[] = []
  const inFlight = new Set<Promise<void>>()
  let stopping = false
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const handle = async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== ORIGIN) {
      unexpected.push(`${request.method()} ${url.protocol}//${url.host}${url.pathname}`)
      await route.abort('blockedbyclient')
      return
    }
    const api = url.pathname.replace(/^\/(api|v1)/, '')
    if (api === '/public/config' && request.method() === 'GET') {
      await route.fulfill({ json: { success: true, data: { features: { bankId: true } } } })
      return
    }
    const kind = api.slice(PREFIX.length)
    if (
      api.startsWith(PREFIX) &&
      ['start', 'collect', 'choose'].includes(kind) &&
      request.method() === 'POST'
    ) {
      if (stopping) {
        await route.abort('aborted')
        return
      }
      let release!: (reply: Reply) => void
      const response = new Promise<Reply>((resolve) => {
        release = resolve
      })
      const entry: Held = {
        route,
        kind: kind as Kind,
        body: request.postData() ? request.postDataJSON() : null,
        answered: false,
        release(reply) {
          if (!entry.answered) {
            entry.answered = true
            release(reply)
          }
        },
      }
      held.push(entry)
      await route.fulfill(await response)
      return
    }
    // Dashboard hämtas från samma befintliga HTTP-fixture, med dess riktiga
    // syntetiska Bearer-kontroll. Alla andra API-/externa anrop är otillåtna.
    if (api === '/portal/dashboard' && request.method() === 'GET') {
      await route.continue()
      return
    }
    if (/^\/(api|v1)\//.test(url.pathname) || ['xhr', 'fetch'].includes(request.resourceType())) {
      unexpected.push(`${request.method()} ${url.pathname}`)
      await route.abort('blockedbyclient')
      return
    }
    await route.continue()
  }
  const handler = async (route: Route) => {
    const work = handle(route)
    inFlight.add(work)
    try {
      await work
    } finally {
      inFlight.delete(work)
    }
  }
  await context.route('**/*', handler)
  return {
    held,
    async next(kind: Kind, index: number) {
      await expect
        .poll(() => held.filter((entry) => entry.kind === kind).length)
        .toBeGreaterThan(index)
      return held.filter((entry) => entry.kind === kind)[index]!
    },
    async collect(orderRef: string) {
      const matches = () =>
        held.filter(
          (entry) =>
            entry.kind === 'collect' &&
            entry.body !== null &&
            typeof entry.body === 'object' &&
            'orderRef' in entry.body &&
            entry.body.orderRef === orderRef,
        )
      await expect.poll(() => matches().length).toBeGreaterThan(0)
      return matches()[0]!
    },
    async reply(entry: Held, data: unknown, status = 200) {
      // Knyt kvittot till just denna request, inte bara nästa URL av samma sort.
      const response = page.waitForResponse((value) => value.request() === entry.route.request())
      entry.release({
        status,
        json:
          status === 200 ? { success: true, data } : { success: false, error: { message: ERROR } },
      })
      const delivered = await response
      expect(delivered.status()).toBe(status)
      expect(await delivered.finished()).toBeNull()
      // Handler-/React-settlement bevisas därefter av det förväntade UI-steget;
      // själva route.fulfill/response är inte en sådan barriär.
    },
    async close() {
      stopping = true
      for (const entry of held)
        entry.release({
          status: 400,
          json: { success: false, error: { message: 'Syntetisk teststädning' } },
        })
      // Alla manuellt hållna routes frisläpps även när ett föreprov faller.
      await Promise.all([...inFlight])
      // Kontextfixturen tar bort routen vid teardown. Blockeringen ligger kvar
      // tills dess så sena telemetri-/API-anrop aldrig får en fri nätväg.
      expect(unexpected, 'Blockerade oväntade nätanrop').toEqual([])
      expect(pageErrors, 'Verkliga browserfel').toEqual([])
    },
  }
}

async function openLogin(page: Page) {
  await page.goto(`${ORIGIN}/login`)
  const cookies = page.getByRole('dialog', { name: 'Cookies', exact: true })
  await expect(cookies).toBeVisible()
  await cookies.getByRole('button', { name: 'Endast nödvändiga', exact: true }).click()
  await expect(cookies).toBeHidden()
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await expect(page.getByTestId('bankid-login-button')).toBeVisible()
}
async function focusInside(dialog: Locator) {
  await expect
    .poll(() =>
      dialog.evaluate((element) => {
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
async function tabTo(page: Page, dialog: Locator, target: Locator) {
  // Faktiska Tab-händelser, ingen DOM-fokusflytt för att passera dialoggrinden.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return
    await page.keyboard.press('Tab')
    await focusInside(dialog)
  }
  await expect(target).toBeFocused()
}
async function reachable(target: Locator, page: Page, wholeControl = true) {
  await target.scrollIntoViewIfNeeded()
  await expect(target).toBeVisible()
  await target.click({ trial: true })
  const box = await target.boundingBox()
  const viewport = page.viewportSize()
  if (!box || !viewport) throw new Error('Renderad kontroll/viewport saknas')
  expect(box.width).toBeGreaterThan(0)
  expect(box.height).toBeGreaterThan(0)
  expect(box.x).toBeGreaterThanOrEqual(-0.5)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5)
  if (wholeControl) {
    expect(box.y).toBeGreaterThanOrEqual(-0.5)
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 0.5)
  } else {
    // Lång kandidattext får vara högre än skärmen. Trial-klicket bevisar en
    // verklig träffpunkt; hela Avbryt-kontrollen måste däremot rymmas ovan.
    expect(Math.min(box.y + box.height, viewport.height) - Math.max(box.y, 0)).toBeGreaterThan(0)
  }
}

for (const width of [320, 430]) {
  test.describe(`BankID-dialog ${width}×740`, () => {
    test.use({ viewport: { width, height: 740 } })

    test('tangentbord genom start, val, låst anrop, fel, retry, Escape och ny positiv session', async ({
      page,
      context,
      request,
    }) => {
      expect((await request.post('/__fixture/reset')).status()).toBe(200)
      const api = await transport(context, page)
      try {
        await openLogin(page)
        const start = page.getByTestId('bankid-login-button')
        const dialog = page.getByRole('dialog', { name: 'BankID', exact: true })
        const cancel = dialog.getByRole('button', { name: 'Avbryt', exact: true })
        // Bara testets ursprungliga fokus sätts; öppning och alla dialogsteg
        // nedan använder riktiga tangentbordshändelser.
        await start.focus()
        await page.keyboard.press('Enter')
        const firstStart = await api.next('start', 0)
        expect(firstStart.body).toBeNull()
        await expect(dialog).toBeVisible()
        await expect(dialog.getByText('Startar BankID…')).toBeVisible()
        await focusInside(dialog)
        await page.keyboard.press('Tab')
        await expect(cancel).toBeFocused()
        await page.keyboard.press('Shift+Tab')
        await expect(cancel).toBeFocused()

        await api.reply(firstStart, { orderRef: 'synthetic-dialog-order-1' })
        await expect(
          dialog.getByText('Legitimera dig med BankID på den här enheten eller med QR-kod.'),
        ).toBeVisible()
        await focusInside(dialog)
        const firstCollect = await api.collect('synthetic-dialog-order-1')
        expect(firstCollect.body).toEqual({ orderRef: 'synthetic-dialog-order-1' })
        await api.reply(firstCollect, {
          status: 'choose',
          chooseToken: 'synthetic-dialog-choice-1',
          candidates: CANDIDATES,
        })
        const candidates = dialog.getByTestId('bankid-candidate')
        await expect(candidates).toHaveCount(2)
        await tabTo(page, dialog, candidates.nth(0))
        await page.keyboard.press('Shift+Tab')
        await expect(cancel).toBeFocused()
        await page.keyboard.press('Tab')
        await expect(candidates.nth(0)).toBeFocused()
        await page.keyboard.press('Tab')
        await expect(candidates.nth(1)).toBeFocused()
        await page.keyboard.press('Tab')
        await expect(cancel).toBeFocused()
        await page.keyboard.press('Tab')
        await expect(candidates.nth(0)).toBeFocused()
        await page.keyboard.press('Enter')
        const firstChoose = await api.next('choose', 0)
        expect(firstChoose.body).toEqual({
          chooseToken: 'synthetic-dialog-choice-1',
          tenantId: TENANT.id,
        })
        await expect(candidates.nth(0)).toBeDisabled()
        await expect(candidates.nth(1)).toBeDisabled()
        await focusInside(dialog)
        await page.keyboard.press('Tab')
        await expect(cancel).toBeFocused()
        await page.keyboard.press('Shift+Tab')
        await expect(cancel).toBeFocused()
        expect(api.held.filter((entry) => entry.kind === 'choose')).toHaveLength(1)

        await api.reply(firstChoose, null, 400)
        await expect(dialog.getByTestId('bankid-error')).toHaveText(ERROR)
        await focusInside(dialog)
        await tabTo(page, dialog, dialog.getByRole('button', { name: 'Försök igen', exact: true }))
        await page.keyboard.press('Enter')
        const retry = await api.next('start', 1)
        await api.reply(retry, { orderRef: 'synthetic-dialog-order-2' })
        await expect(
          dialog.getByText('Legitimera dig med BankID på den här enheten eller med QR-kod.'),
        ).toBeVisible()
        await focusInside(dialog)
        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()
        await expect(start).toBeFocused()
        await expect(page).toHaveURL(`${ORIGIN}/login`)

        await page.keyboard.press('Enter')
        await api.reply(await api.next('start', 2), { orderRef: 'synthetic-dialog-order-3' })
        // Riktiga intervall kan ha hunnit ge fler gamla poller före Avbryt.
        // Bind därför nästa steg till ordern, aldrig ett globalt requestindex.
        const finalCollect = await api.collect('synthetic-dialog-order-3')
        expect(finalCollect.body).toEqual({ orderRef: 'synthetic-dialog-order-3' })
        await api.reply(finalCollect, {
          status: 'choose',
          chooseToken: 'synthetic-dialog-choice-3',
          candidates: CANDIDATES,
        })
        await expect(candidates).toHaveCount(2)
        await tabTo(page, dialog, candidates.nth(0))
        await page.keyboard.press('Enter')
        const finalChoose = await api.next('choose', 1)
        expect(finalChoose.body).toEqual({
          chooseToken: 'synthetic-dialog-choice-3',
          tenantId: TENANT.id,
        })
        await api.reply(finalChoose, {
          status: 'complete',
          sessionToken: TOKEN,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          tenant: TENANT,
        })
        await expect(page).toHaveURL(`${ORIGIN}/dashboard`)
        await expect(page.getByText(/PRIVATE_ALPHA/).first()).toBeVisible()
        await expect(dialog).toHaveCount(0)
        await expect(start).toHaveCount(0)
        const stored: unknown = await page.evaluate(() =>
          JSON.parse(localStorage.getItem('tenant_session') ?? 'null'),
        )
        expect(stored).toMatchObject({
          state: { sessionToken: TOKEN, tenant: { id: TENANT.id }, isAuthenticated: true },
        })
        expect(api.held.filter((entry) => entry.kind === 'start')).toHaveLength(3)
        expect(api.held.filter((entry) => entry.kind === 'choose')).toHaveLength(2)
      } finally {
        await api.close()
      }
    })

    test('långa namn och adresser ryms horisontellt och Avbryt kan nås med riktig scroll/klick', async ({
      page,
      context,
      request,
    }, testInfo) => {
      expect((await request.post('/__fixture/reset')).status()).toBe(200)
      const api = await transport(context, page)
      try {
        await openLogin(page)
        const start = page.getByTestId('bankid-login-button')
        // Fastställ tidigare fokus oberoende av motorns policy för musklick.
        await start.focus()
        await start.click()
        await api.reply(await api.next('start', 0), { orderRef: 'synthetic-long-order' })
        const dialog = page.getByRole('dialog', { name: 'BankID', exact: true })
        await expect(
          dialog.getByText('Ingen QR-kod. Använd knappen nedan på den här enheten.'),
        ).toBeVisible()
        const collect = await api.collect('synthetic-long-order')
        expect(collect.body).toEqual({ orderRef: 'synthetic-long-order' })
        await api.reply(collect, {
          status: 'choose',
          chooseToken: 'synthetic-long-choice',
          candidates: LONG_CANDIDATES,
        })
        const candidates = dialog.getByTestId('bankid-candidate')
        await expect(candidates).toHaveCount(2)
        for (let index = 0; index < 2; index += 1) {
          await expect(candidates.nth(index)).toContainText(
            LONG_CANDIDATES[index]!.organizationName,
          )
          await expect(candidates.nth(index)).toContainText(LONG_CANDIDATES[index]!.address)
        }
        const panel = dialog.getByTestId('bankid-panel')
        const geometry = await panel.evaluate((element) => {
          const box = element.getBoundingClientRect()
          return {
            width: innerWidth,
            height: innerHeight,
            panel: {
              left: box.left,
              right: box.right,
              top: box.top,
              bottom: box.bottom,
              scrollWidth: element.scrollWidth,
              clientWidth: element.clientWidth,
              scrollHeight: element.scrollHeight,
              clientHeight: element.clientHeight,
            },
            children: [...element.querySelectorAll<HTMLElement>('button, button span')].map(
              (child) => {
                const rect = child.getBoundingClientRect()
                return {
                  left: rect.left,
                  right: rect.right,
                  scrollWidth: child.scrollWidth,
                  clientWidth: child.clientWidth,
                }
              },
            ),
          }
        })
        await testInfo.attach(`bankid-geometri-${width}`, {
          body: JSON.stringify(geometry),
          contentType: 'application/json',
        })
        expect(geometry.panel.left).toBeGreaterThanOrEqual(0)
        expect(geometry.panel.right).toBeLessThanOrEqual(geometry.width)
        expect(geometry.panel.top).toBeGreaterThanOrEqual(0)
        expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.height)
        expect(geometry.panel.scrollWidth).toBeLessThanOrEqual(geometry.panel.clientWidth + 1)
        for (const child of geometry.children) {
          expect(child.clientWidth).toBeGreaterThan(0)
          expect(child.scrollWidth).toBeLessThanOrEqual(child.clientWidth + 1)
          expect(child.left).toBeGreaterThanOrEqual(geometry.panel.left - 0.5)
          expect(child.right).toBeLessThanOrEqual(geometry.panel.right + 0.5)
        }
        // Den långa syntetiska texten ska verkligen överskrida panelens höjd,
        // så detta inte bara är ett klick på en redan fullt synlig liten dialog.
        expect(geometry.panel.scrollHeight).toBeGreaterThan(geometry.panel.clientHeight)
        for (const candidate of await candidates.all()) await reachable(candidate, page, false)
        const cancel = dialog.getByRole('button', { name: 'Avbryt', exact: true })
        await reachable(cancel, page)
        await testInfo.attach(`bankid-avbryt-nåbar-${width}`, {
          body: await page.screenshot(),
          contentType: 'image/png',
        })
        await cancel.click()
        await expect(dialog).toBeHidden()
        await expect(start).toBeFocused()
        await expect(page).toHaveURL(`${ORIGIN}/login`)
        expect(api.held.filter((entry) => entry.kind === 'choose')).toHaveLength(0)
      } finally {
        await api.close()
      }
    })
  })
}
