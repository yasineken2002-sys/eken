/**
 * En sammanhängande syntetisk UI-resa i byggd portal, 320px i båda befintliga motorerna.
 * Kommentar slutförs efter route-unmount men inom samma session. Ingen backend-/SW-bevisning.
 */
import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Request,
  type Response,
  type Route,
} from '@playwright/test'

const ORIGIN = 'http://127.0.0.1:' + Number(process.env.PWA_TEST_PORT ?? 4179)
const PASSWORD = 'SyntheticPassword123!'
const MESSAGE = 'PRIVATE_A_JOURNEY: Jag är hemma på torsdag efter klockan tio.'
const INTERNAL = 'PRIVATE_INTERNAL_JOURNEY_MUST_NOT_RENDER'
const ACCOUNTS = {
  a: {
    id: '11111111-1111-4111-8111-111111111111',
    firstName: 'PRIVATE_ALPHA_JOURNEY',
    lastName: 'Syntetisk',
    companyName: null,
    email: 'a@example.invalid',
  },
  b: {
    id: '22222222-2222-4222-8222-222222222222',
    firstName: 'PRIVATE_BETA_JOURNEY',
    lastName: 'Syntetisk',
    companyName: null,
    email: 'b@example.invalid',
  },
}
const TOKENS = { a: 'PRIVATE_SESSION_ALPHA_JOURNEY', b: 'PRIVATE_SESSION_BETA_JOURNEY' }
const A_TICKET = {
  id: '33333333-3333-4333-8333-333333333333',
  ticketNumber: 'SYNTHETIC-JOURNEY-A',
  title: 'PRIVATE_A: Droppande kökskran',
  description: 'PRIVATE_A: Kökskranen droppar när den är stängd.',
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
      content: 'PRIVATE_A: Vi kommer på torsdag. Svara gärna här.',
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
const B_TICKET = {
  ...A_TICKET,
  id: '44444444-4444-4444-8444-444444444444',
  ticketNumber: 'SYNTHETIC-JOURNEY-B',
  title: 'PRIVATE_B: Trasig hallampa',
  description: 'PRIVATE_B: Hallampan behöver bytas.',
  category: 'ELECTRICAL',
  status: 'NEW',
  property: { name: 'Syntetiskt hus B' },
  unit: { name: 'Lägenhet B' },
  comments: [
    {
      id: '77777777-7777-4777-8777-777777777777',
      content: 'PRIVATE_B: Tack, ditt eget ärende är mottaget.',
      createdAt: '2026-10-18T12:00:00.000Z',
      isInternal: false,
    },
  ],
}
const COMMENT_PATH = '/portal/maintenance/' + A_TICKET.id + '/comment'
type Actor = keyof typeof ACCOUNTS
type HeldComment = { route: Route; content: string; release(status: 200 | 400): void }
type DomWatch = { leaked: boolean; observations: number; stop(): void }

test.use({ serviceWorkers: 'block' })

async function prepare(context: BrowserContext, page: Page) {
  const unexpected: string[] = []
  const errors: string[] = []
  const posts: string[] = []
  const inFlight = new Set<Promise<void>>()
  const pendingRequests = new Set<Request>()
  const terminal = { started: 0, finished: 0, failed: 0, success304: 0, cleanup304: 0 }
  const successFailures: { path: string; kind: string }[] = []
  const cleanupFailures: { path: string; kind: string }[] = []
  const successHttpErrors: { path: string; status: number }[] = []
  const cleanupHttpErrors: { path: string; status: number }[] = []
  let closing = false
  const onRequest = (request: Request) => {
    terminal.started += 1
    pendingRequests.add(request)
  }
  const onFinished = (request: Request) => {
    terminal.finished += 1
    pendingRequests.delete(request)
  }
  const onFailed = (request: Request) => {
    terminal.failed += 1
    pendingRequests.delete(request)
    const kind = /abort|cancel/i.test(request.failure()?.errorText ?? '') ? 'aborted' : 'other'
    ;(closing ? cleanupFailures : successFailures).push({
      path: new URL(request.url()).pathname,
      kind,
    })
  }
  const onResponse = (response: Response) => {
    if (response.status() === 304) terminal[closing ? 'cleanup304' : 'success304'] += 1
    if (response.status() >= 400) {
      ;(closing ? cleanupHttpErrors : successHttpErrors).push({
        path: new URL(response.url()).pathname,
        status: response.status(),
      })
    }
  }
  context.on('request', onRequest)
  context.on('requestfinished', onFinished)
  context.on('requestfailed', onFailed)
  context.on('response', onResponse)
  const counts = { publicConfig: 0, dashboardB: 0, maintenanceA: 0, maintenanceB: 0 }
  let actor: Actor | null = 'a'
  let loginCount = 0
  let logoutCount = 0
  let downloads = 0
  let extraPages = 0
  let firstAReadAt: number | undefined
  let held: HeldComment | undefined
  let aTicket = A_TICKET
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('download', () => {
    downloads += 1
  })
  const onPage = () => {
    extraPages += 1
  }
  context.on('page', onPage)
  await context.addInitScript(
    (initial) => {
      localStorage.setItem(
        'tenant_session',
        JSON.stringify({
          state: {
            sessionToken: initial.token,
            tenant: { ...initial.tenant, type: 'INDIVIDUAL' },
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            isAuthenticated: true,
          },
          version: 0,
        }),
      )
    },
    { token: TOKENS.a, tenant: ACCOUNTS.a },
  )

  const handle = async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    const isApi = url.pathname.startsWith('/api/')
    const api = isApi ? url.pathname.slice(4) : url.pathname
    const authorization = request.headers()['authorization']
    const json = (data: unknown) => route.fulfill({ json: { success: true, data } })
    if (url.origin !== ORIGIN || url.search !== '' || request.headers()['x-dev-tenant-id']) {
      unexpected.push(method + ' ' + url.origin + url.pathname)
      await route.abort('blockedbyclient')
      return
    }
    if (isApi && method === 'POST') {
      posts.push(api)
      expect(request.headers()['content-type']).toContain('application/json')
      if (api === '/tenant-portal/login/resolve') {
        const who: Actor = 'b'
        expect(loginCount).toBe(0)
        expect(actor).toBeNull()
        expect(logoutCount).toBe(1)
        expect(authorization).toBeUndefined()
        expect(request.postDataJSON()).toEqual({ email: ACCOUNTS[who].email, password: PASSWORD })
        loginCount += 1
        actor = who
        await json({
          status: 'complete',
          tenant: ACCOUNTS[who],
          sessionToken: TOKENS[who],
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        })
        return
      }
      if (api === '/tenant-portal/logout') {
        expect(actor).toBe('a')
        expect(logoutCount).toBe(0)
        expect(authorization).toBeUndefined()
        expect(request.postDataJSON()).toEqual({ sessionToken: TOKENS.a })
        actor = null
        logoutCount += 1
        await json(null)
        return
      }
      if (api === COMMENT_PATH) {
        expect(actor).toBe('a')
        expect(authorization).toBe('Bearer ' + TOKENS.a)
        expect(held).toBeUndefined()
        const payload: unknown = request.postDataJSON()
        expect(payload).toEqual({ content: MESSAGE })
        const content = (payload as { content: string }).content
        let release!: (status: 200 | 400) => void
        const reply = new Promise<200 | 400>((resolve) => {
          release = resolve
        })
        let answered = false
        held = {
          route,
          content,
          release(status) {
            if (answered) return
            answered = true
            release(status)
          },
        }
        const status = await reply
        if (status === 200) {
          // Först mottagen, exakt kontrollerad POST-data får ändra transportfixturen.
          aTicket = {
            ...A_TICKET,
            comments: [
              ...A_TICKET.comments,
              {
                id: '88888888-8888-4888-8888-888888888888',
                content,
                createdAt: '2026-10-18T13:00:00.000Z',
                isInternal: false,
              },
            ],
          }
        }
        // POST visar ALDRIG den nya kommentaren. Bara en följande GET kan visa den.
        await route.fulfill({
          status,
          json:
            status === 200
              ? { success: true, data: A_TICKET }
              : { success: false, error: { message: 'Syntetisk teststädning' } },
        })
        return
      }
    }
    if (isApi && method === 'GET' && api === '/public/config') {
      expect(authorization).toBeUndefined()
      expect(request.postData()).toBeNull()
      counts.publicConfig += 1
      await json({ features: { bankId: false } })
      return
    }
    if (isApi && method === 'GET' && ['/portal/dashboard', '/portal/maintenance'].includes(api)) {
      expect(actor).not.toBeNull()
      if (!actor) throw new Error('Privat GET utan syntetisk inloggning')
      expect(authorization).toBe('Bearer ' + TOKENS[actor])
      expect(request.postData()).toBeNull()
      if (api === '/portal/dashboard') {
        expect(actor).toBe('b')
        counts.dashboardB += 1
        await json({
          tenant: { ...ACCOUNTS[actor], type: 'INDIVIDUAL' },
          activeLease: null,
          overdueInvoices: 0,
          upcomingInvoice: null,
          openMaintenanceTickets: 1,
          unreadNotices: 0,
        })
      } else {
        counts[actor === 'a' ? 'maintenanceA' : 'maintenanceB'] += 1
        if (actor === 'a' && firstAReadAt === undefined) firstAReadAt = performance.now()
        await json([actor === 'a' ? aTicket : B_TICKET])
      }
      return
    }
    const appPath = ['/login', '/dashboard', '/maintenance', '/installningar'].includes(
      url.pathname,
    )
    const staticPath =
      /^\/(assets|icons)\//.test(url.pathname) || url.pathname === '/manifest.webmanifest'
    if (
      method === 'GET' &&
      !authorization &&
      !request.postData() &&
      !['xhr', 'fetch'].includes(request.resourceType()) &&
      (appPath || staticPath)
    ) {
      await route.continue()
      return
    }
    unexpected.push(method + ' ' + url.pathname)
    await route.abort('blockedbyclient')
  }
  await context.route('**/*', async (route) => {
    const work = handle(route).catch(async (error: unknown) => {
      errors.push(error instanceof Error ? error.message : String(error))
      await route.abort('blockedbyclient').catch(() => undefined)
    })
    inFlight.add(work)
    try {
      await work
    } finally {
      inFlight.delete(work)
    }
  })

  return {
    counts,
    async pendingComment() {
      await expect.poll(() => held !== undefined).toBe(true)
      if (!held) throw new Error('Kommentar-POST saknas')
      expect(held.content).toBe(MESSAGE)
      expect(posts).toEqual([COMMENT_PATH])
    },
    async completeComment() {
      if (!held) throw new Error('Kommentar-POST saknas')
      const response = page.waitForResponse((value) => value.request() === held?.route.request())
      held.release(200)
      const delivered = await response
      expect(delivered.status()).toBe(200)
      expect(await delivered.finished()).toBeNull()
      // Network completion ensam är inte app-settlement. En riktig nästa host-task
      // följs av positivt GET-/DOM-facit efter remount; ingen query-hook eller TTL-väntan.
      await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    },
    async waitForTransport() {
      await expect
        .poll(() => pendingRequests.size, 'Alla verkliga browserrequests ska nå terminalt event')
        .toBe(0)
      expect(successFailures).toEqual([])
      expect(successHttpErrors).toEqual([])
      expect(terminal.finished + terminal.failed).toBe(terminal.started)
    },
    assertFreshWindow() {
      expect(firstAReadAt).toBeDefined()
      if (firstAReadAt === undefined) throw new Error('Första A-läsningen saknas')
      expect(
        performance.now() - firstAReadAt,
        'Återbesök före produktens staleTime 60s',
      ).toBeLessThan(60_000)
    },
    assertComplete() {
      expect(posts).toEqual([COMMENT_PATH, '/tenant-portal/logout', '/tenant-portal/login/resolve'])
      // Loginvyn monteras först efter logout och på nytt i B:s generation före navigeringen.
      expect(counts).toEqual({ publicConfig: 2, dashboardB: 1, maintenanceA: 2, maintenanceB: 1 })
      expect(loginCount).toBe(1)
      expect(logoutCount).toBe(1)
      expect(actor).toBe('b')
    },
    async finish() {
      closing = true
      held?.release(400)
      try {
        await Promise.all([...inFlight])
      } finally {
        // Spärren sitter kvar även genom close; inga sena routes lämnas oobserverade.
        try {
          await Promise.all(context.pages().map((value) => value.close()))
        } finally {
          try {
            await Promise.all([...inFlight])
            await expect
              .poll(() => pendingRequests.size, 'Ingen request kvar efter close/drain')
              .toBe(0)
          } finally {
            context.off('page', onPage)
            context.off('request', onRequest)
            context.off('requestfinished', onFinished)
            context.off('requestfailed', onFailed)
            context.off('response', onResponse)
          }
        }
      }
      expect.soft(downloads, 'Ingen nedladdning ingår').toBe(0)
      expect.soft(extraPages, 'Inga extra sidor ingår').toBe(0)
      expect.soft(unexpected, 'Oväntat nätanrop').toEqual([])
      expect.soft(errors, 'Browser-/routefel').toEqual([])
      expect.soft(successFailures, 'Transportfel före teardown').toEqual([])
      expect.soft(successHttpErrors, 'HTTP-fel före teardown').toEqual([])
      expect.soft(terminal.finished + terminal.failed).toBe(terminal.started)
      return {
        ...terminal,
        pending: pendingRequests.size,
        successFailures,
        cleanupFailures,
        successHttpErrors,
        cleanupHttpErrors,
      }
    },
  }
}

async function login(page: Page, actor: Actor) {
  await page.getByLabel('E-postadress').fill(ACCOUNTS[actor].email)
  await page.getByLabel('Lösenord', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Logga in', exact: true }).click()
  await expect(page).toHaveURL(ORIGIN + '/dashboard')
  await expect(page.getByText(new RegExp(ACCOUNTS[actor].firstName)).first()).toBeVisible()
}

function ticketButton(page: Page, title: string) {
  return page.getByRole('button').filter({ has: page.getByText(title, { exact: true }) })
}

test('kommentar efter sidbyte följer A genom återbesök men inte med till B vid 320px', async ({
  page,
  context,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 })
  const network = await prepare(context, page)
  let completed = false
  try {
    await page.goto('/maintenance')
    const cookies = page.getByRole('dialog', { name: 'Cookies', exact: true })
    await expect(cookies).toBeVisible()
    await cookies.getByRole('button', { name: 'Endast nödvändiga', exact: true }).click()
    await expect(cookies).toHaveCount(0)
    await expect(page).toHaveURL(ORIGIN + '/maintenance')
    const opener = ticketButton(page, A_TICKET.title)
    await opener.click()
    const card = opener.locator('..')
    await expect(card.getByText(A_TICKET.description, { exact: true })).toBeVisible()
    await expect(card.getByText(A_TICKET.comments[0]!.content, { exact: true })).toBeVisible()
    await expect(page.getByText(INTERNAL, { exact: true })).toHaveCount(0)
    const input = card.getByRole('textbox', { name: 'Meddelande till hyresvärden', exact: true })
    await input.fill('  ' + MESSAGE + '  ')
    await card.getByRole('button', { name: 'Skicka', exact: true }).click()
    await network.pendingComment()
    await expect(card.getByRole('button', { name: 'Skickar...', exact: true })).toBeDisabled()
    await expect(input).toHaveValue('  ' + MESSAGE + '  ')

    // Det nya integrationsfallet: avmontera TicketCard medan dess POST fortfarande väntar.
    await page.getByRole('link', { name: 'Konto', exact: true }).click()
    await expect(page).toHaveURL(ORIGIN + '/installningar')
    await expect(page.getByRole('heading', { name: 'Inställningar', exact: true })).toBeVisible()
    await expect(page.getByText(/a@example\.invalid/)).toBeVisible()
    await expect(opener).toHaveCount(0)
    expect(network.counts.maintenanceA).toBe(1)
    await network.completeComment()
    await expect(page).toHaveURL(ORIGIN + '/installningar')
    await page.getByRole('link', { name: 'Felanmälan', exact: true }).click()
    await expect(page).toHaveURL(ORIGIN + '/maintenance')
    await expect.poll(() => network.counts.maintenanceA).toBe(2)
    network.assertFreshWindow()
    await opener.click()
    await expect(card.getByText(MESSAGE, { exact: true })).toHaveCount(1)
    await expect(card.getByText(MESSAGE, { exact: true })).toBeVisible()
    await expect(input).toHaveValue('')
    await expect(card.getByRole('button', { name: 'Skicka', exact: true })).toBeDisabled()

    const logout = page.waitForResponse(
      (value) => new URL(value.url()).pathname === '/api/tenant-portal/logout',
    )
    await page.getByRole('button', { name: 'Logga ut', exact: true }).click()
    const logoutResponse = await logout
    expect(logoutResponse.status()).toBe(200)
    expect(await logoutResponse.finished()).toBeNull()
    await expect(page).toHaveURL(ORIGIN + '/login')
    await expect(page.getByRole('button', { name: 'Logga in', exact: true })).toBeVisible()
    await expect(page.locator('body')).not.toContainText('PRIVATE_A')
    // Bounded DOM-observation från utloggat läge genom B:s positiva ärendevy.
    await page.evaluate(() => {
      let observer: MutationObserver | undefined
      const state: DomWatch = {
        leaked: false,
        observations: 0,
        stop() {
          observer?.disconnect()
        },
      }
      const check = () => {
        state.observations += 1
        state.leaked ||= /PRIVATE_A|a@example\.invalid/.test(document.body.textContent ?? '')
      }
      observer = new MutationObserver(check)
      observer.observe(document.body, { subtree: true, childList: true, characterData: true })
      ;(window as Window & { ticketJourneyWatch?: DomWatch }).ticketJourneyWatch = state
      check()
    })
    await login(page, 'b')
    await page.getByRole('link', { name: 'Felanmälan', exact: true }).click()
    await expect(page).toHaveURL(ORIGIN + '/maintenance')
    await expect.poll(() => network.counts.maintenanceB).toBe(1)
    const bOpener = ticketButton(page, B_TICKET.title)
    await bOpener.click()
    const bCard = bOpener.locator('..')
    await expect(bCard.getByText(B_TICKET.description, { exact: true })).toBeVisible()
    await expect(bCard.getByText(B_TICKET.comments[0]!.content, { exact: true })).toBeVisible()
    await expect(
      bCard.getByRole('textbox', { name: 'Meddelande till hyresvärden', exact: true }),
    ).toHaveValue('')
    await expect(bCard.getByRole('button', { name: 'Skicka', exact: true })).toBeDisabled()
    await network.waitForTransport()
    await expect(page.getByText(A_TICKET.title, { exact: true })).toHaveCount(0)
    await expect(page.getByText(MESSAGE, { exact: true })).toHaveCount(0)
    await expect(page.getByText(INTERNAL, { exact: true })).toHaveCount(0)
    const watch = await page.evaluate(() => {
      const state = (window as Window & { ticketJourneyWatch?: DomWatch }).ticketJourneyWatch
      if (!state) throw new Error('DOM-observatören saknas')
      state.stop()
      return { leaked: state.leaked, observations: state.observations }
    })
    expect(watch.observations).toBeGreaterThan(1)
    expect(watch.leaked, 'A-markörer får inte återkomma under B-resan').toBe(false)
    network.assertComplete()
    await testInfo.attach('arenderesa-B-320', {
      body: await page.screenshot(),
      contentType: 'image/png',
    })
    completed = true
  } finally {
    const terminal = await network.finish()
    await testInfo.attach('request-terminalization', {
      body: JSON.stringify(terminal, null, 2),
      contentType: 'application/json',
    })
    if (completed) network.assertComplete()
  }
})
