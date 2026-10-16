import { expect, test } from '@playwright/test'
import { createRequire } from 'node:module'
import type { FortnoxExportRow } from '@eken/shared'
import type * as Shared from '@eken/shared'

// Playwright kör i Node; använd paketets byggda CJS-ingång, inte Vites source-alias.
const { CURRENT_TERMS_VERSION } = createRequire(import.meta.url)('@eken/shared') as typeof Shared

/**
 * Browserregression med syntetiska route-svar, INTE ett fullstack- eller bankprov.
 * Riktig router, auth-store, QueryClient, schemas, Fortnox-sida och CSS körs.
 * PostgreSQL-provet fortnox-worklist.db.spec.ts bevisar serverns kompletta urval;
 * här provas att användaren kan nå dess sidor och gamla problem utan sidoeffekter.
 * Ingen registrering, databas, Fortnox-kontakt eller skrivande HTTP tillåts.
 */
const PREFIX = '/api/v1/integrations/fortnox'
const STAMP = '2026-10-16T12:00:00.000Z'
const PROBLEM_STATES = ['UNKNOWN', 'REJECTED', 'RECEIPT_MISMATCH', 'RECEIPT_IDENTIFIED'] as const

interface Entry {
  journalDate: string
  row: FortnoxExportRow
}

// Redan sorterad syntetisk API-historik: 201 nya poster före alla fyra äldre problem.
const newer: Entry[] = Array.from({ length: 201 }, (_, index) => ({
  journalDate: '2026-01-15',
  row: {
    id: `synthetic-confirmed-${201 - index}`,
    journalEntryId: `synthetic-journal-${201 - index}`,
    state: 'CONFIRMED',
    blockReason: null,
    updatedAt: STAMP,
    externalYear: 2026,
    externalSeries: 'A',
    externalNumber: 201 - index,
  },
}))
const older: Entry[] = [
  { state: 'RECEIPT_IDENTIFIED', journalDate: '2024-03-01' },
  { state: 'RECEIPT_MISMATCH', journalDate: '2024-02-29' },
  { state: 'REJECTED', journalDate: '2024-02-29' },
  { state: 'UNKNOWN', journalDate: '2024-02-28' },
].map(({ state, journalDate }) => ({
  journalDate,
  row: {
    id: `synthetic-old-${state}`,
    journalEntryId: `old-${state}-synthetic-journal`,
    state: state as (typeof PROBLEM_STATES)[number],
    blockReason: `Syntetiskt äldre problem ${state}. ${'Långsammanhängandeprovtext'.repeat(5)}`,
    draftHash: 'a'.repeat(64),
    lastOutcome: state === 'REJECTED' ? 'REJECTED_429_NA' : null,
    updatedAt: `${journalDate}T12:00:00.000Z`,
  },
}))
const entries = [...newer, ...older]

const status = {
  enabled: true,
  connection: {
    status: 'DISCONNECTED',
    company: { name: 'Syntetiskt testföretag', orgNumber: '559999-0001', databaseNumber: 990001 },
    connectedAt: '2024-01-01T12:00:00.000Z',
    disconnectedAt: STAMP,
    lastErrorClass: null,
    lastErrorAt: null,
    exportVoucherSeries: 'A',
    exportOmitDimensions: true,
  },
  mappings: [],
  latestRead: null,
  latestCompleteRead: null,
  exports: {
    counts: {
      DRY_RUN_READY: 0,
      BLOCKED: 0,
      SENDING: 0,
      UNKNOWN: 1,
      REJECTED: 1,
      RECEIPT_MISMATCH: 1,
      RECEIPT_IDENTIFIED: 1,
      CONFIRMED: 201,
    },
    needsReconciliation: 3,
    sendingEnabled: false,
    sendingDisabledReason: 'IDEMPOTENCY_UNRESOLVED',
  },
}

test('Fortnox-arbetslista: äldre problem, sidantal, datumval och 320 px utan sändning', async ({
  page,
  baseURL,
}, testInfo) => {
  if (!baseURL) throw new Error('Browserprovet kräver Playwrights lokala baseURL')
  const appOrigin = new URL(baseURL).origin
  const unexpectedRequests: string[] = []
  const writes: string[] = []
  const externalRequests: string[] = []
  const pageRequests: Array<{
    group: string
    offset: number
    limit: number
    from: string | null
    to: string | null
  }> = []

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
    if (request.method() !== 'GET') {
      writes.push(`${request.method()} ${url.pathname}`)
      await route.abort('blockedbyclient')
      return
    }
    if (url.origin !== appOrigin) {
      externalRequests.push(`${url.origin}${url.pathname}`)
      await route.abort('blockedbyclient')
      return
    }
    if (!url.pathname.startsWith('/api/')) {
      await route.continue()
      return
    }
    let data: unknown
    if (url.pathname === '/api/v1/accounting/ledger-owner') {
      data = { agare: 'FORTNOX', valdAt: STAMP, skal: 'Syntetisk browserfixture' }
    } else if (url.pathname === `${PREFIX}/status`) {
      data = status
    } else if (url.pathname === '/api/v1/notifications/count') {
      data = { unread: 0 }
    } else if (url.pathname === '/api/v1/notifications') {
      data = []
    } else if (url.pathname === `${PREFIX}/exports-page`) {
      const params = url.searchParams
      const group = params.get('group') ?? 'ALL'
      const offset = Number(params.get('offset') ?? 0)
      const limit = Number(params.get('limit') ?? 50)
      const from = params.get('from')
      const to = params.get('to')
      pageRequests.push({ group, offset, limit, from, to })
      const filtered = entries.filter(({ journalDate, row }) => {
        const needsReview = PROBLEM_STATES.some((state) => state === row.state)
        return (
          (group === 'ALL' || (group === 'NEEDS_REVIEW' ? needsReview : !needsReview)) &&
          (from === null || journalDate >= from) &&
          (to === null || journalDate <= to)
        )
      })
      data = {
        items: filtered.slice(offset, offset + limit).map(({ row }) => row),
        total: filtered.length,
        offset,
        limit,
      }
    } else {
      // Även den gamla /exports-vägen är otillåten: verklig ny API-kedja måste användas.
      unexpectedRequests.push(`${request.method()} ${url.pathname}`)
      await route.abort('blockedbyclient')
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data }),
    })
  })

  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/fortnox/overforing')
  await expect(
    page.getByRole('heading', { name: 'Överföring och avstämning', exact: true }),
  ).toBeVisible()
  const review = page.getByTestId('att-stamma-av')
  const other = page.getByTestId('ovriga-overforingar')
  await expect(
    review.getByRole('heading', { name: 'Att stämma av (4)', exact: true }),
  ).toBeVisible()
  await expect(review.getByText('Visar 1–4 av 4 överföringar.', { exact: true })).toBeVisible()
  for (const state of PROBLEM_STATES) {
    await expect(review.locator(`[data-export-state="${state}"]`)).toHaveCount(1)
  }
  await expect(review.getByText('Inget att stämma av i urvalet.', { exact: true })).toHaveCount(0)
  await expect(page.getByTestId('anslutning-bruten')).toBeVisible()
  await expect(other.getByText('Visar 1–50 av 201 överföringar.', { exact: true })).toBeVisible()
  await expect(other.locator('[data-export-state="CONFIRMED"]')).toHaveCount(50)
  expect(pageRequests).toHaveLength(2)
  expect(pageRequests).toEqual(
    expect.arrayContaining([
      { group: 'NEEDS_REVIEW', offset: 0, limit: 50, from: null, to: null },
      { group: 'OTHER', offset: 0, limit: 50, from: null, to: null },
    ]),
  )
  await page.screenshot({ path: testInfo.outputPath('fortnox-arbetslista-desktop.png') })

  // Vanliga kontroller, utan force: nästa, sista, föregående och tillbaka till första.
  await other.getByRole('button', { name: 'Nästa', exact: true }).click()
  await expect(other.getByText('Visar 51–100 av 201 överföringar.', { exact: true })).toBeVisible()
  await expect(
    other.getByText('Fortnox-verifikat A151 (räkenskapsår-id 2026)', { exact: true }),
  ).toBeVisible()
  await expect(
    other.getByText('Fortnox-verifikat A201 (räkenskapsår-id 2026)', { exact: true }),
  ).toHaveCount(0)
  await other.getByRole('button', { name: 'Sista sidan', exact: true }).click()
  await expect(other.getByText('Visar 201–201 av 201 överföringar.', { exact: true })).toBeVisible()
  await expect(other.locator('[data-export-state="CONFIRMED"]')).toHaveCount(1)
  await expect(other.getByRole('button', { name: 'Nästa', exact: true })).toBeDisabled()
  await other.getByRole('button', { name: 'Föregående', exact: true }).click()
  await expect(other.getByText('Visar 151–200 av 201 överföringar.', { exact: true })).toBeVisible()
  await other.getByRole('button', { name: 'Alla datum', exact: true }).click()
  await expect(other.getByText('Visar 1–50 av 201 överföringar.', { exact: true })).toBeVisible()
  await expect(other.getByRole('button', { name: 'Föregående', exact: true })).toBeDisabled()

  // Redigerade datum gäller först efter uttrycklig formulärsubmit, även med tangentbord.
  await review.getByLabel('Från', { exact: true }).fill('2024-02-29')
  await review.getByLabel('Till', { exact: true }).fill('2024-02-29')
  await expect(review.getByText('Visar alla datum.', { exact: true })).toBeVisible()
  await expect(review.locator('[data-export-state]')).toHaveCount(4)
  await review.getByRole('button', { name: 'Visa period', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(review.getByText('Visar 1–2 av 2 överföringar.', { exact: true })).toBeVisible()
  await expect(review.locator('[data-export-state="REJECTED"]')).toHaveCount(1)
  await expect(review.locator('[data-export-state="RECEIPT_MISMATCH"]')).toHaveCount(1)
  await expect(review.locator('[data-export-state="UNKNOWN"]')).toHaveCount(0)
  expect(pageRequests).toContainEqual({
    group: 'NEEDS_REVIEW',
    offset: 0,
    limit: 50,
    from: '2024-02-29',
    to: '2024-02-29',
  })
  await review.getByRole('button', { name: 'Alla datum', exact: true }).click()
  await expect(review.getByText('Visar 1–4 av 4 överföringar.', { exact: true })).toBeVisible()
  await expect(review.getByLabel('Från', { exact: true })).toHaveValue('')
  await expect(review.getByLabel('Till', { exact: true })).toHaveValue('')

  await page.setViewportSize({ width: 320, height: 740 })
  await review
    .getByRole('heading', { name: 'Att stämma av (4)', exact: true })
    .scrollIntoViewIfNeeded()
  for (const region of [review, other]) {
    const box = await region.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(321)
  }
  expect(
    await page.evaluate(
      () =>
        Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
        window.innerWidth,
    ),
  ).toBeLessThanOrEqual(1)
  await page.screenshot({ path: testInfo.outputPath('fortnox-arbetslista-320px.png') })
  // Också mobilen måste kunna använda pagineringen med riktiga klick.
  await other.getByRole('button', { name: 'Sista sidan', exact: true }).click()
  await expect(other.getByText('Visar 201–201 av 201 överföringar.', { exact: true })).toBeVisible()
  await other.getByRole('button', { name: 'Alla datum', exact: true }).click()
  await expect(other.getByText('Visar 1–50 av 201 överföringar.', { exact: true })).toBeVisible()
  expect(
    pageRequests.some(
      ({ group, offset, limit }) => group === 'OTHER' && offset === 200 && limit === 50,
    ),
  ).toBe(true)
  expect(writes).toEqual([])
  expect(externalRequests).toEqual([])
  expect(unexpectedRequests).toEqual([])
})
