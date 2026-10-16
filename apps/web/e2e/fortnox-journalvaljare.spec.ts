import { expect, test } from '@playwright/test'
import { createRequire } from 'node:module'
import type * as Shared from '@eken/shared'

const { CURRENT_TERMS_VERSION } = createRequire(import.meta.url)('@eken/shared') as typeof Shared
const STAMP = '2026-10-16T12:00:00.000Z'
const PREFIX = '/api/v1/integrations/fortnox'
const company = { name: 'Syntetiskt testföretag', orgNumber: '559999-0001', databaseNumber: 990001 }
const journals = Array.from({ length: 2005 }, (_, index) => ({
  id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  date: index < 2000 ? '2026-01-31' : '2023-01-31',
  series: 'A',
  verNumber: index + 1,
  description: `Syntetiskt verifikat ${index + 1}`,
  source: index % 2 === 0 ? 'PAYMENT' : 'INVOICE',
}))

/** Riktig SettingsPage/router/CSS, syntetiska nätgränser. Inga server-/provider-skrivningar. */
test('Fortnox-journalväljare: över 2000, äldre datum och mobil med en uttrycklig förhandskontroll', async ({
  page,
  baseURL,
}, testInfo) => {
  if (!baseURL) throw new Error('Lokalt baseURL krävs')
  const origin = new URL(baseURL).origin
  const unexpected: string[] = []
  const dryRuns: unknown[] = []
  const requests: Array<{
    offset: number
    limit: number
    from: string | null
    to: string | null
    source: string | null
  }> = []
  const browserErrors: string[] = []
  page.on('pageerror', (error) => browserErrors.push(error.message))
  await page.addInitScript(
    ({ termsVersion, stamp }) => {
      localStorage.setItem('eveno-cookies-consent', 'necessary-only')
      localStorage.setItem('eveno-cookies-consent-at', stamp)
      localStorage.setItem(
        'eken-auth',
        JSON.stringify({
          version: 0,
          state: {
            user: {
              id: '10000000-0000-4000-8000-000000000001',
              organizationId: '20000000-0000-4000-8000-000000000001',
              role: 'OWNER',
              email: 'synthetic-owner@example.invalid',
              firstName: 'Syntetisk',
              lastName: 'Granskare',
              createdAt: stamp,
              updatedAt: stamp,
            },
            organization: {
              id: '20000000-0000-4000-8000-000000000001',
              name: 'Syntetiskt testföretag',
              orgNumber: '559999-0001',
              termsVersion,
            },
            accessToken: 'synthetic-browser-token',
            refreshToken: 'synthetic-browser-refresh',
            isAuthenticated: true,
          },
        }),
      )
    },
    { termsVersion: CURRENT_TERMS_VERSION, stamp: STAMP },
  )

  await page.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== origin) {
      unexpected.push(`external ${url.origin}${url.pathname}`)
      await route.abort()
      return
    }
    if (request.method() === 'POST' && url.pathname === `${PREFIX}/exports/dry-run`) {
      const input = request.postDataJSON() as { journalEntryId: string }
      dryRuns.push(input)
      expect(journals.some((row) => row.id === input.journalEntryId)).toBe(true)
      await route.fulfill({
        json: {
          success: true,
          data: {
            id: 'synthetic-dry-run',
            journalEntryId: input.journalEntryId,
            state: 'DRY_RUN_READY',
            blockReason: null,
            updatedAt: STAMP,
          },
        },
      })
      return
    }
    if (request.method() !== 'GET') {
      unexpected.push(`${request.method()} ${url.pathname}`)
      await route.abort()
      return
    }
    if (!url.pathname.startsWith('/api/')) {
      await route.continue()
      return
    }
    let data: unknown
    switch (url.pathname) {
      case '/api/v1/organizations/me':
        data = {
          id: '20000000-0000-4000-8000-000000000001',
          ...company,
          termsVersion: CURRENT_TERMS_VERSION,
        }
        break
      case '/api/v1/accounting/ledger-owner':
        data = { agare: 'FORTNOX', valdAt: STAMP, skal: 'Syntetiskt browserprov' }
        break
      case '/api/v1/notifications/count':
        data = { unread: 0 }
        break
      case '/api/v1/notifications':
      case '/api/v1/properties':
        data = []
        break
      case '/api/v1/ai/assignments/summary':
        data = { total: 0, byStatus: {}, shadowTotal: 0 }
        break
      case `${PREFIX}/status`:
        data = {
          enabled: true,
          connection: {
            status: 'ACTIVE',
            company,
            connectedAt: STAMP,
            disconnectedAt: null,
            lastErrorClass: null,
            lastErrorAt: null,
            exportVoucherSeries: 'A',
            exportOmitDimensions: true,
          },
          mappings: [],
          latestRead: null,
          latestCompleteRead: null,
          exports: {
            counts: { DRY_RUN_READY: 0, BLOCKED: 0, UNKNOWN: 0, CONFIRMED: 0 },
            needsReconciliation: 0,
            sendingEnabled: false,
            sendingDisabledReason: 'IDEMPOTENCY_UNRESOLVED',
          },
        }
        break
      case `${PREFIX}/catalog`:
        data = {
          ready: true,
          reason: null,
          observedAt: STAMP,
          company,
          financialYears: [{ id: 1, from: '2026-01-01', to: '2026-12-31' }],
          voucherSeries: [{ code: 'A', description: 'Syntetisk' }],
          selectedFinancialYearId: null,
          costAccounts: [],
          dimensions: [],
          complete: true,
        }
        break
      case `${PREFIX}/account-mapping`:
        data = { behov: [], ejStodda: [], revisioner: [] }
        break
      case `${PREFIX}/customer-activation`:
        data = {
          flaggaPa: false,
          huvudbok: { agare: 'FORTNOX', valdAt: STAMP, fortnoxDatabasnummer: 990001 },
          aktiv: null,
          aktivHinder: null,
          forslag: { ok: false, hinder: ['Syntetiskt prov'], text: null, textSha256: null },
          historik: [],
        }
        break
      case `${PREFIX}/exports-page`:
        data = { items: [], total: 0, offset: 0, limit: 50 }
        break
      case '/api/v1/accounting/journal-page': {
        const p = url.searchParams
        const filter = {
          offset: Number(p.get('offset')),
          limit: Number(p.get('limit')),
          from: p.get('from'),
          to: p.get('to'),
          source: p.get('source'),
        }
        requests.push(filter)
        const matching = journals.filter(
          (row) =>
            (!filter.from || row.date >= filter.from) &&
            (!filter.to || row.date <= filter.to) &&
            (!filter.source || row.source === filter.source),
        )
        data = {
          entries: matching.slice(filter.offset, filter.offset + filter.limit),
          total: matching.length,
          offset: filter.offset,
          limit: filter.limit,
        }
        break
      }
      default:
        unexpected.push(`${request.method()} ${url.pathname}`)
        await route.abort()
        return
    }
    await route.fulfill({ json: { success: true, data } })
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/settings/fortnox')
  const picker = page.getByRole('region', { name: 'Välj verifikat för förhandskontroll' })
  await expect(picker.getByText('Visar 1–50 av 2005 verifikat', { exact: true })).toBeVisible()
  await expect(picker.getByLabel('Verifikat', { exact: true }).locator('option')).toHaveCount(51)
  expect(requests).toEqual([{ offset: 0, limit: 50, from: null, to: null, source: null }])
  await picker.getByRole('button', { name: 'Sista sidan', exact: true }).click()
  await expect(picker.getByText('Visar 2001–2005 av 2005 verifikat', { exact: true })).toBeVisible()
  await picker.getByLabel('Verifikat', { exact: true }).selectOption(journals[2004]!.id)
  expect(dryRuns).toEqual([])
  await picker.getByRole('button', { name: 'Förhandskontrollera', exact: true }).click()
  await expect(picker.getByTestId('fortnox-dry-run-result')).toContainText(
    'INTE skickat eller bokfört',
  )
  expect(dryRuns).toEqual([{ journalEntryId: journals[2004]!.id }])
  await picker.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('fortnox-journalvaljare-desktop.png') })

  await page.setViewportSize({ width: 320, height: 740 })
  await picker.getByLabel('Verifikationsdatum från').fill('2023-01-31')
  await picker.getByLabel('Verifikationsdatum till').fill('2023-01-31')
  await picker.getByLabel('Källa', { exact: true }).selectOption('PAYMENT')
  await expect(picker.getByTestId('fortnox-dry-run-result')).toHaveCount(0)
  await picker.getByRole('button', { name: 'Visa urval', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(picker.getByText('Visar 1–3 av 3 verifikat', { exact: true })).toBeVisible()
  await expect(picker.getByLabel('Verifikat', { exact: true })).toHaveValue('')
  await expect(
    picker.getByRole('button', { name: 'Förhandskontrollera', exact: true }),
  ).toBeDisabled()
  expect(requests.at(-1)).toEqual({
    offset: 0,
    limit: 50,
    from: '2023-01-31',
    to: '2023-01-31',
    source: 'PAYMENT',
  })
  await picker.scrollIntoViewIfNeeded()
  const box = await picker.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(321)
  expect(
    await page.evaluate(
      () => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - innerWidth,
    ),
  ).toBeLessThanOrEqual(1)
  await page.screenshot({ path: testInfo.outputPath('fortnox-journalvaljare-320px.png') })
  await picker.getByRole('button', { name: 'Alla datum', exact: true }).click()
  await expect(picker.getByText('Visar 1–50 av 1003 verifikat', { exact: true })).toBeVisible()
  expect(requests.every(({ limit }) => limit === 50)).toBe(true)
  expect(dryRuns).toHaveLength(1)
  expect(unexpected).toEqual([])
  expect(browserErrors).toEqual([])
})
