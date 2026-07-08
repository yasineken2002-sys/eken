# Eveno — Tidigare buggar & fix

> Senast uppdaterad: 2026-05-29
> Källa: git log + PR-historik på `main`-branch

Detta dokument samlar de **viktigaste failure modes** vi redan har betalat för i produktion. Varje fix här representerar ett tillfälle då en bug nådde användarna eller var nära att göra det. Granska all ny kod mot listan — vi har **inte råd** att upprepa dessa.

Format: varje FIX har **vad gick fel**, **rotorsak**, **fix**, och **vad du måste kontrollera framöver**.

---

## FIX 1 — Saknad `@Roles()` på admin-endpoints

**När:** Tidig 2026 (innan branch protection skärptes)
**Commit-ref:** se git log för `auth/RolesGuard` ändringar
**Severity (vid upptäckt):** CRITICAL

### Vad gick fel

`JwtAuthGuard` var globalt och skyddade alla routes mot anonyma anrop, men `@Roles()` glömdes på flera state-changing admin-endpoints. Detta innebar att en inloggad **VIEWER** kunde anropa endpoints som skulle vara begränsade till OWNER/ADMIN — t.ex. radera fastigheter eller redigera fakturor.

### Rotorsak

NestJS `RolesGuard` triggas bara om `@Roles()`-dekoratorn finns. Saknas den, släpper guard:en igenom alla authenticated requests. Det är "fail-open" i designen — vilket är farligt.

### Fix

1. Lade till `@Roles(OWNER, ADMIN, MANAGER)` på alla state-changing endpoints
2. Skrev linter-regel (manuell granskningschecklist tills vi automatiserar) som flaggar `@Delete`/`@Put`/`@Patch` utan `@Roles()`
3. Skapade enhets-test som verifierar att VIEWER får 403 på destruktiva endpoints

### Vad du måste kontrollera framöver

För **varje** ny `@Delete`, `@Put`, `@Patch`, `@Post` på admin-resurser:

- Har den `@Roles(...)` med begränsning?
- Är rollerna rätt? (Inte alla mutations är för OWNER — vissa är MANAGER+.)

Grep-kommando:

```bash
grep -rB3 "@Delete\|@Put\|@Patch" apps/api/src | grep -v "@Roles"
```

Om något kommer upp utan `@Roles`, fråga författaren motivera varför.

---

## FIX 2 — Multi-tenant data-leak via Prisma `where` utan `organizationId`

**När:** Vinter 2025/2026
**Severity (vid upptäckt):** CRITICAL

### Vad gick fel

Flera `findUnique({ where: { id } })`-anrop saknade `organizationId`-scoping. Eftersom UUID:s normalt inte gissas trodde devs att UUID-ettan ensam räckte. Men:

1. UUID kunde läcka via URL:er, e-postmeddelanden, frontend-state, exportfiler
2. En illvillig användare i org A kunde anropa `GET /v1/invoices/<uuid-från-org-B>` och få fakturadetaljer

### Rotorsak

`findUnique` med bara `id` returnerar resursen **utan tenant-check**. Det är Prisma:s default — det är vi som måste lägga till multi-tenant-villkoret.

### Fix

1. Bytte `findUnique({ where: { id } })` → `findFirst({ where: { id, organizationId: orgId } })`
2. Lade till `@OrgId()`-dekorator som extraherar `organizationId` från JWT-payload
3. Skrev integration-test som verifierar att org A inte kan läsa/skriva org B:s data

### Mönster — så här ska det se ut

```typescript
// ❌ Fel — tenant-leak
async findOne(id: string) {
  return this.prisma.invoice.findUnique({ where: { id } })
}

// ✅ Korrekt
async findOne(id: string, orgId: string) {
  const invoice = await this.prisma.invoice.findFirst({
    where: { id, organizationId: orgId },
  })
  if (!invoice) throw new NotFoundException()
  return invoice
}
```

### Vad du måste kontrollera framöver

För **varje** ny Prisma-query i API:

- `where`-klausulen innehåller `organizationId`?
- `organizationId` kommer från `@OrgId()` (alltså JWT) — aldrig från body/query/path?

Grep-kommando:

```bash
# Hitta findUnique med bara id (sannolikt buggar)
grep -rn "findUnique({ *where: *{ *id" apps/api/src

# Hitta find/update/delete utan organizationId
grep -rEn "(findMany|findFirst|update|delete|count)" apps/api/src | grep -v organizationId
```

Förekomster måste motiveras: antingen är de globala admin-endpoints (i `platform/`-modulen) eller så är de buggar.

---

## FIX 3 — Cascade-delete tog ner audit-loggar (BFL-överträdelse)

**När:** Tidig 2026
**Severity (vid upptäckt):** HIGH (juridisk risk)

### Vad gick fel

Prisma-schemat hade `onDelete: Cascade` på relationen `Invoice → InvoiceEvent`. När en faktura raderades försvann hela händelseloggen för den fakturan. Detta bröt mot **Bokföringslagen 7 kap 2 §** (räkenskapsinformation ska bevaras i 7 år) och tog bort vår audit-trail.

### Rotorsak

Prisma-default beteende är `onDelete: NoAction`. Vi hade aktivt satt `Cascade` för enkelhet, utan att tänka på arkivkravet.

### Fix

1. Ändrade till `onDelete: Restrict` på `Invoice → InvoiceEvent`, `JournalEntry → JournalEntryLine`, och alla audit-relationer
2. Implementerade **soft-delete** för fakturor (`deletedAt` istället för faktisk DELETE)
3. Skapade migration som lägger till `deletedAt`-kolumner

### Mönster

```prisma
// ❌ Fel — bryter mot BFL
model InvoiceEvent {
  invoice    Invoice @relation(fields: [invoiceId], references: [id], onDelete: Cascade)
}

// ✅ Korrekt
model InvoiceEvent {
  invoice    Invoice @relation(fields: [invoiceId], references: [id], onDelete: Restrict)
}
```

### Vad du måste kontrollera framöver

För varje ny relation i `schema.prisma`:

- Är `onDelete` korrekt för domänen?
- Audit/redovisnings-data: `Restrict` (eller `NoAction` om referensintegriteten kommer från app-lagret)
- Användardata: `Cascade` är OK om GDPR-rättigheten "right to erasure" kräver det
- Generella relationer: avgör utifrån semantik

Grep-kommando:

```bash
grep -rn "onDelete: *Cascade" apps/api/prisma/schema.prisma | grep -iE "(invoice|journal|event|account|document)"
```

Om något kommer upp på audit-modeller, ifrågasätt.

---

## FIX 4 — Tunga synkrona PDF-jobb blockerade Fastify event loop

**Commit:** ab16974 — `fix(api): move send/bulk PDF generation to a Bull queue (#14)`
**När:** maj 2026
**Severity (vid upptäckt):** HIGH (UX + DoS-risk)

### Vad gick fel

Massutskick av fakturor (`POST /v1/invoices/bulk-send`) körde Puppeteer **synkront i request-tråden**. För en kund med 200+ fakturor tog requesten 5-10 minuter och blockerade Fastify från att serva andra requests. Användarna fick timeouter och dubbelklickade → genererade dubbletter.

### Rotorsak

Puppeteer är CPU-tungt och blockerande. Att köra det i request-context skalar inte. Synchronous batch-operations är fel mönster för API.

### Fix

1. Skapade `pdf-jobs/`-modul med Bull queue
2. `bulk-send` endpoint enkar nu jobbet och returnerar `{ jobId, status: 'queued' }`
3. Frontend pollar `GET /v1/jobs/:id` för status
4. Worker-process konsumerar queue och kör Puppeteer asynkront

### Mönster

- **Synkrona endpoints:** enskilda PDF-nedladdningar (< 2 sek) — OK direkt
- **Asynkrona via queue:** bulk-operations, massutskick, AI-tunga jobb (PDF-parsing)

Beslut motiverat i `design-decisions.md` — "Sync downloads / async sends".

### Vad du måste kontrollera framöver

För nya bulk-endpoints:

- Skapar de jobb i Bull-queue, eller försöker köra synkront?
- Returnerar de `jobId` så frontend kan följa status?
- Har queue korrekt retry-policy och dead-letter-hantering?

Grep-kommando:

```bash
# Synkrona Puppeteer-anrop i controllers (red flag)
grep -rn "puppeteer\|chromium\|pdf" apps/api/src --include="*.controller.ts"
```

---

## FIX 5 — Frontend routing via `useState<Route>` tappade djup-länkning

**Commit:** eefe04e — `fix(web): URL-based routing with TanStack Router (#13)`
**När:** maj 2026
**Severity (vid upptäckt):** HIGH (UX-regression vid back/forward + delade länkar bröt)

### Vad gick fel

Tidig version av `apps/web` hade en hemmasnickrad router via `useState<Route>('dashboard')` i `App.tsx`. Det innebar:

1. URL:en uppdaterades inte vid navigation — alla sidor delade samma URL
2. Browser back/forward-knappar fungerade inte
3. Refresh tog användaren tillbaka till `dashboard`
4. Delade länkar (kollega skickar URL via Slack) ledde alltid till `dashboard`

### Rotorsak

Premature optimization — devs trodde att TanStack Router var "overkill" och rullade en egen lösning. Glömde grundläggande URL-state-koppling.

### Fix

Migrerade till **TanStack Router** med:

- File-based routing i `app/routes/`
- URL-state är källan till sanning för aktuell vy
- Loaders preloadar data deklarativt
- Type-safe paths via `createFileRoute`

### Vad du måste kontrollera framöver

I `apps/web` och `apps/portal`:

- All navigation går via TanStack Router (`Link`, `useNavigate`, `navigate()`)
- INGEN navigation via `useState<Route>` eller andra mock-routers
- Nya sidor får motsvarande route-fil

CLAUDE.md är **out-of-date** här — den nämner fortfarande `useState<Route>`-mönstret. Ignorera det avsnittet, TanStack Router gäller numera.

Grep-kommando:

```bash
# Old router-pattern
grep -rn "useState<Route>\|onNavigate" apps/web/src apps/portal/src

# New router-pattern (good)
grep -rn "createFileRoute\|@tanstack/react-router" apps/web/src apps/portal/src
```

---

## FIX 6 — FIFO matching + double-match prevention på hyresnotiser

**Commit:** f7465ea — `fix(reconciliation): FIFO matching + prevent double-match on rent notices (#15)`
**När:** maj 2026
**Severity (vid upptäckt):** CRITICAL (felaktig bokföring → BFL-överträdelse)

### Vad gick fel

Bank-betalningsmatchning kunde matcha samma OCR-belopp mot **flera fakturor** eller mot **fel faktura** när en hyresgäst hade flera öppna fakturor. Konsekvens:

1. Dubbla intäkter i bokföringen
2. Felaktig faktura-status (PAID när den fortfarande hade utestående)
3. Förverkanderätt eroderad — en hyresgäst kunde stå utan att hyra var betald enligt systemet, samtidigt som banken visade betalning

### Rotorsak

Matchningen körde "alla öppna fakturor" mot inkommande betalning i fel ordning, utan låsning. Race condition vid samtidiga jobb.

### Fix

1. **FIFO-ordning:** äldsta förfallna faktura matchas först (rättssäker per Räntelagen och praxis)
2. **Double-match prevention:** låser raden i `Invoice` med `SELECT ... FOR UPDATE` inom transaktion
3. **Idempotency-key:** varje matchningsförsök får en unik nyckel; retry skapar inte dubbla matchningar
4. Skrev test som simulerar två samtidiga matchningsjobb mot samma faktura

### Vad du måste kontrollera framöver

Vid nya reconciliation/matching-flöden:

- FIFO-ordning per affärsregel (oftast äldsta först — kontrollera juridik)
- Transaktion med pessimistisk eller optimistisk låsning
- Idempotency för retryable operationer
- Test för concurrent execution

Grep-kommando:

```bash
grep -rn "reconcil\|matching\|payment" apps/api/src/invoices apps/api/src/accounting
```

---

## FIX 7 — AI-baserad PDF-parsing av bankutdrag (kvalitet + cost-tracking)

**Commit:** 93f2765 — `feat(reconciliation): AI-powered PDF bank statement parsing (#16)`
**Commit (UX-fix efter):** 583111f — `fix(web): robust drag-and-drop on bank statement upload (#17)`
**När:** maj 2026
**Severity (vid implementation):** HIGH om vi inte hanterar AI-kostnad

### Vad gick fel (eller riskerade gå fel)

Vi introducerade AI-parsing för bankutdrag (PDF) → strukturerade transaktioner. Risker:

1. AI-kostnad utan tracking → en kund kunde dra på en stor faktura utan att vi visste
2. Felaktig parsing → felmatchning av betalningar → bokföringsfel (lika illvilligt som FIX 6)
3. PDF kan innehålla PII-text → AI-anrop läcker till tredjeparts API utan samtycke
4. Stora PDF:er blockerar event loop om de körs synkront

### Fix

1. **`ai-usage/`-modul** — varje AI-anrop loggas med org, token-cost, modell, latency
2. **`pdf-jobs/` queue** — bank-import är asynkron, blockerar inte API
3. **Confidence-score** på varje parsad transaktion → låg confidence → manuell granskning
4. **Drag-and-drop UX-fix** (FIX 7b) — robusta dropzone-events, ingen flicker, tydlig progress
5. **Datadelnings-disclaimer** i UI innan AI-parsing körs

### Vad du måste kontrollera framöver

För nya AI-feature:

- Token-cost loggas till `ai-usage`?
- Stora payloads går via Bull queue?
- PII-disclaimer / opt-in från användaren?
- Confidence-score eller human-in-the-loop för viktiga beslut?
- Retry-budget — vad händer om OpenAI/Anthropic API är nere?

Grep-kommando:

```bash
grep -rn "openai\|anthropic" apps/api/src | grep -v ai-usage
```

(Borde vara nästan tomt — alla AI-anrop ska gå genom `ai/`-modulen som loggar.)

---

## FIX 8 — Sido-entitet med egen statusmaskin ej synkad vid varje betalväg (orphan state)

**Commit:** 1135630 — `fix(deposits): deposit-F1 — synka Deposit.status vid bankmatchad deposition-faktura (#185)`
**När:** juli 2026
**Severity (vid upptäckt):** HIGH (pengar — deposition kunde aldrig återbetalas)

### Vad gick fel

`Deposit` har en egen statusmaskin (PENDING→PAID→REFUND_PENDING→REFUNDED) parallell med den
`Invoice`/`RentNotice` den är länkad till. En manuellt skapad deposition (`deposits.create()`,
`Deposit.invoiceId`-länkad) som betalades via **bankavstämning** fick sin `Invoice` flippad PAID +
bokförd (1930 D/1510 K), men `applyMatchToInvoice` rörde aldrig `Deposit`-raden. Depositionen stod
kvar `PENDING` för evigt → `refund()` och `markRefundPendingForLease` (kräver PAID) hittade den
aldrig → **återbetalning permanent omöjlig, tyst.** Pengarna var rätt bokförda; entiteten var i
"orphan state".

### Rotorsak

När en betalning kan komma in via FLERA vägar (manuell markPaid, bankmatchning av Invoice,
bankmatchning av RentNotice-avi) måste VARJE väg synka ALLA länkade sido-entiteters statusmaskiner.
En sido-entitet med eget statusfält som bara synkas på en delmängd av betalvägarna hamnar tyst i
inkonsekvent tillstånd på de andra.

### Fix

I varje betalväg, i samma atomiska tx som statusclaimet + verifikatet, synka den länkade
sido-entiteten status-gardat (CAS via `updateMany` med statusfilter):

```typescript
await tx.deposit.updateMany({
  where: { invoiceId, organizationId, status: 'PENDING' },
  data: { status: 'PAID', paidAt: transactionDate },
})
```

`@unique`-länken (`Deposit.invoiceId`/`Deposit.rentNoticeId`) är diskriminatorn → no-op för
icke-relaterade rader. Statusgardat `updateMany` serialiserar mot samtidiga betalvägar (ingen
dubbelbokning). Speglar det redan beprövade mönstret i `applyMatchToRentNotice` (avi-vägen, #41).

### Vad du måste kontrollera framöver

- Har du lagt till en NY betalväg (matchning/markPaid/kvittning) för en entitet? → synka ALLA
  länkade sido-entiteter med egen statusmaskin i SAMMA tx.
- Har du lagt till en NY sido-entitet med eget statusfält (parallellt med Invoice/RentNotice)? →
  inventera ALLA befintliga betalvägar och synka den i var och en.
- Grep: `grep -rn "claimPaidWithinTx\|status: 'PAID'\|markAsPaid\|applyMatchTo" apps/api/src` —
  varje träff som flippar en betalstatus: rör den alla länkade sido-entiteter?

---

## Sammanfattning — checklist för varje ny PR

Innan du säger "klart", verifiera systematiskt:

```
[ ] FIX 1: Alla nya @Delete/@Put/@Patch/@Post har @Roles()?
[ ] FIX 2: Alla nya Prisma-queries har organizationId i where?
[ ] FIX 3: Inga nya onDelete: Cascade på audit/redovisnings-modeller?
[ ] FIX 4: Tunga jobb (PDF, AI, bulk) körs via Bull queue, inte sync i request?
[ ] FIX 5: All routing via TanStack Router, inte useState<Route>?
[ ] FIX 6: Reconciliation/matching använder FIFO + låsning + idempotency?
[ ] FIX 7: AI-anrop loggar token-cost och har confidence/disclaimer?
```

Om du är osäker på något: säg det i PR-beskrivningen. Det är bättre att flagga osäkerhet än att smyga in en regression.
