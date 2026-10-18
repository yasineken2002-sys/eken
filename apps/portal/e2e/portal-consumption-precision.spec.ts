/** Byggd portal, tre syntetiska förbrukningskort; inga produktformatterare som facit. */
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
const PERIOD = { periodStart: '2026-05-01T12:00:00.000Z', periodEnd: '2026-05-31T12:00:00.000Z' }
const CHARGES = [
  {
    id: 'a1000000-0000-4000-8000-000000000001',
    meterType: 'ELECTRICITY',
    ...PERIOD,
    quantity: 12.345,
    netAmount: 0.23,
    vatAmount: 0.06,
    totalAmount: 0.29,
  },
  {
    id: 'b2000000-0000-4000-8000-000000000002',
    meterType: 'WATER_COLD',
    ...PERIOD,
    quantity: 8.125,
    netAmount: 987.65,
    vatAmount: 246.91,
    totalAmount: 1234.56,
  },
  {
    id: 'c3000000-0000-4000-8000-000000000003',
    meterType: 'HEATING',
    ...PERIOD,
    quantity: 200,
    netAmount: 6000,
    vatAmount: 1500,
    totalAmount: 7500,
  },
]
const EXPECTED = [
  { category: 'El', quantity: '12,345 kWh', amount: '0,29 kr' },
  { category: 'Kallvatten', quantity: '8,125 m³', amount: '1 234,56 kr' },
  { category: 'Värme', quantity: '200 kWh', amount: '7 500 kr' },
]

test.use({ serviceWorkers: 'block' })

async function prepare(context: BrowserContext, page: Page) {
  const unexpected: string[] = []
  const writes: string[] = []
  const errors: string[] = []
  const inFlight = new Set<Promise<void>>()
  let lists = 0
  let downloads = 0
  const watch = (entry: Page) => {
    entry.on('pageerror', (error) => errors.push(error.message))
    entry.on('download', () => {
      downloads++
    })
  }
  watch(page)
  context.on('page', watch)
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
    const deny = async () => {
      unexpected.push(label)
      await route.abort('blockedbyclient')
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      writes.push(label)
      await deny()
      return
    }
    if (url.origin !== ORIGIN || url.search !== '') {
      await deny()
      return
    }
    if (request.method() === 'GET' && api === '/public/config') {
      await route.fulfill({ json: { success: true, data: { features: { bankId: false } } } })
      return
    }
    if (request.method() === 'GET' && api === '/portal/consumption') {
      if (request.headers()['authorization'] !== `Bearer ${TOKEN}` || request.postData() !== null) {
        await deny()
      } else {
        lists++
        await route.fulfill({ json: { success: true, data: CHARGES } })
      }
      return
    }
    const staticPath =
      url.pathname === '/forbrukning' ||
      url.pathname === '/manifest.webmanifest' ||
      url.pathname === '/favicon.ico' ||
      /^\/(assets|icons)\/[^/]+\.(js|css|svg|png|webp|ico|woff2?)$/.test(url.pathname)
    if (staticPath && !['xhr', 'fetch'].includes(request.resourceType())) {
      await route.continue()
      return
    }
    await deny()
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
      // Spärren kvarstår även för oväntade popup-sidor till faktisk stängning och drain.
      await Promise.all(context.pages().map((entry) => entry.close()))
      await Promise.all([...inFlight])
      context.off('page', watch)
    }
    expect(lists, 'Verklig förbrukningslista hämtad').toBeGreaterThan(0)
    expect(downloads).toBe(0)
    expect(writes).toEqual([])
    expect(unexpected, 'Oväntad API-/fil-/externtrafik').toEqual([])
    expect(errors, 'Browser-/routefel').toEqual([])
  }
}

async function measureCard(card: Locator) {
  return card.evaluate((element) => {
    const paragraphs = Array.from(element.querySelectorAll('p'))
    if (paragraphs.length !== 4)
      throw new Error('Förväntade kategori/period/kvantitet/belopp saknas')
    const rect = (value: DOMRect) => ({
      left: value.left,
      right: value.right,
      top: value.top,
      bottom: value.bottom,
      width: value.width,
      height: value.height,
    })
    const c = element.getBoundingClientRect()
    const cardBounds = {
      left: c.left + element.clientLeft,
      right: c.left + element.clientLeft + element.clientWidth,
    }
    return paragraphs.map((paragraph) => {
      const p = paragraph.getBoundingClientRect()
      const textBounds = {
        left: p.left + paragraph.clientLeft,
        right: p.left + paragraph.clientLeft + paragraph.clientWidth,
      }
      const bounds = {
        left: Math.max(textBounds.left, cardBounds.left, 0),
        right: Math.min(textBounds.right, cardBounds.right, document.documentElement.clientWidth),
      }
      const range = document.createRange()
      range.selectNodeContents(paragraph)
      const rows = Array.from(range.getClientRects())
        .filter((value) => value.width > 0 && value.height > 0)
        .map(rect)
      return {
        rawText: paragraph.textContent,
        text: (paragraph.textContent ?? '').replace(/\s+/g, ' ').trim(),
        rows,
        textBounds,
        cardBounds,
        bounds,
        outside: rows.filter(
          (value) => value.left < bounds.left - 1 || value.right > bounds.right + 1,
        ),
        viewportWidth: document.documentElement.clientWidth,
        documentWidth: document.documentElement.scrollWidth,
        whiteSpace: getComputedStyle(paragraph).whiteSpace,
        overflowX: getComputedStyle(paragraph).overflowX,
      }
    })
  })
}

test('förbrukningens belopp och enheter är exakta och ryms vid 320px', async ({
  page,
  context,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 })
  const finish = await prepare(context, page)
  try {
    await page.goto('/forbrukning')
    const cookies = page.getByRole('dialog', { name: 'Cookies', exact: true })
    await expect(cookies).toBeVisible()
    await cookies.getByRole('button', { name: 'Endast nödvändiga', exact: true }).click()
    await expect(cookies).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Min förbrukning', exact: true })).toBeVisible()
    await expect(page.getByText('Värme', { exact: true })).toHaveCount(1)
    await page.evaluate(async () => {
      await document.fonts.ready
    })
    const measurements = []
    for (const expected of EXPECTED) {
      const title = page.getByText(expected.category, { exact: true })
      await expect(title).toHaveCount(1)
      // Titel → info → cardLeft → card; samma befintliga DOM före och efter formatterarbytet.
      const card = title.locator('..').locator('..').locator('..')
      measurements.push({ expected, fields: await measureCard(card) })
    }
    // Samtliga tolv textfält mäts före facit, även om förebygget avrundar beloppen.
    const screenshot = testInfo.outputPath('forbrukning-320.png')
    await page.screenshot({ path: screenshot, fullPage: true })
    await testInfo.attach('forbrukning-320', { path: screenshot, contentType: 'image/png' })
    await testInfo.attach('forbrukning-heltext-geometri', {
      body: JSON.stringify(measurements, null, 2),
      contentType: 'application/json',
    })
    for (const { expected, fields } of measurements) {
      const literals = [
        expected.category,
        '1 maj – 31 maj 2026',
        expected.quantity,
        expected.amount,
      ]
      for (const [index, geometry] of fields.entries()) {
        const label = `${expected.category}/${['kategori', 'period', 'kvantitet', 'belopp'][index]}`
        expect.soft(geometry.text, `${label}: bokstavligt facit`).toBe(literals[index])
        expect
          .soft(geometry.bounds.right - geometry.bounds.left, `${label}: innehållsyta`)
          .toBeGreaterThan(0)
        expect.soft(geometry.rows.length, `${label}: verklig heltext-Range`).toBeGreaterThan(0)
        expect
          .soft(geometry.outside, `${label}: heltext inom text/kort/viewport horisontellt`)
          .toEqual([])
      }
    }
    await expect(page.getByText('Hög', { exact: true })).toHaveCount(0)
    await expect(page).toHaveURL(`${ORIGIN}/forbrukning`)
  } finally {
    await finish()
  }
})
