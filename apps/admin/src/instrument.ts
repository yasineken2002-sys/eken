import * as Sentry from '@sentry/react'

const dsn = import.meta.env.VITE_SENTRY_DSN
const env = import.meta.env.MODE

if (dsn) {
  const isProd = env === 'production'
  Sentry.init({
    dsn,
    environment: env,
    release: import.meta.env.VITE_GIT_COMMIT_SHA,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: isProd ? 0.1 : 0,
    beforeSend(event, hint) {
      const exc = hint?.originalException as
        | { status?: number; response?: { status?: number }; message?: string; code?: string }
        | undefined
      const status = exc?.status ?? exc?.response?.status
      if (status === 401 || status === 403) return null
      if (exc?.code === 'ERR_NETWORK' || /Network Error/i.test(exc?.message ?? '')) return null
      return event
    },
  })
}

export { Sentry }
