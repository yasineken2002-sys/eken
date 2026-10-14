import { test, expect } from '@playwright/test'
import type { APIRequestContext, Browser, Page } from '@playwright/test'
import { createHash, randomBytes } from 'node:crypto'
import { API, registerOrg, sqlValue } from './helpers/seed'

/**
 * KUNDSTART-205 (R165-3) — kundavstämning mot tidigare reskontra, två aktörer.
 *
 * En OWNER laddar upp en SEPARAT syntetisk export ur "det tidigare systemet" och en
 * uttrycklig mappning; servern jämför dokument för dokument och kund för kund mot
 * importen. En ACCOUNTANT (egen inloggning) granskar exakt den versionen. Först då
 * släpper ägarens godkännandespärr. Den omkastade importen har SAMMA totalsumma men
 * fel kunder: den ska visa differensen per kund och hålla både granskning och
 * godkännande stängda.
 *
 * Allt är syntetiskt (egen färsk organisation, psql bara för fixturfält som API:t inte
 * exponerar). Ingen Fortnox-kontakt; själva godkännandet/verkställningen kräver en
 * Fortnox-läsning och provas mot riktig Postgres i opening-evidence.db.spec.ts.
 */

const MOBIL = { width: 390, height: 844 }

async function unwrap<T>(
  res: { ok(): boolean; status(): number; json(): Promise<unknown> },
  vad: string,
): Promise<T> {
  const body = (await res.json()) as { success?: boolean; data?: T; error?: { message?: string } }
  if (!res.ok() || body?.success === false)
    throw new Error(
      `${vad} misslyckades (${res.status()}): ${body?.error?.message ?? JSON.stringify(body)}`,
    )
  return body.data as T
}

async function apiLogin(request: APIRequestContext, email: string, password: string) {
  return (
    await unwrap<{ accessToken: string }>(
      await request.post(`${API}/auth/login`, { data: { email, password } }),
      'Inloggning',
    )
  ).accessToken
}

async function uiLogin(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByLabel('E-postadress').fill(email)
  await page.locator('input[autocomplete="current-password"]').fill(password)
  await page.getByRole('button', { name: 'Logga in', exact: true }).click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 })
}

const iso = (d: Date) => d.toISOString().slice(0, 10)

interface Kundstart {
  owner: { email: string; password: string; headers: Record<string, string> }
  accountant: { email: string; password: string; headers: Record<string, string> }
  packageId: string
  sourceName: string
  orgNumber: string
  asOf: string
  kalla: string
  mappning: string
}

/** Färsk organisation med två hyresgäster/avtal, brytdatum, validerat paket och en ACCOUNTANT. */
async function seedKundstart(request: APIRequestContext, swapped: boolean): Promise<Kundstart> {
  const { email, password } = await registerOrg(request)
  const headers = { Authorization: `Bearer ${await apiLogin(request, email, password)}` }
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`
  const orgId = sqlValue(`SELECT "organizationId" FROM "User" WHERE email = '${email}'`)
  const orgNumber = `55${stamp.slice(-4)}-${stamp.slice(-8, -4)}`
  sqlValue(`UPDATE "Organization" SET "orgNumber" = '${orgNumber}' WHERE id = '${orgId}'`)

  // Brytdatum = den 1:a nästa månad; fordringarna gäller innevarande månad.
  const nu = new Date()
  const cutover = new Date(Date.UTC(nu.getUTCFullYear(), nu.getUTCMonth() + 1, 1))
  const period = new Date(Date.UTC(nu.getUTCFullYear(), nu.getUTCMonth(), 1))
  const forfallo = iso(new Date(cutover.getTime() - 86_400_000))
  const ar = period.getUTCFullYear(),
    manad = period.getUTCMonth() + 1

  const property = await unwrap<{ id: string }>(
    await request.post(`${API}/properties`, {
      headers,
      data: {
        name: 'E2E Kundstart 1',
        propertyDesignation: `Stockholm E2E ${stamp}:1`,
        type: 'RESIDENTIAL',
        address: { street: 'Storgatan 1', city: 'Stockholm', postalCode: '111 22' },
        totalArea: 500,
      },
    }),
    'Skapa fastighet',
  )
  const kunder: Array<{ email: string; tenantId: string; leaseId: string; avtal: string }> = []
  for (const n of [1, 2]) {
    const unit = await unwrap<{ id: string }>(
      await request.post(`${API}/units`, {
        headers,
        data: {
          propertyId: property.id,
          name: `Lgh ${n}`,
          unitNumber: `${2000 + n}`,
          type: 'APARTMENT',
          status: 'VACANT',
          area: 50,
          monthlyRent: 6000,
        },
      }),
      'Skapa enhet',
    )
    const tenantEmail = `e2e.kund${n}+${stamp}@eveno.test`
    await unwrap(
      await request.post(`${API}/tenants`, {
        headers,
        data: {
          type: 'INDIVIDUAL',
          firstName: `Kund${n}`,
          lastName: 'E2E',
          email: tenantEmail,
          lease: { unitId: unit.id, startDate: `${ar - 1}-01-01`, monthlyRent: 6000 },
        },
      }),
      'Skapa hyresgäst + avtal',
    )
    const rad = sqlValue(
      `SELECT t.id || '|' || l.id FROM "Tenant" t JOIN "Lease" l ON l."tenantId" = t.id WHERE t.email = '${tenantEmail}'`,
    ).split('|')
    // Aktiveringen via SQL (som seedActiveLease) tilldelar inget avtalsnummer – sätt ett
    // unikt syntetiskt så att importens avtalsreferens kan lösas.
    const avtal = `E2E-${stamp}-${n}`
    sqlValue(
      `UPDATE "Lease" SET status = 'ACTIVE', "contractNumber" = '${avtal}' WHERE id = '${rad[1]}'`,
    )
    kunder.push({ email: tenantEmail, tenantId: rad[0]!, leaseId: rad[1]!, avtal })
  }

  await unwrap(
    await request.put(`${API}/kundstart/cutover`, { headers, data: { cutoverDate: iso(cutover) } }),
    'Brytdatum',
  )

  // Importen: DOC-1 6000 kr på kund 1, DOC-2 4000 kr på kund 2 – eller omkastad (samma total).
  const kr = [6000, 4000]
  const importRader = kunder.map((_k, i) => {
    const k = kunder[swapped ? 1 - i : i]!
    return `DOC-${i + 1};FORDRAN;${k.email};${k.avtal};;;${ar};${manad};${forfallo};${kr[i]};${kr[i]};;0;0`
  })
  const sourceName = `E2E-oppning-${stamp}.csv`
  const paket = await unwrap<{ id: string }>(
    await request.post(`${API}/kundstart/opening-packages`, {
      headers,
      data: {
        sourceName,
        innehall:
          [
            'radId;typ;hyresgast;avtal;fastighet;enhet;periodAr;periodManad;forfallodag;ursprungligtBelopp;oppetBelopp;mottagetDatum;betaltBelopp;krediteratBelopp',
            ...importRader,
          ].join('\n') + '\n',
      },
    }),
    'Skapa paket',
  )
  const validerat = await unwrap<{ status: string }>(
    await request.post(`${API}/kundstart/opening-packages/${paket.id}/validate`, { headers }),
    'Validera',
  )
  expect(validerat.status).toBe('VALIDATED')

  // Oberoende källa: alltid RÄTT kunder (det tidigare systemet), aldrig ur importen.
  const per = `${ar}-${String(manad).padStart(2, '0')}`
  const kalla = [
    'kallforetag;kund;avtal;dokument;typ;period;forfallodag;ursprungOre;betaltOre;krediteratOre;oppetOre;mottagetDatum;mottagningsbevis',
    `E2E-GAMMALT;A;K-A;DOC-1;RECEIVABLE;${per};${forfallo};600000;0;0;600000;;`,
    `E2E-GAMMALT;B;K-B;DOC-2;RECEIVABLE;${per};${forfallo};400000;0;0;400000;;`,
  ].join('\n')
  const mappning = [
    'kallforetag;kund;avtal;tenantId;leaseId;metod',
    `E2E-GAMMALT;A;K-A;${kunder[0]!.tenantId};${kunder[0]!.leaseId};syntetiskt e2e`,
    `E2E-GAMMALT;B;K-B;${kunder[1]!.tenantId};${kunder[1]!.leaseId};syntetiskt e2e`,
  ].join('\n')

  // Ekonomigranskare med egen inloggning (inbjudan → känd token → accept).
  const accEmail = `e2e.ekonomi+${stamp}@eveno.test`,
    accPassword = 'TestE2e123!'
  await unwrap(
    await request.post(`${API}/users/invite`, {
      headers,
      data: { email: accEmail, firstName: 'Eva', lastName: 'Ekonomi', role: 'ACCOUNTANT' },
    }),
    'Inbjudan ACCOUNTANT',
  )
  const raw = randomBytes(32).toString('hex')
  sqlValue(
    `UPDATE "UserInvitation" SET token = '${createHash('sha256').update(raw).digest('hex')}' WHERE "userId" = (SELECT id FROM "User" WHERE email = '${accEmail}')`,
  )
  await unwrap(
    await request.post(`${API}/auth/accept-invite`, {
      data: { token: raw, newPassword: accPassword },
    }),
    'Acceptera inbjudan',
  )
  const accHeaders = { Authorization: `Bearer ${await apiLogin(request, accEmail, accPassword)}` }

  return {
    owner: { email, password, headers },
    accountant: { email: accEmail, password: accPassword, headers: accHeaders },
    packageId: paket.id,
    sourceName,
    orgNumber,
    asOf: forfallo,
    kalla,
    mappning,
  }
}

async function oppnaPaket(page: Page, k: Kundstart) {
  await page.goto('/settings/kundstart')
  await page.getByText(k.sourceName).click()
  await expect(page.getByTestId('kundavstamning')).toBeVisible({ timeout: 15_000 })
}

/** OWNER laddar upp källa och mappning i UI:t. */
async function laddaUpp(page: Page, k: Kundstart) {
  const ladda = page.getByTestId('evidens-ladda')
  await ladda.getByLabel(/^Tidigare system/).fill('Syntetiskt e2e-system')
  await ladda.getByLabel(/^Företag i tidigare system/).fill('E2E-GAMMALT')
  await ladda.getByLabel(/^Källföretagets organisationsnummer/).fill(k.orgNumber)
  await ladda.getByLabel(/^Avstämningsdag/).fill(k.asOf)
  await ladda.getByLabel(/^När exporten togs ut/).fill(`${k.asOf}T18:00`)
  await ladda.getByLabel(/^Ansvarig för att exporten/).fill('Syntetisk ekonomichef')
  await ladda.getByLabel(/^Omfattning/).fill('Samtliga öppna kundfordringar per avstämningsdagen')
  await ladda.getByLabel('Reskontra ur tidigare system').setInputFiles({
    name: 'reskontra.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(k.kalla, 'utf8'),
  })
  await ladda.getByLabel('Mappning gammal kund och avtal till ny').setInputFiles({
    name: 'mappning.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(k.mappning, 'utf8'),
  })
  await ladda.getByRole('button', { name: 'Jämför och spara underlaget' }).click()
  await expect(page.getByTestId('evidens-status')).toBeVisible({ timeout: 15_000 })
}

async function granskareSida(
  browser: Browser,
  k: Kundstart,
  viewport?: { width: number; height: number },
) {
  const ctx = await browser.newContext(viewport ? { viewport } : {})
  const page = await ctx.newPage()
  await uiLogin(page, k.accountant.email, k.accountant.password)
  await oppnaPaket(page, k)
  return { ctx, page }
}

test.describe('KUNDSTART-205: kundavstämning före godkännande', () => {
  test('rätt kedja (desktop): OWNER laddar upp, ACCOUNTANT granskar, spärren släpper', async ({
    page,
    request,
    browser,
  }) => {
    const k = await seedKundstart(request, false)
    await uiLogin(page, k.owner.email, k.owner.password)
    await oppnaPaket(page, k)
    await expect(page.getByTestId('godkannande-sparr')).toContainText('Ingen kundavstämning')

    await laddaUpp(page, k)
    await expect(page.getByTestId('evidens-status')).toHaveAttribute('data-status', 'OK')
    await expect(page.getByText(/Syntetiskt e2e-system, företag E2E-GAMMALT/)).toBeVisible()
    await expect(page.getByTestId('godkannande-sparr')).toContainText(
      'ekonomigranskarens granskning',
    )
    // Ägaren kan inte granska sitt eget underlag.
    await expect(page.getByTestId('evidens-granska')).toHaveCount(0)

    const g = await granskareSida(browser, k)
    await expect(g.page.getByTestId('evidens-ladda')).toHaveCount(0)
    await g.page.getByTestId('evidens-granska').click()
    await expect(g.page.getByTestId('evidens-granskning')).toContainText('Granskad av dig')
    // Granskaren har ingen godkännandeknapp.
    await expect(g.page.getByRole('button', { name: 'Godkänn paketet' })).toHaveCount(0)
    await g.ctx.close()

    await page.reload()
    await page.getByText(k.sourceName).click()
    await expect(page.getByTestId('evidens-granskning')).toContainText(
      'Granskad av ekonomigranskaren',
    )
    await expect(page.getByTestId('godkannande-sparr')).toHaveCount(0)
    await page.getByRole('checkbox', { name: /granskat version/ }).check()
    await expect(page.getByRole('button', { name: 'Godkänn paketet' })).toBeEnabled()
  })

  test('fel kedja (desktop): lika total men fel kunder ger differens och stängd granskning', async ({
    page,
    request,
    browser,
  }) => {
    const k = await seedKundstart(request, true)
    await uiLogin(page, k.owner.email, k.owner.password)
    await oppnaPaket(page, k)
    await laddaUpp(page, k)
    await expect(page.getByTestId('evidens-status')).not.toHaveAttribute('data-status', 'OK')
    const tabell = page.getByTestId('evidens-avvikelser')
    await expect(tabell).toContainText('DOC-1')
    await expect(tabell).toContainText('DOC-2')
    await expect(page.getByTestId('evidens-atgard')).toBeVisible()
    await expect(page.getByTestId('godkannande-sparr')).toBeVisible()
    await page.getByRole('checkbox', { name: /granskat version/ }).check()
    await expect(page.getByRole('button', { name: 'Godkänn paketet' })).toBeDisabled()

    const g = await granskareSida(browser, k)
    await expect(g.page.getByTestId('evidens-granska')).toBeDisabled()
    await g.ctx.close()

    // Servern nekar granskning av en avvikande version även om klienten försöker.
    const lista = await unwrap<{ aktuell: { id: string; evidenceSha256: string } }>(
      await request.get(`${API}/kundstart/opening-packages/${k.packageId}/evidence`, {
        headers: k.accountant.headers,
      }),
      'Läs evidens',
    )
    const nekad = await request.post(
      `${API}/kundstart/opening-packages/${k.packageId}/evidence/${lista.aktuell.id}/review`,
      { headers: k.accountant.headers, data: { evidenceSha256: lista.aktuell.evidenceSha256 } },
    )
    expect(nekad.status()).toBe(409)
    expect(
      sqlValue(
        `SELECT count(*) FROM "OpeningEvidenceReview" WHERE "evidenceId" = '${lista.aktuell.id}'`,
      ),
    ).toBe('0')
  })

  test('390px: kundavstämningen och granskningen fungerar i mobilvy', async ({
    page,
    request,
    browser,
  }) => {
    await page.setViewportSize(MOBIL)
    const k = await seedKundstart(request, false)
    await uiLogin(page, k.owner.email, k.owner.password)
    await oppnaPaket(page, k)
    await laddaUpp(page, k)
    await expect(page.getByTestId('evidens-status')).toHaveAttribute('data-status', 'OK')
    const ruta = await page.getByTestId('kundavstamning').boundingBox()
    expect(ruta!.x + ruta!.width).toBeLessThanOrEqual(MOBIL.width)

    const g = await granskareSida(browser, k, MOBIL)
    const knapp = g.page.getByTestId('evidens-granska')
    const kb = await knapp.boundingBox()
    expect(kb!.x + kb!.width).toBeLessThanOrEqual(MOBIL.width)
    await knapp.click()
    await expect(g.page.getByTestId('evidens-granskning')).toContainText('Granskad av dig')
    await g.ctx.close()
  })

  test('direkta API-vägar: roller och serverns identitet gäller, inte klientens', async ({
    request,
  }) => {
    const k = await seedKundstart(request, false)
    const body = {
      sourceSystemProduct: 'Syntetiskt e2e-system',
      sourceCompanyKey: 'E2E-GAMMALT',
      scopeDeclaration: 'Samtliga öppna kundfordringar',
      sourceOrgNumber: k.orgNumber,
      sourceAsOfDate: k.asOf,
      sourceExportedAt: `${k.asOf}T18:00:00Z`,
      scopeResponsible: 'Syntetisk ekonomichef',
      sourceName: 'reskontra.csv',
      sourceContent: k.kalla,
      mappingName: 'mappning.csv',
      mappingContent: k.mappning,
    }
    const url = `${API}/kundstart/opening-packages/${k.packageId}/evidence`
    // ACCOUNTANT får inte skapa underlag.
    expect((await request.post(url, { headers: k.accountant.headers, data: body })).status()).toBe(
      403,
    )
    // Fel källföretag (orgnr) stoppas av servern.
    expect(
      (
        await request.post(url, {
          headers: k.owner.headers,
          data: { ...body, sourceOrgNumber: '000000-0000' },
        })
      ).status(),
    ).toBeGreaterThanOrEqual(400)
    const e = await unwrap<{ id: string; evidenceSha256: string; comparisonStatus: string }>(
      await request.post(url, { headers: k.owner.headers, data: body }),
      'Skapa evidens',
    )
    expect(e.comparisonStatus).toBe('OK')
    // OWNER kan inte granska; klientens reviewerId avvisas.
    expect(
      (
        await request.post(`${url}/${e.id}/review`, {
          headers: k.owner.headers,
          data: { evidenceSha256: e.evidenceSha256 },
        })
      ).status(),
    ).toBe(403)
    expect(
      (
        await request.post(`${url}/${e.id}/review`, {
          headers: k.accountant.headers,
          data: { evidenceSha256: e.evidenceSha256, reviewerId: 'någon-annan' },
        })
      ).status(),
    ).toBe(400)
    // ACCOUNTANT får inte godkänna.
    expect(
      (
        await request.post(`${API}/kundstart/opening-packages/${k.packageId}/approve`, {
          headers: k.accountant.headers,
          data: { version: 1, sourceSha256: 'a'.repeat(64), evidenceSha256: e.evidenceSha256 },
        })
      ).status(),
    ).toBe(403)
    // Ingen granskning har skapats av de nekade försöken.
    expect(
      sqlValue(`SELECT count(*) FROM "OpeningEvidenceReview" WHERE "evidenceId" = '${e.id}'`),
    ).toBe('0')
  })
})
