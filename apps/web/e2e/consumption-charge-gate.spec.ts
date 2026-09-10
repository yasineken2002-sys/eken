import { test, expect } from '@playwright/test'
import { PrismaClient } from '../../api/node_modules/@prisma/client/default.js'
import { hash } from '../../api/node_modules/bcryptjs/index.js'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
const { CURRENT_TERMS_VERSION } = createRequire(import.meta.url)('@eken/shared')

// Verklig webbläsare → ordinarie API/behörighetsvakter → isolerad PostgreSQL.
// Fixturen skapas direkt; alla avläsningar, bedömningar och konfirmeringar går via API/webb.
test('debiteringsgrind: spärr → behörigt intyg → omläsning → konfirmering; felaktigt fortsatt spärrat', async ({
  page,
  request,
}) => {
  if (!process.env.DATABASE_URL) throw new Error('Testet kräver en explicit isolerad DATABASE_URL')
  const db = new PrismaClient()
  const api = process.env.CONSUMPTION_GATE_API_URL ?? 'http://localhost:3000/v1'
  const email = `gate-browser-${randomUUID()}@example.test`
  const password = 'IsoleratTest123!'
  const org = await db.organization.create({
    data: {
      name: 'Grind web fixture',
      termsVersion: CURRENT_TERMS_VERSION,
      email,
      street: 'Test',
      city: 'Test',
      postalCode: '11111',
    },
  })
  try {
    await db.user.create({
      data: {
        organizationId: org.id,
        email,
        passwordHash: await hash(password, 10),
        firstName: 'Ada',
        lastName: 'Webbgrind',
        role: 'MANAGER',
      },
    })
    const property = await db.property.create({
      data: {
        organizationId: org.id,
        name: 'Grindhuset',
        propertyDesignation: randomUUID(),
        type: 'RESIDENTIAL',
        street: 'Test',
        city: 'Test',
        postalCode: '11111',
        totalArea: 50,
        consumptionBillingMode: 'RENT_NOTICE_LINE',
      },
    })
    const unit = await db.unit.create({
      data: {
        propertyId: property.id,
        name: 'Grindlägenhet',
        unitNumber: '101',
        type: 'APARTMENT',
        area: 50,
        monthlyRent: 1000,
      },
    })
    const tenant = await db.tenant.create({
      data: {
        organizationId: org.id,
        type: 'INDIVIDUAL',
        firstName: 'Test',
        lastName: 'Hyresgäst',
        email: `tenant-${email}`,
      },
    })
    await db.lease.create({
      data: {
        organizationId: org.id,
        unitId: unit.id,
        tenantId: tenant.id,
        status: 'ACTIVE',
        startDate: new Date('2026-01-01'),
        tenancyStartDate: new Date('2026-01-01'),
        monthlyRent: 1000,
        depositAmount: 0,
      },
    })
    await db.account.createMany({
      data: [
        { organizationId: org.id, number: 1510, name: 'Kundfordringar', type: 'ASSET' },
        { organizationId: org.id, number: 3920, name: 'Förbrukning', type: 'REVENUE' },
      ],
    })
    const login = await request.post(`${api}/auth/login`, { data: { email, password } })
    expect(login.ok()).toBe(true)
    const headers = { Authorization: `Bearer ${(await login.json()).data.accessToken}` }
    async function post(path: string, data: unknown) {
      const res = await request.post(`${api}${path}`, { headers, data })
      expect(res.ok(), JSON.stringify(await res.json())).toBe(true)
      return (await res.json()).data
    }
    const meter = await post('/consumption/meters', {
      unitId: unit.id,
      type: 'ELECTRICITY',
      unitOfMeasure: 'kWh',
    })
    await post('/consumption/tariffs', {
      scope: 'ORGANIZATION',
      meterType: 'ELECTRICITY',
      pricePerUnit: 2,
      validFrom: '2026-01-01',
    })
    let chargeId = ''
    for (const [i, value] of [10, 10, 10, 40].entries()) {
      const date = `2026-01-0${i + 1}`
      const result = await post('/consumption/readings', {
        meterId: meter.id,
        value,
        readingType: 'PERIOD_VOLUME',
        source: 'MANUAL',
        readingDate: date,
        periodStart: date,
        periodEnd: date,
      })
      chargeId = result.charge.id
    }
    const control = (
      await (
        await request.get(`${api}/consumption/charges/${chargeId}/control`, { headers })
      ).json()
    ).data
    const blocked = await request.patch(`${api}/consumption/charges/${chargeId}/confirm`, {
      headers,
      data: { expectedFingerprint: control.fingerprint },
    })
    expect(blocked.status()).toBe(409)
    expect(await db.consumptionChargeCheck.count({ where: { organizationId: org.id } })).toBe(0)
    expect(await db.journalEntry.count({ where: { organizationId: org.id } })).toBe(0)

    await page.goto('/login')
    await page.getByLabel('E-postadress').fill(email)
    await page.locator('input[autocomplete="current-password"]').fill(password)
    await page.getByRole('button', { name: 'Logga in', exact: true }).click()
    await expect(page).not.toHaveURL(/\/login/)
    await page.goto('/consumption?tab=charges')
    // Den stora periodvolymen har 80 kr. Öppna just den posten.
    await page
      .getByRole('row')
      .filter({ hasText: /80\s*kr/ })
      .click()
    await expect(page.getByText('Kontroll före debitering')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Bekräfta och bokför' })).toBeDisabled()
    await page.getByRole('button', { name: 'Öppna Granskning' }).click()
    await page.getByRole('button', { name: 'Bedöm varningen', exact: true }).click()
    await page.getByLabel('Bedömning', { exact: true }).selectOption('EXPLAINED')
    await page
      .getByLabel('Motivering')
      .fill('Original och period kontrollerade. Verklig ökning vid utökad användning.')
    await page.getByLabel('Intyg om debiteringsunderlaget').selectOption('INCORRECT')
    await page.getByRole('button', { name: 'Spara bedömning', exact: true }).click()
    await expect(page.getByText('Bedömningen har sparats.')).toBeVisible()
    expect(
      (
        await (
          await request.get(`${api}/consumption/charges/${chargeId}/control`, { headers })
        ).json()
      ).data.allowed,
    ).toBe(false)
    await page.getByRole('button', { name: 'Lägg till ny bedömning', exact: true }).click()
    await page.getByLabel('Bedömning', { exact: true }).selectOption('EXPLAINED')
    await page
      .getByLabel('Motivering')
      .fill(
        'Ny kontroll av original och alla jämförelseperioder: korrekt underlag, verklig ökning.',
      )
    await page
      .getByLabel('Intyg om debiteringsunderlaget')
      .selectOption('VERIFIED_CORRECT_REAL_INCREASE')
    await page.getByRole('button', { name: 'Spara bedömning', exact: true }).click()
    await expect(page.getByText('Bedömningen har sparats.')).toBeVisible()
    await page.getByRole('button', { name: 'Förbrukningsposter', exact: true }).click()
    await page
      .getByRole('row')
      .filter({ hasText: /80\s*kr/ })
      .click()
    await page.getByRole('button', { name: 'Läs om kontrollen' }).click()
    await page
      .getByRole('checkbox', {
        name: 'Jag har läst denna kontroll och vill konfirmera debiteringen.',
      })
      .check()
    await page.getByRole('button', { name: 'Bekräfta och bokför' }).click()
    await expect(page.getByText('Kontrollen och konfirmeringen har sparats.')).toBeVisible()
    expect((await db.consumptionCharge.findUniqueOrThrow({ where: { id: chargeId } })).status).toBe(
      'CONFIRMED',
    )
    expect(await db.consumptionChargeCheck.count({ where: { organizationId: org.id } })).toBe(1)
    expect(await db.journalEntry.count({ where: { organizationId: org.id } })).toBe(1)
    expect(
      await db.journalEntryLine.count({ where: { journalEntry: { organizationId: org.id } } }),
    ).toBe(2)
    await page.screenshot({ path: 'test-results/consumption-charge-gate.png', fullPage: true })
  } finally {
    const where = { organizationId: org.id }
    await db.journalEntryLine.deleteMany({ where: { journalEntry: where } })
    await db.journalEntry.deleteMany({ where })
    await db.journalEntrySequence.deleteMany({ where })
    await db.consumptionChargeCheck.deleteMany({ where })
    await db.consumptionCharge.deleteMany({ where })
    await db.meterReading.deleteMany({ where })
    await db.meter.deleteMany({ where })
    await db.consumptionTariff.deleteMany({ where })
    await db.lease.deleteMany({ where })
    await db.property.deleteMany({ where })
    await db.tenant.deleteMany({ where })
    await db.account.deleteMany({ where })
    await db.organization.delete({ where: { id: org.id } })
    expect(await db.consumptionChargeCheck.count({ where })).toBe(0)
    await db.$disconnect()
  }
})
