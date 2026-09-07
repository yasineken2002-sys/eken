import * as Sentry from '@sentry/react'

const dsn = import.meta.env.VITE_SENTRY_DSN
const env = import.meta.env.MODE

/**
 * 32 bytes som 64 hex — formen på varje bärartoken i kodbasen. Samma mönster
 * som `HEXTOKEN` i API:ts `redact-sensitive.ts`; de två kan inte delas, eftersom
 * webben inte importerar från apps/api, men de beskriver samma sak och ska
 * ändras tillsammans.
 *
 * Exakt 64, inte `{32,}`: ett bredare spann hade börjat träffa commit-shas och
 * uuid-delar och gjort felmeddelanden obrukbara utan att skydda mer.
 */
const HEXTOKEN = /(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g

const maskeraToken = (s: string): string => s.replace(HEXTOKEN, '[token]')

if (dsn) {
  const isProd = env === 'production'
  Sentry.init({
    dsn,
    environment: env,
    release: import.meta.env.VITE_GIT_COMMIT_SHA,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: isProd ? 0.1 : 0,
    /**
     * TRANSAKTIONSNAMNET ÄR PATHEN — och pathen kan bära ett token.
     *
     * `browserTracingIntegration()` utan routerintegration parametriserar inte
     * dynamiska segment: en pageload av `/arbetsorder/<64 hex>` får hela
     * sökvägen som transaktionsnamn. Med `tracesSampleRate: 0.1` i produktion
     * betyder det att var tionde öppning av en arbetsorderlänk skickar en
     * fortfarande GILTIG bärartoken till Sentrys dashboard — utan att något fel
     * inträffat.
     *
     * De äldre token-länkarna (`/reset-password?token=…`) bär sitt token som
     * QUERY, som normalt inte ingår i transaktionsnamnet. Etapp 10:s svarslänk
     * lägger det i PATHEN, och det är den skillnaden som gör den här funktionen
     * nödvändig. Funnet av security-auditor.
     */
    beforeSendTransaction(event) {
      if (event.transaction) event.transaction = maskeraToken(event.transaction)
      if (event.request?.url) event.request.url = maskeraToken(event.request.url)
      return event
    },
    // Filtrera bort förväntat kontrollflöde — auth-fel och flyktiga
    // nätverksfel ska inte räknas som incidenter.
    beforeSend(event, hint) {
      // Samma maskering på felhändelser: `event.request.url` bär hela URL:en.
      if (event.request?.url) event.request.url = maskeraToken(event.request.url)
      if (event.transaction) event.transaction = maskeraToken(event.transaction)
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
