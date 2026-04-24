/**
 * Räknar ut base-URL:en för apps/web utifrån admin-tabbens origin.
 *
 * Prio:
 *   1. `VITE_WEB_URL` (explicit konfig — använd i produktion där web ligger
 *      på eget domän som eken-web.vercel.app)
 *   2. Codespace-subdomän: `...-5175.app.github.dev` → `...-5173.app.github.dev`
 *   3. Klassiskt port-suffix: `http://localhost:5175` → `http://localhost:5173`
 *   4. Fallback: returnera origin oförändrad (bättre än regex-miss som öppnar
 *      admin-domänen)
 */
export function resolveWebUrl(): string {
  const explicit = import.meta.env.VITE_WEB_URL as string | undefined
  if (explicit) return explicit.replace(/\/$/, '')

  const origin = window.location.origin

  // Codespaces: porten är del av subdomänen (t.ex. "-5175.app.github.dev")
  const codespaceMatch = origin.match(/^(https?:\/\/[^/]*?)-\d+(\.[^/]+)$/)
  if (codespaceMatch) {
    return `${codespaceMatch[1]}-5173${codespaceMatch[2]}`
  }

  // Lokal dev: porten i klassiskt :port-suffix
  if (/:\d+$/.test(origin)) {
    return origin.replace(/:\d+$/, ':5173')
  }

  return origin
}
