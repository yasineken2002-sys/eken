/** Riktig byggd portal; Range-geometri för text, enbart syntetiska GET-svar. */
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
const IDENTIFIER = 'SYNTHETICREFERENCE0123456789'.repeat(8)
const URL_TEXT = `https://example.invalid/${'SyntheticUnbrokenReference0123456789'.repeat(7)}`
const DESCRIPTION = `Första raden.\nAndra  raden.\n${IDENTIFIER}`
const PUBLIC_COMMENT = `Syntetisk referens: ${URL_TEXT}`
const NORMAL_DESCRIPTION = 'Hallampan behöver bytas. Detta är en vanlig beskrivning med mellanrum.'
const INTERNAL = 'INTERNAL_WRAP_SENTINEL_MUST_NOT_RENDER'
const common = {
  ticketNumber: 'SYNTHETIC-WRAP-A',
  category: 'PLUMBING',
  status: 'IN_PROGRESS',
  priority: 'NORMAL',
  createdAt: '2026-10-18T10:00:00.000Z',
  scheduledDate: null,
  property: { name: 'Syntetiskt hus' },
  unit: { name: 'Syntetisk lägenhet' },
}
const TICKETS = [
  {
    ...common,
    id: '33333333-3333-4333-8333-333333333333',
    title: 'Ärende med lång referens',
    description: DESCRIPTION,
    comments: [
      {
        id: '55555555-5555-4555-8555-555555555555',
        content: PUBLIC_COMMENT,
        createdAt: common.createdAt,
        isInternal: false,
      },
      {
        id: '66666666-6666-4666-8666-666666666666',
        content: INTERNAL,
        createdAt: common.createdAt,
        isInternal: true,
      },
    ],
  },
  {
    ...common,
    id: '44444444-4444-4444-8444-444444444444',
    ticketNumber: 'SYNTHETIC-WRAP-B',
    title: 'Normalt kontrollärende',
    description: NORMAL_DESCRIPTION,
    comments: [],
  },
]

test.use({ serviceWorkers: 'block' })

async function prepare(context: BrowserContext, page: Page) {
  const unexpected: string[] = []
  const writes: string[] = []
  const errors: string[] = []
  const inFlight = new Set<Promise<void>>()
  let reads = 0
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
    if (!['GET', 'HEAD'].includes(request.method())) {
      writes.push(label)
      await route.abort('blockedbyclient')
      return
    }
    if (url.origin !== ORIGIN || url.search !== '') {
      unexpected.push(label)
      await route.abort('blockedbyclient')
      return
    }
    if (request.method() === 'GET' && api === '/public/config') {
      await route.fulfill({ json: { success: true, data: { features: { bankId: false } } } })
      return
    }
    if (request.method() === 'GET' && api === '/portal/maintenance') {
      reads += 1
      if (request.headers()['authorization'] !== `Bearer ${TOKEN}`) {
        unexpected.push('Fel syntetisk Bearer i maintenance-GET')
        await route.abort('blockedbyclient')
      } else {
        await route.fulfill({ json: { success: true, data: TICKETS } })
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
  return async () => {
    try {
      await Promise.all([...inFlight])
    } finally {
      await page.close()
      await Promise.all([...inFlight])
    }
    expect(reads).toBeGreaterThan(0)
    expect(writes, 'Ingen API-skrivning i textläsprovet').toEqual([])
    expect(unexpected, 'Oväntade API-/externa anrop').toEqual([])
    expect(errors, 'Browser-/routefel').toEqual([])
  }
}

function row(page: Page, title: string) {
  return page.getByText(title, { exact: true }).locator('..').locator('..')
}

async function measureText(card: Locator, expected: string, token = '') {
  return card.evaluate(
    (element, input) => {
      const paragraph = Array.from(element.querySelectorAll('p')).find(
        (p) => p.textContent === input.expected,
      )
      if (!paragraph) throw new Error('Förväntad oförkortad text saknas')
      const node = paragraph.firstChild
      if (!node || node.nodeType !== Node.TEXT_NODE || node.textContent !== input.expected) {
        throw new Error('Förväntad faktisk textnod saknas')
      }
      const rect = (r: DOMRect) => ({
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      })
      const rangeRects = (start: number, end: number) => {
        const range = document.createRange()
        range.setStart(node, start)
        range.setEnd(node, end)
        return Array.from(range.getClientRects())
          .filter((r) => r.width > 0 && r.height > 0)
          .map(rect)
      }
      const p = paragraph.getBoundingClientRect()
      const c = element.getBoundingClientRect()
      const content = {
        left: p.left + paragraph.clientLeft,
        right: p.left + paragraph.clientLeft + paragraph.clientWidth,
        top: p.top + paragraph.clientTop,
        bottom: p.top + paragraph.clientTop + paragraph.clientHeight,
      }
      const clip = {
        left: c.left + element.clientLeft,
        right: c.left + element.clientLeft + element.clientWidth,
        top: c.top + element.clientTop,
        bottom: c.top + element.clientTop + element.clientHeight,
      }
      // Vertikal dokumentrullning är tillåten. Ingen textrad får däremot ligga
      // utanför sin egen yta, kortets klippkant eller viewportens horisontella bredd.
      const bounds = {
        left: Math.max(content.left, clip.left, 0),
        right: Math.min(content.right, clip.right, document.documentElement.clientWidth),
        top: Math.max(content.top, clip.top),
        bottom: Math.min(content.bottom, clip.bottom),
      }
      const rows = rangeRects(0, input.expected.length)
      const tokenStart = input.token ? input.expected.indexOf(input.token) : -1
      if (input.token && tokenStart < 0) throw new Error('Sammanhängande referens saknas')
      const tokenRows =
        tokenStart < 0 ? [] : rangeRects(tokenStart, tokenStart + input.token.length)
      const outside = rows.filter(
        (r) =>
          r.left < bounds.left - 1 ||
          r.right > bounds.right + 1 ||
          r.top < bounds.top - 1 ||
          r.bottom > bounds.bottom + 1,
      )
      const lineBreaks = input.expected.startsWith('Första raden.\nAndra  raden.\n')
        ? [
            rangeRects(0, 'Första raden.'.length)[0],
            rangeRects('Första raden.\n'.length, 'Första raden.\nAndra  raden.'.length)[0],
          ]
        : []
      return {
        rows,
        tokenRows,
        outside,
        bounds,
        content,
        clip,
        lineBreaks,
        overflowX: getComputedStyle(element).overflowX,
      }
    },
    { expected, token },
  )
}

for (const width of [320, 430]) {
  test(`hela ärendebeskrivningen och offentliga referensen ryms vid ${width}px`, async ({
    page,
    context,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 740 })
    const finish = await prepare(context, page)
    try {
      await page.goto('/maintenance')
      const cookies = page.getByRole('dialog', { name: 'Cookies', exact: true })
      await expect(cookies).toBeVisible()
      await cookies.getByRole('button', { name: 'Endast nödvändiga', exact: true }).click()
      await expect(cookies).toHaveCount(0)
      const primary = row(page, 'Ärende med lång referens')
      const other = row(page, 'Normalt kontrollärende')
      await expect(primary).toBeVisible()
      await expect(other).toBeVisible()
      await page.evaluate(async () => {
        await document.fonts.ready
      })
      // Positiv normaltext-kontroll först, med samma mätning som problemtexterna.
      await other.click()
      await expect(other).toHaveAttribute('aria-expanded', 'true')
      const normal = await measureText(other.locator('..'), NORMAL_DESCRIPTION)
      expect(normal.rows.length).toBeGreaterThan(0)
      expect(normal.outside, 'Normal beskrivning').toEqual([])
      await other.click()
      await expect(other).toHaveAttribute('aria-expanded', 'false')
      await expect(page.getByText(NORMAL_DESCRIPTION, { exact: true })).toHaveCount(0)

      await primary.click()
      await expect(primary).toHaveAttribute('aria-expanded', 'true')
      const card = primary.locator('..')
      // textContent bevarar även dubbla blanksteg/nyrader; toHaveText normaliserar dem.
      expect(await card.getByText(DESCRIPTION, { exact: true }).textContent()).toBe(DESCRIPTION)
      expect(await card.getByText(PUBLIC_COMMENT, { exact: true }).textContent()).toBe(
        PUBLIC_COMMENT,
      )
      await expect(page.getByText(INTERNAL, { exact: true })).toHaveCount(0)
      await expect(other).toHaveAttribute('aria-expanded', 'false')
      const description = await measureText(card, DESCRIPTION, IDENTIFIER)
      const comment = await measureText(card, PUBLIC_COMMENT, URL_TEXT)
      const screenshot = testInfo.outputPath(`arendetext-${width}.png`)
      await page.screenshot({ path: screenshot, fullPage: true })
      await testInfo.attach(`arendetext-${width}`, { path: screenshot, contentType: 'image/png' })
      await testInfo.attach('textrader-och-klippkanter', {
        body: JSON.stringify({ normal, description, comment }, null, 2),
        contentType: 'application/json',
      })
      // Båda problemtexterna är mätta innan soft-asserts; första felet får inte
      // dölja om även commentContent klipper. Inget exakt antal radbrytningar krävs.
      for (const [name, geometry] of [
        ['description', description],
        ['comment', comment],
      ] as const) {
        expect.soft(geometry.rows.length, `${name}: verkliga textrader`).toBeGreaterThan(0)
        expect
          .soft(geometry.tokenRows.length, `${name}: referensen ska rymmas över flera rader`)
          .toBeGreaterThan(1)
        expect.soft(geometry.outside, `${name}: rader utanför text/kort/viewport`).toEqual([])
      }
      const [firstLine, secondLine] = description.lineBreaks
      expect(firstLine).toBeDefined()
      expect(secondLine).toBeDefined()
      if (!firstLine || !secondLine) throw new Error('Literalradernas Range saknas')
      expect(secondLine.top, 'Befintlig pre-wrap-nyrad bevaras').toBeGreaterThan(firstLine.top)
      expect(Math.abs(firstLine.left - secondLine.left)).toBeLessThanOrEqual(1)
      await expect(page).toHaveURL(`${ORIGIN}/maintenance`)
    } finally {
      await finish()
    }
  })
}
