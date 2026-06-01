import type { APIRequestContext } from '@playwright/test'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'

/**
 * Provisionerar förutsättningarna för avi-flödet via det RIKTIGA API:t
 * (samma väg som appen använder) och returnerar inloggningsuppgifter.
 *
 * Varje körning skapar en HELT FÄRSK organisation (unik e-post) så att testet
 * är isolerat och idempotent — vi rör aldrig annan org-data och behöver ingen
 * separat test-DB. Kedjan som byggs upp:
 *
 *   Organisation → Fastighet → Enhet → Hyresgäst (+ kontrakt) → AKTIVT kontrakt
 *
 * Ett ACTIVE-kontrakt krävs för att "Generera avier" ska producera en avi
 * (AviseringService.generateMonthlyNotices filtrerar på status ACTIVE).
 */

const API = 'http://localhost:3000/v1'

export interface SeededOrg {
  email: string
  password: string
  /** Avtalad månadshyra (SEK, bostad → ingen moms → totalbelopp = denna). */
  monthlyRent: number
  /** Period (månad/år) som avin genereras för — se kommentar i seedActiveLease. */
  periodMonth: number
  periodYear: number
}

async function unwrap<T>(
  res: { ok(): boolean; status(): number; json(): Promise<unknown> },
  what: string,
): Promise<T> {
  const body = (await res.json()) as { success?: boolean; data?: T; error?: { message?: string } }
  if (!res.ok() || body?.success === false) {
    throw new Error(
      `${what} misslyckades (${res.status()}): ${body?.error?.message ?? JSON.stringify(body)}`,
    )
  }
  return body.data as T
}

export interface RegisteredOrg {
  email: string
  password: string
}

/**
 * Registrerar enbart en HELT FÄRSK organisation + ägare via API:t och returnerar
 * inloggningsuppgifter — ingen fastighet/enhet/kontrakt. Används av flöden som
 * bygger upp grunddatan via UI:t (och därför vill starta från en tom org).
 */
export async function registerOrg(request: APIRequestContext): Promise<RegisteredOrg> {
  const stamp = Date.now()
  const email = `e2e.landlord+${stamp}@eveno.test`
  const password = 'TestE2e123!'
  await unwrap(
    await request.post(`${API}/auth/register`, {
      data: {
        email,
        password,
        firstName: 'E2E',
        lastName: 'Hyresvärd',
        organizationName: `E2E Fastigheter ${stamp}`,
        acceptTerms: true,
      },
    }),
    'Registrering',
  )
  return { email, password }
}

export async function seedActiveLease(request: APIRequestContext): Promise<SeededOrg> {
  // Unik identitet per körning. (Date.now här är OK — vanlig Node-testkod.)
  const stamp = Date.now()
  const email = `e2e.landlord+${stamp}@eveno.test`
  const password = 'TestE2e123!'
  const monthlyRent = 10_000

  // Vi genererar avin för en period som ligger SÄKERT i det förflutna (två
  // månader bak). Då blir förfallodatumet garanterat passerat → avin visas
  // alltid som FÖRSENAD i UI, oavsett vilken dag testet körs. Det gör flödet
  // deterministiskt och låter oss markera betald direkt (knappen "Markera
  // betald" visas för SENT/OVERDUE) utan att behöva gå via den asynkrona
  // skicka-vägen (Puppeteer-PDF i Bull-worker), som vore onödigt flaky här.
  const now = new Date()
  const period = new Date(now.getFullYear(), now.getMonth() - 2, 1)
  const periodMonth = period.getMonth() + 1
  const periodYear = period.getFullYear()
  // Kontraktet startar första dagen i perioden → aktivt hela månaden, full hyra.
  const leaseStartDate = `${periodYear}-${String(periodMonth).padStart(2, '0')}-01`

  // 1) Registrera organisation + ägare → access token
  const auth = await unwrap<{ accessToken: string }>(
    await request.post(`${API}/auth/register`, {
      data: {
        email,
        password,
        firstName: 'E2E',
        lastName: 'Hyresvärd',
        organizationName: `E2E Fastigheter ${stamp}`,
        acceptTerms: true,
      },
    }),
    'Registrering',
  )
  const headers = { Authorization: `Bearer ${auth.accessToken}` }

  // 2) Fastighet
  const property = await unwrap<{ id: string }>(
    await request.post(`${API}/properties`, {
      headers,
      data: {
        name: 'E2E Storgatan 1',
        propertyDesignation: 'Stockholm E2E 1:1',
        type: 'RESIDENTIAL',
        address: { street: 'Storgatan 1', city: 'Stockholm', postalCode: '111 22' },
        totalArea: 500,
      },
    }),
    'Skapa fastighet',
  )

  // 3) Enhet (ledig — aktivering av kontraktet sätter den till OCCUPIED)
  const unit = await unwrap<{ id: string }>(
    await request.post(`${API}/units`, {
      headers,
      data: {
        propertyId: property.id,
        name: 'Lägenhet 1A',
        unitNumber: '1001',
        type: 'APARTMENT',
        status: 'VACANT',
        area: 65,
        monthlyRent,
      },
    }),
    'Skapa enhet',
  )

  // 4) Hyresgäst + kontrakt (skapas som DRAFT)
  await unwrap(
    await request.post(`${API}/tenants`, {
      headers,
      data: {
        type: 'INDIVIDUAL',
        firstName: 'Test',
        lastName: 'Hyresgäst',
        email: `e2e.tenant+${stamp}@eveno.test`,
        lease: { unitId: unit.id, startDate: leaseStartDate, monthlyRent },
      },
    }),
    'Skapa hyresgäst + kontrakt',
  )

  // 5) Hämta kontraktet (färsk org → exakt ett) och aktivera det (DRAFT → ACTIVE)
  const leases = await unwrap<Array<{ id: string }>>(
    await request.get(`${API}/leases`, { headers }),
    'Hämta kontrakt',
  )
  const lease = leases[0]
  if (!lease) throw new Error('Inget kontrakt skapades för seed-organisationen')

  // Aktivera via DB (DRAFT → ACTIVE) i stället för API. DETERMINISTISKT VAL:
  // API-aktiveringen köar en Puppeteer-kontrakts-PDF som failar + retrear 5×
  // (R2-lagring ej konfigurerad i dev) och mättar CPU → flaky svit. Avi-flödet
  // testar inte aktiveringen (det gör create-base-data via UI), så vi flippar
  // statusen direkt. Ett ACTIVE-kontrakt räcker för att generera avier.
  runSql(`UPDATE "Lease" SET status = 'ACTIVE' WHERE id = '${lease.id}';`)

  return { email, password, monthlyRent, periodMonth, periodYear }
}

// ── Portal (hyresgäst-sidan) ──────────────────────────────────────────────────

// Dev-databasen som API:t kör mot (apps/api/.env). Vi behöver direkt DB-access
// för EN sak: sätta aktiverings-token-hashen på hyresgästen. Aktiveringstoken
// genereras som randomBytes och bara dess SHA-256-hash lagras — råtoken finns
// annars enbart i välkomstmejlet, som vi inte kan läsa i ett E2E-test. Genom
// att skriva hashen själva kan vi sedan anropa det RIKTIGA /activate-endpointet
// (som i sin tur bcrypt:ar lösenordet) och få en hyresgäst som kan logga in.
const DB = { host: 'localhost', user: 'eken', database: 'eken_dev', password: 'eken' }

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function runSql(sql: string): void {
  execFileSync(
    'psql',
    ['-h', DB.host, '-U', DB.user, '-d', DB.database, '-v', 'ON_ERROR_STOP=1', '-c', sql],
    {
      env: { ...process.env, PGPASSWORD: DB.password },
      stdio: 'pipe',
    },
  )
}

export interface PortalTenant {
  /** Hyresgästens portal-inloggning. */
  email: string
  password: string
  /** Belopp på den avi som sås och markeras betald (visas i portalen). */
  noticeAmount: number
}

/**
 * Sår en hyresgäst som kan logga in i portalen OCH har en synlig hyresavi.
 *
 * Portalen autentiserar annorlunda än admin: inget lösenord sätts vid
 * kontraktsskapande — hyresgästen aktiverar sitt konto via en länk i
 * välkomstmejlet. Vi kortsluter det deterministiskt (se DB-kommentaren ovan):
 * skriv token-hash → anropa /activate. Avin måste ha status SENT/PAID/OVERDUE
 * för att synas i portalen (`getRentNotices`-filtret) — vi markerar den BETALD
 * via admin-API:t, vilket är deterministiskt och slipper den asynkrona
 * skicka-vägen (Puppeteer-PDF i en Bull-worker).
 */
export async function seedPortalTenant(request: APIRequestContext): Promise<PortalTenant> {
  const stamp = Date.now()
  const adminEmail = `e2e.landlord+${stamp}@eveno.test`
  const adminPassword = 'TestE2e123!'
  const tenantEmail = `e2e.tenant+${stamp}@eveno.test`
  const tenantPassword = 'TestE2e123!'
  const monthlyRent = 10_000

  const now = new Date()
  const month = now.getMonth() + 1
  const year = now.getFullYear()
  const leaseStartDate = `${year}-${String(month).padStart(2, '0')}-01`

  // 1) Org + admin-token
  const auth = await unwrap<{ accessToken: string }>(
    await request.post(`${API}/auth/register`, {
      data: {
        email: adminEmail,
        password: adminPassword,
        firstName: 'E2E',
        lastName: 'Hyresvärd',
        organizationName: `E2E Fastigheter ${stamp}`,
        acceptTerms: true,
      },
    }),
    'Registrering',
  )
  const headers = { Authorization: `Bearer ${auth.accessToken}` }

  // 2) Fastighet → enhet → hyresgäst (+ kontrakt) → aktivt kontrakt
  const property = await unwrap<{ id: string }>(
    await request.post(`${API}/properties`, {
      headers,
      data: {
        name: 'E2E Storgatan 1',
        propertyDesignation: 'Stockholm E2E 1:1',
        type: 'RESIDENTIAL',
        address: { street: 'Storgatan 1', city: 'Stockholm', postalCode: '111 22' },
        totalArea: 500,
      },
    }),
    'Skapa fastighet',
  )
  const unit = await unwrap<{ id: string }>(
    await request.post(`${API}/units`, {
      headers,
      data: {
        propertyId: property.id,
        name: 'Lägenhet 1A',
        unitNumber: '1001',
        type: 'APARTMENT',
        status: 'VACANT',
        area: 65,
        monthlyRent,
      },
    }),
    'Skapa enhet',
  )
  await unwrap(
    await request.post(`${API}/tenants`, {
      headers,
      data: {
        type: 'INDIVIDUAL',
        firstName: 'Test',
        lastName: 'Hyresgäst',
        email: tenantEmail,
        lease: { unitId: unit.id, startDate: leaseStartDate, monthlyRent },
      },
    }),
    'Skapa hyresgäst + kontrakt',
  )
  const leases = await unwrap<Array<{ id: string }>>(
    await request.get(`${API}/leases`, { headers }),
    'Hämta kontrakt',
  )
  const lease = leases[0]
  if (!lease) throw new Error('Inget kontrakt skapades för seed-organisationen')

  // Hyresgästens id (för DB-skrivningar)
  const tenants = await unwrap<Array<{ id: string; email: string }>>(
    await request.get(`${API}/tenants`, { headers }),
    'Hämta hyresgäster',
  )
  const tenant = tenants.find((t) => t.email === tenantEmail)
  if (!tenant) throw new Error('Hyresgästen hittades inte efter skapande')

  // 3) Aktivera kontraktet via DB (status DRAFT → ACTIVE) i stället för
  //    /leases/:id/status. DETERMINISTISKT VAL: API-aktiveringen köar tunga
  //    bakgrundsjobb (Puppeteer-kontrakts-PDF som dessutom failar + retrear 5×
  //    eftersom R2-lagring inte är konfigurerad i dev) som mättar CPU och gör
  //    HELA sviten flaky. Portal-flödet testar hyresgäst-sidan, inte
  //    kontrakts-aktiveringen, så vi flippar statusen direkt. Ett ACTIVE-
  //    kontrakt räcker för att generera avi och för portalens /lease + avier.
  runSql(`UPDATE "Lease" SET status = 'ACTIVE' WHERE id = '${lease.id}';`)

  // 4) Generera avi för innevarande månad och markera den BETALD → status PAID,
  //    vilket gör att den syns i portalen (getRentNotices filtrerar på
  //    SENT/PAID/OVERDUE). Generate renderar ingen PDF.
  await unwrap(
    await request.post(`${API}/avisering/generate`, { headers, data: { month, year } }),
    'Generera avi',
  )
  const notices = await unwrap<Array<{ id: string }>>(
    await request.get(`${API}/avisering?month=${month}&year=${year}`, { headers }),
    'Hämta avier',
  )
  const notice = notices[0]
  if (!notice) throw new Error('Ingen avi genererades för kontraktet')
  await unwrap(
    await request.patch(`${API}/avisering/${notice.id}/paid`, {
      headers,
      data: { paidAmount: monthlyRent, paymentMethod: 'BANK' },
    }),
    'Markera avi betald',
  )

  // 5) Aktivera portal-kontot: skriv token-hash i DB, anropa sedan /activate.
  const activationToken = randomBytes(32).toString('hex')
  runSql(
    `UPDATE "Tenant" SET "activationTokenHash" = '${sha256(activationToken)}', ` +
      `"activationTokenExpiresAt" = now() + interval '1 day', "portalActivated" = false ` +
      `WHERE id = '${tenant.id}';`,
  )
  await unwrap(
    await request.post(`${API}/tenant-portal/activate`, {
      data: { token: activationToken, password: tenantPassword, signatureName: 'Test Hyresgäst' },
    }),
    'Aktivera portalkonto',
  )

  return { email: tenantEmail, password: tenantPassword, noticeAmount: monthlyRent }
}
