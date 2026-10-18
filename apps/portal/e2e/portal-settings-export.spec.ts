/**
 * Byggd portal, syntetisk A-session och native lokal Blob-download vid 320px.
 * En testdefinition × Chromium/WebKit. Inget backend-, sessionsrace- eller OS-filväljarbevis.
 */
import {
  expect,
  test,
  type BrowserContext,
  type Download,
  type Page,
  type Route,
} from '@playwright/test'

const ORIGIN = `http://127.0.0.1:${Number(process.env.PWA_TEST_PORT ?? 4179)}`
const TOKEN = 'PRIVATE_SESSION_ALPHA'
const FIXED_NOW = '2027-02-03T12:34:56.789Z'
const FILENAME = 'eveno-mina-uppgifter-2027-02-03.json'
const DATA = {
  tenant: { id: 'synthetic-tenant-a', name: 'Åsa "Prov"', email: 'a@example.invalid' },
  leases: [{ id: 'synthetic-lease-a', monthlyRent: 7500.29, depositAmount: 0 }],
  notes: ['Rad 1\nRad 2', 'Öresbelopp: 0,29 kr'],
  metadata: { active: true, closedAt: null },
}
// Oberoende fullbytesfacit; ingen JSON.stringify(data, null, 2) som testoracle.
const EXPECTED_JSON = String.raw`{
  "tenant": {
    "id": "synthetic-tenant-a",
    "name": "Åsa \"Prov\"",
    "email": "a@example.invalid"
  },
  "leases": [
    {
      "id": "synthetic-lease-a",
      "monthlyRent": 7500.29,
      "depositAmount": 0
    }
  ],
  "notes": [
    "Rad 1\nRad 2",
    "Öresbelopp: 0,29 kr"
  ],
  "metadata": {
    "active": true,
    "closedAt": null
  }
}`
type BlobObservation = { url: string; type: string; size: number }
type ExportProbeWindow = Window & {
  __settingsExportProbe: { blobs: BlobObservation[]; overflow: boolean }
}

test.use({ serviceWorkers: 'block', acceptDownloads: true })

async function prepare(context: BrowserContext, page: Page) {
  const errors: string[] = []
  const unexpected: string[] = []
  const downloads: Download[] = []
  const inFlight = new Set<Promise<void>>()
  let writes = 0
  let configs = 0
  let exports = 0
  let extraPages = 0
  let release!: () => void
  const exportGate = new Promise<void>((resolve) => {
    release = resolve
  })
  const watch = (entry: Page) => {
    entry.on('pageerror', (error) => errors.push(error.message))
    entry.on('download', (download) => downloads.push(download))
  }
  watch(page)
  const watchNewPage = (entry: Page) => {
    extraPages++
    watch(entry)
  }
  context.on('page', watchNewPage)

  // Lokal installerad API dokumenterar att timers fortsätter gå med setFixedTime.
  await page.clock.setFixedTime(new Date(FIXED_NOW))
  await context.addInitScript((token) => {
    localStorage.setItem(
      'tenant_session',
      JSON.stringify({
        state: {
          sessionToken: token,
          tenant: {
            id: 'synthetic-tenant-a',
            type: 'INDIVIDUAL',
            firstName: 'Åsa',
            email: 'a@example.invalid',
          },
          expiresAt: '2027-02-04T12:34:56.789Z',
          isAuthenticated: true,
        },
        version: 0,
      }),
    )
    const observed: ExportProbeWindow['__settingsExportProbe'] = { blobs: [], overflow: false }
    Object.defineProperty(window, '__settingsExportProbe', { value: observed })
    const nativeCreate = URL.createObjectURL
    // Anropsbevarande MIME-observation: ingen Blob/anchor/revoke/download ersätts.
    URL.createObjectURL = function (this: typeof URL, object: Blob | MediaSource) {
      const url = Reflect.apply(nativeCreate, this, [object]) as string
      if (observed.blobs.length < 2) {
        observed.blobs.push({
          url,
          type: object instanceof Blob ? object.type : 'NON_BLOB',
          size: object instanceof Blob ? object.size : -1,
        })
      } else observed.overflow = true
      return url
    }
  }, TOKEN)

  const handle = async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const label = `${request.method()} ${url.origin}${url.pathname}`
    const deny = async () => {
      unexpected.push(label)
      await route.abort('blockedbyclient')
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      writes++
      await deny()
      return
    }
    if (url.origin !== ORIGIN || url.search !== '' || request.postData() !== null) {
      await deny()
      return
    }
    const api = url.pathname.replace(/^\/(api|v1)(?=\/)/, '')
    if (request.method() === 'GET' && api === '/public/config') {
      if (request.headers()['authorization'] !== undefined) {
        await deny()
        return
      }
      configs++
      await route.fulfill({ json: { success: true, data: { features: { bankId: false } } } })
      return
    }
    if (request.method() === 'GET' && api === '/portal/me/export') {
      if (request.headers()['authorization'] !== `Bearer ${TOKEN}`) {
        await deny()
        return
      }
      exports++
      if (exports !== 1) {
        await deny()
        return
      }
      await exportGate
      await route.fulfill({ json: { success: true, data: DATA } })
      return
    }
    const staticPath =
      url.pathname === '/installningar' ||
      url.pathname === '/manifest.webmanifest' ||
      url.pathname === '/favicon.ico' ||
      /^\/(assets|icons)\/[^/]+\.(js|css|svg|png|webp|ico|woff2?)$/.test(url.pathname)
    if (
      staticPath &&
      !['xhr', 'fetch'].includes(request.resourceType()) &&
      request.headers()['authorization'] === undefined
    ) {
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
    downloads,
    release,
    exportCount: () => exports,
    async finish() {
      release()
      try {
        await Promise.all([...inFlight])
      } finally {
        // Spärren gäller genom avmontering/sidstängning, även om ett tidigare facit fäller.
        await Promise.all(context.pages().map((entry) => entry.close()))
        await Promise.all([...inFlight])
        context.off('page', watchNewPage)
      }
      expect.soft(writes).toBe(0)
      expect.soft(unexpected, 'Ingen oväntad API-, fil- eller externtrafik').toEqual([])
      expect.soft(errors, 'Inga browser-/routefel').toEqual([])
      expect.soft(extraPages).toBe(0)
      expect.soft(downloads).toHaveLength(1)
      expect.soft(exports).toBe(1)
      // Kontosidan kräver inte public/config; om appen läser den måste den följa grinden.
      expect.soft(configs).toBeLessThanOrEqual(2)
    },
  }
}

test('kontosidan laddar ned hela syntetiska JSON-exporten vid 320px', async ({
  page,
  context,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 })
  const network = await prepare(context, page)
  try {
    await page.goto('/installningar')
    const cookies = page.getByRole('dialog', { name: 'Cookies', exact: true })
    await expect(cookies).toBeVisible()
    await cookies.getByRole('button', { name: 'Endast nödvändiga', exact: true }).click()
    await expect(cookies).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Inställningar', exact: true })).toBeVisible()
    await expect(page.getByText('a@example.invalid · Åsa', { exact: true })).toBeVisible()
    const sessionBefore = await page.evaluate(() => localStorage.getItem('tenant_session'))
    expect(sessionBefore).not.toBeNull()
    const row = page
      .getByText('Exportera mina uppgifter', { exact: true })
      .locator('..')
      .locator('..')
    const button = row.getByRole('button', { name: 'Ladda ner', exact: true })
    await expect(button).toBeEnabled()
    expect(network.exportCount()).toBe(0)
    expect(network.downloads).toHaveLength(0)
    expect(await page.evaluate(() => new Date().toISOString())).toBe(FIXED_NOW)

    // Riktigt browserklick. Ingen DOM-anchorclick, Blobmock eller syntetiskt Download-event.
    await button.click()
    await expect.poll(network.exportCount).toBe(1)
    await expect(row.getByRole('button', { name: 'Hämtar…', exact: true })).toBeDisabled()
    expect(network.downloads).toHaveLength(0)
    network.release()
    await expect.poll(() => network.downloads.length).toBe(1)
    const download = network.downloads[0]!
    expect(download.url().startsWith(`blob:${ORIGIN}/`)).toBe(true)
    expect(download.suggestedFilename()).toBe(FILENAME)
    expect(await download.failure()).toBeNull()
    const stream = await download.createReadStream()
    if (!stream) throw new Error('Native download saknar fullbordad läsbar fil')
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk)
      size += bytes.length
      expect(size).toBeLessThanOrEqual(4096)
      chunks.push(bytes)
    }
    const actual = Buffer.concat(chunks)
    expect(actual.equals(Buffer.from(EXPECTED_JSON, 'utf8'))).toBe(true)
    expect(JSON.parse(actual.toString('utf8'))).toEqual(DATA)
    const observed = await page.evaluate(() => (window as ExportProbeWindow).__settingsExportProbe)
    expect(observed).toEqual({
      blobs: [{ url: download.url(), type: 'application/json', size: actual.length }],
      overflow: false,
    })
    // Full fil + återställd handler/DOM, inte bara GET-svaret eller anchorclick.
    await expect(row.getByRole('button', { name: 'Ladda ner', exact: true })).toBeEnabled()
    await expect(page).toHaveURL(`${ORIGIN}/installningar`)
    expect(await page.evaluate(() => localStorage.getItem('tenant_session'))).toBe(sessionBefore)
    await page.screenshot({
      path: testInfo.outputPath('settings-export-complete.png'),
      fullPage: true,
    })
    expect(network.exportCount()).toBe(1)
    expect(network.downloads).toHaveLength(1)
  } finally {
    await network.finish()
  }
})
