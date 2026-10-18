/** Testserver: verklig HTTP mot dist, enbart syntetiska konton och inga externa anrop. */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const port = Number(process.env.PWA_TEST_PORT ?? 4179)
if (!Number.isInteger(port) || port < 1024 || port > 65534) throw new Error('Ogiltig testport')
await stat(resolve(dist, 'index.html'))
const spa = new Set([
  '/',
  '/login',
  '/activate',
  '/reset-password',
  '/forgot-password',
  '/dashboard',
  '/notices',
  '/maintenance',
  '/news',
  '/documents',
  '/besiktning',
  '/forbrukning',
  '/installningar',
  '/integritet',
  '/integritetspolicy',
  '/privacy',
  '/legal/villkor',
  '/legal/integritet',
  '/legal/cookies',
])
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
}
const accounts = {
  a: {
    id: '11111111-1111-4111-8111-111111111111',
    firstName: 'PRIVATE_ALPHA',
    lastName: 'Syntetisk',
    companyName: null,
    email: 'a@example.invalid',
  },
  b: {
    id: '22222222-2222-4222-8222-222222222222',
    firstName: 'PRIVATE_BETA',
    lastName: 'Syntetisk',
    companyName: null,
    email: 'b@example.invalid',
  },
}
const tokens = { a: 'PRIVATE_SESSION_ALPHA', b: 'PRIVATE_SESSION_BETA' }
let settings
let counters
function reset() {
  settings = { fallback: 'valid', version: 1, navigation500: false, dropNavigation: false }
  counters = {
    posts: [],
    privateReads: [],
    documentReads: [],
    keyboardDownloads: [],
    offlineRequests: 0,
  }
}
reset()

function send(res, status, body, contentType = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', ...headers })
  res.end(body)
}
function json(res, status, body) {
  send(res, status, JSON.stringify(body), 'application/json')
}
function data(res, body) {
  json(res, 200, { success: true, data: body })
}
async function body(req) {
  let text = ''
  for await (const chunk of req) {
    text += chunk
    if (text.length > 16_384) throw new Error('För stor syntetisk kropp')
  }
  return text ? JSON.parse(text) : {}
}

async function handle(req, res) {
  const origin = `http://127.0.0.1:${port}`
  const url = new URL(req.url, origin)
  const path = url.pathname
  // Native browsernedladdningar kan gå utanför Playwrights route-interception.
  // En exakt loopbackfixtur ger därför verkliga bytes och ett serverkvitto.
  if (path.startsWith('/__document-keyboard/')) {
    let receivedBytes = 0
    for await (const chunk of req) {
      receivedBytes += chunk.length
      if (receivedBytes > 4096) break
    }
    counters.keyboardDownloads.push({
      method: req.method,
      path,
      query: url.search,
      hasAuthorization: req.headers.authorization !== undefined,
      receivedBytes,
    })
    if (
      req.method !== 'GET' ||
      path !== '/__document-keyboard/a.pdf' ||
      url.search !== '?signature=SYNTHETIC_DOCUMENT_A' ||
      req.headers.authorization !== undefined ||
      receivedBytes !== 0
    )
      return send(res, 400, 'Ogiltig syntetisk nedladdning')
    return send(res, 200, '%PDF-1.4\nSYNTHETIC_DOCUMENT_A_ONLY\n%%EOF\n', 'application/pdf', {
      'Content-Disposition': 'attachment',
    })
  }
  if (path === '/__fixture/health') return json(res, 200, { ready: true })
  if (path === '/__fixture/state' && req.method === 'GET') return json(res, 200, counters)
  if (path === '/__fixture/reset' && req.method === 'POST') {
    reset()
    return json(res, 200, settings)
  }
  if (path === '/__fixture/configure' && req.method === 'POST') {
    const next = await body(req)
    if (
      next.fallback !== undefined &&
      !['valid', '404', 'mime', 'tamper'].includes(next.fallback)
    ) {
      return send(res, 400, 'Ogiltig fixture')
    }
    if (next.version !== undefined && ![1, 2].includes(next.version))
      return send(res, 400, 'Ogiltig version')
    settings = { ...settings, ...next }
    return json(res, 200, settings)
  }
  if (path.startsWith('/__fixture/')) return send(res, 404, 'Okänd fixtureväg')

  if (path.startsWith('/api/') || path.startsWith('/v1/')) {
    const api = path.replace(/^\/(api|v1)/, '')
    if (req.method === 'POST') counters.posts.push(api)
    if (api === '/public/config' && req.method === 'GET')
      return data(res, { features: { bankId: false } })
    if (api === '/tenant-portal/login/resolve' && req.method === 'POST') {
      const input = await body(req)
      const actor =
        input.email === accounts.a.email ? 'a' : input.email === accounts.b.email ? 'b' : null
      if (!actor || input.password !== 'SyntheticPassword123!')
        return json(res, 401, { success: false })
      return data(res, {
        status: 'complete',
        tenant: accounts[actor],
        sessionToken: tokens[actor],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
    }
    if (api === '/tenant-portal/logout' && req.method === 'POST') return data(res, null)
    if (api === '/tenant-portal/forgot-password' && req.method === 'POST') {
      await body(req)
      return data(res, { message: 'Syntetiskt mottaget; inga mejl skickas' })
    }
    if (api === '/portal/failure') return json(res, 500, { sentinel: 'REAL_HTTP_500' })
    const actor = Object.keys(tokens).find(
      (key) => req.headers.authorization === `Bearer ${tokens[key]}`,
    )
    if (!actor) return json(res, 401, { success: false })
    counters.privateReads.push({ actor, path: api })
    if (api === '/portal/dashboard')
      return data(res, {
        tenant: { ...accounts[actor], type: 'INDIVIDUAL' },
        activeLease: null,
        overdueInvoices: 0,
        upcomingInvoice: null,
        openMaintenanceTickets: 0,
        unreadNotices: 0,
      })
    if (api === '/portal/documents')
      return data(res, [
        {
          id: `doc-${actor}`,
          name: `PRIVATE_DOCUMENT_${actor.toUpperCase()}`,
          category: 'LEASE',
          mimeType: 'application/pdf',
          fileSize: 120,
          createdAt: '2026-01-01T00:00:00Z',
          description: 'Syntetiskt privat dokument',
        },
      ])
    if (api === `/portal/documents/doc-${actor}/download`)
      return data(res, {
        url: `${origin}/private/document-${actor}.pdf?signature=PRIVATE_SIGNED_${actor.toUpperCase()}`,
        filename: `private-${actor}.pdf`,
      })
    return json(res, 404, { error: 'Okänd syntetisk API-väg' })
  }
  if (path.startsWith('/private/document-') && path.endsWith('.pdf')) {
    counters.documentReads.push(path)
    return send(
      res,
      200,
      `%PDF-1.4\nPRIVATE_PDF_${path.includes('-a.pdf') ? 'ALPHA' : 'BETA'}\n%%EOF`,
      'application/pdf',
    )
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Metod ej tillåten')
  if (settings.dropNavigation && spa.has(path)) {
    res.destroy()
    return
  }
  if (settings.navigation500 && path === '/documents') return send(res, 500, 'REAL_NAVIGATION_500')

  let filename = path
  if (path === '/offline-v1.html' || path === '/offline-v2.html') {
    counters.offlineRequests += 1
    if (settings.fallback === '404') return send(res, 404, 'Saknad offentlig fallback')
    if (settings.fallback === 'mime')
      return send(res, 200, await readFile(resolve(dist, 'offline-v1.html')), 'text/plain')
    if (settings.fallback === 'tamper')
      return send(res, 200, await readFile(resolve(dist, 'index.html')), 'text/html')
    filename = '/offline-v1.html'
  }
  let decoded
  try {
    decoded = decodeURIComponent(filename)
  } catch {
    return send(res, 400, 'Ogiltig URL')
  }
  const absolute = resolve(dist, `.${decoded}`)
  if (!absolute.startsWith(`${resolve(dist)}${sep}`)) {
    if (path !== '/') return send(res, 404, 'Saknas')
  }
  try {
    const info = await stat(absolute)
    if (info.isFile()) {
      let contents = await readFile(absolute)
      if (path === '/portal-sw.js' && settings.version === 2) {
        // Enbart testversionering av den byggda produktionsworkern. Samma
        // offentliga HTML-bytes/hash; inga alternativa cache-/fetchalgoritmer.
        const worker = contents.toString()
        if (!worker.includes('eveno-portal-offline-v1') || !worker.includes('/offline-v1.html')) {
          throw new Error(
            'Byggda workerns versionsform har ändrats; uppdatera testets versionsbyte',
          )
        }
        contents = Buffer.from(worker.replaceAll('offline-v1', 'offline-v2'))
      }
      const headers =
        path === '/portal-sw.js' || path === '/manifest.webmanifest'
          ? { 'Cache-Control': 'public, max-age=0, must-revalidate' }
          : {}
      return send(
        res,
        200,
        contents,
        mime[extname(filename)] ?? 'application/octet-stream',
        headers,
      )
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
  }
  if (spa.has(path))
    return send(res, 200, await readFile(resolve(dist, 'index.html')), mime['.html'])
  return send(res, 404, 'Saknas; okända statiska filer är aldrig SPA-HTML')
}

const server = createServer((req, res) => {
  void handle(req, res).catch(() => send(res, 500, 'Syntetisk fixture misslyckades'))
})
const external = createServer((_req, res) => {
  send(res, 200, 'EXTERNAL_ORIGIN_SENTINEL', 'text/plain', { 'Access-Control-Allow-Origin': '*' })
})
await Promise.all(
  [server, external].map(
    (entry, index) =>
      new Promise((resolveListening, reject) => {
        entry.once('error', reject)
        entry.listen(port + index, '127.0.0.1', resolveListening)
      }),
  ),
)
console.log(`PWA-fixture lyssnar endast på loopback ${port}/${port + 1}`)
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    server.close()
    external.close()
    server.closeAllConnections()
    external.closeAllConnections()
  })
