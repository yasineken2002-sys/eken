import { test, expect, type APIRequestContext } from '@playwright/test'

/**
 * Bevistest: skapandet av hyresgäst (+ hyreskontrakt) ska lyckas EXAKT varje
 * gång — 50 av 50. Kör mot den LEVANDE stacken (NestJS → Prisma → Postgres) via
 * samma endpoint som UI:t använder (POST /v1/tenants, som skapar hyresgäst + ett
 * DRAFT-kontrakt mot enheten). Varje iteration har unik e-post; kontraktet
 * verifieras dessutom mot DB (GET /leases + GET /tenants ska vara 50).
 *
 * RATE-LIMIT / PACING (medvetet val): API:t rate-limitar (100 req/IP/60s globalt,
 * 5 registreringar/IP/60s). Vi PACE:ar därför anropen (~1,2 s mellan) i stället
 * för att stänga av throttlern. Alternativet — @SkipThrottle på tenants-/units-
 * endpointen — hade krävt att försvaga rate-limit-skyddet i PRODUKTIONS-koden
 * bara för testets skull, vilket vore fel. Pacing är test-only, rör ingen
 * prod-kod och testar den RIKTIGA endpointen med skyddet intakt. Ett enda fräscht
 * API (som i CI, eller via E2E_API mot en egen port) startar med tom throttle-
 * räknare; pacingen håller oss under gränsen även mot en delad/varm :3000.
 */

// Pekas mot en isolerad dev-API-instans (egen port → egen, tom throttle-räknare)
// via E2E_API; faller annars tillbaka på standard-dev-API:t.
const API = process.env.E2E_API ?? 'http://localhost:3000/v1'
const N = 50

interface Result {
  i: number
  ok: boolean
  status: number
  tenantId: string | null
  error: string | null
}

async function postJson<T>(
  request: APIRequestContext,
  path: string,
  data: unknown,
  headers?: Record<string, string>,
): Promise<{
  status: number
  body: { success?: boolean; data?: T; error?: { message?: string } }
}> {
  const res = await request.post(`${API}${path}`, { data, ...(headers ? { headers } : {}) })
  return { status: res.status(), body: (await res.json()) as never }
}

test('skapa hyresgäst + kontrakt 50 gånger — alla 50 ska lyckas', async ({ playwright }) => {
  test.setTimeout(180_000)
  const request = await playwright.request.newContext()
  const stamp = Date.now()

  // ── Förberedelse: org + fastighet (inte det som testas) ─────────────────────
  const reg = await postJson<{ accessToken: string }>(request, '/auth/register', {
    email: `e2e.50x+${stamp}@eveno.test`,
    password: 'TestE2e123!',
    firstName: 'E2E',
    lastName: 'Hyresvärd',
    organizationName: `E2E 50x ${stamp}`,
    acceptTerms: true,
  })
  const is2xx = (s: number) => s >= 200 && s < 300
  expect(is2xx(reg.status), `org-registrering (status ${reg.status})`).toBe(true)
  const token = reg.body.data!.accessToken
  const headers = { Authorization: `Bearer ${token}` }

  const prop = await postJson<{ id: string }>(
    request,
    '/properties',
    {
      name: 'E2E 50x Fastighet',
      propertyDesignation: 'Stockholm 50x 1:1',
      type: 'RESIDENTIAL',
      address: { street: 'Storgatan 1', city: 'Stockholm', postalCode: '111 22' },
      totalArea: 5000,
    },
    headers,
  )
  expect(is2xx(prop.status), `skapa fastighet (status ${prop.status})`).toBe(true)
  const propertyId = prop.body.data!.id

  // En enhet räcker — hyresgäst-skapandet lägger ett DRAFT-kontrakt mot enheten,
  // och flera DRAFT-kontrakt på samma enhet är tillåtet (bara ACTIVE är unikt).
  // Det halverar antalet requests så vi håller oss under throttle-gränsen.
  const unit = await postJson<{ id: string }>(
    request,
    '/units',
    {
      propertyId,
      name: 'Lägenhet 1',
      unitNumber: '1001',
      type: 'APARTMENT',
      status: 'VACANT',
      area: 65,
      monthlyRent: 10_000,
    },
    headers,
  )
  expect(is2xx(unit.status), `skapa enhet (status ${unit.status})`).toBe(true)
  const unitId = unit.body.data!.id

  // ── Flödet som testas: skapa hyresgäst (+ kontrakt) 50 gånger ───────────────
  // Pacing: API:t rate-limitar (100 req/60s per IP). ~1,2s mellan anrop håller
  // oss tryggt under gränsen så att det är FLÖDET vi mäter, inte rate-limitern.
  const results: Result[] = []

  for (let i = 1; i <= N; i++) {
    const tenant = await postJson<{ id: string }>(
      request,
      '/tenants',
      {
        type: 'INDIVIDUAL',
        firstName: 'Test',
        lastName: `Hyresgäst ${i}`,
        email: `e2e.tenant.${i}+${stamp}@eveno.test`,
        lease: { unitId, startDate: '2026-06-01', monthlyRent: 10_000 },
      },
      headers,
    )
    const ok = is2xx(tenant.status) && tenant.body.success !== false && !!tenant.body.data?.id
    results.push({
      i,
      ok,
      status: tenant.status,
      tenantId: tenant.body.data?.id ?? null,
      error: ok ? null : (tenant.body.error?.message ?? `oväntad status ${tenant.status}`),
    })
    if (i < N) await new Promise((r) => setTimeout(r, 1200))
  }

  // ── Bevis: räkna utfall ─────────────────────────────────────────────────────
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)

  // Verifiera mot databasen att kontraktet skapades varje gång.
  const leasesRes = await request.get(`${API}/leases`, { headers })
  const leases = ((await leasesRes.json()) as { data?: unknown[] }).data ?? []
  const tenantsRes = await request.get(`${API}/tenants`, { headers })
  const tenants = ((await tenantsRes.json()) as { data?: unknown[] }).data ?? []

  // eslint-disable-next-line no-console
  console.log(
    `\n──────── RESULTAT: skapa hyresgäst + kontrakt ────────\n` +
      `Försök:           ${N}\n` +
      `Lyckades:         ${passed}\n` +
      `Misslyckades:     ${failed.length}\n` +
      `Hyresgäster i DB: ${tenants.length}\n` +
      `Kontrakt i DB:    ${leases.length}\n` +
      (failed.length > 0
        ? `Fel:\n${failed.map((f) => `  #${f.i} (status ${f.status}): ${f.error}`).join('\n')}\n`
        : `Inga fel.\n`) +
      `──────────────────────────────────────────────────────\n`,
  )

  await request.dispose()

  // Hård validering: exakt 50/50, och DB bekräftar 50 hyresgäster + 50 kontrakt.
  expect(failed, 'inga misslyckade skapanden').toEqual([])
  expect(passed, 'alla 50 lyckades').toBe(N)
  expect(tenants.length, '50 hyresgäster i DB').toBe(N)
  expect(leases.length, '50 kontrakt i DB').toBe(N)
})
