import { test, expect, type APIRequestContext } from '@playwright/test'
import { execFileSync } from 'node:child_process'

/**
 * Bevistest: BANKAVSTÄMNING (auto-matchning av bankbetalning → faktura).
 *
 * Kör mot den LEVANDE stacken (NestJS → Prisma → Postgres) via exakt samma
 * endpoints som UI:t/AI-toolen använder:
 *
 *   POST /v1/invoices                 (skapa faktura, OCR auto-genereras)
 *   PATCH /v1/invoices/:id/status     (DRAFT → SENT, synkron state machine)
 *   POST /v1/reconciliation/import    (ladda upp bank-CSV → auto-matchar inline)
 *
 * 50 gånger skapas en faktura med KÄNT OCR + belopp, en bankbetalning som
 * matchar (rätt OCR + belopp) matas in, och VARJE gång verifieras utfallet
 * MOT DATABASEN — inte bara ett 200-svar:
 *
 *   1. Fakturan blev PAID (status + paidAt satt).
 *   2. Banktransaktionen blev MATCHED och länkades till RÄTT faktura
 *      (BankTransaction.invoiceId === just denna iterations faktura — aldrig
 *      en annan), och INTE till någon hyresavi (matchedRentNoticeId IS NULL).
 *   3. Verifikatet (JournalEntry, source=PAYMENT) skapades korrekt och balanserar:
 *      1930 Företagskonto  DEBET  = beloppet
 *      1510 Kundfordringar KREDIT = beloppet
 *
 * NEGATIVT FALL (måste alltid hålla): en betalning med FEL OCR och ett belopp
 * som ingen faktura har får ALDRIG matchas. En "lock"-faktura (SENT, obetald,
 * OCR en siffra från den felaktiga) ska förbli SENT — beviset att fel OCR inte
 * råkar matchas mot fel faktura.
 *
 * RATE-LIMIT / PACING (medvetet, permanent inbyggt): API:t rate-limitar
 * (THROTTLE_LIMIT=100 req / THROTTLE_TTL=60s per användare/IP). Flödet gör 3
 * HTTP-anrop per iteration (~153 totalt). Vi PACE:ar därför varje anrop med en
 * minsta lucka (MIN_GAP_MS) i `paced()` nedan — pacingen sitter i request-
 * hjälparen så att den inte kan kringgås och håller oss tryggt under gränsen.
 * Alternativet — @SkipThrottle på endpointen — hade krävt att försvaga rate-
 * limit-skyddet i PRODUKTIONS-koden bara för testets skull, vilket vore fel.
 * En fräsch API-instans (egen port via E2E_API → tom throttle-räknare) plus
 * pacingen gör att det är FLÖDET vi mäter, inte rate-limitern.
 *
 * DB-verifieringen sker via psql (samma mönster som e2e/helpers/seed.ts) — den
 * belastar inte throttlern och ger bevis på rad-nivå, inte bara via API-svar.
 */

// Pekas mot en isolerad dev-API-instans (egen port → egen, tom throttle-räknare)
// via E2E_API; faller annars tillbaka på standard-dev-API:t.
const API = process.env.E2E_API ?? 'http://localhost:3000/v1'
const N = 50

// Minsta lucka mellan HTTP-anrop. 950 ms ⇒ ≤ ~63 anrop/60s, klart under 100/60s.
const MIN_GAP_MS = 950

// Dev-databasen som API:t kör mot (apps/api/.env). Samma uppgifter som seed.ts.
const DB = { host: 'localhost', user: 'eken', database: 'eken_dev', password: 'eken' }

interface MatchResult {
  i: number
  ok: boolean
  reason: string | null
  /** true om betalningen länkades till FEL faktura (får ALDRIG inträffa). */
  wrongInvoice: boolean
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

async function patchJson<T>(
  request: APIRequestContext,
  path: string,
  data: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; body: { success?: boolean; data?: T } }> {
  const res = await paced(() => request.patch(`${API}${path}`, { data, headers }))
  return { status: res.status(), body: (await res.json()) as never }
}

/** Laddar upp en bank-CSV (fält "statement") och returnerar import-resultatet. */
async function importCsv(
  request: APIRequestContext,
  csv: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: { success?: boolean; data?: { autoMatched: number } } }> {
  const res = await paced(() =>
    request.post(`${API}/reconciliation/import`, {
      headers,
      multipart: {
        statement: {
          name: 'statement.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from(csv, 'utf-8'),
        },
      },
    }),
  )
  return { status: res.status(), body: (await res.json()) as never }
}

// ── DB-access (psql, tuples-only, |-separerat) ────────────────────────────────
function queryRow(sql: string): string[] {
  const out = execFileSync(
    'psql',
    [
      '-h',
      DB.host,
      '-U',
      DB.user,
      '-d',
      DB.database,
      '-tA',
      '-F',
      '|',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { env: { ...process.env, PGPASSWORD: DB.password }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
    .toString()
    .trim()
  if (out === '') return []
  return out.split('\n')[0]!.split('|')
}

const is2xx = (s: number) => s >= 200 && s < 300

// En GENERIC bank-CSV med en rad: OCR i Referens-kolumnen, belopp i Belopp.
// Beskrivningen görs globalt unik (stamp + tagg) så att (a) duplikatkontrollen
// (org, datum, beskrivning, belopp) aldrig slår till och (b) vi entydigt kan
// slå upp just denna transaktion i DB.
function bankCsv(desc: string, amount: number, ocr: string): string {
  return `Datum;Text;Belopp;Referens\n2026-06-15;${desc};${amount.toFixed(2)};${ocr}\n`
}

test('bankavstämning: 50 betalningar matchas mot rätt faktura + korrekt verifikat', async ({
  playwright,
}) => {
  test.setTimeout(600_000)
  const request = await playwright.request.newContext()
  const stamp = Date.now()

  // ── Förberedelse: org + fastighet + enhet + hyresgäst (inte det som testas) ──
  const reg = await postJson<{ accessToken: string }>(request, '/auth/register', {
    email: `e2e.recon50x+${stamp}@eveno.test`,
    password: 'TestE2e123!',
    firstName: 'E2E',
    lastName: 'Bankavstämning',
    organizationName: `E2E Recon 50x ${stamp}`,
    acceptTerms: true,
  })
  expect(is2xx(reg.status), `org-registrering (status ${reg.status})`).toBe(true)
  const token = reg.body.data!.accessToken
  const headers = { Authorization: `Bearer ${token}` }
  // organizationId ur JWT → används för org-scopade DB-assertions (OCR-serien
  // 0000001x återanvänds av andra test-orgar i den delade eken_dev).
  const orgId = (
    JSON.parse(Buffer.from(token.split('.')[1]!, 'base64').toString()) as { organizationId: string }
  ).organizationId

  const prop = await postJson<{ id: string }>(
    request,
    '/properties',
    {
      name: 'E2E Recon Fastighet',
      propertyDesignation: 'Stockholm Recon 1:1',
      type: 'RESIDENTIAL',
      address: { street: 'Storgatan 1', city: 'Stockholm', postalCode: '111 22' },
      totalArea: 5000,
    },
    headers,
  )
  expect(is2xx(prop.status), `skapa fastighet (status ${prop.status})`).toBe(true)

  // APARTMENT (bostad) ⇒ momsfri ⇒ vatRate 0 ⇒ total = unitPrice (deterministiskt).
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

  // Hyresgäst + DRAFT-kontrakt. Ett kontrakt räcker — en faktura får skapas mot
  // ett DRAFT-kontrakt (invoices.service tillåter ACTIVE | DRAFT).
  const tenant = await postJson<{ id: string }>(
    request,
    '/tenants',
    {
      type: 'INDIVIDUAL',
      firstName: 'Test',
      lastName: 'Hyresgäst',
      email: `e2e.recon.tenant+${stamp}@eveno.test`,
      lease: { unitId: unit.body.data!.id, startDate: '2026-06-01', monthlyRent: 10_000 },
    },
    headers,
  )
  expect(is2xx(tenant.status), `skapa hyresgäst (status ${tenant.status})`).toBe(true)
  const leasesRes = await paced(() => request.get(`${API}/leases`, { headers }))
  const leaseId = ((await leasesRes.json()) as { data: Array<{ id: string }> }).data[0]!.id

  // En liten hjälpare: skapa faktura (DRAFT) + flytta till SENT, returnera nyckeldata.
  async function createSentInvoice(
    amount: number,
  ): Promise<{ id: string; ocr: string; total: number }> {
    const inv = await postJson<{ id: string; ocrNumber: string; total: string }>(
      request,
      '/invoices',
      {
        type: 'RENT',
        leaseId,
        lines: [{ description: 'Hyra', quantity: 1, unitPrice: amount, vatRate: 0 }],
        issueDate: '2026-06-01',
        dueDate: '2026-06-30',
      },
      headers,
    )
    if (!is2xx(inv.status) || !inv.body.data?.id) {
      throw new Error(
        `skapa faktura misslyckades (status ${inv.status}): ${inv.body.error?.message}`,
      )
    }
    const sent = await patchJson(
      request,
      `/invoices/${inv.body.data.id}/status`,
      { status: 'SENT' },
      headers,
    )
    if (!is2xx(sent.status)) throw new Error(`SENT-övergång misslyckades (status ${sent.status})`)
    return { id: inv.body.data.id, ocr: inv.body.data.ocrNumber, total: amount }
  }

  // ── Flödet som testas: 50× skapa faktura → mata in matchande betalning ───────
  const results: MatchResult[] = []

  for (let i = 1; i <= N; i++) {
    // Unikt belopp per iteration (10001..10050) ⇒ ingen tvetydighet, lätt att
    // särskilja. OCR är ändå den deterministiska matchnings-nyckeln.
    const amount = 10_000 + i
    let invId = ''
    try {
      const invoice = await createSentInvoice(amount)
      invId = invoice.id
      const desc = `E2E-recon-${stamp}-match-${i}`
      const imp = await importCsv(request, bankCsv(desc, invoice.total, invoice.ocr), headers)
      if (!is2xx(imp.status)) throw new Error(`import misslyckades (status ${imp.status})`)

      // ── BEVIS mot DB (rad-nivå) ──────────────────────────────────────────
      // Slå upp transaktionen via den globalt unika beskrivningen, joina mot
      // den förväntade fakturan och verifikatet i en enda fråga.
      const row = queryRow(`
        SELECT
          bt.status,
          (bt."invoiceId" = '${invId}')                AS right_invoice,
          (bt."invoiceId" IS NOT NULL
            AND bt."invoiceId" <> '${invId}')          AS wrong_invoice,
          (bt."matchedRentNoticeId" IS NULL)           AS no_notice,
          i.status                                     AS inv_status,
          (i."paidAt" IS NOT NULL)                     AS paid_set,
          (SELECT count(*) FROM "JournalEntry" je
             WHERE je.source='PAYMENT' AND je."sourceId"=bt.id) AS je_count,
          (SELECT coalesce(sum(l.debit),0) FROM "JournalEntryLine" l
             JOIN "JournalEntry" je ON je.id=l."journalEntryId"
             JOIN "Account" a ON a.id=l."accountId"
             WHERE je.source='PAYMENT' AND je."sourceId"=bt.id AND a.number=1930) AS d1930,
          (SELECT coalesce(sum(l.credit),0) FROM "JournalEntryLine" l
             JOIN "JournalEntry" je ON je.id=l."journalEntryId"
             JOIN "Account" a ON a.id=l."accountId"
             WHERE je.source='PAYMENT' AND je."sourceId"=bt.id AND a.number=1510) AS c1510
        FROM "BankTransaction" bt
        JOIN "Invoice" i ON i.id = '${invId}'
        WHERE bt.description = '${desc}' AND bt."organizationId" = '${orgId}';
      `)

      if (row.length === 0) throw new Error('ingen banktransaktion hittades i DB')
      const [status, rightInv, wrongInv, noNotice, invStatus, paidSet, jeCount, d1930, c1510] = row
      const wrongInvoice = wrongInv === 't'
      const amt = amount.toFixed(2)

      const checks: Array<[boolean, string]> = [
        [status === 'MATCHED', `tx-status=${status} (väntat MATCHED)`],
        [rightInv === 't', 'tx länkad till RÄTT faktura'],
        [!wrongInvoice, 'tx INTE länkad till fel faktura'],
        [noNotice === 't', 'tx ej länkad till hyresavi'],
        [invStatus === 'PAID', `faktura-status=${invStatus} (väntat PAID)`],
        [paidSet === 't', 'paidAt satt'],
        [jeCount === '1', `verifikat-antal=${jeCount} (väntat 1)`],
        [d1930 === amt, `1930 debet=${d1930} (väntat ${amt})`],
        [c1510 === amt, `1510 kredit=${c1510} (väntat ${amt})`],
      ]
      const failed = checks.filter(([ok]) => !ok).map(([, msg]) => msg)
      results.push({
        i,
        ok: failed.length === 0,
        reason: failed.length ? failed.join('; ') : null,
        wrongInvoice,
      })
    } catch (err) {
      results.push({
        i,
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        wrongInvoice: false,
      })
    }
  }

  // ── NEGATIVT FALL: fel OCR + belopp ingen faktura har ⇒ får ALDRIG matchas ───
  // "Lock"-faktura: SENT, obetald, OCR en siffra från den felaktiga betalningens.
  const lock = await createSentInvoice(55_555)
  // Mutera sista siffran i lås-OCR:t → en OCR som ingen faktura har.
  const last = lock.ocr.slice(-1)
  const wrongOcr = lock.ocr.slice(0, -1) + (last === '0' ? '1' : String(Number(last) - 1))
  const negDesc = `E2E-recon-${stamp}-negativ`
  // Belopp 99 999,99 — matchar varken lås-fakturan (55 555) eller någon match-
  // faktura (10 001..10 050), så även fuzzy-matchning (belopp + datum) faller.
  const negImp = await importCsv(request, bankCsv(negDesc, 99_999.99, wrongOcr), headers)
  expect(is2xx(negImp.status), `negativ import (status ${negImp.status})`).toBe(true)

  const negRow = queryRow(`
    SELECT
      bt.status,
      (bt."invoiceId" IS NULL)              AS no_invoice,
      (bt."matchedRentNoticeId" IS NULL)    AS no_notice,
      (SELECT count(*) FROM "JournalEntry" je
         WHERE je.source='PAYMENT' AND je."sourceId"=bt.id) AS je_count,
      (SELECT status FROM "Invoice" WHERE id='${lock.id}') AS lock_status
    FROM "BankTransaction" bt
    WHERE bt.description = '${negDesc}' AND bt."organizationId" = '${orgId}';
  `)
  const negChecks: Array<[boolean, string]> = []
  if (negRow.length === 0) {
    negChecks.push([false, 'ingen negativ transaktion hittades i DB'])
  } else {
    const [negStatus, noInvoice, noNotice, jeCount, lockStatus] = negRow
    negChecks.push(
      [negStatus === 'UNMATCHED', `negativ tx-status=${negStatus} (väntat UNMATCHED)`],
      [noInvoice === 't', 'negativ tx ej länkad till faktura'],
      [noNotice === 't', 'negativ tx ej länkad till hyresavi'],
      [jeCount === '0', `negativ tx-verifikat=${jeCount} (väntat 0)`],
      [lockStatus === 'SENT', `lås-faktura status=${lockStatus} (väntat SENT — ej felmatchad)`],
    )
  }
  const negFailed = negChecks.filter(([ok]) => !ok).map(([, msg]) => msg)

  // ── Org-scopad slutkontroll: exakt N fakturor är PAID, lås-fakturan obetald ──
  const paidCount = Number(
    queryRow(
      `SELECT count(*) FROM "Invoice" WHERE "organizationId"='${orgId}' AND status='PAID';`,
    )[0],
  )

  // ── Rapport ──────────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)
  const wrongMatches = results.filter((r) => r.wrongInvoice)

  // eslint-disable-next-line no-console
  console.log(
    `\n──────── RESULTAT: bankavstämning (auto-match) ────────\n` +
      `Försök (matchning):       ${N}\n` +
      `Lyckade matchningar:      ${passed}\n` +
      `Misslyckade:              ${failed.length}\n` +
      `Matchat mot FEL faktura:  ${wrongMatches.length}   (måste vara 0)\n` +
      `PAID-fakturor i DB (org): ${paidCount}   (väntat ${N})\n` +
      `Negativt fall (fel OCR):  ${negFailed.length === 0 ? 'OK — ej matchad' : 'FEL'}\n` +
      (failed.length > 0
        ? `Fel (matchning):\n${failed.map((f) => `  #${f.i}: ${f.reason}`).join('\n')}\n`
        : `Inga matchningsfel.\n`) +
      (negFailed.length > 0 ? `Fel (negativt fall):\n  ${negFailed.join('\n  ')}\n` : '') +
      `───────────────────────────────────────────────────────\n`,
  )

  await request.dispose()

  // ── Hård validering ──────────────────────────────────────────────────────────
  expect(wrongMatches, 'INGEN betalning matchad mot fel faktura').toEqual([])
  expect(failed, 'inga misslyckade matchningar').toEqual([])
  expect(passed, `alla ${N} matchningar lyckades`).toBe(N)
  expect(negFailed, 'negativt fall hanteras korrekt (fel OCR matchas ej)').toEqual([])
  expect(paidCount, `exakt ${N} fakturor PAID i DB`).toBe(N)
})
