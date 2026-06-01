import { test, expect, type APIRequestContext } from '@playwright/test'
import { execFileSync } from 'node:child_process'

/**
 * Bevistest: HYRESAVI-PDF ska genereras korrekt EXAKT varje gång — 50 av 50.
 *
 * Bakgrund (PDF-utredningen): avi-PDF har en DETERMINISTISK väg utan
 * Bull/R2/mejl. GET /avisering/:id/pdf renderar PDF:en on-the-fly (Puppeteer)
 * och returnerar bufferten direkt. Vi undviker hela det flaky async-flödet:
 *
 *   1. Bygg grunddata och aktivera leasen via direkt DB-UPDATE (status=ACTIVE)
 *      — exakt som e2e/helpers/seed.ts gör. Det hoppar över lease-activation-
 *      kön, vars kontrakts-PDF-jobb annars failar + retrear 5× i dev (saknad
 *      R2). Avi-flödet självt rör varken R2 eller mejl.
 *   2. POST /avisering/generate (SYNKRONT) — skapar avin (RentNotice, PENDING).
 *   3. GET /avisering/:id/pdf (SYNKRONT) — renderar PDF:en.
 *
 * Detta täcker RentNotice-grenen som bankavstämnings-testet INTE täckte.
 *
 * VARJE iteration verifieras på riktigt — inte bara HTTP 200, utan att en
 * GILTIG, icke-tom PDF faktiskt genererades:
 *   • status 200
 *   • Content-Type: application/pdf
 *   • magiska byten %PDF i början
 *   • %%EOF i slutet (PDF:en är komplett, inte trunkerad)
 *   • rimlig storlek (> 1 KB — en tom/misslyckad render fångas)
 *
 * RATE-LIMIT / PACING (medvetet, permanent inbyggt): API:t rate-limitar
 * (THROTTLE_LIMIT=100 req / THROTTLE_TTL=60s). Flödet gör 2 HTTP-anrop per
 * iteration (~106 totalt). `paced()` håller en minsta lucka (MIN_GAP_MS) mellan
 * varje anrop — pacingen sitter i request-hjälparen så den inte kan kringgås.
 * Aldrig @SkipThrottle (skulle försvaga prod-skyddet). En fräsch API-instans
 * (egen port via E2E_API → tom throttle-räknare) plus pacingen gör att det är
 * FLÖDET vi mäter, inte rate-limitern.
 *
 * OBS kallstart: PdfService lat-initierar Chromium vid första renderingen
 * (~26 s uppmätt — se issue #57). Iteration 1 absorberar den; därför stor
 * test-timeout. Det är ett prestanda-/robusthetsspår, inte ett fel i flödet.
 */

const API = process.env.E2E_API ?? 'http://localhost:3000/v1'
const N = 50

// Minsta lucka mellan HTTP-anrop. 950 ms ⇒ ≤ ~63 anrop/60s, klart under 100/60s.
const MIN_GAP_MS = 950

// Dev-databasen som API:t kör mot (apps/api/.env). Samma uppgifter som seed.ts.
const DB = { host: 'localhost', user: 'eken', database: 'eken_dev', password: 'eken' }

interface PdfResult {
  i: number
  month: number
  year: number
  ok: boolean
  /** true om avin skapades men PDF:en blev ogiltig/tom (får ALDRIG hända). */
  invalidPdf: boolean
  bytes: number
  reason: string | null
}

// ── Pacing: en delad klocka så att inga anrop kommer tätare än MIN_GAP_MS ──────
let lastReqAt = 0
async function paced<T>(fn: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const wait = Math.max(0, lastReqAt + MIN_GAP_MS - now)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastReqAt = Date.now()
  return fn()
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
  const res = await paced(() =>
    request.post(`${API}${path}`, { data, ...(headers ? { headers } : {}) }),
  )
  return { status: res.status(), body: (await res.json()) as never }
}

// ── DB-access (psql) — för lease-aktivering + slutkontroll, ej throttlat ───────
function runSql(sql: string): string {
  return execFileSync(
    'psql',
    ['-h', DB.host, '-U', DB.user, '-d', DB.database, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { env: { ...process.env, PGPASSWORD: DB.password }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
    .toString()
    .trim()
}

const is2xx = (s: number) => s >= 200 && s < 300

/** Validerar att en buffer är en komplett, icke-tom PDF. */
function validatePdf(buffer: Buffer): { ok: boolean; reason: string | null } {
  if (buffer.length < 1024) return { ok: false, reason: `för liten PDF (${buffer.length} byte)` }
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return {
      ok: false,
      reason: `saknar %PDF-header (börjar med "${buffer.subarray(0, 8).toString('latin1')}")`,
    }
  }
  // PDF:er avslutas med %%EOF (ev. följt av newline) — bevisar att filen inte
  // trunkerats mitt i renderingen.
  if (!buffer.subarray(-1024).toString('latin1').includes('%%EOF')) {
    return { ok: false, reason: 'saknar %%EOF (trunkerad PDF)' }
  }
  return { ok: true, reason: null }
}

test('hyresavi-PDF: 50 avier genererar var sin giltiga PDF', async ({ playwright }) => {
  test.setTimeout(600_000)
  const request = await playwright.request.newContext()
  const stamp = Date.now()

  // ── Förberedelse: org + fastighet + enhet + hyresgäst (inte det som testas) ──
  const reg = await postJson<{ accessToken: string }>(request, '/auth/register', {
    email: `e2e.avipdf50x+${stamp}@eveno.test`,
    password: 'TestE2e123!',
    firstName: 'E2E',
    lastName: 'AviPdf',
    organizationName: `E2E AviPdf 50x ${stamp}`,
    acceptTerms: true,
  })
  expect(is2xx(reg.status), `org-registrering (status ${reg.status})`).toBe(true)
  const token = reg.body.data!.accessToken
  const headers = { Authorization: `Bearer ${token}` }
  const orgId = (
    JSON.parse(Buffer.from(token.split('.')[1]!, 'base64').toString()) as { organizationId: string }
  ).organizationId

  const prop = await postJson<{ id: string }>(
    request,
    '/properties',
    {
      name: 'E2E AviPdf Fastighet',
      propertyDesignation: 'Stockholm AviPdf 1:1',
      type: 'RESIDENTIAL',
      address: { street: 'Storgatan 1', city: 'Stockholm', postalCode: '111 22' },
      totalArea: 5000,
    },
    headers,
  )
  expect(is2xx(prop.status), `skapa fastighet (status ${prop.status})`).toBe(true)

  // APARTMENT (bostad) ⇒ momsfri ⇒ totalbelopp = hyra (deterministiskt).
  const unit = await postJson<{ id: string }>(
    request,
    '/units',
    {
      propertyId: prop.body.data!.id,
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

  // Hyresgäst + DRAFT-kontrakt. startDate långt bak ⇒ aktivt under alla 50
  // perioder (2022-01 … 2026-02) så generate alltid producerar en avi.
  const tenant = await postJson<{ id: string }>(
    request,
    '/tenants',
    {
      type: 'INDIVIDUAL',
      firstName: 'Test',
      lastName: 'Hyresgäst',
      email: `e2e.avipdf.tenant+${stamp}@eveno.test`,
      lease: { unitId: unit.body.data!.id, startDate: '2020-01-01', monthlyRent: 10_000 },
    },
    headers,
  )
  expect(is2xx(tenant.status), `skapa hyresgäst (status ${tenant.status})`).toBe(true)
  const leasesRes = await paced(() => request.get(`${API}/leases`, { headers }))
  const leaseId = ((await leasesRes.json()) as { data: Array<{ id: string }> }).data[0]!.id

  // Aktivera leasen via DB (DRAFT → ACTIVE). DETERMINISTISKT VAL: API-aktivering
  // köar en Puppeteer-kontrakts-PDF som failar + retrear 5× (R2 ej i dev) och
  // mättar CPU. Avi-flödet testar inte aktiveringen, så vi flippar statusen
  // direkt — exakt som e2e/helpers/seed.ts. Ett ACTIVE-kontrakt räcker.
  runSql(`UPDATE "Lease" SET status = 'ACTIVE' WHERE id = '${leaseId}';`)
  const leaseStatus = runSql(`SELECT status FROM "Lease" WHERE id = '${leaseId}';`)
  expect(leaseStatus, 'leasen är ACTIVE efter DB-UPDATE').toBe('ACTIVE')

  // ── Flödet som testas: 50× generera avi → rendera + verifiera PDF ────────────
  const results: PdfResult[] = []

  for (let i = 1; i <= N; i++) {
    // Distinkt månad per iteration: 2022-01 … 2026-02 (50 på varandra följande).
    const idx = i - 1
    const year = 2022 + Math.floor(idx / 12)
    const month = (idx % 12) + 1

    try {
      const gen = await postJson<{
        created: number
        skipped: number
        notices: Array<{ id: string }>
      }>(request, '/avisering/generate', { month, year }, headers)
      if (!is2xx(gen.status)) throw new Error(`generate misslyckades (status ${gen.status})`)
      const noticeId = gen.body.data?.notices[0]?.id
      if (!noticeId) {
        throw new Error(
          `ingen avi skapades (created=${gen.body.data?.created}, skipped=${gen.body.data?.skipped})`,
        )
      }

      // GET PDF — renderas on-the-fly. body() ger råbufferten.
      const pdfRes = await paced(() => request.get(`${API}/avisering/${noticeId}/pdf`, { headers }))
      const status = pdfRes.status()
      const contentType = pdfRes.headers()['content-type'] ?? ''
      const buffer = await pdfRes.body()

      const checks: string[] = []
      if (status !== 200) checks.push(`status=${status} (väntat 200)`)
      if (!contentType.includes('application/pdf')) {
        checks.push(`content-type="${contentType}" (väntat application/pdf)`)
      }
      const pdfCheck = validatePdf(buffer)
      const invalidPdf = !pdfCheck.ok
      if (invalidPdf) checks.push(pdfCheck.reason!)

      results.push({
        i,
        month,
        year,
        ok: checks.length === 0,
        invalidPdf,
        bytes: buffer.length,
        reason: checks.length ? checks.join('; ') : null,
      })
    } catch (err) {
      results.push({
        i,
        month,
        year,
        ok: false,
        invalidPdf: false,
        bytes: 0,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ── Org-scopad slutkontroll: exakt N hyresavier (RENT) skapades ──────────────
  const noticeCount = Number(
    runSql(`SELECT count(*) FROM "RentNotice" WHERE "organizationId"='${orgId}' AND type='RENT';`),
  )

  // ── Rapport ──────────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)
  const invalidPdfs = results.filter((r) => r.invalidPdf)
  const avgBytes = Math.round(
    results.filter((r) => r.bytes > 0).reduce((s, r) => s + r.bytes, 0) /
      Math.max(1, results.filter((r) => r.bytes > 0).length),
  )

  // eslint-disable-next-line no-console
  console.log(
    `\n──────── RESULTAT: hyresavi-PDF (generera + rendera) ────────\n` +
      `Försök:                ${N}\n` +
      `Lyckade (giltig PDF):  ${passed}\n` +
      `Misslyckade:           ${failed.length}\n` +
      `Ogiltig/tom PDF:       ${invalidPdfs.length}   (måste vara 0)\n` +
      `Avier i DB (org):      ${noticeCount}   (väntat ${N})\n` +
      `Genomsnittlig storlek: ${avgBytes} byte\n` +
      (failed.length > 0
        ? `Fel:\n${failed.map((f) => `  #${f.i} (${f.year}-${String(f.month).padStart(2, '0')}): ${f.reason}`).join('\n')}\n`
        : `Inga fel.\n`) +
      `─────────────────────────────────────────────────────────────\n`,
  )

  await request.dispose()

  // ── Hård validering ──────────────────────────────────────────────────────────
  expect(invalidPdfs, 'INGEN avi genererade en ogiltig/tom PDF').toEqual([])
  expect(failed, 'inga misslyckade PDF-genereringar').toEqual([])
  expect(passed, `alla ${N} avier gav en giltig PDF`).toBe(N)
  expect(noticeCount, `exakt ${N} hyresavier i DB`).toBe(N)
})
