/**
 * Byggd portal och riktig Tab/Enter till dokument A; endast syntetiska GET-svar.
 * Inget sessionsrace-, backend-, signatur- eller operativsystemsbevis.
 */
import {
  expect,
  test,
  type BrowserContext,
  type Download,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test'

const ORIGIN = `http://127.0.0.1:${Number(process.env.PWA_TEST_PORT ?? 4179)}`
const TOKEN = 'PRIVATE_SESSION_ALPHA'
const PRIMARY = {
  id: 'a1000000-0000-4000-8000-000000000001',
  name: 'Syntetiskt hyresavtal A.pdf',
  description: 'Dokument A ska laddas ned med tangentbord.',
  category: 'LEASE',
  mimeType: 'application/pdf',
  fileSize: 120,
  createdAt: '2026-01-01T12:00:00.000Z',
}
const SECONDARY = {
  ...PRIMARY,
  id: 'b2000000-0000-4000-8000-000000000002',
  name: 'Separat besiktning B.pdf',
  description: 'Kontrolldokument B ska inte hämtas.',
  category: 'INSPECTION',
}
const METADATA_PATH = `/portal/documents/${PRIMARY.id}/download`
const FILE_PATH = '/__document-keyboard/a.pdf'
const FILE_URL = `${ORIGIN}${FILE_PATH}?signature=SYNTHETIC_DOCUMENT_A`
const FILE_BYTES = '%PDF-1.4\nSYNTHETIC_DOCUMENT_A_ONLY\n%%EOF\n'

test.use({ serviceWorkers: 'block' })

async function prepare(context: BrowserContext, page: Page) {
  const before = await context.request.get(`${ORIGIN}/__fixture/state`)
  expect(before.status()).toBe(200)
  const previousDownloads: unknown[] = (await before.json()).keyboardDownloads
  expect(Array.isArray(previousDownloads)).toBe(true)
  const unexpected: string[] = []
  const errors: string[] = []
  const writes: string[] = []
  const metadata: string[] = []
  const files: string[] = []
  const downloads: Download[] = []
  const inFlight = new Set<Promise<void>>()
  let lists = 0
  const watch = (entry: Page) => {
    entry.on('pageerror', (error) => errors.push(error.message))
    entry.on('download', (download) => {
      if (!downloads.includes(download)) downloads.push(download)
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
    if (url.origin !== ORIGIN) {
      await deny()
      return
    }
    if (url.href === FILE_URL && request.method() === 'GET') {
      if (request.headers()['authorization'] !== undefined || request.postData() !== null) {
        await deny()
        return
      }
      files.push(url.href)
      // Om motorn skickar nedladdningen genom interception tillåts bara exakt A.
      // Andra motorer hämtar nativt; fulla bytes och serverkvitto krävs nedan.
      await route.continue()
      return
    }
    if (url.search !== '') {
      await deny()
      return
    }
    if (request.method() === 'GET' && api === '/public/config') {
      await route.fulfill({ json: { success: true, data: { features: { bankId: false } } } })
      return
    }
    if (request.method() === 'GET' && (api === '/portal/documents' || api === METADATA_PATH)) {
      if (request.headers()['authorization'] !== `Bearer ${TOKEN}` || request.postData() !== null) {
        await deny()
        return
      }
      if (api === '/portal/documents') {
        lists++
        await route.fulfill({ json: { success: true, data: [PRIMARY, SECONDARY] } })
      } else {
        metadata.push(api)
        await route.fulfill({
          json: {
            success: true,
            data: {
              url: FILE_URL,
              filename: '  A:/hyresavtal?.pdf  ',
              mimeType: 'application/pdf',
            },
          },
        })
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
  return {
    metadata,
    previousDownloads,
    files,
    downloads,
    async finish() {
      try {
        await Promise.all([...inFlight])
      } finally {
        // Även eventuell target=_blank-sida hålls bakom samma nätspärr till stängning.
        await Promise.all(context.pages().map((entry) => entry.close()))
        await Promise.all([...inFlight])
        context.off('page', watch)
      }
      expect(lists, 'Verklig dokumentlista måste ha hämtats').toBeGreaterThan(0)
      expect(writes).toEqual([])
      expect(unexpected, 'Oväntad API-/fil-/externtrafik').toEqual([])
      expect(errors, 'Browser-/routefel').toEqual([])
    },
  }
}

async function tabToDownload(page: Page, target: Locator) {
  const trace: string[] = []
  for (let step = 0; step < 12; step++) {
    await page.keyboard.press('Tab')
    if (await target.evaluate((element) => element === document.activeElement)) return
    trace.push(
      await page.evaluate(() => {
        const active = document.activeElement
        return `${active?.tagName ?? 'null'}:${active?.textContent?.trim().slice(0, 60) ?? ''}`
      }),
    )
  }
  await expect(
    target,
    `A:s knapp nåddes inte med 12 riktiga Tab: ${trace.join(' → ')}`,
  ).toBeFocused()
}

test('Tab och Enter hämtar exakt dokument A vid 320px', async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 })
  const network = await prepare(context, page)
  try {
    await page.goto('/documents')
    const cookies = page.getByRole('dialog', { name: 'Cookies', exact: true })
    await expect(cookies).toBeVisible()
    await cookies.getByRole('button', { name: 'Endast nödvändiga', exact: true }).click()
    await expect(cookies).toHaveCount(0)
    await expect(page.getByText(PRIMARY.name, { exact: true })).toBeVisible()
    await expect(page.getByText(SECONDARY.name, { exact: true })).toBeVisible()
    // Namn → docInfo → cardLeft → card; samma verkliga kort före och efter en ev. tabindexfix.
    const card = page
      .getByText(PRIMARY.name, { exact: true })
      .locator('..')
      .locator('..')
      .locator('..')
    const button = card.getByRole('button', { name: 'Ladda ned', exact: true })
    await expect(button).toBeEnabled()
    // Ingen focus(), DOM-click eller attributgrind på dokumentknappen. Bounded riktig Tab först.
    await tabToDownload(page, button)
    await expect(button).toBeFocused()
    await page.screenshot({ path: testInfo.outputPath('download-focus.png') })
    expect(network.metadata).toEqual([])
    expect(network.files).toEqual([])
    await page.keyboard.press('Enter')
    await expect.poll(() => network.downloads.length).toBe(1)
    const download = network.downloads[0]!
    expect(download.url()).toBe(FILE_URL)
    expect(download.suggestedFilename()).toBe('A_hyresavtal_.pdf')
    expect(await download.failure()).toBeNull()
    const stream = await download.createReadStream()
    if (!stream) throw new Error('Fullbordad syntetisk download saknar läsbar fil')
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of stream) {
      const value = Buffer.from(chunk)
      bytes += value.length
      expect(bytes).toBeLessThanOrEqual(4096)
      chunks.push(value)
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe(FILE_BYTES)
    // Full download + återställd handlerknapp, inte enbart metadataresponse-settlement.
    await expect(button).toBeEnabled()
    await expect(page).toHaveURL(`${ORIGIN}/documents`)
    expect(network.metadata).toEqual([METADATA_PATH])
    expect(network.files.every((url) => url === FILE_URL)).toBe(true)
    expect(network.files.length).toBeLessThanOrEqual(1)
    const receipt = await context.request.get(`${ORIGIN}/__fixture/state`)
    expect(receipt.status()).toBe(200)
    expect((await receipt.json()).keyboardDownloads).toEqual([
      ...network.previousDownloads,
      {
        method: 'GET',
        path: FILE_PATH,
        query: '?signature=SYNTHETIC_DOCUMENT_A',
        hasAuthorization: false,
        receivedBytes: 0,
      },
    ])
    expect(network.downloads).toHaveLength(1)
    await expect(page.getByText(SECONDARY.name, { exact: true })).toBeVisible()
  } finally {
    await network.finish()
  }
})
