/** Visuell dokumentidentitet före hämtning; riktig byggd portal, syntetiska GET-svar. */
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
const PREFIX = 'Hyresavtal lägenhet 1201 — REF20261018ABCDEF0123456789'
const DESCRIPTION_PREFIX =
  'Läs villkoret före val. Referens https://example.invalid/Avtal20261018SyntetiskReferens0123456789. '
const DOCUMENTS = [
  {
    id: 'a1000000-0000-4000-8000-000000000001',
    name: `${PREFIX} — AVTAL A.pdf`,
    description: `${DESCRIPTION_PREFIX}Gäller från januari, AVTAL A.`,
    category: 'LEASE',
    mimeType: 'application/pdf',
    fileSize: 120,
    createdAt: '2026-01-01T12:00:00.000Z',
  },
  {
    id: 'b2000000-0000-4000-8000-000000000002',
    name: `${PREFIX} — AVTAL B.pdf`,
    description: `${DESCRIPTION_PREFIX}Gäller från juli, AVTAL B.`,
    category: 'LEASE',
    mimeType: 'application/pdf',
    fileSize: 120,
    createdAt: '2026-01-01T12:00:00.000Z',
  },
  {
    id: 'c3000000-0000-4000-8000-000000000003',
    name: 'Kort.pdf',
    description: 'Ok.',
    category: 'LEASE',
    mimeType: 'application/pdf',
    fileSize: 120,
    createdAt: '2026-01-01T12:00:00.000Z',
  },
]

test.use({ serviceWorkers: 'block' })

async function prepare(context: BrowserContext, page: Page) {
  const unexpected: string[] = []
  const writes: string[] = []
  const metadata: string[] = []
  const files: string[] = []
  const errors: string[] = []
  const inFlight = new Set<Promise<void>>()
  let downloads = 0
  let lists = 0
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
    if (/^\/portal\/documents\/[^/]+\/download$/.test(api)) metadata.push(api)
    if (url.pathname.startsWith('/private/') || url.pathname.startsWith('/__document-keyboard/')) {
      files.push(url.pathname)
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
    if (request.method() === 'GET' && api === '/portal/documents') {
      if (request.headers()['authorization'] !== `Bearer ${TOKEN}` || request.postData() !== null) {
        await deny()
      } else {
        lists++
        await route.fulfill({ json: { success: true, data: DOCUMENTS } })
      }
      return
    }
    const staticPath =
      url.pathname === '/documents' ||
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
      // Nätspärren gäller även eventuella oväntade popup-sidor och ligger kvar till stängning.
      await Promise.all(context.pages().map((entry) => entry.close()))
      await Promise.all([...inFlight])
      context.off('page', watch)
    }
    expect(lists, 'Verklig dokumentlista ska ha hämtats').toBeGreaterThan(0)
    expect(metadata, 'Identiteten ska synas före metadatahämtning').toEqual([])
    expect(files, 'Ingen dokumentfil får hämtas').toEqual([])
    expect(downloads).toBe(0)
    expect(writes).toEqual([])
    expect(unexpected, 'Oväntad API-/fil-/externtrafik').toEqual([])
    expect(errors, 'Browser-/routefel').toEqual([])
  }
}

async function measureText(card: Locator, expected: string, suffix: string) {
  return card.evaluate(
    (element, input) => {
      const paragraph = Array.from(element.querySelectorAll('p')).find(
        (entry) => entry.textContent === input.expected,
      )
      if (!paragraph) throw new Error('Förväntad råtext saknas i dokumentkortet')
      const node = paragraph.firstChild
      if (!node || node.nodeType !== Node.TEXT_NODE || node.textContent !== input.expected) {
        throw new Error('Förväntad oförkortad textnod saknas')
      }
      if (!input.expected.endsWith(input.suffix)) throw new Error('Literal slutsuffix saknas')
      const rect = (value: DOMRect) => ({
        left: value.left,
        right: value.right,
        top: value.top,
        bottom: value.bottom,
        width: value.width,
        height: value.height,
      })
      const ranges = (start: number, end: number) => {
        const range = document.createRange()
        range.setStart(node, start)
        range.setEnd(node, end)
        return Array.from(range.getClientRects())
          .filter((value) => value.width > 0 && value.height > 0)
          .map(rect)
      }
      const p = paragraph.getBoundingClientRect()
      const c = element.getBoundingClientRect()
      const textBounds = {
        left: p.left + paragraph.clientLeft,
        right: p.left + paragraph.clientLeft + paragraph.clientWidth,
        top: p.top + paragraph.clientTop,
        bottom: p.top + paragraph.clientTop + paragraph.clientHeight,
      }
      const cardBounds = {
        left: c.left + element.clientLeft,
        right: c.left + element.clientLeft + element.clientWidth,
        top: c.top + element.clientTop,
        bottom: c.top + element.clientTop + element.clientHeight,
      }
      const bounds = {
        left: Math.max(textBounds.left, cardBounds.left, 0),
        right: Math.min(textBounds.right, cardBounds.right, document.documentElement.clientWidth),
        top: Math.max(textBounds.top, cardBounds.top),
        bottom: Math.min(textBounds.bottom, cardBounds.bottom),
      }
      const rows = ranges(0, input.expected.length)
      const suffixRows = ranges(input.expected.length - input.suffix.length, input.expected.length)
      const outside = (values: typeof rows) =>
        values.filter(
          (value) =>
            value.left < bounds.left - 1 ||
            value.right > bounds.right + 1 ||
            value.top < bounds.top - 1 ||
            value.bottom > bounds.bottom + 1,
        )
      // Hela texten ska rymmas i sin egen yta och kortet. Viewportgränsen gäller
      // bara horisontellt: normal vertikal dokumentrullning är tillåten.
      return {
        rawText: paragraph.textContent,
        rows,
        suffixRows,
        outside: outside(rows),
        suffixOutside: outside(suffixRows),
        textBounds,
        cardBounds,
        bounds,
        viewportWidth: document.documentElement.clientWidth,
        documentWidth: document.documentElement.scrollWidth,
        whiteSpace: getComputedStyle(paragraph).whiteSpace,
        overflowX: getComputedStyle(paragraph).overflowX,
      }
    },
    { expected, suffix },
  )
}

for (const width of [320, 430]) {
  test(`dokumentens fulla namn och villkor kan särskiljas före hämtning vid ${width}px`, async ({
    page,
    context,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 740 })
    const finish = await prepare(context, page)
    try {
      await page.goto('/documents')
      const cookies = page.getByRole('dialog', { name: 'Cookies', exact: true })
      await expect(cookies).toBeVisible()
      await cookies.getByRole('button', { name: 'Endast nödvändiga', exact: true }).click()
      await expect(cookies).toHaveCount(0)
      await expect(page.getByRole('heading', { name: 'Mina dokument', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Ladda ned', exact: true })).toHaveCount(3)
      await page.evaluate(async () => {
        await document.fonts.ready
      })
      const measurements = []
      for (const [index, doc] of DOCUMENTS.entries()) {
        const name = page.getByText(doc.name, { exact: true })
        await expect(name).toHaveCount(1)
        // Namn → docInfo → cardLeft → card; ingen produktklass/ny roll behövs för föreprovet.
        const card = name.locator('..').locator('..').locator('..')
        const nameSuffix = index === 0 ? 'AVTAL A.pdf' : index === 1 ? 'AVTAL B.pdf' : 'Kort.pdf'
        const descriptionSuffix =
          index === 0
            ? 'Gäller från januari, AVTAL A.'
            : index === 1
              ? 'Gäller från juli, AVTAL B.'
              : 'Ok.'
        measurements.push(
          {
            field: `${index === 2 ? 'normal' : index === 0 ? 'A' : 'B'}.name`,
            expected: doc.name,
            geometry: await measureText(card, doc.name, nameSuffix),
          },
          {
            field: `${index === 2 ? 'normal' : index === 0 ? 'A' : 'B'}.description`,
            expected: doc.description,
            geometry: await measureText(card, doc.description, descriptionSuffix),
          },
        )
      }
      // Alla fyra problemfält och båda korta kontroller är mätta före första geometrikravet.
      const screenshot = testInfo.outputPath(`dokumenttext-${width}.png`)
      await page.screenshot({ path: screenshot, fullPage: true })
      await testInfo.attach(`dokumenttext-${width}`, { path: screenshot, contentType: 'image/png' })
      await testInfo.attach('dokumenttext-range-och-suffix', {
        body: JSON.stringify(measurements, null, 2),
        contentType: 'application/json',
      })
      for (const { field, expected, geometry } of measurements.filter((entry) =>
        entry.field.startsWith('normal.'),
      )) {
        expect(geometry.rawText, `${field}: råtext bevarad`).toBe(expected)
        expect(
          geometry.bounds.right - geometry.bounds.left,
          `${field}: innehållsyta`,
        ).toBeGreaterThan(0)
        expect(geometry.rows.length, `${field}: verklig heltext`).toBeGreaterThan(0)
        expect(geometry.suffixRows.length, `${field}: verkligt suffix`).toBeGreaterThan(0)
        expect(geometry.outside, `${field}: positiv korttextkontroll`).toEqual([])
        expect(geometry.suffixOutside, `${field}: positiv suffixkontroll`).toEqual([])
      }
      for (const { field, expected, geometry } of measurements.filter(
        (entry) => !entry.field.startsWith('normal.'),
      )) {
        expect.soft(geometry.rawText, `${field}: råtext bevarad`).toBe(expected)
        expect
          .soft(geometry.bounds.right - geometry.bounds.left, `${field}: innehållsyta`)
          .toBeGreaterThan(0)
        expect.soft(geometry.rows.length, `${field}: faktisk heltext-Range`).toBeGreaterThan(0)
        expect
          .soft(geometry.suffixRows.length, `${field}: faktisk slutsuffix-Range`)
          .toBeGreaterThan(0)
        expect
          .soft(geometry.outside, `${field}: heltext utanför text/kort eller horisontell viewport`)
          .toEqual([])
        expect
          .soft(
            geometry.suffixOutside,
            `${field}: suffix utanför text/kort eller horisontell viewport`,
          )
          .toEqual([])
      }
      await expect(page).toHaveURL(`${ORIGIN}/documents`)
    } finally {
      await finish()
    }
  })
}
