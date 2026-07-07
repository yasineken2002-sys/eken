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

### 1. Env-validering vid boot (stänger hela klassen "funkar i dev, dör tyst i prod")

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
