import { test, expect, type Browser, type BrowserContextOptions } from '@playwright/test'

/**
 * Portalens cookie-dialog ska gå att stänga när hyresgästen är INLOGGAD utan
 * tidigare samtycke — med ett vanligt klick/tap, inte bara med tangentbordet.
 *
 * Fyndet (2026-09-27, KLIENTER PORTAL-COOKIE-TACKT): dialogen låg på z-index 50
 * och bottenmenyn (PortalLayout .bottomNav) på 100. Menyn täckte knapparna —
 * vid 390 px BÅDA, på desktop "Endast nödvändiga" — och dialogen gick inte att
 * stänga med pekare. Samma fel fanns redan i ed3d0ef2; utloggat (/login, ingen
 * meny) syntes det aldrig, och ingen annan spec rör dialogen.
 *
 * Varför webbläsare och inte jsdom: felet är en STAPLINGSORDNING. Beviset är att
 * knappens mittpunkt träffar knappen (`elementFromPoint`) och att Playwrights
 * vanliga klick — med sin träffkontroll, utan `force` — går igenom. Ett
 * klassnamn eller ett z-index-värde i en assertion mäter inte det.
 *
 * Inget API behövs: sessionen riggas i localStorage före sidladdning (samma form
 * som session.store persisterar) och varje /api-anrop besvaras SYNTETISKT i
 * webbläsaren. Trafik till andra origins avbryts. Samtycket SKRIVS aldrig av
 * provet — det läses efter klicket, som bevis på att produktens egen knapp körde.
 */

const PORTAL = 'http://localhost:5174'
const CONSENT_KEY = 'eveno-portal-cookies-consent'
const SESSION = JSON.stringify({
  state: {
    sessionToken: 'e2e-syntetisk-session',
    tenant: {
      id: 'e2e-syntetisk-hyresgast',
      type: 'INDIVIDUAL',
      firstName: 'Syntetisk',
      lastName: 'Hyresgäst',
      email: 'syntetisk@example.invalid',
    },
    expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
    isAuthenticated: true,
  },
  version: 0,
})

const KNAPPAR = [
  { namn: 'Godkänn', varde: 'accepted' },
  { namn: 'Endast nödvändiga', varde: 'necessary-only' },
] as const

async function provaKnapp(
  browser: Browser,
  vy: BrowserContextOptions,
  knapp: (typeof KNAPPAR)[number],
  pekare: 'click' | 'tap',
) {
  const ctx = await browser.newContext(vy)
  const externa: string[] = []
  // Bara sessionen riggas — INTE samtycket. En gång per kontext, så att en
  // omladdning inte skriver tillbaka något.
  await ctx.addInitScript((s) => {
    if (!sessionStorage.getItem('e2e-riggad')) {
      localStorage.setItem('tenant_session', s)
      sessionStorage.setItem('e2e-riggad', '1')
    }
  }, SESSION)
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url())
    if (u.origin !== PORTAL) {
      externa.push(u.href)
      return route.abort()
    }
    if (u.pathname.startsWith('/api/')) {
      // Listor tomma, övrigt null: sidorna visar då sina tomma lägen i stället
      // för att krascha på ett objekt de inte känner igen.
      const data = u.pathname.includes('/public/config')
        ? { features: { bankId: false } }
        : /(invoices|rent-notices|notices|maintenance|news|documents|inspections|consumption)/.test(
              u.pathname,
            )
          ? []
          : null
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'x-e2e-syntetisk': '1' },
        body: JSON.stringify({ data }),
      })
    }
    return route.continue()
  })

  const page = await ctx.newPage()
  await page.goto(`${PORTAL}/notices`)
  await expect(page.getByRole('heading', { name: 'Avier & fakturor' })).toBeVisible()
  const nav = page.locator('nav')
  await expect(nav).toBeVisible()

  const dialog = page.getByRole('dialog', { name: 'Cookies' })
  const btn = dialog.getByRole('button', { name: knapp.namn, exact: true })
  await expect(btn).toBeVisible()

  // Staplingen: knappens mittpunkt ska träffa knappen, inte en menyflik.
  const overst = await btn.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return t === el || el.contains(t)
      ? 'knappen'
      : (t?.closest('a')?.getAttribute('aria-label') ?? String(t?.tagName))
  }, undefined)
  expect(overst, `${knapp.namn}: överst vid knappens mitt`).toBe('knappen')

  // Vanlig pekare, med Playwrights träffkontroll. Ingen force.
  if (pekare === 'tap') await btn.tap({ timeout: 5_000 })
  else await btn.click({ timeout: 5_000 })

  await expect(dialog).toBeHidden()
  expect(await page.evaluate((k) => localStorage.getItem(k), CONSENT_KEY)).toBe(knapp.varde)
  expect(await page.evaluate((k) => localStorage.getItem(`${k}-at`), CONSENT_KEY)).not.toBeNull()

  // Menyn fungerar efter stängning, och sidan har ingen horisontell scroll.
  const flik = async (namn: string) => {
    const l = nav.getByRole('link', { name: namn })
    if (pekare === 'tap') await l.tap({ timeout: 5_000 })
    else await l.click({ timeout: 5_000 })
  }
  await flik('Hem')
  await expect(page).toHaveURL(`${PORTAL}/`)
  await flik('Avier')
  await expect(page).toHaveURL(`${PORTAL}/notices`)
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false,
  )

  expect(externa, 'inga anrop utanför portalen').toEqual([])
  await ctx.close()
}

test('portal: cookie-dialogen går att stänga med tap ovanför bottenmenyn vid 390 px', async ({
  browser,
}) => {
  const vy = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
  for (const knapp of KNAPPAR) await provaKnapp(browser, vy, knapp, 'tap')
})

test('portal: cookie-dialogen går att stänga med klick ovanför bottenmenyn på desktop', async ({
  browser,
}) => {
  const vy = { viewport: { width: 1440, height: 900 } }
  for (const knapp of KNAPPAR) await provaKnapp(browser, vy, knapp, 'click')
})
