// Måste importeras FÖRST i main.ts. Sentry / OpenTelemetry-instrumenteringen
// behöver hookas in i Node:s require-cache innan NestJS, Fastify och Prisma
// laddas in — annars missar Sentry att wrappa http-handlers, db-queries m.m.
import * as Sentry from '@sentry/nestjs'
import { nodeProfilingIntegration } from '@sentry/profiling-node'
import type { ErrorEvent, EventHint } from '@sentry/nestjs'

const dsn = process.env['SENTRY_DSN']
const env = process.env['NODE_ENV'] ?? 'development'

/**
 * MASKERINGEN LADDAS LAT, OCH DET ÄR INTE EN OPTIMERING.
 *
 * `redact-sensitive.ts` importerar `@prisma/client`. En vanlig `import` här
 * hade laddat Prisma vid modulutvärderingen — alltså FÖRE `Sentry.init()`, som
 * står i den här filens kropp — och då hinner instrumenteringen inte wrappa
 * Prisma. Filens hela existensberättigande är att den laddas först; en import
 * som bryter det gör den verkningslös utan att något blir rött.
 *
 * `require` vid första `beforeSend` är säkert: när ett fel skickas är Prisma
 * sedan länge laddat. Resultatet cachas.
 */
type Skrubb = {
  deepScrub: <T>(v: T, depth?: number) => T
  maskSensitiveText: (s: string) => string
}
let skrubb: Skrubb | null = null
function hämtaSkrubb(): Skrubb {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  if (!skrubb) skrubb = require('./common/redaction/redact-sensitive') as Skrubb
  return skrubb
}

/**
 * Skrubbar ett Sentry-event. Exporterad för att kunna provas — `Sentry.init`
 * går inte att inspektera utifrån, och en `beforeSend` som bara finns som en
 * anonym funktion i ett options-objekt är omätbar.
 *
 * VAD SOM SKRUBBAS OCH VARFÖR JUST DET: en Sentry-payload bär personuppgifter
 * på fyra ställen, och de kräver olika behandling.
 *
 *   request.headers   Authorization och cookies är BÄRARE, inte innehåll —
 *                     de stryks helt, aldrig maskeras.
 *   request.data      Domänobjekt: fältnamnsstrykning OCH fritextmaskering.
 *   user              Bara `id`. En e-post i user-kontexten är den vanligaste
 *                     läckan, och den ser harmlös ut eftersom Sentry ber om den.
 *   meddelanden       Fritext: exception-värden, message, breadcrumbs, extra.
 *
 * Reglerna kommer ur `redact-sensitive.ts` — den här funktionen KOMPONERAR dem
 * i Sentrys form, den definierar dem inte. En egen lista här hade varit den
 * andra kopian som #545 finns för att förhindra.
 */
export function skrubbaEvent(event: ErrorEvent): ErrorEvent {
  const { deepScrub, maskSensitiveText } = hämtaSkrubb()

  if (event.request) {
    // deepScrub stryker de känsliga huvudena via SENSITIVE_HEADER_NAMES och
    // maskerar resten. Cookies har ett eget fält och tas bort helt.
    event.request = deepScrub(event.request)
    delete event.request.cookies
  }

  // Bara id. Sentry fyller gärna user med e-post och ip om något sätter det.
  if (event.user) {
    const id = event.user.id
    event.user = id === undefined ? {} : { id }
  }

  if (event.message) event.message = maskSensitiveText(event.message)

  for (const v of event.exception?.values ?? []) {
    if (v.value) v.value = maskSensitiveText(v.value)
  }

  for (const b of event.breadcrumbs ?? []) {
    if (b.message) b.message = maskSensitiveText(b.message)
    if (b.data) b.data = deepScrub(b.data)
  }

  if (event.extra) event.extra = deepScrub(event.extra)
  if (event.contexts) event.contexts = deepScrub(event.contexts)

  return event
}

/**
 * Brusfiltret. Oförändrat från tidigare — förväntade kontrollflödes-fel (auth)
 * och flyktiga nätverksfel är inga incidenter.
 *
 * SEPARAT FRÅN SKRUBBNINGEN med flit: det ena avgör OM eventet ska skickas, det
 * andra VAD det får innehålla. Slås de ihop blir det lätt att av misstag göra
 * skrubbningen villkorad av filtret.
 */
export function ärBrus(hint?: EventHint): boolean {
  const exc = hint?.originalException as
    | { status?: number; getStatus?: () => number; message?: string; code?: string }
    | undefined
  const status = typeof exc?.getStatus === 'function' ? exc.getStatus() : (exc?.status ?? undefined)
  if (status === 401 || status === 403) return true
  const code = exc?.code ?? ''
  return /^(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET)$/i.test(code)
}

if (dsn) {
  const isProd = env === 'production'
  Sentry.init({
    dsn,
    environment: env,
    release: process.env['SENTRY_RELEASE'] ?? process.env['GIT_COMMIT_SHA'],
    integrations: [nodeProfilingIntegration()],
    // 10 % i prod, 0 i dev — vi ska inte fylla kvotpåsen med utvecklingstrafik.
    tracesSampleRate: isProd ? 0.1 : 0,
    profilesSampleRate: isProd ? 0.1 : 0,
    // UTTRYCKLIGT FALSKT, inte förlitat på defaulten.
    //
    // MÄTT: `@default false` står i @sentry/core@10.52.0:s egen typdeklaration
    // (types-hoist/options.d.ts:347). Den var alltså redan falsk — men en
    // default är ett beslut någon annan fattar åt oss, och den kan ändras i en
    // minor utan att något här blir rött.
    //
    // OCH DEN RÄCKER INTE ÄNDÅ. Samma deklaration säger att flaggan bara gäller
    // data SDK:n skickar av sig själv, "not data that was explicitly set (e.g.
    // by calling Sentry.setUser())". Ett framtida `setUser({ email })` passerar
    // alltså rakt igenom flaggan. Det är skrubbningen nedan som fångar det, och
    // det är därför båda behövs. (Mätt i dag: koden anropar inte setUser alls.)
    sendDefaultPii: false,
    beforeSend(event, hint) {
      if (ärBrus(hint)) return null
      return skrubbaEvent(event)
    },
  })
}
