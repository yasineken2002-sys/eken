/**
 * Byggd portal, riktig Tab/Enter/Space och en enda syntetisk kommentar-POST.
 * API-svar ersätts vid nätgränsen; inget backend-/persistens- eller sessionsracebevis.
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
const MESSAGE = 'Jag är hemma på torsdag efter klockan tio.'
const INTERNAL = 'INTERNAL_TICKET_NOTE_MUST_NOT_RENDER'
const PRIMARY = {
  id: '33333333-3333-4333-8333-333333333333',
  ticketNumber: 'SYNTHETIC-A',
  title: 'Droppande kökskran',
  description: 'Det droppar från kökskranen även när den är stängd.',
  category: 'PLUMBING',
  status: 'IN_PROGRESS',
  priority: 'NORMAL',
  createdAt: '2026-10-18T10:00:00.000Z',
  scheduledDate: null,
  property: { name: 'Syntetiskt hus A' },
  unit: { name: 'Lägenhet A' },
  comments: [
    {
      id: '55555555-5555-4555-8555-555555555555',
      content: 'Vi kommer på torsdag. Svara gärna här om tiden passar.',
      createdAt: '2026-10-18T11:00:00.000Z',
      isInternal: false,
    },
    {
      id: '66666666-6666-4666-8666-666666666666',
      content: INTERNAL,
      createdAt: '2026-10-18T11:01:00.000Z',
      isInternal: true,
    },
  ],
}
const SECONDARY = {
  ...PRIMARY,
  id: '44444444-4444-4444-8444-444444444444',
  ticketNumber: 'SYNTHETIC-B',
  title: 'Trasig hallampa',
  description: 'Hallampan behöver bytas; detta är ett separat ärende.',
  category: 'ELECTRICAL',
  status: 'NEW',
  property: { name: 'Syntetiskt hus B' },
  unit: { name: 'Lägenhet B' },
  comments: [
    {
      id: '77777777-7777-4777-8777-777777777777',
      content: 'Separat offentligt svar för ärende B.',
      createdAt: '2026-10-18T12:00:00.000Z',
      isInternal: false,
    },
  ],
}
const SAVED_COMMENT = {
  id: '88888888-8888-4888-8888-888888888888',
  content: MESSAGE,
  createdAt: '2026-10-18T13:00:00.000Z',
  isInternal: false,
}
const COMMENT_PATH = `/portal/maintenance/${PRIMARY.id}/comment`
type HeldComment = { route: Route; payload: unknown; release(status: number): void }

test.use({ serviceWorkers: 'block' })

async function prepare(context: BrowserContext, page: Page) {
  const unexpected: string[] = []
  const writes: string[] = []
  const reads: string[] = []
  const errors: string[] = []
  const inFlight = new Set<Promise<void>>()
  let held: HeldComment | undefined
  let tickets = [PRIMARY, SECONDARY]
  page.on('pageerror', (error) => errors.push(error.message))
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
    if (url.origin !== ORIGIN || url.search !== '') {
      unexpected.push(label)
      await route.abort('blockedbyclient')
      return
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      writes.push(`${request.method()} ${api}`)
      if (request.method() !== 'POST' || api !== COMMENT_PATH || held) {
        unexpected.push(label)
        await route.abort('blockedbyclient')
        return
      }
      if (request.headers()['authorization'] !== `Bearer ${TOKEN}`) {
        unexpected.push('Fel syntetisk Bearer i kommentar-POST')
        await route.abort('blockedbyclient')
        return
      }
      let release!: (status: number) => void
      const reply = new Promise<number>((resolve) => {
        release = resolve
      })
      let answered = false
      held = {
        route,
        payload: request.postDataJSON(),
        release(status) {
          if (answered) return
          answered = true
          release(status)
        },
      }
      const status = await reply
      await route.fulfill({
        status,
        json:
          status === 200
            ? { success: true, data: PRIMARY }
            : { success: false, error: { message: 'Syntetisk teststädning' } },
      })
      return
    }
    if (request.method() === 'GET' && api === '/public/config') {
      await route.fulfill({ json: { success: true, data: { features: { bankId: false } } } })
      return
    }
    if (request.method() === 'GET' && api === '/portal/maintenance') {
      const authorization = request.headers()['authorization'] ?? ''
      reads.push(authorization)
      if (authorization !== `Bearer ${TOKEN}`) {
        unexpected.push('Fel syntetisk Bearer i maintenance-GET')
        await route.abort('blockedbyclient')
      } else {
        await route.fulfill({ json: { success: true, data: tickets } })
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
    const work = handle(route).catch((error: unknown) => {
      errors.push(error instanceof Error ? error.message : String(error))
    })
    inFlight.add(work)
    try {
      await work
    } finally {
      inFlight.delete(work)
    }
  })
  return {
    async nextComment() {
      await expect.poll(() => held !== undefined).toBe(true)
      if (!held) throw new Error('Syntetisk kommentar-POST saknas')
      expect(writes).toEqual([`POST ${COMMENT_PATH}`])
      expect(held.payload).toEqual({ content: MESSAGE })
      return held
    },
    async complete(entry: HeldComment) {
      const before = reads.length
      const response = page.waitForResponse((value) => value.request() === entry.route.request())
      // Bara GET får den nya kommentaren; POST-returen ovan innehåller den inte.
      tickets = [{ ...PRIMARY, comments: [...PRIMARY.comments, SAVED_COMMENT] }, SECONDARY]
      entry.release(200)
      const delivered = await response
      expect(delivered.status()).toBe(200)
      expect(await delivered.finished()).toBeNull()
      await expect.poll(() => reads.length).toBeGreaterThan(before)
      expect(writes).toEqual([`POST ${COMMENT_PATH}`])
    },
    async finish() {
      held?.release(400)
      try {
        await Promise.all([...inFlight])
      } finally {
        // Behåll nätspärren genom sidstängning och dränera även då påbörjade routes.
        await page.close()
        await Promise.all([...inFlight])
      }
      expect(writes.length).toBeLessThanOrEqual(1)
      expect(writes.every((value) => value === `POST ${COMMENT_PATH}`)).toBe(true)
      expect(reads.length, 'Appen ska göra ett autentiserat maintenance-GET').toBeGreaterThan(0)
      expect(reads.every((value) => value === `Bearer ${TOKEN}`)).toBe(true)
      expect(unexpected, 'Oväntade API-/externa anrop').toEqual([])
      expect(errors, 'Browser-/routefel').toEqual([])
    },
  }
}

function ticketRow(page: Page, title: string) {
  // Samma text→parent→parent-ankare hittar den gamla div-raden och nya knappen.
  return page.getByText(title, { exact: true }).locator('..').locator('..')
}

async function tabToRow(page: Page, row: Locator) {
  const trace: string[] = []
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press('Tab')
    if (await row.evaluate((element) => element === document.activeElement)) return
    trace.push(
      await page.evaluate(() => {
        const active = document.activeElement
        return `${active?.tagName ?? 'null'}:${active?.textContent?.trim().slice(0, 50) ?? ''}`
      }),
    )
  }
  await expect(row, `Ärendet nåddes inte genom 12 verkliga Tab: ${trace.join(' → ')}`).toBeFocused()
}

for (const width of [320, 430]) {
  test(`befintlig felanmälan öppnas och besvaras med tangentbord vid ${width}px`, async ({
    page,
    context,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 740 })
    const network = await prepare(context, page)
    try {
      await page.goto('/maintenance')
      const cookies = page.getByRole('dialog', { name: 'Cookies', exact: true })
      await expect(cookies).toBeVisible()
      await cookies.getByRole('button', { name: 'Endast nödvändiga', exact: true }).click()
      await expect(cookies).toHaveCount(0)
      const row = ticketRow(page, PRIMARY.title)
      const other = ticketRow(page, SECONDARY.title)
      await expect(row).toBeVisible()
      await expect(other).toBeVisible()
      // Enda programmatiska focus-anropet gäller den befintliga headerknappen.
      await page.getByRole('button', { name: 'Ny felanmälan', exact: true }).focus()
      await tabToRow(page, row)
      await expect(row).toBeFocused()
      // Föreversionen faller på verklig Tab ovan, före nya roll-/ARIA-krav.
      expect(await row.evaluate((element) => element.tagName)).toBe('BUTTON')
      await expect(row).toHaveAttribute('type', 'button')
      await expect(row).toHaveAttribute('aria-expanded', 'false')
      const bodyId = await row.getAttribute('aria-controls')
      expect(bodyId).toBeTruthy()
      if (!bodyId) throw new Error('Öppnarens body-id saknas')
      await expect(other).toHaveAttribute('aria-expanded', 'false')
      const focus = await row.evaluate((element) => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return {
          outlineStyle: style.outlineStyle,
          outlineWidth: parseFloat(style.outlineWidth),
          left: rect.left,
          right: rect.right,
          viewport: document.documentElement.clientWidth,
          documentWidth: document.documentElement.scrollWidth,
        }
      })
      const screenshot = testInfo.outputPath(`arende-tangentbordsfokus-${width}.png`)
      await page.screenshot({ path: screenshot })
      await testInfo.attach(`arende-tangentbordsfokus-${width}`, {
        path: screenshot,
        contentType: 'image/png',
      })
      expect(focus.outlineStyle).not.toBe('none')
      expect(focus.outlineWidth).toBeGreaterThan(0)
      expect(focus.left).toBeGreaterThanOrEqual(0)
      expect(focus.right).toBeLessThanOrEqual(focus.viewport + 1)
      expect(focus.documentWidth).toBeLessThanOrEqual(focus.viewport + 1)

      await page.keyboard.press('Enter')
      await expect(row).toHaveAttribute('aria-expanded', 'true')
      await expect(row).toBeFocused()
      const card = row.locator('..')
      const body = card.getByText(PRIMARY.description, { exact: true }).locator('..')
      await expect(body).toBeVisible()
      await expect(body).toHaveAttribute('id', bodyId)
      expect(
        await page.evaluate(
          (id) =>
            Array.from(document.querySelectorAll('[id]')).filter((element) => element.id === id)
              .length,
          bodyId,
        ),
      ).toBe(1)
      await expect(body.getByText(PRIMARY.comments[0]!.content, { exact: true })).toBeVisible()
      await expect(page.getByText(INTERNAL, { exact: true })).toHaveCount(0)
      await expect(page.getByText(SECONDARY.description, { exact: true })).toHaveCount(0)
      const input = body.getByRole('textbox', { name: 'Meddelande till hyresvärden', exact: true })
      await page.keyboard.press('Tab')
      await expect(input).toBeFocused()
      await page.keyboard.type(MESSAGE)
      await expect(input).toHaveValue(MESSAGE)

      await page.keyboard.press('Shift+Tab')
      await expect(row).toBeFocused()
      await page.keyboard.press('Space')
      await expect(row).toHaveAttribute('aria-expanded', 'false')
      await expect(body).toHaveCount(0)
      await expect(row).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(other).toBeFocused()
      await expect(other).toHaveAttribute('aria-expanded', 'false')
      await page.keyboard.press('Shift+Tab')
      await expect(row).toBeFocused()
      await page.keyboard.press('Space')
      await expect(row).toHaveAttribute('aria-expanded', 'true')
      await expect(body).toHaveAttribute('id', bodyId)
      await page.keyboard.press('Tab')
      await expect(input).toBeFocused()
      await expect(input).toHaveValue(MESSAGE)
      await page.keyboard.press('Tab')
      const send = body.getByRole('button', { name: 'Skicka', exact: true })
      await expect(send).toBeFocused()
      await page.keyboard.press('Enter')
      const pending = await network.nextComment()
      await expect(body.getByRole('button', { name: 'Skickar...', exact: true })).toBeDisabled()
      await expect(input).toHaveValue(MESSAGE)
      await network.complete(pending)
      // GET-content + tomt fält + återställd knapptext avgränsar invalidate/finally,
      // inte bara den syntetiska adapterns response-settlement.
      await expect(body.getByText(MESSAGE, { exact: true })).toBeVisible()
      await expect(input).toHaveValue('')
      await expect(send).toBeVisible()
      await expect(send).toBeDisabled()
      await expect(other).toHaveAttribute('aria-expanded', 'false')
      await expect(page.getByText(SECONDARY.description, { exact: true })).toHaveCount(0)
      await expect(page.getByText(INTERNAL, { exact: true })).toHaveCount(0)
      await expect(row).toHaveAttribute('aria-expanded', 'true')
      await expect(page).toHaveURL(`${ORIGIN}/maintenance`)
    } finally {
      await network.finish()
    }
  })
}
