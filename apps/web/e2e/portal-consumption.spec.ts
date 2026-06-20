import { test, expect } from '@playwright/test'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'

/**
 * IMD Etapp 1, PR 1.6 — browser-bevis för hyresgästens förbrukningsvy (portal).
 *
 * Bevisar renderat i portalen (:5174):
 *   1. Förbruknings-korten renderas (en per bekräftad period).
 *   2. Den röda "hög förbrukning"-markeringen visas på en ovanligt hög period
 *      (> 1,3× hyresgästens snitt för samma mätartyp) — och INTE på normala.
 *
 * Seedar en hel debiterbar kedja via API + aktiverar portal-kontot (DB-token,
 * som seedPortalTenant), och bekräftar charges så att de syns för hyresgästen
 * (portalen visar bara CONFIRMED/ATTACHED).
 */

const API = 'http://localhost:3000/v1'
const PORTAL = 'http://localhost:5174'

function sql(query: string): void {
  execFileSync('psql', ['-h', 'localhost', '-U', 'eken', '-d', 'eken_dev', '-tAc', query], {
    env: { ...process.env, PGPASSWORD: 'eken' },
  })
}
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

test('portal: förbruknings-kort renderas + röd hög-markering', async ({ page, request }) => {
  const stamp = Date.now()
  const adminEmail = `e2e.landlord+${stamp}@eveno.test`
  const tenantEmail = `e2e.tenant+${stamp}@eveno.test`
  const password = 'TestE2e123!'

  // ── Seed via API ───────────────────────────────────────────────────────────
  const reg = await request.post(`${API}/auth/register`, {
    data: {
      email: adminEmail,
      password,
      firstName: 'E2E',
      lastName: 'Hyresvärd',
      organizationName: `E2E IMD Portal ${stamp}`,
      acceptTerms: true,
    },
  })
  const token = ((await reg.json()) as { data: { accessToken: string } }).data.accessToken
  const headers = { Authorization: `Bearer ${token}` }

  async function post<T>(path: string, data: unknown): Promise<T> {
    const r = await request.post(`${API}${path}`, { headers, data })
    const b = (await r.json()) as { success?: boolean; data?: T; error?: unknown }
    if (!r.ok() || b.success === false) throw new Error(`${path}: ${JSON.stringify(b)}`)
    return b.data as T
  }

  const property = await post<{ id: string }>('/properties', {
    name: 'IMD Portalfastighet',
    propertyDesignation: 'Eken 8:8',
    type: 'RESIDENTIAL',
    address: {
      street: 'Portalgatan 8',
      city: 'Stockholm',
      postalCode: '11122',
      country: 'Sverige',
    },
    totalArea: 300,
  })
  const unit = await post<{ id: string }>('/units', {
    propertyId: property.id,
    name: 'Lgh 8001',
    unitNumber: '8001',
    type: 'APARTMENT',
    status: 'VACANT',
    area: 60,
    monthlyRent: 11000,
  })
  await post('/tenants', {
    type: 'INDIVIDUAL',
    firstName: 'Test',
    lastName: 'Hyresgäst',
    email: tenantEmail,
    lease: { unitId: unit.id, startDate: '2026-01-01', monthlyRent: 11000 },
  })
  async function getJson<T>(path: string): Promise<T> {
    const r = await request.get(`${API}${path}`, { headers })
    return ((await r.json()) as { data: T }).data
  }
  const leases = await getJson<Array<{ id: string }>>('/leases')
  const leaseId = leases[0]!.id
  const tenantsList = await getJson<Array<{ id: string; email: string }>>('/tenants')
  const tenantId = tenantsList.find((t) => t.email === tenantEmail)!.id

  sql(`UPDATE "Lease" SET status='ACTIVE' WHERE id='${leaseId}';`)

  // Tariff + elmätare + tre avläsningar med varierande förbrukning (100, 110, 400).
  // Snitt ≈ 203 → 400 > 1,3×203 (≈264) → röd; 100/110 normala.
  await post('/consumption/tariffs', {
    scope: 'ORGANIZATION',
    meterType: 'ELECTRICITY',
    pricePerUnit: 2.5,
    validFrom: '2026-01-01',
  })
  const meter = await post<{ id: string }>('/consumption/meters', {
    unitId: unit.id,
    type: 'ELECTRICITY',
    unitOfMeasure: 'kWh',
  })
  const periods: Array<[string, string, string, number]> = [
    ['2026-01-31', '2026-01-01', '2026-01-31', 100],
    ['2026-02-28', '2026-02-01', '2026-02-28', 110],
    ['2026-03-31', '2026-03-01', '2026-03-31', 400],
  ]
  for (const [readingDate, periodStart, periodEnd, value] of periods) {
    const res = await post<{ charge: { id: string } | null }>('/consumption/readings', {
      meterId: meter.id,
      value,
      readingType: 'PERIOD_VOLUME',
      source: 'MANUAL',
      readingDate,
      periodStart,
      periodEnd,
    })
    // Bekräfta charge:n så att hyresgästen ser den (portalen döljer DRAFT).
    if (res.charge)
      await request.patch(`${API}/consumption/charges/${res.charge.id}/confirm`, { headers })
  }

  // Aktivera portal-kontot (token-hash i DB → /tenant-portal/activate).
  const activationToken = randomBytes(32).toString('hex')
  sql(
    `UPDATE "Tenant" SET "activationTokenHash"='${sha256(activationToken)}', ` +
      `"activationTokenExpiresAt"=now()+interval '1 day', "portalActivated"=false WHERE id='${tenantId}';`,
  )
  await post('/tenant-portal/activate', {
    token: activationToken,
    password,
    signatureName: 'Test Hyresgäst',
  })

  // ── Logga in i portalen ────────────────────────────────────────────────────
  await page.goto(`${PORTAL}/login`)
  await page.locator('#email').fill(tenantEmail)
  await page.locator('#password').fill(password)
  await page.getByRole('button', { name: 'Logga in' }).click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 })

  // ── Förbrukningsvyn ────────────────────────────────────────────────────────
  await page.goto(`${PORTAL}/forbrukning`)
  await expect(page.getByRole('heading', { name: 'Min förbrukning' })).toBeVisible()

  // ── Bevis 1: tre förbruknings-kort renderas ────────────────────────────────
  await expect(page.getByText('100 kWh')).toBeVisible()
  await expect(page.getByText('110 kWh')).toBeVisible()
  await expect(page.getByText('400 kWh')).toBeVisible()

  // ── Bevis 2: röd "Hög"-markering på 400-perioden, inte på de normala ───────
  const highTag = page.getByText('Hög', { exact: true })
  await expect(highTag).toHaveCount(1)
  await expect(highTag).toBeVisible()
  // "Hög"-taggen är röd (#dc2626 → rgb(220, 38, 38)).
  await expect(highTag).toHaveCSS('color', 'rgb(220, 38, 38)')

  await page.screenshot({ path: 'test-results/imd-portal-consumption.png', fullPage: true })
})
