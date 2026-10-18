/** Verklig tangentbordsrullning i byggd portal; inga scroll- eller fokusgenvägar till läsytan. */
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
const TITLE = 'Lång syntetisk nyhet'
const LAST = 'SLUTMARKÖR 7429'
const BODY = [
  ...Array.from(
    { length: 24 },
    (_, i) =>
      `Avsnitt ${i + 1}. Detta är syntetisk information om gården och gemensamma utrymmen. Läsaren ska kunna ta del av hela nyheten med tangentbordet utan att bakgrundens nyhetslista flyttas.`,
  ),
  LAST,
].join('\n\n')
const NEWS = [
  { id: 'news-long', title: TITLE, body: BODY },
  ...Array.from({ length: 12 }, (_, i) => ({
    id: `news-background-${i + 1}`,
    title: `Annan syntetisk nyhet ${i + 1}`,
    body: 'Denna nyhet gör bakgrundslistan verkligt rullbar även på den bredare testvyn.',
  })),
].map((post) => ({
  ...post,
  publishedAt: '2026-01-15T12:00:00.000Z',
  imageUrl: null,
  organizationName: 'Syntetisk hyresvärd',
  authorName: null,
}))

test.use({ serviceWorkers: 'block' })

async function prepare(context: BrowserContext, page: Page) {
  const unexpected: string[] = []
  const writes: string[] = []
  const pageErrors: string[] = []
  const inFlight = new Set<Promise<void>>()
  let newsReads = 0
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
    if (request.method() === 'GET' && api === '/portal/news') {
      if (request.headers()['authorization'] !== `Bearer ${TOKEN}`) {
        unexpected.push('Fel syntetisk Bearer i news-GET')
        await route.abort('blockedbyclient')
      } else {
        newsReads += 1
        await route.fulfill({ json: { success: true, data: NEWS } })
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
    // Sidan stängs med nätspärren kvar, före slutassertionerna. Inga sena sidsteg återstår.
    await page.close()
    await Promise.all([...inFlight])
    expect(newsReads).toBeGreaterThan(0)
    expect(writes, 'Läsning av nyheter får inte göra API-skrivningar').toEqual([])
    expect(unexpected, 'Oväntade API-/externa anrop').toEqual([])
    expect(pageErrors, 'Browserfel').toEqual([])
  }
}

function backgroundPosition(page: Page) {
  return page.evaluate(() => ({
    x: window.scrollX,
    y: window.scrollY,
    rootTop: document.scrollingElement?.scrollTop ?? null,
    rootLeft: document.scrollingElement?.scrollLeft ?? null,
    bodyTop: document.body.scrollTop,
    bodyLeft: document.body.scrollLeft,
  }))
}

async function scrollState(surface: Locator) {
  return surface.evaluate((element, marker) => {
    const area = element as HTMLElement
    const box = area.getBoundingClientRect()
    const clip = {
      left: Math.max(0, box.left + area.clientLeft),
      right: Math.min(innerWidth, box.left + area.clientLeft + area.clientWidth),
      top: Math.max(0, box.top + area.clientTop),
      bottom: Math.min(innerHeight, box.top + area.clientTop + area.clientHeight),
    }
    // Range läser den faktiska sluttextens geometri utan DOM-ändring eller scrollIntoView.
    const walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT)
    const rects: DOMRect[] = []
    let matches = 0
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? ''
      let at = text.indexOf(marker)
      while (at !== -1) {
        matches += 1
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + marker.length)
        rects.push(...Array.from(range.getClientRects()))
        at = text.indexOf(marker, at + marker.length)
      }
    }
    return {
      top: area.scrollTop,
      max: area.scrollHeight - area.clientHeight,
      height: area.clientHeight,
      markerMatches: matches,
      markerVisible:
        matches === 1 &&
        rects.length > 0 &&
        rects.every(
          (rect) =>
            rect.width > 0 &&
            rect.height > 0 &&
            rect.left >= clip.left &&
            rect.right <= clip.right &&
            rect.top >= clip.top &&
            rect.bottom <= clip.bottom,
        ),
    }
  }, LAST)
}

for (const width of [320, 430]) {
  test(`lång nyhet kan läsas med Tab, PageDown och End vid ${width}px`, async ({
    page,
    context,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 740 })
    const finish = await prepare(context, page)
    try {
      await page.goto('/news')
      const cookies = page.getByRole('dialog', { name: 'Cookies', exact: true })
      await expect(cookies).toBeVisible()
      await cookies.getByRole('button', { name: 'Endast nödvändiga', exact: true }).click()
      await expect(cookies).toHaveCount(0)
      const opener = page.getByRole('button', { name: `Öppna nyhet: ${TITLE}`, exact: true })
      await expect(opener).toBeVisible()
      await page.evaluate(() => document.fonts.ready.then(() => undefined))
      expect(
        await page.evaluate(() => (document.scrollingElement?.scrollHeight ?? 0) - innerHeight),
        'Bakgrundslistan måste faktiskt kunna rulla',
      ).toBeGreaterThan(740)
      // Enda explicita fokusflytten går till den verkliga öppningsknappen.
      await opener.focus()
      const before = await backgroundPosition(page)
      const oldOverflow = await page.evaluate(() => document.body.style.overflow)
      await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog', { name: TITLE, exact: true })
      const close = dialog.getByRole('button', { name: 'Stäng', exact: true })
      await expect(dialog).toBeVisible()
      // Vänta på det faktiska animationsläget, inte en antagen 220 ms-sömn.
      await expect
        .poll(() =>
          dialog.evaluate((element) =>
            element
              .getAnimations()
              .every((animation) => ['finished', 'idle'].includes(animation.playState)),
          ),
        )
        .toBe(true)
      await expect(close).toBeFocused()
      expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden')
      expect(await backgroundPosition(page)).toEqual(before)
      const closeBefore = await close.boundingBox()
      expect(closeBefore).not.toBeNull()
      // Befintlig h2 → innehåll → scrollbehållare; inget krav på en nytillkommen roll.
      const surface = dialog.locator('#news-sheet-title').locator('..').locator('..')
      const initial = await scrollState(surface)
      expect(initial.markerMatches).toBe(1)
      expect(initial.max).toBeGreaterThan(initial.height * 3)
      expect(initial.top).toBe(0)
      expect(initial.markerVisible).toBe(false)
      await page.keyboard.press('Tab')
      await expect(surface, 'Verklig Tab måste nå nyhetens läsyta').toBeFocused()
      await page.keyboard.press('Shift+Tab')
      await expect(close).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(surface).toBeFocused()
      await page.keyboard.press('PageDown')
      await expect.poll(async () => (await scrollState(surface)).top).toBeGreaterThan(initial.top)
      const paged = await scrollState(surface)
      expect(paged.top).toBeLessThan(paged.max)
      expect(paged.markerVisible).toBe(false)
      expect(await backgroundPosition(page)).toEqual(before)
      await page.keyboard.press('End')
      await expect
        .poll(async () => {
          const state = await scrollState(surface)
          return (
            state.top > paged.top && Math.abs(state.max - state.top) <= 1 && state.markerVisible
          )
        })
        .toBe(true)
      expect(await backgroundPosition(page)).toEqual(before)
      const closeAfter = await close.boundingBox()
      expect(closeAfter).not.toBeNull()
      if (!closeBefore || !closeAfter) throw new Error('Stäng saknar verklig geometri')
      expect(Math.abs(closeAfter.y - closeBefore.y)).toBeLessThanOrEqual(1)
      expect(closeAfter.y).toBeGreaterThanOrEqual(0)
      expect(closeAfter.y + closeAfter.height).toBeLessThanOrEqual(740)
      expect(
        await close.evaluate((button) => {
          const rect = button.getBoundingClientRect()
          return button.contains(
            document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
          )
        }),
        'Stäng ska förbli oskymd i den fasta headern',
      ).toBe(true)
      await testInfo.attach(`nyhet-slut-${width}`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      })
      await page.keyboard.press('Tab')
      await expect(close).toBeFocused()
      await page.keyboard.press('Shift+Tab')
      await expect(surface).toBeFocused()
      expect(await backgroundPosition(page)).toEqual(before)
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(opener).toBeFocused()
      expect(await page.evaluate(() => document.body.style.overflow)).toBe(oldOverflow)
      expect(await backgroundPosition(page)).toEqual(before)
      await expect(page).toHaveURL(`${ORIGIN}/news`)
    } finally {
      await finish()
    }
  })
}
