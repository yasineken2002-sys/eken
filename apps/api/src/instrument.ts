// Måste importeras FÖRST i main.ts. Sentry / OpenTelemetry-instrumenteringen
// behöver hookas in i Node:s require-cache innan NestJS, Fastify och Prisma
// laddas in — annars missar Sentry att wrappa http-handlers, db-queries m.m.
import * as Sentry from '@sentry/nestjs'
import { nodeProfilingIntegration } from '@sentry/profiling-node'

const dsn = process.env['SENTRY_DSN']
const env = process.env['NODE_ENV'] ?? 'development'

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
    // Filtrera bort förväntade kontrollflödes-fel (auth) och flyktiga
    // nätverksfel — de är inga incidenter och fyller bara bullret.
    beforeSend(event, hint) {
      const exc = hint?.originalException as
        | { status?: number; getStatus?: () => number; message?: string; code?: string }
        | undefined
      const status =
        typeof exc?.getStatus === 'function' ? exc.getStatus() : (exc?.status ?? undefined)
      if (status === 401 || status === 403) return null
      const code = exc?.code ?? ''
      if (/^(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET)$/i.test(code)) return null
      return event
    },
  })
}
