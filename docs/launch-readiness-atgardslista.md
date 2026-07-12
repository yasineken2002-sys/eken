# Lanserings-åtgärdslista (launch readiness)

**Datum:** 2026-07-07
**Källa:** Read-only-granskning av main @ `8d5b799` (efter #167–#171). Sex parallella granskningar:
typecheck (grönt, 0 fel), full testsvit (115 sviter / 1 062 tester, alla gröna, 2 m 40 s),
döda knappar i web (0 fynd), front↔back-kontrakt (1 latent fynd), perifera backend-moduler,
produktions-/deploykonfiguration.

**Helhetsbild:** Produkten är funktionellt hel — inga döda knappar, inga kontraktsbrott, grön
testsvit. Lanseringsriskerna är (1) tysta produktionskonfigurationsfel, (2) oarmerat
regressionsskydd i CI, (3) en handfull avgränsade logikbuggar. Inget kräver omdesign.

---

## 🧭 PRIORITERAD HANDLINGSORDNING (bygg i denna ordning)

Ordningen är riskstyrd: aktiva dataläckor först, sedan behörighet, sedan regulatoriskt,
sedan drift-grindar, sedan pengafel, sedan finish. Punktnumren (#) hänvisar till detaljerna
längre ned i dokumentet. **Allt nedan kan fixas NU** — inget i MÅSTE-listan är gatat av
bolagsregistrering. De gatade posterna listas separat sist.

### Steg 1 — Tenant-isolation (farligast: aktiva dataläckor mellan kunder)

Stäng hela temat i en omgång, samma allow-list-mönster överallt:

- **#19 `leases.update`** — läcker främmande orgs hyresgäst-PII inkl. personnummer. **Allvarligast, börja här.**
- **#5** — de tre kända create-buggarna: `maintenance` / `documents` / `news` validerar inte
  relations-id mot org.

_Varför först:_ detta är den enda felklassen där org A **redan idag** kan läsa/skriva org B:s
data. Ett enda läckt personnummer är en förtroendekris som inte går att ta tillbaka.

### Steg 2 — AI-behörighet

- **#20** — rollinversion i AI-vägen: ACCOUNTANT kan via AI utföra MANAGER/ADMIN-mutationer
  (bl.a. terminera hyresavtal). Fix: mappa varje verktyg till en `UserRole`-miniminivå och
  jämför mot `ROLE_HIERARCHY` i stället för strängmatchning.
  > **⚠️ Konsekvenskrav (från T1.4-följd-PR #194):** backfill-`allowBeyondWarning`-override kräver
  > ADMIN/OWNER, grindat i `RentBackfillService.createBackfillNotices` via `actorRole`. Om en AI-väg
  > någonsin exponerar backfill-bekräftelse måste den skicka rätt `actorRole` och hanteras av samma
  > minimirolls-mappning — annars kringgår AI-vägen grinden. Verifiera vid #20.

### Steg 3 — GDPR-radering (matar in i juridiska slutgenomgången)

- **#21 + #22 tillsammans** — anonymiserings-fallback: pseudonymisera hyresgästens persondata
  men **behåll raderna** för BFL:s 7-årskrav. Löser både portal-raderingen som lämnar PII kvar
  (#21) och hyresvärdens hård-delete som kraschar 500 på Restrict (#22).

_Beslut som krävs (juridik):_ exakt lista över "bevara (räkenskapsmaterial, BFL 7 år)" vs
"anonymisera/radera (GDPR-rest)". Se tabellen i #21.

### Steg 4 — Env-validering vid boot

- **#1** — Zod-schema som vägrar starta i `NODE_ENV=production` utan de kritiska variablerna.
  Utöka listan med de **nya** signering-/PSD2-variablerna som tillkommit sedan svep 1 (#172–#176):
  `SIGNING_ENABLED`, `PSD2_ENABLED`, `PSD2_TOKEN_KEY` (BankConsent-kryptering),
  `BACKUP_ENABLED` m.fl. Verifiera de exakta namnen mot `scratchpad-item4-bankid-psd2-plan.md`
  och `.env.example` innan schemat skrivs.

_Varför före pengafelen:_ en tyst felkonfig (localhost-länkar, död R2/Redis) gör att lanseringen
_ser_ lyckad ut men hyresgäster inte kan aktivera konton — billig fix, stänger hela klassen.

### Steg 5 — Armera CI

- **#2** — kör testsviten i CI (grön, 2 m 40 s). Gör detta innan pengafelen fixas, så
  rättningarna av #23/#24 skyddas av regressionstester direkt.

### Steg 6 — Pengafel i randflöden

- **#23** — betalning som ej täcker ränta flippar avi till PAID → strandad räntefordran
  (bryter INV-S). Kräver produktbeslut om restränta.
- **#24** — faktura-`/pay` bokför alltid full total, ignorerar angivet belopp (delbetalning
  omöjlig, `PARTIAL` död kod).

### Steg 7 — Resten av 🟠 + 🟡

- **🟠 atomicitet i randflöden:** #25 (deposition-refund), #26 (manuell markAsPaid),
  #27 (SENT före leverans), #28 (CSV-import), #29 (termination approve).
- **🟡 GDPR-finish + drift:** #30–#39 (ofullständig dataexport, e-post/token i loggar+Sentry,
  Art. 13-info vid portalaktivering, graceful shutdown m.m.) + svep 1:s #8–#18.

### ⛔ GATADE av bolagsregistrering (fixa INTE nu — vänta på avtal/nycklar)

Dessa ligger utanför MÅSTE-listan och blockeras av extern registrering/avtal, inte av kod:

- **S3** — skarp e-signeringsadapter (Scrive/Assently) + hyresvärds-signering. Scaffolding
  (#172) och orkestrering (#176) är mergade och inerta bakom `SIGNING_ENABLED`.
- **P3** — skarp PSD2-adapter (Enable Banking/Tink). Ingest + bankkoppling (#173–#175) är
  mergade och inerta bakom `PSD2_ENABLED`; kräver avtal + produktionsnycklar för att aktiveras.
- Även **DB-backup-aktivering** (#169) och **BankID-inloggning** är gatade på bolags-/
  leverantörsregistrering enligt CLAUDE.md — koden finns, aktiveringen väntar.

> Notera: env-valideringen (#1, steg 4) ska känna till dessa flaggor (`SIGNING_ENABLED`/
> `PSD2_ENABLED`/`BACKUP_ENABLED`) men **kräva** dem endast när respektive funktion slås på —
> inte blockera boot bara för att den skarpa adaptern ännu inte är aktiverad.

---

## 🔴 MÅSTE FÖRE LANSERING

### 1. Env-validering vid boot (stänger hela klassen "funkar i dev, dör tyst i prod") — ✅ ÅTGÄRDAD

**Problem:** `ConfigModule.forRoot(...)` i `apps/api/src/app.module.ts:58` saknar
`validationSchema`. Saknade env-vars i Railway kraschar inte appen utan ger tysta fel först i
drift:

| Variabel                                                                         | Vad som går sönder tyst                                                                                                           | Referens                                                                         |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `PORTAL_URL`                                                                     | Aktiverings-/reset-mejl till hyresgäster får `http://localhost:5174/...` — hyresgäster kan aldrig aktivera konton                 | `apps/api/src/tenant-portal/tenant-auth.service.ts:148-155, :528`                |
| `WEB_URL`                                                                        | Användarinbjudningar får `http://localhost:5173/accept-invite?...`                                                                | `apps/api/src/users/users.service.ts:111`                                        |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME` | Appen bootar friskt; alla avi-PDF:er, logotyper och dokument dör vid första användning (`InternalServerErrorException` per anrop) | `apps/api/src/storage/storage.service.ts:18-25, :53, :74`                        |
| `REDIS_URL`                                                                      | Fallback `redis://localhost:6379` → alla köer (mejl, PDF, kontraktsskanning) dör tyst                                             | `apps/api/src/app.module.ts:80`, `apps/api/src/common/redis/redis.service.ts:19` |
| `RESEND_API_KEY`                                                                 | Bara `logger.warn` + `new Resend('missing-key')` → mejl failar tyst (retry → dead)                                                | `apps/api/src/mail/mail.worker.ts:32-34`                                         |
| `MAIL_FROM`                                                                      | Default `noreply@eveno.se`; overifierad domän avvisas av Resend helt tyst (varning loggas bara för `resend.dev`)                  | `apps/api/src/mail/mail.worker.ts:18, :40-43`                                    |
| `RESEND_WEBHOOK_SECRET`                                                          | Bounce-/leveransspårning helt död (503, fail-safe men tyst)                                                                       | `apps/api/src/webhooks/resend-webhook.service.ts:50-60`                          |

**Fix:** Zod-schema (eller Joi via `validationSchema`) som i `NODE_ENV=production` **vägrar
starta** om någon av ovanstående + `DATABASE_URL`, `APP_URL`, `ADMIN_URL`, `JWT_SECRET`,
`PLATFORM_JWT_SECRET` saknas. I dev: varna. En liten PR som stänger hela felklassen.

**Fix (implementerad):** `apps/api/src/config/env.validation.ts` (`validateEnv`) inkopplad via
`ConfigModule.forRoot({ validate: validateEnv })` i `app.module.ts`. Kör vid boot innan DB/Redis.

- **Alltid-kritiska** (prod → vägrar starta, dev/test → varnar, blockerar ej): `DATABASE_URL`,
  `REDIS_URL`, `JWT_SECRET`/`PLATFORM_JWT_SECRET` (≥16), `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`,
  `ANTHROPIC_API_KEY`, alla fyra `R2_*`, samt `APP_URL`/`WEB_URL`/`ADMIN_URL`/`PORTAL_URL` (URL-format).
  Alla fel samlas i ETT tydligt boot-fel som namnger varje saknad/ogiltig variabel.
- **Flagg-villkorade** (krävs bara när flaggan är på, valideras i alla miljöer — **speglar** den
  befintliga fail-fast i `psd2.module.ts`/`signing.module.ts`, dubblar/motsäger den inte):
  `PSD2_ENABLED=true` ⇒ `PSD2_TOKEN_KEY` (64 hex); `SIGNING_ENABLED=true` ⇒ `SIGNING_PII_KEY`
  (64 hex) + `SIGNING_PII_PEPPER` (≥16).
- **Valfria med default** (`MAIL_FROM`, `PORT`, `THROTTLE_*`, `BACKUP_RETENTION_DAYS`,
  `PSD2_CALLBACK_URL`/`PSD2_APP_RETURN_URL`): endast format-varning om satta, blockerar aldrig.
- **`BACKUP_*` medvetet UTELÄMNAT ur boot-krasch:** `backup.service.ts:74-93` är en avsiktlig
  fail-closed no-op + error-logg (appen ska köra vidare utan backup) — ett boot-krasch där skulle
  motsäga den logiken.

**Bevis:** 14 enhetstester (`env.validation.spec.ts`) + 3 boot-integrationstester
(`env.validation.integration.spec.ts` — riktig `ConfigModule.forRoot`-boot). Verifierat live:
dev-server bootar oförändrat (health `ok`) och loggar bara en icke-blockerande varning för de
lokalt osatta varerna (R2/WEB_URL/PORTAL_URL). Additivt — appen bootar exakt som förut när alla
variabler finns.

> **Kvarstår (icke-blockerande, hygien):** flera lästa variabler saknas i `apps/api/.env.example`
> (`WEB_URL`, `SIGNING_ENABLED`/`SIGNING_PII_KEY`/`SIGNING_PII_PEPPER`, `BACKUP_*`,
> `R2_BACKUP_*`, m.fl.). Uppdatera `.env.example` som referens så operatören ser hela listan.

### 2. Koppla in testsviten i CI

**Problem:** `.github/workflows/ci.yml` kör bara typecheck + lint. 115 spec-sviter
(1 062 tester, inkl. leak-/RBAC-/money-neutrality-tester) körs aldrig automatiskt —
regressionsskyddet finns men är oarmerat. Verifierat 2026-07-07: sviten är grön och tar
2 m 40 s (`cd apps/api && npx jest`).

**Fix:** Lägg till ett `test`-jobb i `ci.yml` (`npx jest` i `apps/api`; ev. även portalens
Vitest). Inget skäl att vänta.

### 3. Hyreshöjnings-cronen applicerar höjning på döda avtal (pengafel)

**Problem:** `applyDueIncreases` i `apps/api/src/rent-increases/rent-increases.service.ts:340-369`
hämtar `ACCEPTED`-höjningar med `effectiveDate <= today` och skriver
`lease.monthlyRent = newRent` **utan att kontrollera att avtalet fortfarande är `ACTIVE`**.
Scenario: ett FIXED_TERM-avtal auto-förnyas mellan accept och ikraftträdande
(`leases.service.ts` `autoRenewExpiredFixedTerm` sätter gamla avtalet `EXPIRED` och skapar ett
nytt lease-id) → cronen bumpar hyran på det döda avtalet, markerar höjningen `APPLIED`, och det
nya aktiva avtalet behåller gammal hyra. Höjningen försvinner tyst. Höjningar på
`TERMINATED`-avtal skrivs också.

**Fix:** Guard på `lease.status === 'ACTIVE'` i cronen; vid EXPIRED/förnyat avtal — antingen
följ med till efterträdar-avtalet (om spårbart) eller flagga höjningen för manuell åtgärd +
notis, i stället för tyst `APPLIED`. Lägg spec som täcker auto-förnyelse-scenariot.

---

## 🟠 BÖR FÖRE LANSERING

### 4. Statusguard på maintenance-uppdatering (dubbelnotiser + nollställd completedAt)

**Problem:** `apps/api/src/maintenance/maintenance.service.ts:226, :262-274` — `update()`
saknar övergångsguard. Varje PATCH på ett redan `COMPLETED`-ärende (t.ex. lägga till
`actualCost`) nollställer `completedAt` till dagens datum och skickar en ny
"Underhållsärende slutfört"-notis till alla org-användare.

**Fix:** Gör COMPLETED→COMPLETED till no-op för `completedAt` + notis (jämför föregående
status innan sidoeffekter triggas).

### 5. Org-validering av relations-id (IDOR-injektion) — ✅ ÅTGÄRDAD

**Problem:** Moduler som skrev klient-skickade relations-id utan att verifiera att de tillhör
`organizationId`. Med ett känt UUID kunde en användare peka sin egen rad mot en annan orgs
entitet; egen orgs `findOne`/`findAll` inkluderar sedan `property.name/city/street` resp.
tenant-namn → främmande orgs data läcker in i egen vy.

**RÄTTELSE (svep 2): klassen var bredare än "tre create-metoder".** Kartläggning före fix
visade att den omfattade **fyra moduler och sex metoder** — inte bara create, utan även två
update-metoder (precis som #19 självt var en _update_):

- `maintenance.service.ts` — **create + update** (`propertyId`/`unitId`/`tenantId`)
- `documents.service.ts` — **upload/create** (`propertyId`/`unitId`/`leaseId`/`tenantId`)
- `inspections.service.ts` — **create** (`propertyId`/`unitId`/`leaseId`/`tenantId`) —
  ⚠️ listades TIDIGARE FELAKTIGT som "OK" nedan; hade hålet (läcker `SAFE_TENANT_SELECT` via
  `FULL_INCLUDE`).
- `news.service.ts` — **create + update** (`propertyId`)

**Fix (implementerad):** privat `assertRelationsInOrg`-helper per service som gör
`findFirst({ id, organizationId })` (unit via `property: { organizationId }`) på varje icke-tomt
relations-id före skrivning → `NotFoundException`. Speglar `invoices.update` + #19. Eget
isolations-test per metod (främmande org → 404 + skriv-metod anropas aldrig; egen org →
oförändrad). **Hela IDOR-klassen (leases.update #19 + dessa 6 metoder) är nu stängd.**

**Slutgranskning (security-auditor, 2026-07-07):** GODKÄND — 0 fynd på alla nivåer
(CRITICAL/HIGH/MEDIUM/LOW). Sjunde stället explicit jagat över hela `apps/api/src` (deposits,
keys, misc-charges, consumption, rent-increases, invoices, units, leases, import, avisering,
ai-tools) — inget ytterligare hål; alla org-scopar redan sina klient-relations-id (flera
härleder dem server-side från lease). TOCTOU/bypass uteslutet. 14 icke-vakuösa isolations-test
gröna.

**Icke-blockerande följdförslag (backlog, ur slutgranskningen):**

1. **CI-lint mot återöppning av klassen** — regel/check som flaggar
   `prisma.<model>.create/update({ data: { …Id: dto.xxxId } })` utan ett föregående
   `findFirst`/`findUnique`-org-kontroll i samma funktion. Automatiserar det som nu görs
   manuellt vid varje svep → förebygger att IDOR-klassen öppnas igen vid framtida moduler.
   _Värdefullt (förebyggande)._
2. **Isolations-spec för `keys.service.ts` + `misc-charges/misc-charge.service.ts`** — båda
   följer redan mönstret korrekt (org-scopar relations-id / härleder från lease), men saknar
   egen `*-org-isolation.spec.ts` i samma stil som svepet. Testtäckningshygien, inte
   säkerhetsbrist.

### 6. Massmejl: utflyttade hyresgäster + saknad idempotens

**Problem:** `apps/api/src/messages/messages.service.ts:159` — `sendToAll` itererar alla
tenants i orgen, inklusive utflyttade utan aktivt avtal. `retryFailed` (:105-110) matchar på
`email IN (...)` → delad e-post ger dubbletter. Ingen idempotensnyckel på massutskick →
dubbelklick/retry ger dubbla mejl.

**Fix:** Filtrera på tenants med aktivt avtal (eller gör mottagarurvalet explicit i UI),
retry per tenant-id i stället för e-post, idempotensnyckel per utskick.

### 7. Kvarstående från tidigare granskningar

- **Portal-login med valfri `organizationId`** — `apps/api/src/tenant-portal/tenant-auth.service.ts:322-334`:
  utan org görs `findFirst({ email })` som godtyckligt väljer tenant om samma person hyr av två
  hyresvärdar (e-post unik per `[organizationId, email]`, `schema.prisma:942`). Ingen dataläcka,
  men fel org kan väljas. **Fix:** gör `organizationId` obligatorisk i portal-login.
- **Σdebet=Σkredit-assert i bokföringen** — `apps/api/src/accounting/accounting.service.ts`
  (`createNumberedEntry`, ~rad 187-208) persisterar rader utan balanskontroll. Balanserat
  "by construction" idag, men en framtida felaktig `JournalLineInput` bokförs obalanserat
  oupptäckt. **Fix:** billig assert (kasta om `|Σdebet − Σkredit| > 0.005`) inne i transaktionen.
- **Dockerfile kör som root** — `apps/api/Dockerfile` saknar `USER`. API + Chromium som root är
  en härdningsbrist. **Fix:** `USER node` (verifiera Puppeteer-/tmp-rättigheter).
- **Verifiera att portal-activation-HIGH-läckan är stängd** — `GET /portal/activation/:token`
  läckte rå Property-rad (`tenant-auth.service.ts:192` include, `tenant-portal.controller.ts:223`),
  se `scratchpad-portal-defense-in-depth-audit.md` (2026-07-03). Portal-härdning #156–#159 är
  mergad — bekräfta att just denna väg fick allow-list-select, annars fixa. Samma audit listar
  även `getDashboard` rå tenant (mapMe saknas) och `exportTenantData` rå invoice-include.

---

## 🟡 MINDRE (dokumenterat — fixa när tid finns)

| #   | Problem                                                                                                                                                                                                          | Referens                                                                                                                            | Föreslagen fix                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 8   | Dashboard använder dagens `totalUnits` för alla historiska månader → fel historisk uthyrningsgrad                                                                                                                | `apps/api/src/dashboard/dashboard.service.ts:183`                                                                                   | Snapshotta eller härled enhetsantal per månad                                                    |
| 9   | Nycklar kan kvitteras ut på TERMINATED-avtal                                                                                                                                                                     | `apps/api/src/keys/keys.service.ts:58`                                                                                              | Lease-statusguard i `issue()`                                                                    |
| 10  | Avtals-utgångspåminnelser: ingen dedup vid dubbel cron-fire; missad cron-dag hoppar över tröskel (90/60/30)                                                                                                      | `apps/api/src/leases/leases.service.ts:835`                                                                                         | Sentinel-dedup (samma mönster som notifications-cron) + intervallfönster i stället för exakt dag |
| 11  | Cron-tidszoner inkonsekventa: bara notifications sätter `Europe/Stockholm`, övriga kör UTC (avisering `'0 7 1 * *'`, platform-fakturor `'0 8 1 * *'`) — rätt dag idag men DST-drift + tickande bugg nära midnatt | `apps/api/src/avisering/avisering.scheduler.ts:29`, `apps/api/src/platform/platform-invoices.service.ts:490`, `apps/api/Dockerfile` | `TZ=Europe/Stockholm` i Dockerfile + `timeZone` på alla `@Cron`                                  |
| 12  | Railway-URL hårdkodad i tre `vercel.json` — domänbyte kräver tre manuella ändringar, annars tyst 404                                                                                                             | `apps/web/vercel.json`, `apps/admin/vercel.json`, `apps/portal/vercel.json`                                                         | Dokumentera i DEPLOYMENT.md; ev. env-styrd generering                                            |
| 13  | Död portal-funktion `markNoticeRead` anropar endpoint som inte finns (`POST /portal/notices/:id/read` → 404); oanvänd idag men blir död knapp om den kopplas in                                                  | `apps/portal/src/api/portal.api.ts:163` (backend-route saknas i `tenant-portal.controller.ts`)                                      | Ta bort funktionen eller bygg routen                                                             |
| 14  | `JWT_REFRESH_SECRET` + `PLATFORM_JWT_REFRESH_SECRET` finns i `.env.example` men används aldrig i koden — falsk trygghet                                                                                          | `.env.example` (grep i src: 0 träffar)                                                                                              | Ta bort ur `.env.example` (refresh-tokens är DB-hashade, signeras ej separat)                    |
| 15  | Trasig migration vid deploy → Railway-crashloop utan larm (fail-fast är rätt, alertering saknas)                                                                                                                 | `apps/api/scripts/migrate-and-start.sh`                                                                                             | Sentry-/webhook-notis vid migrationsfel; dokumentera rollback-rutin                              |
| 16  | Health-endpoint kollar bara DB, inte Redis/köer — köstopp syns inte i proben                                                                                                                                     | `apps/api/src/common/health/health.controller.ts`                                                                                   | Lägg Redis-ping (+ ev. Bull-ködjup) i Terminus-checken                                           |
| 17  | Redis `enableOfflineQueue: false` → kommandon kastas direkt under Redis-omstartsfönstret (Bull-jobb retryar dock)                                                                                                | `apps/api/src/common/redis/redis.service.ts:24`                                                                                     | Medvetet val? Dokumentera eller aktivera buffering för icke-kritiska anrop                       |
| 18  | CORS loggar `console.warn` per request — brusigt i produktion                                                                                                                                                    | `apps/api/src/main.ts:110-111`                                                                                                      | Logga bara avvisade origins, en gång per origin                                                  |

---

# SVEP 2 — djupgranskning av flöden (2026-07-07)

Fem parallella agenter på ytor som svep 1 inte täckte: betalnings-/kravtrappe-tillstånd
end-to-end, GDPR-radering/export/loggläckor, rollmodellen (inkl. AI-vägen), bred
multi-tenant-isolation, kraschåterhämtning i kärnflöden. Numrering fortsätter (#19→).

**Övergripande:** den härdade bokföringskärnan och kravtrappan står sig (dubbeltrigg, VOID
mitt i trappan, unmatch, färskhetsgrind, bank-matchning: verifierat rena). Nya fynden sitter
i (a) ett allvarligt tenant-isolationshål i `leases.update`, (b) en rollinversion i AI-vägen,
(c) GDPR-radering som lämnar denormaliserad PII kvar, och (d) status-skrivning före/utan
transaktionsskydd i randflöden (deposition-refund, avi-SENT-semantik, termination, CSV-import).

## 🔴 MÅSTE FÖRE LANSERING (svep 2)

### 19. `leases.update` läcker främmande orgs hyresgäst-PII (IDOR, personnummer)

**Problem:** `apps/api/src/leases/leases.service.ts:264-318` (skrivning rad 300-304), via
`leases.controller.ts:102`. `update()` verifierar att _avtalet_ tillhör orgen och org-scopar
`unitId` (rad 275-279), men applicerar klient-skickat `dto.tenantId` **rått** utan
`tenant.findFirst({ id, organizationId })`. Svaret returnerar med `tenant: SAFE_TENANT_SELECT`
som innehåller **personnummer, namn, e-post, telefon, adress, orgnr**. En angripare i org A
gör `PATCH /leases/{egetLeaseId}` med `{ "tenantId": "<tenant-id i org B>" }` → uppdateringen
lyckas och svaret läcker offrets fullständiga PII. Dessutom korrumperas data (avtalet pekar på
främmande orgs hyresgäst). Allvarligare än de tre kända create-buggarna (#5) — detta är en
**update med läsläckage av personnummer**. `invoices.update` (rad 397-408) gör det rätt och är
mönstret att kopiera.

**Fix:** org-scopad `tenant.findFirst({ where: { id: dto.tenantId, organizationId } })` (kasta
NotFound) innan `tenantId` appliceras — spegla `unitId`-mönstret i samma metod.

### 20. Rollinversion i AI-vägen — ACCOUNTANT kan utföra MANAGER/ADMIN-mutationer

**Problem:** `apps/api/src/ai/tools/tool-executor.service.ts:582-607` gör rollkontroll med
**exakt strängjämförelse** (`userRole === 'MANAGER'` / `=== 'VIEWER'`) i stället för
hierarkin i `RolesGuard`. Följd: **ACCOUNTANT (nivå 2) faller genom alla vakter** och får köra
i princip alla action-verktyg utom `prepare_contract_signing` — en större uppsättning än
MANAGER (nivå 3), som är whitelist-begränsad till 8 verktyg. Via `/ai/chat` + `/ai/confirm`
kan en ACCOUNTANT därmed göra mutationer som HTTP-lagret nekar dem. Allvarligast:
**ACCOUNTANT kan terminera hyresavtal** (`transition_lease_status` → `TERMINATED`) fast HTTP
kräver **ADMIN** (`leases.controller.ts:70`). Även skapa/ändra fastighetsbestånd, avier,
besiktningar, underhåll (alla MANAGER via HTTP). `userRole` kommer från JWT (ej spoofbart),
men behörighetsnivån i sig är fel. VIEWER blockeras korrekt; bokförings-/inkasso-verktyg och
signering är korrekt grindade; tenant-AI:n är korrekt org/tenant-scoped.

**Fix:** mappa varje action-verktyg till en `UserRole`-miniminivå och jämför mot
`ROLE_HIERARCHY` (samma logik som `RolesGuard`), i stället för punktvisa `===`-kontroller.

### 21. GDPR-radering lämnar denormaliserad persondata kvar (Art. 17)

**Problem:** Portalens självservice-radering `deleteTenantAccount`
(`apps/api/src/tenant-portal/tenant-portal.service.ts:964-993`) maskerar bara fälten på
`Tenant`-raden (rätt princip: BFL kräver 7 års bevarande av räkenskapsmaterial). Men eftersom
raden anonymiseras i stället för att raderas triggas aldrig Cascade, och denormaliserad PII
**utanför bokföringskravet** lämnas kvar och anonymiseras aldrig:

| Kvarvarande PII                                                                                           | Referens                           | Allvarlighet                  |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------- |
| `AiTenantConversation`/`AiTenantMessage` (hela chatthistoriken; Cascade triggas ej)                       | `schema.prisma:2090-2117`          | HÖG                           |
| `KeyHandover.issuedToName` + `notes` (namn, ej räkenskapsmaterial)                                        | `schema.prisma:2987,2991`          | HÖG                           |
| `FailedEmail.to` + `payload` (e-post + full mejl, ingen FK till tenant → nås aldrig)                      | `schema.prisma:2859,2861`          | HÖG                           |
| `SentMessage.content`/`subject` (meddelandehistorik med fritext-PII)                                      | `schema.prisma:2703-2704`          | MEDEL                         |
| `Document.signatureName`/`signedFromIp`/`signedUserAgent`                                                 | signeringsspår                     | MEDEL                         |
| `Invoice-/RentNoticeEvent.actorLabel`+`payload` (namn/e-post; eget känt ärende i DESIGN_DECISIONS.md:491) | `schema.prisma:1194,2469`          | MEDEL (delvis bokföringsnära) |
| R2-blobbar (dokument/bilder) raderas aldrig — bara DB-metadata                                            | `deleteTenantAccount` rör ingen R2 | MEDEL                         |

**Fix:** utöka anonymiseringen till att maskera/radera de icke-bokföringsbundna posterna ovan
(inkl. R2-objekt), eller radera dem där de saknar bevarandekrav. Kräver en medveten lista
"bevara (BFL) vs anonymisera (GDPR)".

### 22. Hyresvärdens `tenants.remove` kraschar 500 på verkliga hyresgäster

**Problem:** `apps/api/src/tenants/tenants.service.ts:268-291` gör hård `tenant.delete`. Guards
blockerar bara aktiva leases/öppna fakturor, men schemat har **Restrict** (utan `onDelete`) på
`Lease`, `RentNotice`, `Deposit`, `KeyHandover`, `ConsumptionCharge`, `MiscCharge`
(`schema.prisma:1086,2385,2900,3000,3227,3294`). Varje hyresgäst med _historik_ (avslutat
kontrakt, gamla avier) ger rå `P2003` → delete kastar 500, ingen anonymiseringsfallback. I
praktiken går verkliga hyresgäster inte att radera alls.

**Fix:** låt hyresvärdens radering falla tillbaka på samma anonymisering som portalen (#21) när
historik finns, i stället för hård delete. Löser #21 och #22 tillsammans.

## 🟠 BÖR FÖRE LANSERING (svep 2)

### 23. Betalning som ej täcker ränta flippar avi till PAID → strandad räntefordran (INV-S bryts)

**Problem:** `computeRentDebt` sätter `ocrOutstanding` exkl. ränta
(`apps/api/src/avisering/rent-debt.service.ts:125-126`). Både `markAsPaid`
(`avisering.service.ts:1202`) och `applyMatchToRentNotice` (`reconciliation.service.ts:1131,
1169-1184`) flippar avin till PAID + `collectionStage=NONE` så snart `ocrOutstanding<=0` — även
om `interestAccruedAmount>0`. `crystallizeInterest` returnerar sedan null för PAID
(`rent-interest.service.ts:102`) och exportgrinden blockerar PAID
(`rent-collection-export.service.ts:319`). Scenario: avi påminns (ränta kristalliseras),
hyresgästen betalar exakt hyra+förbrukning+påminnelseavgift men inte räntan → avin blir PAID
medan `outstanding` (inkl. ränta) > 0. Räntefordran ligger kvar på 1510/8131, faller ur alla
crons och all export → **INV-S bryts (PAID men outstanding>0)** och räntan blir en strandad,
oindrivbar 1510-post. Utvecklarna noterar själva att per-avi-rekonciliering av 1510 saknas
(`rent-bad-debt.service.ts:376-381`).

**Fix:** flippa inte PAID medan `outstanding>0` (räntan inräknad); antingen håll avin öppen för
räntedelen eller boka av räntefordran medvetet vid ocr-täckt betalning. Kräver produktbeslut om
hur restränta ska hanteras.

### 24. Faktura-`/pay` bokför alltid full total, ignorerar angivet belopp (delbetalning omöjlig)

**Problem:** `invoices.controller.ts:140-148` skickar `enteredAmount`, men
`markAsPaidManually` (`apps/api/src/invoices/invoices.service.ts:589-595`) sätter
`settlementAmount = Number(invoice.total)` och flippar PAID ovillkorligt. En operatör som
registrerar en delbetalning bokför hela fakturabeloppet mot likvidkonto/1510 och markerar PAID
→ likvidkontot överdrivs, status motsäger faktiskt mottaget belopp. Faktura-`PARTIAL` (enum +
`PAYMENT_PARTIAL`-mappning, rad 33) är i praktiken **död/oåtkomlig** — fakturor saknar
delallokeringsmodell (till skillnad från hyresavier).

**Fix:** respektera `enteredAmount`; boka bara mottaget belopp och sätt PARTIAL när
`< total`. Alternativt: dölj delbetalning i UI tills modellen finns, och dokumentera gapet.

### 25. Deposition-återbetalning skriver status utan verifikat, ingen revert

**Problem:** `apps/api/src/deposits/deposits.service.ts:302-325` — `refund()` flippar
`deposit.status` → REFUNDED/FORFEITED/PARTIALLY_REFUNDED och anropar SEDAN
`createJournalEntryForDepositRefund` **icke-transaktionellt** i ett `try/catch` som bara
loggar. Saknas 1930/2890 i kontoplanen eller DB-hicka → depositionen visas som återbetald men
skulden på 2890 reverseras aldrig → fantomskuld utan motverifikat, ingen återställning (till
skillnad från `markAsPaid` som ångrar statusen).

**Fix:** kör statusflip + verifikat i samma `$transaction` och kasta vid fel (samma mönster som
`cancelNotice`).

### 26. Manuell `markAsPaid` (hyresavi) är icke-atomisk

**Problem:** `apps/api/src/avisering/avisering.service.ts:1206` (status-claim) och `1253-1275`
(allokering + verifikat) körs i **separata** top-nivå Prisma-anrop (bankvägen kör allt i ett
`$transaction`, `reconciliation.service.ts:1092`). En hård processkrasch mellan claim-commit
och allokering lämnar avi=PAID/`paidAmount` satt men utan `RentNoticePayment` → den
allokeringsderiverade `outstanding()` returnerar full skuld → INV-S bryts. Normala fel fångas
av revert (rad 1305-1321); en processkrasch kringgår reverten.

**Fix:** slå ihop claim + allokering + verifikat i ett `$transaction`.

### 27. Avi/faktura kan säga "SENT" fast mejlet aldrig gick ut; bounce av original är tyst

**Problem:** `apps/api/src/avisering/avisering.service.ts:542-565` sätter status SENT direkt
efter att mejlet **köats** (Bull), inte efter leverans. Töms alla 5 retries skapas en
`FailedEmail`-rad (`mail.worker.ts:146-157`) men inget flippar `RentNotice`/`Invoice` tillbaka
till FAILED → status säger "skickad" fast mejlet aldrig lämnade systemet. Dessutom persisteras
ingen Resend-`messageId` för original-avin/fakturan, så en **bounce** av just den blir en tyst
no-op i webhooken (`resend-webhook.service.ts:126-165` korrelerar bara påminnelser +
inbjudningar). Ingen larmas. (Påminnelseflödet är rent — leverans verifieras, inkasso-grinden
blockerar på bounce.)

**Fix:** flippa status till FAILED när mejljobbet dör; persistera messageId på original-avi/
faktura och hantera bounce i webhooken (minst larm).

### 28. Massimport av leaseavtal (CSV) icke-transaktionell, ingen dedup, kan fastna

**Problem:** `apps/api/src/import/import.service.ts:552-669`, körs **synkront** i
HTTP-requesten (`import.controller.ts:48`). Rad-för-rad `create` utan `$transaction`; timeout/
deploy mitt i → halva raderna committade, `ImportJob` fastnar i PROCESSING. `importLeases`
saknar dessutom dubblettkontroll (properties/units/tenants har det) → samma fil igen skapar
dubbla kontrakt för samma hyresgäst+enhet (var och en flippar enheten OCCUPIED). Bankimporten
är i kontrast robust (draft-rad, FAILED vid parse-fel, dedup, idempotent confirm).

**Fix:** kör importen i bakgrundsjobb (som kontrakts-batchskanningen), transaktionellt per rad
eller med dedup-nyckel (org, enhet, hyresgäst, period).

### 29. Termination approve är inte atomisk → begäran kan fastna permanent i PENDING

**Problem:** `apps/api/src/terminations/terminations.service.ts:119-129` — `leases.terminate()`
och `terminationRequest.update(APPROVED)` körs i två steg utan `$transaction`. Krasch emellan →
kontraktet är uppsagt men begäran står kvar PENDING, och ett nytt approve-försök misslyckas
(`leases.terminate` kastar på icke-aktivt kontrakt) → begäran fastnar permanent, kräver manuell
DB-rättning.

**Fix:** kör båda stegen i ett `$transaction`.

## 🟡 MINDRE (svep 2 — dokumenterat)

| #   | Problem                                                                                                                                                                               | Referens                                                                                                      | Föreslagen fix                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 30  | Överbetalning via manuell `markAsPaid` (hyresavi) bokförs helt → 1510 blir negativ (kundkredit), döljs (outstanding klampas till 0). Bankvägen avvisar överbetalning — asymmetri      | `apps/api/src/avisering/avisering.service.ts:1253-1275` vs `reconciliation.service.ts:1147-1149`              | Grinda överbetalning även på manuella vägen, eller exponera kundkrediten         |
| 31  | Unmatch återställer inte kravsteget — felmatchad INKASSO_READY-avi tappar steget permanent, måste klättra om från dag 7 (konservativt/säkert, men state-regression)                   | `apps/api/src/reconciliation/reconciliation.service.ts:1500-1513`                                             | Överväg att återställa `collectionStage` vid unmatch inom X dagar                |
| 32  | "Exportera mina data" (Art. 15) saknar ConsumptionCharge, MiscCharge, KeyHandover, SentMessage, AiTenant-chatt, TerminationRequest, Deposit                                           | `apps/api/src/tenant-portal/tenant-portal.service.ts:874-953`                                                 | Lägg till saknade tabeller i exporten                                            |
| 33  | E-post loggas i klartext på flera ställen                                                                                                                                             | `tenant-auth.service.ts:361,384,650`, `tool-executor.service.ts:1319`, `notifications.service.ts:388,485,586` | Maskera e-post i loggar (eller logga bara id)                                    |
| 34  | Full URL inkl. query/token skickas till Sentry (`setTag('path', request.url)`) och sparas i ErrorLog-context (+ IP = PII)                                                             | `apps/api/src/common/filters/global-exception.filter.ts:34,45-56`                                             | Strippa query/token ur URL före Sentry/ErrorLog; överväg IP-hantering            |
| 35  | Portal-aktivering saknar dataskyddsinfo/samtycke (Art. 13) — ingen privacy-policy-länk eller acceptedTerms vid aktivering (hyresvärds-User har det)                                   | `apps/api/src/tenant-portal/tenant-auth.service.ts:227-263`                                                   | Lägg Art. 13-info + policy-länk i aktiveringsflödet                              |
| 36  | Hyresvärds-API returnerar personnummer i list-svar (`findAll`) där det sällan behövs (dataminimering)                                                                                 | `apps/api/src/tenants/tenants.service.ts:96-129, SAFE_TENANT_SELECT:34,40`                                    | Utelämna personnummer i listvyn, bara i detalj vid behov                         |
| 37  | Hyreshöjning: juridiskt meddelande köas före `status→NOTICE_SENT`, ingen idempotensnyckel → krasch efter enqueue ger dubbelt meddelande vid omskick                                   | `apps/api/src/rent-increases/rent-increases.service.ts:225-250`                                               | Idempotensnyckel + sätt status i samma steg                                      |
| 38  | Ingen graceful shutdown: `enableShutdownHooks()`/SIGTERM saknas → Bull-workers dräneras ej och Puppeteer städas ej vid Railway-deploy (mildras av idempotens + Bull stalled-recovery) | `apps/api/src/main.ts:174`, `apps/api/src/invoices/pdf.service.ts:52`                                         | `app.enableShutdownHooks()` + SIGTERM-dränering av köer                          |
| 39  | AI: verktyg muterar data, sedan sparas assistent-meddelandet separat → krasch emellan ger mutation utan chatt-spår (revisionslogg finns men är fire-and-forget)                       | `apps/api/src/ai/ai-assistant.service.ts:776-810`                                                             | Persistera tool-resultat i samma tx som mutationen, eller säkra logToolExecution |

---

## 🔬 SVEP 3 — Hyreskontraktets HELA livscykel (2026-07-07)

**Källa:** fem parallella read-only-granskningar av kontraktets livscykel (skapande/aktivering,
löptid, övergångar, avslutning, omöjliga tillstånd). Findings #40–#63. Alla är BEKRÄFTADE via
kodläsning om inget annat anges (MISSTÄNKT = plausibelt men ej fullt reproducerat). Flera fynd
bekräftades oberoende av flera granskare (särskilt förnyelse- och `leases.update`-hålen).

**Rotmönster (går igen i #40–#45, #49):** `Lease`-raden behandlas som enda sanningskällan vid
förnyelse/byte/redigering, men följdentiteter (RentIncrease, Deposit, Document, RentNotice,
Unit.status) har implicit 1:1-koppling till ett `leaseId` som aldrig omprövas/migreras när
kontraktet "byter identitet" eller redigeras. Ingen gemensam "lease succession/edit"-abstraktion.

### 🔴 MÅSTE (aktiv skada, tyst intäktsbortfall eller juridiskt ogiltigt)

#### 40. `leases.update` låter ADMIN ändra hyran på ett ACTIVE-avtal → kringgår hela hyreshöjningslagen

`leases.service.ts:264-331` har ingen spärr mot att ändra `monthlyRent` när `status==='ACTIVE'`
(`UpdateLeaseDto` = `PartialType(CreateLeaseDto)`, inget fält låst efter aktivering). **Live i UI:**
`apps/web/.../LeasesPage.tsx:199-210` (`handleUpdate` skickar alltid `monthlyRent`), "Redigera"-knapp
visas oavsett status (`:823-826`), hyra-inputen alltid redigerbar (`LeaseForm.tsx:864-865`). Hela
`RentIncreasesService`-flödet (3-mån varsel, invändningsfrist, meddelande till hyresgäst) kringgås —
nästa avi genereras direkt med ny hyra, hyresgästen får ingen avisering/invändningsrätt. **BEKRÄFTAT
end-to-end (API + UI).** Fix: lås `monthlyRent`/`unitId`/`tenantId`/datum på ACTIVE, tvinga ändringar
via rätt domänflöde (RentIncrease resp. förnyelse).

#### 41. Deposition som betalas via aktiverings-avin spåras ALDRIG i `Deposit`-modellen (obokförda pengar)

Aktivering skapar en `RentNotice{type:DEPOSIT}` om `lease.depositAmount>0`
(`avisering.service.ts:365-379`) men **aldrig** en `Deposit`-rad — enda `deposit.create` är den
manuella admin-vägen (`deposits.service.ts:149`). Depositions-avin exkluderas dessutom medvetet från
bokföring (`avisering.service.ts:118`, `accounting.service.ts:1082`) eftersom "deposits-modulen äger
1510/2890-flödet" — men den modulen äger ingenting eftersom raden aldrig skapas. Följd: betald
deposition bokförs aldrig (1930 stämmer inte mot skuld till hyresgäst), och `markRefundPendingForLease`
(`deposits.service.ts:332-343`) hittar ingen `Deposit{PAID}` vid uppsägning → ingen återbetalning
triggas. **BEKRÄFTAT** (verifierat: deposit-avi skapas :365, enda `deposit.create` :149).

> **T2-plan granskad 2026-07-08** (bokförings-expert + code-reviewer + hyresjurist): **Riktning D** enhälligt
> godkänd (behåll avin, skapa länkad `Deposit` + boka 1510 D/2890 K, gör avin matchbar; härdningen #109
> byggdes redan för detta — `reconciliation:1235`-carve-out + typ-agnostisk booking finns). MÅSTE-korrigeringar
> från granskningen: (1) T2.1a+T2.1b = EN atomisk commit (annars F1-fällan via omvänd ordning); (2) **backfill/
> gating för BEFINTLIGA orphan-DEPOSIT-avier** — un-gate av computeRentDebt gör dem matchbara → 1930 D/1510 K på
> obokförd 1510 (gata matchning på länkad Deposit, fail-closed); (3) **#42 renewal-orphan är REDAN LIVE** och T2
> gör den systematisk — `markRefundPendingForLease` tyst no-op när Deposit ligger på förnyat-bort leaseId; (4)
> markPaid utan Invoice bokför inget (aktiverings-Deposit har invoiceId:null) → ny metod + EN kanonisk manuell
> betalväg; (5) **#73 (nytt LIVE-fynd):** refund-klockan triggas vid uppsägning (`terminate()`), inte avflytt
> (`terminateExpiredNoticeLeases`/endDate) → falska återbetalningslarm ~2-3 mån för tidigt, kan släppa säkerheten
> under uppsägningstiden; (6) #56 deductions: kategori+dokumentref, cap mot `RentDebtService.outstanding()`, ta
> bort 3040→1510-fallback; (7) `Lease→Deposit onDelete: Cascade` bör bli Restrict (BFL-7år, som #FIX 3).
>
> **T2.1 BYGGD 2026-07-08 (bokförings-expert GODKÄND, väntar user money-review + PR):** `Deposit.rentNoticeId
@unique`-länk; aktivering skapar `Deposit{PENDING}` + bokar 1510 D/2890 K ATOMISKT (kastar annars → Deposit
> aldrig utan accrual); reconciliation-DEPOSIT-gren FAIL-CLOSED (matchbar bara med länkad Deposit) → 1930 D/1510 K
>
> - Deposit→PAID; `computeRentDebt` ORÖRD (gating en nivå upp); idempotent bootstrap-backfill; markPaid-guard.
>   Bevisat live (verifikatrader: create 1510/2890, match 1930/1510, netto 1510=0 + 2890 K kvar; orphan omatchbar;
>   backfill konverterar; kravtrappa orörd) + 14 unit-tester. **Nya uppföljningar (bokförings, ej blockerande):**
>   (8) backfill av orphan-avi vars createdAt ligger i STÄNGD räkenskapsperiod misslyckas fail-closed → behöver
>   administrativ rättelseväg (bokning på dagens datum, BFL 5:5); (9) `Deposit.leaseId @unique` är en förutsättning
>   T1/#42-succession måste designa runt (flera depositioner per lease över tid kräver schemaändring). **Kvar i T2.2:**
>   #73 refund-trigger, markPaid-utan-Invoice-bokväg, #56 (atomicitet+cap+ta-bort-3040-fallback), onDelete Restrict.
>
> **T2.2 BYGGD 2026-07-08 (bokförings-expert + hyresjurist GODKÄNDA):** #73 refund-trigger flyttad från
> terminate() till terminateExpiredNoticeLeases (utflytt, ej notice-date) + daglig catch-up-sweep
> (`sweepTerminatedLeasesForRefundPending`); markPaid-bokväg för avi-länkad deposit (`createJournalEntry
ForDepositManualPayment`, 1930 D/1510 K) + `avisering.markAsPaid` blockerar DEPOSIT (en kanonisk väg);
> refund() atomisk + race-säker claim; 3040→1510-fallback BORTTAGEN (saknat 3040 → error). Bevisat live
> (verifikatrader) + 24 unit. **CAP-beslut bekräftat:** cap onödig nu (utan 1510-routing kan ingen
> kundreskontra-divergens uppstå); den hör ihop med rent-arrears-kategori + allokeringar = följd-PR.
> **NYA FÖLJD-ÄRENDEN:** (F1, egen liten PR — beslut 2026-07-08) manuell `deposits.create()` (invoiceId-länkad)
> synkar aldrig `Deposit.status` vid BANKMATCHNING (`applyMatchToInvoice` rör bara Invoice) → den depositionen
> kan aldrig återbetalas; fix = additiv Deposit.status-synk i applyMatchToInvoice för Invoice.type=DEPOSIT,
> ELLER fasa ut den manuella vägen till förmån för #41-aktiveringsvägen. (F2) lås-ordning markPaid vs
> applyMatchToRentNotice (deadlock-risk, penganeutral). (F3) kategori+dokumentref+cap+RentNoticePayment-
> allokeringar för rent-arrears-avdrag (1510-reglering ist. f. 3040). (F4) `DeductionDto.reason` MinLength.
> (F5) `remindStaleRefundPending` 30→14 dagar. **Kvar helt separat:** onDelete: Restrict (egen liten PR).

#### 42. Deposition strandar på det döda kontraktet vid förnyelse

`Deposit.leaseId` är `@unique` (`schema.prisma:2884`). Varken `renew()` (`leases.service.ts:716-756`)
eller `autoRenewExpiredFixedTerm()` (`:804-836`) rör `Deposit` — den blir kvar på det EXPIRED-avtalet.
Vid senare uppsägning av det nya avtalet letar `markRefundPendingForLease` på nya `leaseId`, hittar
inget, returnerar tyst → depositionen fastnar permanent i `PAID`, ingen återbetalnings-påminnelse. UI
visar dessutom "ingen deposition" på det aktiva kontraktet. **BEKRÄFTAT.**

#### 43. Kontraktsförnyelse mitt i månaden → resterande dagar faktureras ALDRIG (tyst intäktsbortfall)

`renew()` och `autoRenewExpiredFixedTerm()` (`leases.service.ts:686-757`, `:783-844`) skapar nya
kontraktet direkt som ACTIVE utanför `transitionStatus()` → `enqueueInitialNotices` körs aldrig.
Månadsavin för förnyelsemånaden skapades 1:a mot det GAMLA leaseId (t.o.m. utgångsdagen); nya avtalets
dagar (utgång→månadsslut) får ingen avi förrän nästa månads cron (som bara täcker kommande hel månad).
Dagarna däremellan är tyst obetalda vid varje icke-månadsskifte-förnyelse. **BEKRÄFTAT.**

#### 44. Bakdaterad aktivering → mellanliggande månader faktureras aldrig

Inget skydd mot `startDate` i det förflutna (`leases.service.ts:207-262`).
`createInitialNoticesForLease` skapar bara EN avi för `startDate`-månaden
(`avisering.service.ts:352-355`); den återkommande cronen (`generateMonthlyNotices`) plockar bara
kontrakt som är ACTIVE vid körningen. Kontrakt med `startDate=1 jan` som aktiveras 15 april → feb+mars
faktureras aldrig, ingen felnotis. **BEKRÄFTAT.**

#### 45. Uppsägning: explicit `effectiveDate` kringgår HELT uppsägningstidens golv (juridiskt ogiltigt)

`terminate()` (`leases.service.ts:634-651`) validerar bara att `effectiveDate` inte är i det förflutna
— ingen kontroll mot `lease.noticePeriodMonths`. Via `approve()`
(`terminations.service.ts:101-123`) eller direkt `PATCH /leases/:id/terminate` kan en OWNER/ADMIN säga
upp en bostadshyresgäst med en dags varsel. Frontend sätter `min` = idag, inte det juridiska golvet
(`TerminationsPage.tsx:272-277`). Testsviten kodifierar t.o.m. beteendet
(`terminations.service.spec.ts:74-91`). Juridiskt ogiltig uppsägning (tvingande regler till
hyresgästens förmån) — hyresgästen behåller besittningen. **BEKRÄFTAT.**

#### 46. Uppsägning: default-slutdatum rundas inte till månadsskifte (~24 dagar för kort, systematiskt)

`addMonths(today, N)` (`leases.service.ts:38-48,647`; duplicerat i `terminations.service.ts:29-35,85-89`
och i frontend `TerminationsPage.tsx:60-69`) räknar exakt N kalendermånader. Uppsägning ska gälla vid
det månadsskifte som infaller närmast efter N hela månader — koden avrundar aldrig uppåt. Ex (idag
2026-07-07, bostad 3 mån): koden ger 2026-10-07, korrekt är 2026-10-31 → ~24 dagar för kort, för
**varje** icke-korrigerad uppsägning. Saknar en gemensam `endOfNoticePeriod`-helper i `@eken/shared`.
**BEKRÄFTAT.**

#### 47. Dashboardens huvud-KPI:er ("Totala intäkter"/"Försenat belopp") är blinda för hela hyresaviseringen

`DashboardService.getStats()` (`dashboard.service.ts:59-99`, rad 74-81) aggregerar enbart `Invoice`
(**0** referenser till `RentNotice` i hela filen — verifierat). Men den automatiska hyresmotorn bokförs
i `RentNotice`, inte `Invoice`. En org som (som avsett) kör all hyra via avisering ser ~0 kr på
förstasidan (`DashboardPage.tsx:120-129`, generiska etiketter utan förbehåll), medan verkliga siffror
bara finns på separata Avisering-sidan. **BEKRÄFTAT.** (Skild från #8 som gäller beläggningsgrad.)

> **STATUS 2026-07-12 — HELA BLINDHETS-SVEPET STÄNGT (skuld + intäkt).** Klassen "finansiell KPI
> blind för RentNotice + ingen DEPOSIT-exkl" fanns bekräftat på **5 ytor**; alla harmoniserade mot
> **delade sanningskällor** (`OverdueDebtService.getOverdueSnapshot` för skuld, `AccountingService.
getRevenueTotal`/`getRevenueYearToDate` för intäkt) — återanvänd, aldrig kopierad:
>
> - **PR1 #196 (`e9575a1`)** — dashboard "Totala intäkter" = accrual Σ 3xxx (räkenskapsår-till-idag) + DEPOSIT-exkl.
> - **PR2 #197 (`d1ba033`)** — dashboard "Försenat belopp" = Σ `computeRentDebt().outstanding` OVERDUE RentNotice (klampad per avi, type≠DEPOSIT) + OVERDUE Invoice; nytt `@@index([organizationId,status])`.
> - **#199 (`11158a0`)** — månadsrapporten: skuld ur delade `OverdueDebtService` (extraherad ur PR2); dashboard + PDF visar samma siffra.
> - **#200 (`8fadae2`)** — AI-lagret (data-context + portfolio-analysis) läser skuld ur `OverdueDebtService`; AI säger nu samma förfallna skuld som dashboarden.
> - **#201 (`58843a2`)** — AI-lagret läser bokförd intäkt ur delade `getRevenueYearToDate` (Σ 3xxx accrual); "förväntad månadshyra" (run-rate) behållen men ärligt etiketterad, aldrig förväxlad med bokförd intäkt; FAKTUROR-lista antal-only.
>
> Alla fem FAR-granskade (bokforings-expert). Efter #201 bekräftade experten att **inga dolda
> Invoice-only-summor kvarstår i AI-lagret**.
>
> **Kvarvarande småföljder (ej blockerande, egen liten PR när tillfälle ges):**
>
> 1. `DashboardService.fiscalYearToDate` är en 4-raders spegel av perioden i `getRevenueYearToDate` →
>    låt dashboard anropa `getRevenueYearToDate` så perioden också får EN sanningskälla.
> 2. Om ett kassa-/inbetalt-mått önskas (t.ex. AI "hur mycket har betalats in i år"): bygg egen
>    `getCashReceivedYearToDate` ur `RentNoticePayment` + `Invoice`-betalningar — ALDRIG återinför
>    Σ `Invoice` PAID-delmängd (kassa-blind, missar RentNotice-betalning).

> **Koppling:** #43/#44 och hyreshöjnings-tappet vid förnyelse fördjupar känd **#3** (hyreshöjnings-cron
> på döda avtal). #45/#46 är samma juridiska tema; #29 (approve-atomicitet) och #25 (deposit-refund
> utan verifikat) kvarstår bekräftade i samma kodvägar.

### 🟠 BÖR (funktionella hål, felaktig data/UX, ej omedelbar juridisk skada)

#### 48. Förnyelse/hyresgästbyte genererar ingen ny kontrakts-PDF (Tindra-regression)

`renew()`/`autoRenewExpiredFixedTerm()` går inte via `transitionStatus()` → ingen
`enqueueGenerateContract` (`leases.service.ts:716-756`, `:814-830`). Tenant-byte via `update()`
(`:264-331`) rör inte befintliga `Document`-rader → gammalt kontrakts-PDF med FEL hyresgästs namn/pnr
står kvar som "gällande avtal" tills någon manuellt regenererar (ingen sådan endpoint finns). Samma
symptom som produktionsincidenten "Tindra" (ACTIVE utan PDF). **BEKRÄFTAT.**

#### 49. `leases.update` med nytt `unitId` synkar inte `Unit.status` + saknar konfliktkontroll (I1/#62-regression)

`update()` (`leases.service.ts:264-331`) anropar aldrig `syncUnitStatusFromLeases` (till skillnad från
`transitionStatus`/`renew`/`autoRenew`/`terminateExpired`) — `unit-status.sync.ts:12-20` varnar
uttryckligen för exakt detta. Byte av enhet på ACTIVE-kontrakt → gamla enheten fast `OCCUPIED`, nya
aldrig `OCCUPIED`. Saknar även `describeActiveBlocker`/`isActiveUnitConflict` → konflikt mot
`lease_unit_active_unique` ger rå P2002/500 i stället för svenskt 400. **BEKRÄFTAT.**

#### 50. Ingen differentiering Hyreslagen (JB 12 kap) vs Privatuthyrningslagen

**→ ÅTGÄRDAD (uppsägningstider) av #69 (byggd 2026-07-08).** `Lease.tenancyRegime` + regim-/initiator-styrd
`terminationNoticeMonths`. _Kvar av #50 utanför uppsägningstider:_ besittningsskydd + hyressättning
(fri hyra/skälighetsprövning) modelleras fortsatt inte — separata ärenden.

`leases.compliance.ts:7-9` (`minNoticePeriodMonths`) applicerar alltid JB-golvet (3 mån bostad/9 mån
lokal) baserat enbart på `UnitType` — ingen modellering av vilket regelverk som gäller. Evenos
kärnsegment (privatpersoners uthyrning) lyder ofta under privatuthyrningslagen (annan uppsägningsrätt,
inget fullt besittningsskydd, fri hyra med skälighetsprövning). Arkitektur-gap, ej aktiv skada.
**BEKRÄFTAT.**

#### 51. Hyreshöjningens tystnadsverkan kräver manuell klick — ingen auto-accept/påminnelse

`applyDueIncreases` processar bara `status:'ACCEPTED'`; `accept()` nås bara via manuell
`PATCH /rent-increases/:id/accept` (`rent-increases.controller.ts:44-47`), inget cron/påminnelse
(grep-verifierat). Löper invändningsfristen ut utan invändning är höjningen juridiskt bindande — men
systemet uppdaterar aldrig `monthlyRent` förrän en människa klickar. Glöms det → höjningen ligger kvar
i `NOTICE_SENT` för evigt. Motsäger "maximal automatisering". **BEKRÄFTAT.**

#### 52. Förbrukningsdebitering: fakturerar nuvarande hyresgäst + slutavläsning efter avslut tappas

(a) `consumption.service.ts:611-668` läser `lease.tenantId` färskt vid faktureringstillfället; om
hyresgästen bytts (möjligt via #40/#49-vägen) faktureras fel person för föregångarens el/vatten.
(b) `resolveLease` (`:424-456`) kräver ACTIVE-lease VID lästillfället; slutavläsning efter utflytt (då
kontraktet redan är TERMINATED) matchar ingen lease → ingen `ConsumptionCharge`, ingen varning →
sista periodens förbrukning faktureras aldrig. **BEKRÄFTAT.**

#### 53. Portalen visar aldrig delbetalning — statisk skuldsiffra trots registrerad betalning

Bankavstämningens delbetalningsgren behåller medvetet status/kravsteg och uppdaterar bara
`paidAmount`-spegeln (`reconciliation.service.ts:1185-1193`), men `SAFE_PORTAL_RENT_NOTICE_SELECT`
exkluderar explicit `paidAmount`/`payments` (`tenant-portal.service.ts:219,225-251`) och visar bara
statiskt `payableTotal`. Hyresgäst som betalat 8 000 av 10 000 ser "10 000 kr att betala, försenat".
Backend-bokföringen är korrekt — det är bara den yta hyresgästen ser som ljuger. **BEKRÄFTAT.**

#### 54. En trasig avi tystar hela orgens avigenerering + utskick för dagen

`generateMonthlyNotices`-loopen (`avisering.service.ts:189-311`) saknar per-lease try/catch runt
`rentNotice.create`/OCR/nummerallokering; schedulern fångar bara per ORG (`scheduler.ts:60-83`). Ett
enskilt lease-fel (transient DB-fel, P2002-race) kraschar hela orgens körning → efterföljande leases
får ingen avi, och redan skapade avier mejlas aldrig ut den dagen. **BEKRÄFTAT (struktur); utlösande
fel MISSTÄNKT.**

#### 55. `properties.remove`/`units.remove` kraschar 500 på enheter med HISTORISKA kontrakt (samma klass som #22)

Båda guardar bara mot `status:'ACTIVE'`-leases (`properties.service.ts:103-114`,
`units.service.ts:98-112`), men FK är `ON DELETE RESTRICT` utan statusvillkor. Fastighet/enhet med ett
avslutat/EXPIRED-kontrakt (normalt) → rå P2003 → okontrollerad 500 vid legitim städning. Ingen
PII/GDPR här — enklare fix än #22 (blockera vid NÅGON lease-koppling, eller soft-delete). **BEKRÄFTAT.**

#### 56. Slutavräkning mot deposition ej kopplad till verklig skuld/dokumentation

`refund()` (`deposits.service.ts:269-328`) tar en fri `deductions`-lista utan koppling till
`RentDebtService.outstanding()` eller dokumenterade `MiscCharge`/besiktningsposter. Risk: full
återbetalning trots kvarstående skuld (dubbel förlust), eller odokumenterade avdrag som inte håller i
hyresnämnd. Kopplar till känd **#25**. **BEKRÄFTAT.**

#### 57. Redigering av datum på ACTIVE-avtal + uppsägning mitt i cykel utan avstämning mot redan genererade avier

`leases.update` (`:264-331`) saknar konsistenskontroll mot befintliga `RentNotice.periodStart/End` när
`startDate`/`endDate` ändras; `terminate()` (`:634-682`) krediterar/annullerar aldrig en redan skapad
avi för innevarande månad om uppsägning beslutas efter att månadsavin genererats (särskilt i kombination
med #45). Ingen mekanism för retroaktiv justering/kreditering. **BEKRÄFTAT frånvaro / MISSTÄNKT scenario.**

#### 58. Aktivering saknar atomicitet DB↔kö + ingen manuell retrigger för misslyckad initial-notices

`transitionStatus()` committar status=ACTIVE i `$transaction` och enqueuear PDF/mejl/avi-jobb
**efteråt** (`leases.service.ts:352-429`, inget outbox). Krasch däremellan → permanent ACTIVE utan
aktiverings-artefakter, ingen SYSTEM-notis (den ligger i workerns `@OnQueueFailed` som aldrig triggas).
Vid permanent jobbfel lovar notisen "Skapa manuellt från avisering-sidan" (`worker:93-94`) men
`createInitialNoticesForLease` exponeras av ingen controller → åtgärden finns inte. **BEKRÄFTAT
(retrigger-gap) / MISSTÄNKT (krasch-fönster).**

#### 59. Enda DB-skyddet mot dubbeluthyrning är ett `schema.prisma`-osynligt partiellt index

`lease_unit_active_unique` (migration `20260426120000_lease_active_unique`) är verifierat aktivt men
finns bara i migrations-SQL, inte i `schema.prisma` (`:1100-1103` säger "sync manuellt"). En framtida
`prisma migrate dev` kan tolka det som drift och generera en DROP → nästa `migrate deploy` tar bort det
enda DB-skyddet mot två ACTIVE-leases på samma enhet. Samma drift-klass har redan inträffat en gång
(`Organization_status_idx`). **BEKRÄFTAT nuläge OK / MISSTÄNKT framtida risk.**

### 🟡 MINDRE (dokumenterat — fixa när tid finns)

- **60. Ingen central lease-statusmaskin.** `VALID_TRANSITIONS` (`leases.service.ts:28-31`) gate:as bara
  i `transitionStatus()`; tre andra ställen skriver `status` direkt (`renew`/`autoRenew`/
  `terminateExpired`). Alla är idag giltiga övergångar, men av konvention — ingen delad
  `assertValidTransition()`, ingen export till `@eken/shared` (jfr `INVOICE_TRANSITIONS`). En framtida
  kopia av mönstret kan skriva en ogiltig övergång ostört.
- **61. DTO saknar `endDate>startDate` och `monthlyRent>0`.** `CreateLeaseSchema.refine` finns i
  `packages/shared/.../schemas:238-255` men används ingenstans (orphanad); `CreateLeaseDto` tillåter
  `endDate<startDate` och `monthlyRent=0` → negativ proration i första avin. Bryter "@eken/shared som
  enda sanning".
- **62. Andrahandsuthyrning saknas som datamodell.** Ingen `Sublease`/subtenant-modell; "andrahand"
  finns bara i AI-kunskapsbas/genererad avtalstext. Funktionsgap, ingen bugg.
- **63. Diverse mindre:** (a) välkomstmejlets Bull-`jobId` är per-tenant (`lease-activation.queue.ts:74`)
  → två snabba aktiveringar för samma hyresgäst kan dedupas tyst (MISSTÄNKT, låg påverkan);
  (b) edit-formuläret visar en hyresgäst-väljare som ignoreras vid spara (`LeaseForm.tsx:625-647` vs
  `LeasesPage.tsx:199-210`) — missvisande UX, men just nu det enda som håller #52a borta från webb-UI:t;
  (c) lokalhyra saknar varning om indirekt besittningsskydd/ersättningsrisk vid uppsägning;
  (d) uppsägningsgolvet för korta FIXED_TERM-avtal är striktare än lagen kräver (ej skadligt);
  (e) cron-race `autoRenewExpiredFixedTerm` ↔ `applyDueIncreases` i samma `Promise.all`
  (`leases.service.ts:768-773`) gör hyreshöjnings-tappet (#3/#43) deterministiskt.

### ✅ Verifierat FRISKT i livscykeln (undvik felaktig omrapportering)

- **Kravtrappan är korrekt frikopplad från `Lease.status`** — påminnelse/ränta/inkasso/kundförlust
  filtrerar bara på `RentNotice`-fält + betalningsderiverad skuld (`rent-debt.service.ts`), aldrig
  `lease.status`. Verklig skuld tappas INTE vid avslut; eskalering stannar korrekt vid `ocrOutstanding<=0`
  oavsett om hyresgästen flyttat. Principen "skuld är beräknat tillstånd" efterlevs.
- **En aktiv lease per enhet** — tvålagers-skydd (`describeActiveBlocker` + partiellt DB-index +
  `isActiveUnitConflict`-catch) i create/transition/createWithTenant. (Se #59 för skörheten, #49 för
  update-vägen som saknar det vänliga felet.)
- **ACTIVE utan hyresgäst är omöjligt** — `Lease.tenantId` NOT NULL + FK RESTRICT + DTO-validering + #19.
- **Avslutstatus + avi-stopp korrekt** — kontrakt stannar ACTIVE (med `terminatedAt`) till `endDate`,
  blir TERMINATED + frigör enhet först då; `calculateProratedRent` klipper mot `endDate` framåtriktat.
- **Historiska snapshots korrekta** — `RentNotice.totalAmount`/`Invoice.total` fryses vid skapande; en
  senare höjning ändrar inte historiska avier.
- **Förnyelse är atomisk** (`$transaction`, per-lease try/catch) — ingen halvskapad lease vid krasch
  (till skillnad från #29/termination). Problemen i #42/#43/#48 är att följdentiteter inte flyttas, inte
  atomicitet.

---

## ✅ Verifierat friskt (2026-07-07)

- `pnpm typecheck`: 6/6 paket gröna, 0 fel.
- `npx jest` (apps/api): 115 sviter / 1 062 tester, alla gröna, 160 s.
- Döda knappar/länkar/modaler/formulär i `apps/web`: 0 fynd — alla `<Link>`-mål finns i
  route-trädet, alla modaler kan öppnas, alla formulär är kopplade till mutationer.
- Front↔back-kontrakt (web/portal/admin mot alla controllers + DTO:er): konsekvent, enda
  avvikelsen är #13 ovan. Inga metod-/path-/payload-mismatchar (viktigt givet
  `forbidNonWhitelisted`).
- Vercel-rewrites + SPA-fallback: korrekta i alla tre appar.
- Puppeteer/Docker-flaggor (`--no-sandbox`, `--disable-dev-shm-usage`, sidsemafor 5): OK.
- JWT-secrets fail-fast vid boot (`getOrThrow`): OK.
- Notifications-/påminnelse-cron: atomära sentinel-lås, idempotenta: OK.
- IDOR-scoping i keys/terminations/units/users/customers/properties + (svep-2-verifierat)
  misc-charges/rent-increases/consumption/deposits: OK. **OBS:** `inspections` stod tidigare
  här men hade i själva verket hålet (se #5) — nu åtgärdat. Kvarvarande rå-relations-id-klass:
  leases.update (#19) + maintenance/documents/inspections/news (#5) — samtliga stängda.

---

## 🗺️ SVEP 3 — ÅTGÄRDSPLAN (granskad 2026-07-08)

**Status:** Kartläggning + fyra specialistgranskningar (bokförings-expert, hyresjurist, code-reviewer,
ai-architect) klara. Ingen produktionskod skriven. Granskningen bekräftade rotmönstret men fann **fem
fynd som inte finns i #40–#63**, varav **två är live-buggar i produktion**. Kartan är verifierad mot
faktisk kod (`leases.service.ts`, `avisering.service.ts`, `deposits.service.ts`, `accounting.service.ts`,
`reconciliation.service.ts`, `terminations.service.ts`, `rent-increases.service.ts`, `schema.prisma`,
AI-verktygslagret).

### Rotmekanismen (verifierad)

Två distinkta identitetsbyten hanteras ad-hoc, ingen delad abstraktion (`grep succession/carryForward/
repointLease` → 0 träffar):

1. **Succession** (`renew`/`autoRenewExpiredFixedTerm`): nytt `leaseId`, skapas ACTIVE **utanför**
   `transitionStatus()` → tappar gap-avi (#43), PDF (#48), deposit strandar (#42), pending RentIncrease
   pekar på död lease (fördjupar #3).
2. **In-place edit** (`leases.update` på ACTIVE, samma `leaseId`): ingen fältlåsning → #40, #49, #57, #52a.

`syncUnitStatusFromLeases` är den enda delade seam:en — `update()` glömmer den.

### 🆕 Nya fynd (utanför #40–#63)

- **#64 [🟠 KORRIGERAD 2026-07-08 — INTE live på main] Deposit-avier kan inte bankavstämmas → betald
  deposition bokförs aldrig (2890 skrivs aldrig).** _Ursprunglig hypotes (ogrundad 1510-kreditering) var
  FALSE POSITIVE på nuvarande main:_ `createJournalEntryForRentNoticePayment` saknar mycket riktigt
  `type===DEPOSIT`-koll, MEN den nås aldrig för en deposition — `computeRentDebt` returnerar `ZERO_DEBT`
  för DEPOSIT (`rent-debt.service.ts:101-103`, bank-härdning **#105** `80cf9d0`), och
  `applyMatchToRentNotice` bailar på `if (remaining.lte(0)) return false` (`reconciliation.service.ts:1131`,
  **#109** `306c824`) FÖRE bokföringsanropet. Enda anroparen är just den blockerade grenen. `type!==DEPOSIT`
  vid det gamla throw:et är död defensiv kod. **Faktiskt beteende:** deposit-avin hittas som OCR-kandidat,
  avvisas vid `remaining=0`, faller till UNMATCHED → pengarna ligger i banken men krediteras aldrig 2890.
  **Rätt fix ägs av #41/T2.1** (skapa Deposit-rad + boka 1510 D/2890 K vid aktivering, gör avin matchbar,
  reconciliation stänger 1930 D/1510 K) — kan inte fixas isolerat. **VERIFIERAT i kod + empiriskt** (dev:
  2 DEPOSIT-avier, 0 med 1510-betalningsverifikat). _Historisk risk (pre-#105, då depositioner kan ha varit
  matchbara):_ read-only audit-query levererad (`scratchpad/audit-deposit-1510-misbooking.sql`) — kör i prod.
- **#65 [🔴 LIVE — ÅTGÄRDAD (F2, byggd 2026-07-08)] AI säger upp via annan kodväg.**
  `transition_lease_status→TERMINATED` anropade `transitionStatus()` (rå flip), inte `terminate()`.
  **Fix:** `transitionStatus(ACTIVE→TERMINATED)` DELEGERAR nu till `terminate()` i service-lagret → golvet
  gäller AI + HTTP /status + /terminate. **Hyresjurist-granskning fann en FJÄRDE väg:** `PATCH /leases/:id`
  (`update()`) kunde sätta `endDate` fritt på ett ACTIVE-kontrakt (golv-bypass, MANAGER-nåbar). **Stängd:**
  `update()` nekar nu endDate-ändring på ACTIVE (hänvisar till /terminate resp. /renew). Alla fyra vägar
  bevisade live end-to-end (golvade till 2026-10-31; update-vägen nekad).
  _Juridik-uppföljning (ej blockerande, hyresjurist):_ (a) golv-villkoret bör även kräva att tillträde
  passerat (`today >= startDate`, JB 12:6 2 st sista meningen); (b) rollasymmetri /status (MANAGER) vs
  /terminate (ADMIN/OWNER) — nu när /status ger bindande uppsägning; (c) ömsesidig förtida-överenskommelse-väg
  (samtycke golvas ej); (d) #50 privatuthyrningslagen (hög prio).
- **#66 [🔴 — ÅTGÄRDAD (F2)] `terminate()` saknade golv + rundning.** **Fix:** `terminate()` clampar upp
  ett för kort `effectiveDate` till golvet `endOfNoticePeriod(idag, lease.noticePeriodMonths)`; DRAFT
  undantaget (ingen uppsägningstid). Ligger i service-lagret (ingen väg kringgår). #50 (privatuthyrning
  1/3 + hyresvärd/hyresgäst-asymmetri) MEDVETET utanför scope — uppföljning.
- **#67 [🔴 — ÅTGÄRDAD (F2)] månadsskiftesrundning.** **Fix:** delad `endOfNoticePeriod` i `@eken/shared`
  (addMonths månadsdrift-säker + runda upp till månadsskifte); ersätter duplicerad `addMonths` i
  leases/terminations/web. FIXED_TERM-förnyelse behåller exakt-N-månader (ingen rundning) — korrekt.
- **#68 [🟠] Edit-låsets fältlista för snäv (juridik).** `includes*`-booleaner, `parkingFee/storageFee/
garageFee`, alla `index*`-fält är hyresvillkor (JB 12:19), inte "mjuka". `noticePeriodMonths` får ej
  höjas fritt på bostad (hyresgästens 3-mån-rätt, 5 §, är oberoende + tvingande).

#### F2-uppföljning (hyresjurist-granskning av uppsägningsgolvet, ej blockerande för F2)

- **#69 [🟠 HÖG PRIO — ÅTGÄRDAD (byggd 2026-07-08)] #50 privatuthyrningslagen (2012:978).**
  Lag 2012:978 § 3: hyresgäst 1 mån / hyresvärd 3 mån (bara bostad). **Fix:** nytt fält
  `Lease.tenancyRegime` (PRIVATE_RENTAL | TENANCY_ACT) + `terminationNoticeMonths(regime, initiator,
unitType, contractual)`; `terminate()` tar `initiator` (default LANDLORD, `approve()` → TENANT). Golvet
  (F2) clampar upp med rätt tid: privatuthyrning-hyresgäst 1 mån, hyresvärd 3 mån; hyreslagen OFÖRÄNDRAT.
  **Default = TENANCY_ACT för ALLA (nya + befintliga), ingen backfill** (hyresjurist-CRITICAL + användar-
  beslut 2026-07-08): privatuthyrningslagen § 1 gäller bara egen bostad UTANFÖR näringsverksamhet och kan
  inte härledas från enhetstyp — Evenos kundbas är näringsidkare (`CompanyForm` = enbart bolagsformer).
  Asymmetrin i felriktning avgör: default TENANCY_ACT kan ALDRIG ge en ogiltig (för kort, besittnings-
  skydds-kringgående) uppsägning; default PRIVATE_RENTAL kunde. **PRIVATE_RENTAL är medvetet opt-in per
  kontrakt** (`CreateLeaseDto.tenancyRegime`, lokal nekas); regimen bärs vidare vid förnyelse. Golv-logiken
  tillämpar rätt tid när regimen väl är satt. Bevisat live end-to-end (default→hyreslag, opt-in→1/3 mån,
  ingen ogiltig upps. via default) + 22 unit-tester. Löser #50 (uppsägningstider).
  **Uppföljning:** (a) **→ T1.1 edit-lås:** kriteriefråga vid skapande ("äger du bostaden privat / ej
  näringsverksamhet?") som sätter PRIVATE_RENTAL medvetet + möjlighet att ändra regim per kontrakt
  (edit-regime) — så privatuthyrare får sin 1-månadersrätt via ett MEDVETET val, aldrig en riskabel
  default. Båda hör till T1.1 edit-lås-ytan (#68). (b) kontraktsmallen speglar inte asymmetrisk
  uppsägningstid (relevant först när opt-in används skarpt); (c) besittningsskydd + hyressättning per
  regim modelleras inte (utanför uppsägnings-scope, pre-existing #71).
- **#70 [🟡] Tillträde-villkor på golvet (JB 12:6 2 st sista meningen).** `terminate()`-golvet villkoras på
  `status === 'ACTIVE'`, inte på om tillträdesdagen passerat. Ett ACTIVE-avtal med framtida `startDate`
  (undertecknat, ej tillträtt) som sägs upp ska upphöra **genast** (6 § 2 st), men golvas idag till fulla
  3/9 mån. Fix: byt villkor till `status === 'ACTIVE' && today >= lease.startDate`. Missgynnar ingen akut
  (golvet gör snarast avtalet längre), men blockerar enheten i onödan.
- **#71 [🟡] Rollasymmetri /status vs /terminate.** `/terminate` kräver ADMIN/OWNER; `/status` tillåter
  MANAGER. Nu när `/status`→TERMINATED delegerar till `terminate()` (bindande uppsägning med rättsverkan)
  bör åtkomstnivån vara konsekvent. (Kopplar till S-B rollinversion.)
- **#72 [🟡] Ingen väg för genuint ömsesidig förtida-överenskommelse.** `terminate()` golvar ALLTID. Ett
  samtyckesbaserat tidigareläggande (hyresgästen vill flytta ut tidigare, hyresvärden godkänner) är inte en
  ensidig försämring (1 § 5 st skyddar bara mot ensidigt pålagt) och bör inte golvas — men saknar idag väg.
  Kräver explicit "hyresgästen samtycker till förtida upphörande"-flagga (för att inte bli en golv-bakväg).
- **#74 [🟠 — EGET ÄRENDE, ej succession-seam (beslut 2026-07-08)] FIXED_TERM utan klausul som förfaller
  och ej sägs upp ska bli INDEFINITE (JB 12:3 3 st p1).** Hyresjurist-fynd vid succession-kartläggningen:
  `autoRenewExpiredFixedTerm()` hoppar korrekt över avtal UTAN `renewalPeriodMonths` (`continue`), men gör
  då INGENTING alls. Enligt JB 12:3 3 st p1 ska ett tidsbestämt avtal som saknar bestämmelse om verkan av
  utebliven uppsägning, och som passerat slutdatum utan uppsägning, **i lag anses förlängt på obestämd tid**.
  Eveno flaggar/uppdaterar inte `leaseType`→INDEFINITE → systemets bild (FIXED_TERM, förfallet datum bakåt)
  desyncar från rättslig verklighet. AUTO-ÖVERGÅNG, inte succession — eget ärende (egen liten flip-logik i
  cronen: FIXED_TERM utan klausul + endDate passerat + terminatedAt null → sätt INDEFINITE, ingen ny lease).
  Motsatsen (auto-förnyelse till nytt FIXED_TERM) är juridiskt korrekt eftersom `renewalPeriodMonths`-
  klausulen faktiskt skrivs ut i kontraktstexten (verifierat, carve-out 3 st p1) — så de två fallen är rätt
  åtskilda.

### 🆕 Systemiska ärenden (större än Svep 3)

- **S-A: ~~Inget räkenskapsårslås finns~~ KORRIGERAD 2026-07-08 — det FINNS.** Bokförings-granskningen av
  T2 hittade `ClosedAccountingPeriod` (`schema.prisma:1350`) + `VerifikationsnummerService.allocate()`
  (kastar `ConflictException` om datum ligger i stängd period), körs i `createNumberedEntry` för VARJE
  verifikat. Den tidigare grep:en missade det (annan namngivning). #44-backfill är alltså redan skyddad
  mot att skriva i stängt år. _Kvar:_ backfill-poster (t.ex. gamla deposit-avier, T2) måste köras INNAN
  en period stängs, annars blockeras de.
- **S-B: #20-klass rollinversion på lease-AI-verktyg.** `transition_lease_status`/`create_lease`/
  `create_tenant_and_lease` släpper igenom ACCOUNTANT → gata till OWNER/ADMIN (spegla
  `prepare_contract_signing`). `create_tenant_and_lease` bör dubbelbekräftas.
- **S-C: Hyresförhandlingslagen 3 § ej inläst** — öppen fråga om §54a-tystnadsverkan ens är rätt regel
  för Evenos standardkund (liten privat värd utan förhandlingsordning). Eget granskningsärende.

### Tema-ordning + PR-plan (granskad, beslutad)

**Ordning:** Live-fixar → T1 → T2 → T3 → T4 → T5.

**Snabbfixar först (beslut 2026-07-08 — egna små PR:er, oberoende av refaktoreringen):**

- **~~F1 → #64~~ INSTÄLLD (2026-07-08):** utredning visade att #64 inte är en live-felbokning på main
  (bank-härdningen #105/#109 blockerar deposit-matchning helt). En `1930 D/2890 K`-fix byggd och verifierad
  korrekt på accounting-lagret, men grenen är oåtkomlig och en isolerad fix planterar en landmina för #41
  (som öppnar en 1510-fordran att stänga). **Vikt in i #41/T2.1** (beslut). Read-only prod-audit för
  historiska pre-#105-felbokningar levererad (`scratchpad/audit-deposit-1510-misbooking.sql`).
- **F2 → #65 + #66:** golv + endDate-beräkning + deposit-trigger i `transitionStatus(TERMINATED)` (så
  BÅDE människa och AI täcks), eller re-peka AI-verktyget till en `prepare_termination`-seam. Delad
  `roundUpToMonthEnd`-helper (#67) ingår. **Nu högst prio bland snabbfixarna** (F1 inställd).

**T1 — Övergångar & redigering (rot):**

- **T1.1 Lås redigeringsytan på ACTIVE** (#40, #49, #57, #52a) — GUARD-ONLY i **service-lagret** (AI +
  framtida verktyg passerar aldrig controllern). Fält-tier (hyresjurist):
  - _Tier 1 hårt låst:_ `monthlyRent`, `tenantId`, `unitId`, `startDate`, `endDate`, `leaseType`,
    `depositAmount`, alla `includes*`, `parkingFee/storageFee/garageFee`, alla `index*`,
    `noticePeriodMonths` (låst bostad; lokal endast via auditerat tillägg).
  - _Tier 2 mjuka:_ `specialTerms`, `usagePurpose`, `petsAllowed` (endast lättnad), `sublettingAllowed`,
    `requiresHomeInsurance`, `indexNotes`.
  - **Regim-yta (från #69):** exponera `tenancyRegime` i skapande-/edit-flödet med en juridisk
    kriteriefråga ("äger du bostaden privat / ej näringsverksamhet?") som medvetet sätter PRIVATE_RENTAL, - möjlighet att ändra regim per kontrakt. Backend-fältet + validering (lokal nekas) finns redan (#69);
    detta är UI/flödes-delen så privatuthyrning blir ett medvetet val, aldrig en default.
    > **SUCCESSION-SEAM — KARTLAGD + 3 SPECIALISTGRANSKNINGAR (2026-07-08).** bokförings-expert +
    > code-reviewer + hyresjurist granskade planen mot faktisk kod. Ordning **LÅST: T1.2 (refaktor) FÖRST,
    > sen T1.3 (pengar/juridik)**. Kärnfakta: `JournalEntry`/`JournalEntryLine` har **ingen FK mot `Lease`**
    > (verifikat keyade på `sourceId`/`accountId`) → re-pekning av `Deposit.leaseId` är ren metadata, BFL-säker,
    > kräver ingen omföring. Två LIVE-buggar utöver #42/#43/#48: **(a) RentIncrease-på-dött-avtal** —
    > `applyDueIncreases` skriver `monthlyRent` på gamla (EXPIRED) leaseId + flippar APPLIED → höjningen
    > konsumeras tyst; **(b) villkorsförlust** — renew/autoRenew kopierar bara ~10 fält, tappar resten till
    > schema-defaults, inkl. **`monthlyRentExcludingVat`** (🔴 CRITICAL moms — momspliktig lokal slutar tyst ta
    > ut 2611, ML 1994:200) och `consumptionBillingMode`.

- **T1.2 Central statusmaskin + delad activation-seam** (#60) — **refaktor, FÖRST.** Bygger seam:en till
  EN plats utan att lägga ny domänrisk.
  - **3-lagers uppdelning (code-reviewer):** tvinga INTE in create-shape (renew `tx.lease.create`) och
    update-shape (transitionStatus `tx.lease.update`) i en gemensam funktion. Dela i: (1)
    `allocateContractNumberIfNeeded(tx, orgId, existing)` (redan fristående primitiv); (2) callern gör sin
    EGEN update/create; (3) `applyActivationEffects(tx, {leaseId, unitId, orgId})` = BARA det gemensamma
    efterledet (`syncUnitStatusFromLeases`) — döp så namnet inte lovar mer än det håller.
  - **`dispatchActivationJobs(lease, {origin, actorUserId})` post-commit,** parametriserad:
    `origin:'manual'` (transitionStatus) → PDF + välkomstmejl + `initialNotices` (deposit + första avi);
    `origin:'succession'` (renew/autoRenew) → PDF + **gap-avi (`skipDeposit=true`, ingen deposit-avi)** +
    INGEN välkomstmejl (samma hyresgäst). `skipDeposit` tråds till `createInitialNoticesForLease`.
  - **Bevara i transitionStatus (får ej bakas in i seam:en):** `describeActiveBlocker` UTANFÖR tx
    (optimistisk check) + `isActiveUnitConflict`-catch (race-skydd) + `TERMINATED && ACTIVE`→`terminate()`-
    delegeringen (#65-golv). Succession anropar **ALDRIG** `describeActiveBlocker` (gamla leaset är ACTIVE
    tills det flippas → skulle falskt neka VARJE förnyelse).
  - **`assertValidTransition` → `@eken/shared`** (#60): gata BARA skrivningar på BEFINTLIGA rader
    (renew/autoRenew ACTIVE→EXPIRED, terminateExpired ACTIVE→TERMINATED, transitionStatus). INTE på
    `create` (nytt ACTIVE har ingen from-status). Alla 4 nuvarande övergångar är redan giltiga → ren
    assertion, ändrar inget beteende. `lease_unit_active_unique` är per-statement (ej deferrable) → ordning
    gammalt→EXPIRED FÖRE nytt→create är obligatorisk (redan korrekt, ska testas).
- **T1.3 Succession bär följdentiteter + villkor** (#42) — **pengar/juridik-tung, EFTER T1.2.**
  - **Villkors-carry via delad projektion:** `LEASE_SUCCESSION_CARRY_FIELDS` i `@eken/shared` =
    `LEASE_ACTIVE_LOCKED_FIELDS` (T1.1a) **minus `{monthlyRent, startDate}`** (renew får omförhandla hyra
    via `dto.monthlyRent`; startDate omräknas till oldEnd+1) **plus `{monthlyRentExcludingVat,
consumptionBillingMode}`**. 🔴 `monthlyRentExcludingVat` är CRITICAL (moms), inte kosmetik. Skyddas av
    ett **DMMF-baserat exhaustiveness-test**: varje skalärt `Lease`-fält måste finnas i carry-listan ELLER
    en explicit exkluderingslista (`id, organizationId, unitId, tenantId, status, startDate, endDate,
monthlyRent, activatedAt, terminatedAt, terminationReason, contractNumber, createdAt, updatedAt`) →
    ny kolumn failar CI (fail-closed, samma mönster som edit-låset). Fixar även `indexClauseType`-
    inkonsekvensen (idag kopieras `indexClause`-bool men inte typen).
  - **Deposition:** re-peka **ENDAST `Deposit.leaseId`** gammalt→nytt (bokförings-expert: `rentNoticeId`/
    `invoiceId` pekar på det HISTORISKA verifikat-underlaget (BFL 5:7) OCH bankmatchningen är keyad på
    `rentNoticeId` → får INTE röras). EFTER `tx.lease.create` (FK), samma tx, **org-scopat** (`findFirst
{leaseId, organizationId}`, FIX 2), **no-op om ingen deposition** (depositAmount:0 → ingen rad).
    **v1 ändrar INTE `Deposit.amount`** — höjd deposition vid förnyelse = separat framtida flöde
    (tilläggsavi 1510/2890 på deltat). `Lease.depositAmount`-fältet (avtalat värde) kopieras redan korrekt;
    T1.3 rör bara `Deposit`-ENTITETEN.
  - **RentIncrease vid förnyelse: BARA VOID-som-default + audit-log** (beslut 2026-07-08). **INGET
    repoint-undantag** — säker failure-riktning (försenad höjning, aldrig felaktig); repoint har flera
    villkor som alla måste stämma = subtil pengabugg-risk; hyresjuristen föredrar ren VOID (JB 12:19 —
    hyran ska vara till beloppet bestämd i det NYA avtalet). Voida pending `RentIncrease` för gamla leaset,
    logga audit-event (varför den aldrig applicerades).
  - **Härda `applyDueIncreases` (oberoende zombie-fix):** lägg `lease: { status: 'ACTIVE' }` i `where`
    (aldrig skriva `monthlyRent` mot icke-ACTIVE lease) OCH **serialisera**: kör `autoRenewExpiredFixedTerm`
    (inkl. VOID-steget) HELT före `applyDueIncreases` i `processLifecycle` — ta bort dem ur samma
    `Promise.all` (READ COMMITTED serialiserar dem INTE; det är en daglig 06:00-cron, ingen latensbudget).
  - **Validering i renew/autoRenew:** lägg `minNoticePeriodMonths`/`maxDepositAmount` (create/update har
    dem; renew saknar helt → sänkt hyra kan spränga 3×-depositionstaket).
  - **Gap-avi:** förfallodag enligt JB 12:20 ("kortare tid än en månad" → före periodens start), inte
    standard månadslogik; klassificera INTE gap-perioden som "den första" perioden. Proration via delad
    `calculateProratedRent` (oldEnd+1 = exklusiv gräns, verifierat glappfri). Test: manuell `renew()` samma
    dag som `generateMonthlyNotices` → gamla avtalets sista prorata-avi måste ändå genereras.
    > **⚠️ FÖRUTSÄTTNING:** `Deposit.leaseId @unique` = EN deposition per lease → succession kan INTE skapa
    > ny Deposit, MÅSTE re-peka. Flera depositioner per lease över tid (ny efter återbetalning) kräver
    > schemaändring (deposition-historik) — utanför T1.3-scope.

  > **✅ T1.3 BYGGD + GRANSKAD 2026-07-09** (branch `feat/t13-succession-carry`, cc046f8 + 13a82fc;
  > 3 specialistgranskningar godkända; moms-verifikat 2611 live-bevisat Σd=Σk; 142/142 suites gröna).
  > Utöver planen: **EXPIRED-grind** (bokförings-expert HIGH) — generisk `transitionStatus(ACTIVE→EXPIRED)`
  > (HTTP + AI-verktyget) gatas nu på passerat slutdatum, annars skapades ett föräldralöst EXPIRED-avtal
  > utan succession-sideeffects som via EXPIRED-inkluderingen i månadsgenereringen fortsatte faktureras.
  > **Follow-ups från T1.3-granskningarna (beslut 2026-07-09: noterade, EJ nu):**
  >
  > - **F-T1.3:1 [🟠 hyresjurist] 54 a §-gate på RentIncrease-flödet:** `create()`/`accept()` saknar
  >   `leaseType`-kontroll — tystnadsverkans-flödet (NOTICE_SENT→ACCEPTED) kan tillämpas på FIXED_TERM
  >   trots att JB 12:54 a 1 st p 1 kräver avtal på obestämd tid. Gate mot `INDEFINITE`.
  > - **F-T1.3:2 [🟡 hyresjurist] UI-bekräftelse i förnyelseflödet:** visa "N väntande höjningar
  >   annulleras" INNAN `renew()` anropas (idag bara efterhandsnotis, best-effort).
  > - **F-T1.3:3 [🟠 hyresjurist, JB 12:3 3 st] Eskalering av strandade ACTIVE-avtal förbi endDate:**
  >   compliance-blockerad autoRenew (och gamla `renewalPeriodMonths == null`-grenen, som är HELT tyst)
  >   lämnar avtalet ACTIVE förbi endDate med engångsnotis/ingen notis. Bor hyresgästen kvar >1 mån utan
  >   anmodan att flytta övergår hyresförhållandet ENLIGT LAG till obestämd tid oavsett DB-status.
  >   Upprepat/eskalerande larm >30 d + koppla till #74 (auto-övergång till INDEFINITE).
  > - **F-T1.3:4 [🟡 code-reviewer] Orphan-RentIncrease-sweep:** manuell `renew()` kan raca den dagliga
  >   cronens `applyDueIncreases` mitt i körningen → ACCEPTED-höjning strandad på EXPIRED-avtal (aldrig
  >   APPLIED/VOIDED — pengasäkert men skräpar rapporter för alltid). Nattlig själv-läkning i
  >   `processLifecycle`: VOIDa pending höjningar vars lease inte är ACTIVE.
  > - **F-T1.3:5 [🟡 bokförings-expert] `supersededByLeaseId` som strukturellt facit:** status+endDate-
  >   heuristiken i månadsgenereringens EXPIRED-inkludering är skör mot framtida statusvägar — en explicit
  >   efterträdar-länk satt av `applySuccessionSideEffects` är robustare. Samordnas med **T1.3b**
  >   (`predecessorLeaseId` — samma länk, två riktningar).
  > - **F-T1.3:6 [⚪ code-reviewer] `@@index([organizationId, status])` på Lease** — månadsgenereringens
  >   OR-where saknar komposit-index; ofarligt i nuvarande skala.

- **T1.3b Kontinuitetslänk** (`predecessorLeaseId`, hyresjurist HIGH) — **EGEN PR EFTER T1.3** (annan yta:
  migration + genomsökning av vem som läser `Lease.startDate` som varaktighets-proxy). Flera JB-regler
  räknar på HYRESFÖRHÅLLANDETS sammanlagda tid, inte enskilda avtalet (3§3st 9 mån, 46§ p9 3 år, 55e§ 1 år,
  35§ byte) → varje förnyelse nollställer tyst klockan via `startDate` och kan UNDERSKYDDA hyresgästen.
  Lägg en ärvd länk/"hyresförhållande-sedan"-tidsstämpel.
- **T1.4 Bakdaterad debitering** (#44) — #43 löses redan av T1.2. Kvar: `startDate` i förflutet →
  backfill saknade hela månader endast i öppet räkenskapsår (S-A), annars hård spärr.

  > **🔒 PLAN LÅST 2026-07-10** (kartlagd + två specialistgranskningar, båda "hållbar-med-villkor";
  > användarbeslut på 3 öppna punkter). **Buggen:** `createInitialNoticesForLease`
  > (`avisering.service.ts:343`) skapar bara EN avi för `startDate`-MÅNADEN; månadscronen
  > `generateMonthlyNotices` (`avisering.service.ts:167`, cron `0 7 1 * *`) plockar bara ACTIVE-vid-körning.
  > `startDate` 1 jan + aktivering 15 april → feb+mars+april aviseras ALDRIG. Distinkt från T1.3/#43
  > (förnyelse-glapp) — ingen överlappning, #44 öppet.
  >
  > **MUST-krav (från granskningarna):**
  >
  > - **A [jurist CRITICAL] Människo-bekräftelse:** aldrig tyst auto vid aktivering. **Beslut: SEPARAT
  >   "att efterdebitera"-kö**, blockerar INTE aktiveringen (skilj snabb operativ handling från övervägt
  >   pengabeslut). Dialog "efterdebitera N mån (period X–Y), Z kr — bekräfta?". Varje rad periodtext
  >   ("Hyra feb 2026 — efterfakturerad pga sen registrering"), BFL-verifikat + JB 12:21.
  > - **B [jurist CRITICAL] Preskriptionstak:** JB 12:61 gäller EJ under pågående uthyrning — rätt spärr
  >   är Preskriptionslagen 2 § (bostad/konsument 3 år). \*\*Beslut: hård spärr >36 mån; manuell grind
  >   > 12 mån\*\* (>12 mån bakdatering = sannolikt DATAFEL, "ser konstigt ut"-spärr). Logga period per avi.
  > - **C [jurist HIGH] Kravtrappe-isolering:** backfill-avier får egen markör/typ, EXKLUDERAD från
  >   auto-eskalering (påminnelse→ränta→inkasso-ready) tills människa godkänt. Min 30 dagars frist (ej
  >   1-veckas bostadsfrist), annars blir adminfel förverkandegrund → oskäligt JB 12:42 sista st.
  > - **D [båda] Framåtklampad förfallodag + framåt-ränta:** `rentDueDateForPeriodStart` (T1.3), aldrig
  >   historisk. Ränta endast från nya förfallodagen — explicit dokumenterad eftergift (Räntelagen 3–4 §),
  >   ej implicit. Backfill = alltid "steg 1", ingen retroaktiv påminnelseavgift.
  > - **E [bokförings] Atomicitet + per-månad stängd-koll:** stängd-period-för-koll PER MÅNAD i loopen
  >   (backfill spänner över stängd/öppen-gräns); stängt → skapa INGEN avi + SYSTEM-notis (ej orphan;
  >   not-i-öppen-period vore fel per K2/K3 rättelse). Notis+verifikat ATOMISKT per månad (`$transaction`)
  >   — `tx`-param på `createJournalEntryForRentNotice`, spegla `bookReminderFee`. Fixa tyst `return null`
  >   vid saknat 1510/intäktskonto (`accounting.service.ts:1159`) → logga `error`.
  > - **F [bokförings MEDIUM] Momsperiod-varning:** momsperiod ≠ räkenskapsår (SFL 26 kap). Backfill av
  >   momspliktig LOKAL in i redan-deklarerad period → VARNING (ej spärr; deklarationsrättelse = människans
  >   beslut).
  > - **Dubbeldebitering:** `@@unique([leaseId,year,month,type])` (hård DB-constraint) + idempotens-förkoll
  >   per månad → re-körning/cron-overlap = no-op.
  >
  > **PR-ordning (låst):**
  >
  > - **PR0 — bokförings-härdning (FÖRST, fristående värde):** `tx`-param på `createJournalEntryForRent-
Notice`/`bookRentNoticeRevenue` (spegla `bookReminderFee`) + error-logg vid saknat 1510/intäktskonto
  >   (idag tyst `return null`). Fixar befintlig orphan-avi-risk oavsett #44 (samma princip som PSD2 P0).
  > - **PR1 — backfill-motor (backend):** gap-detektion → **PREVIEW** (skapar/skickar INGET själv); per-
  >   månad-loop med stängd-period-för-koll (E), atomisk notis+verifikat (E), framåtklampad förfallodag (D),
  >   backfill-markör kravtrappe-exkluderad (C), preskriptionstak 36/12 (B), dokumenterad framåt-ränta (D).
  > - **PR2 — bekräftelse-kö + UI (A):** "att efterdebitera"-kö skild från aktivering; bekräftelse triggar
  >   PR1-motorn; manuell retrigger-endpoint (täcker även #58-gapet); ev. staggrade fakturor för stora belopp.
  > - **PR3 — momsperiod-varning (F):** liten fristående.
  > - **Följd (ej T1.4):** reconciliation-job som hittar `RentNotice` utan matchande `JournalEntry`.
  >
  > Granskningsprocess: rapport innan varje PR → användaren granskar (bokföring) → bokförings-expert sista
  > grind → INGEN självmerge. Full karta + krav i minnet (`project_t14_bakdaterad_debitering`).
  >
  > **✅ PR0 MERGAD** (#191, 78cca0a): tx-atomicitet + orphan-avi-logg. **✅ PR1 BYGGD + GRANSKAD 2026-07-10**
  > (branch `feat/t14-pr1-backfill-engine`; bokförings-expert godkänd-m-villkor, hyresjurist hållbar-m-villkor).
  > **Åtgärdat i PR1:** bokförings-CRITICAL (atomicitet höll ej vid saknat konto → `createJournalEntryForRent-
Notice` KASTAR nu under tx i alla 3 gren-fall, motorn får `skippedMissingAccount`-kategori + SYSTEM-notis);
  > hyresjurist-läcka (`tenant-portal.getNotices` saknade status-filter → PENDING backfill-avi syntes för
  > hyresgäst → filter tillagt, speglar `getRentNotices`); preskriptions-marginal (hård spärr `>=36` mån,
  > dag-säker).
  > **DEFERRED (låsta krav till PR2/PR3):**
  >
  > - **[PR2, hyresjurist] Audit-spår:** `createBackfillNotices.actorUserId` MÅSTE persisteras som
  >   `RentNoticeEvent` per skapad avi (vem godkände, `ageMonths`, `allowBeyondWarning` + skäl vid
  >   BEYOND_WARNING) — annars är "människo-bekräftelse" obevisad i tvist.
  > - **[PR2, hyresjurist] PDF-mall:** `isBackfill`-textgren ("Efterfakturerad hyra för perioden X–Y…")
  >   oavsett `isProrated`.
  > - **[PR2→PR3, bokförings HIGH] Momsperiod-varning:** PR2:s bekräftelse-UI får INTE exponeras för org med
  >   frivilligt skattskyldiga lokaler innan PR3 landat, ELLER PR2 lägger en disclaimer när
  >   `voluntaryTaxLiability` bland månaderna (redan deklarerad momsperiod → rättelsedeklaration = människans
  >   beslut, SFL 26 kap).
  > - **[PR2/release] Framåt-ränta:** manuell release får ALDRIG beräkna ränta retroaktivt från historisk
  >   månad — bara framåt från `backfillRentDueDate` (Räntelagen 3–4 §). Testas i release-PR.
  > - **[backlog, bokförings INFO] P2002-diagnos:** `RentBackfillService` tolkar all P2002 som "redan
  >   aviserad"; en (lågfrekvent, ärvd) `noticeNumber`-race felklassas som `skippedExisting`. Differentiera
  >   på `err.meta.target`.
  >
  > **✅ PR2 BYGGD + GRANSKAD 2026-07-10** (branch `feat/t14-pr2-backfill-confirmation-queue`; hyresjurist
  > HÅLLBAR 0 CRITICAL/HIGH, bokförings-expert GODKÄND-m-villkor; användaren granskade pengar+JB+moms +
  > godkände). Levererat: bekräftelse-kö skild från aktivering (`GET/POST avisering/backfill/queue|:leaseId/
preview|confirm`), actor-audit (`CREATED`-`RentNoticeEvent` i samma tx: actorId/ageMonths/beyondWarning/
  > allowBeyondWarning/period), PDF `isBackfill`-text (båda grenar) + bestridande-/kontaktrad, manuell
  > retrigger (#58 via kön över alla aktiva kontrakt). **Momsperiod-krav UPPGRADERAT (bokförings HIGH
  > infoldad):** ingen hårdspärr av momspliktig lokal (blankt block vore obokförda affärshändelser, BFL 4:1)
  > — i stället AKTIV grind: `vatDeclarationAcknowledged` (kryss + server-side `UnprocessableEntity` 422 om
  > momspliktig lokal utan ack + audit-loggat), speglar >12-mån-mönstret. Full svit 1350 grön; live E2E
  > bevisad (utan confirm→0 avier; moms 422 utan ack).
  > **✅ FÖLJD-PR MERGAD 2026-07-10** (PR #194, squash 0bdc533; grön CI; hyresjurist-MEDIUM + användaren
  > godkände): `ADMIN/OWNER` krävs för `allowBeyondWarning`-override, grindat server-side i
  > `RentBackfillService.createBackfillNotices` (money-binding-chokepunkten, ej bara controller/UI) →
  > `ForbiddenException` fail-closed, ingen anropare kan kringgå; MANAGER opåverkad för ≤12-mån; UI döljer
  >
  > > 12-mån-kryss för icke-ADMIN/OWNER. Live-bevisat per roll (MANAGER+override→403 0 skapade; MANAGER
  > > normal→13 billable+5 skippade; ADMIN+override→5 >12-mån skapade). **⚠️ Vid #20 (AI-rollinversion):
  > > verifiera att backfill-override-rollen hanteras konsekvent även där (samma behörighetsyta).**
  > > **PR3 (fristående):** momsperiod-varning periodspecifik (t.ex. `VatReportingPeriod`-spårning) så
  > > disclaimern blir "dessa N månader faller i en redan lämnad momsdeklaration" i stället för generisk.

**T2 — Deposition (PR-nedbruten):**

- **T2.1 → #41 + #64:** skapa `Deposit{PENDING, invoiceId:null}` i samma tx som deposit-avin vid
  aktivering; boka 1510 D/2890 K. Gör `markPaid()` `invoiceId`-agnostisk (annars öppen 1510 för
  aktiverings-deposit). **Ägar även #64:** gör deposit-avin bankmatchbar (idag zeroar `computeRentDebt`
  DEPOSIT → `applyMatchToRentNotice` bailar på `remaining<=0` → UNMATCHED) OCH låt reconciliation-grenen
  stänga fordran `1930 D/1510 K` för en deposit-avi (inte hyresvägens 1510-antagande). Måste samordnas:
  create-sidan (1510 D/2890 K) och match-sidan (1930 D/1510 K) i EN PR, annars felbokas 2890.
- **T2.2 → #56/#25:** `refund()` atomisk (status + verifikat i samma `$transaction`, kasta vid fel);
  `deductions` kopplas till `RentDebtService.outstanding()` + dokumentreferens; skilj skadeavdrag (3040)
  från hyreskvittning (1510-reglering).

**T3 — Uppsägnings-juridik:** #45/#46/#50 — mestadels täckt av F2 ovan (golv + rundning i
`transitionStatus`). Kvar: asymmetriskt hyresvärds-/hyresgäst-golv (bostad: hyresgäst alltid 3 mån
oavsett `noticePeriodMonths`), `FIXED_TERM`-särhantering, Privatuthyrningslagen (2012:978) inläst i
kunskapsbas (ej lanseringsblockerande).

**T4 — Läsmodell:** #47 (dashboard blind för RentNotice), #53 (portal delbetalning).

**T5 — Resten/resiliens:** #51, #54, #55, #58, #59, #61, #62, #63 + systemiska S-A/S-B/S-C.

### Verifierat friskt (bekräftat av granskningen — bryt INTE)

Kravtrappans frikoppling från `lease.status`, en-aktiv-lease-per-enhet (tvålagers), historiska snapshots,
förnyelsens atomicitet. T1.1 har idag **ingen bypass-yta** (7 `lease.update`-call-sites verifierade; AI
rör aldrig `update()`; enda externa `monthlyRent`-skrivaren är den lagliga RentIncrease-vägen).
