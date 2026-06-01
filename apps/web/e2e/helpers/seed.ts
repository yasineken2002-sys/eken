import type { APIRequestContext } from '@playwright/test'

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

  await unwrap(
    await request.patch(`${API}/leases/${lease.id}/status`, {
      headers,
      data: { status: 'ACTIVE' },
    }),
    'Aktivera kontrakt',
  )

  return { email, password, monthlyRent, periodMonth, periodYear }
}
