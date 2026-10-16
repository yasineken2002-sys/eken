/* Offlinestöd för EN offentlig sida. Detta är ingen cache för portalens app eller data. */
const CACHE_PREFIX = 'eveno-portal-offline-'
const CACHE_NAME = 'eveno-portal-offline-v1'
const OFFLINE_PATH = '/offline-v1.html'
// Hela den formaterade offlinefilens bytes. Ändrad fil kräver ny digest/worker-version.
const OFFLINE_SHA256 = '35f9c7c78d602932b5e8d97e2cde5bf2a69f59282edc6d0a71c921d8bd604df7'

// Endast querylösa sidnavigationer från App.tsx. Tokenflödena /activate och
// /reset-password är avsiktligt utanför, liksom alla API-/fil-/okända vägar.
const PUBLIC_FALLBACK_NAVIGATIONS = new Set([
  '/',
  '/login',
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

const OFFLINE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const offlineUrl = new URL(OFFLINE_PATH, self.location.origin).href
      const response = await fetch(offlineUrl, {
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      })
      if (
        response.status !== 200 ||
        response.type !== 'basic' ||
        response.redirected ||
        response.url !== offlineUrl ||
        response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'text/html'
      ) {
        throw new Error('Den offentliga offlinesidan kunde inte verifieras.')
      }
      const bytes = await response.arrayBuffer()
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join('')
      if (digest !== OFFLINE_SHA256) {
        throw new Error('Den offentliga offlinesidan kunde inte verifieras.')
      }
      // Enda cache-skrivaren: verifierade offentliga bytes under en konstant URL,
      // utan ursprungssvarets cookies/headers och aldrig under besökarens URL.
      const cache = await caches.open(CACHE_NAME)
      await cache.put(offlineUrl, new Response(bytes, { status: 200, headers: OFFLINE_HEADERS }))
    })(),
  )
  // Ingen skipWaiting: ett nytt paket får inte ta över en pågående formulärsession.
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      ),
  )
  // Ingen clients.claim eller omladdning. Nästa navigation får den aktiva workern.
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (
    request.method !== 'GET' ||
    request.mode !== 'navigate' ||
    request.headers.has('Authorization') ||
    url.origin !== self.location.origin ||
    url.search !== '' ||
    !PUBLIC_FALLBACK_NAVIGATIONS.has(url.pathname)
  ) {
    return
  }

  event.respondWith(
    (async () => {
      try {
        // Även verkliga HTTP-fel returneras oförändrade. Ingen runtime-cache.
        return await fetch(request)
      } catch {
        const cache = await caches.open(CACHE_NAME)
        const offline = await cache.match(new URL(OFFLINE_PATH, self.location.origin).href)
        if (!offline) return Response.error()
        // 503 markerar otillgänglighet; aldrig en lyckad app-/API-respons.
        return new Response(offline.body, {
          status: 503,
          statusText: 'Service Unavailable',
          headers: OFFLINE_HEADERS,
        })
      }
    })(),
  )
})
