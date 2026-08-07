# Eveno (Eken) – Fullständig systemanalys

**Datum:** 2026-06-16
**Roll:** Senior SaaS-arkitekt + AI-produktarkitekt
**Omfattning:** Read-only analys av hela monorepot `/workspaces/eken`. Ingen kod ändrad.
**Källor:** `apps/api/prisma/schema.prisma` (3074 rader), ~46 NestJS-moduler, 4 frontend-appar, AI-modulen, säkerhets- och skalbarhetsgenomgång.

---

## Sammanfattning (TL;DR)

Eveno är ett **förvånansvärt moget, enterprise-grade fastighets-SaaS** byggt som modulär monolit. Kärnan – förvaltning, avisering, dubbel bokföring (BFL-korrekt), bankavstämning, inkasso-trappa och IMD – är inte en prototyp utan ett genomtänkt domänsystem med append-only revisionsspår, verifikationsnummerserier och praxisvalidering.

Det som gör produkten **särpräglad** är AI-lagret: assistenten är **inte en chatbot utan en agent** med 57 verktyg som kan utföra riktiga affärsåtgärder (skapa fakturor, bokföra, matcha bank, hantera inkasso) bakom human-in-the-loop-bekräftelse. Den har per-användarminne, sliding-window-historik, prompt caching i tre nivåer, en juridik-RAG (BM25+pgvector hybrid med Voyage + Haiku-domare) och Claude Vision för PDF/bilder.

**De största hålen är inte funktionella utan operativa och regulatoriska:** ingen databasbackup, personnummer i klartext (GDPR), saknad paginering på list-endpoints, ingen BankID, ingen automatisk bankkoppling (PSD2). Dessa gatas enligt CLAUDE.md av bolagsregistrering – men de är de verkliga blockerarna mot lansering och skala, inte fler features.

| Område                            | Mognad | Kommentar                                                |
| --------------------------------- | ------ | -------------------------------------------------------- |
| Domänmodell (förvaltning/ekonomi) | ★★★★★  | BFL-korrekt, append-only, praxisvaliderad                |
| AI-lager                          | ★★★★☆  | Agent med actions, RAG, vision – marknadsledande koncept |
| Frontend                          | ★★★★☆  | 3 separata SPA, modernt, designsystem                    |
| Säkerhet (auth/RBAC/audit)        | ★★★★☆  | Stark RBAC + audit; saknar BankID                        |
| GDPR/dataskydd                    | ★★☆☆☆  | PII i klartext, ingen backup                             |
| Skalbarhet                        | ★★★☆☆  | Bra för 100-tals; paginering/index/cron krävs för 10k+   |
| Integrationer (bank/signering)    | ★★☆☆☆  | Manuell filimport; ingen PSD2/BankID/Scrive              |

---

## 1. Teknisk arkitektur

### Frontend

- **Tre separata SPA + en övergiven app:**
  - `apps/web` (operatör/hyresvärd): React 18.3 + Vite 5.4 (SWC) + **TanStack Router** 1.66 + React Query 5.59 + Zustand 5 + React Hook Form + Zod. ~19+ feature-moduler. Radix UI, Lucide, Recharts, Framer Motion 12, Tailwind 3.4. Playwright E2E. Sentry React.
  - `apps/admin` (plattformsadmin): React 18 + Vite + **react-router-dom 6.28** + React Query + Zustand. 8 sidor (org-hantering, billing, errors, AI-usage).
  - `apps/portal` (hyresgäst): React 18 + Vite + react-router-dom + Vitest. Minimal CSS, session-store, egen API-klient.
  - `apps/landing`: övergiven (Next.js, bara byggartefakter).

### Backend

- **NestJS 10.4 + Fastify 5.8** (aldrig Express). Bootstrap i `apps/api/src/main.ts` (180 rader): Sentry/OpenTelemetry före Nest, `trustProxy:1`, `rawBody:true` (webhook-HMAC), global ValidationPipe (whitelist+forbidNonWhitelisted+transform), TransformInterceptor, GlobalExceptionFilter, Helmet CSP, multipart 20 MB, CORS-allowlist, URI-versioning `/v1`, Swagger (av i prod).
- **~46 feature-moduler**, 46 controllers, ~81 services. ThrottlerModule, ScheduleModule (cron), BullModule (Redis-köer), Terminus (health).
- **Globala guards:** `JwtAuthGuard` (default, `@Public()` undantar), `RolesGuard` (hierarki), `UserOrIpThrottlerGuard`.

### Databas

- **PostgreSQL via Prisma 5.19** + **pgvector** (RAG). Schema: 3074 rader, **69 modeller**, **155 `@@index`**, ~16 `@@unique`, **71 enums**. UUID-PK genomgående. Preview: `omitApi`, `postgresqlExtensions`.

### Huvudmodeller (urval)

`Organization`, `User`, `Property`, `Unit`, `Tenant`, `Customer`, `Lease`, `Invoice`/`InvoiceLine`/`InvoiceEvent`, `RentNotice`/`RentNoticeLine`/`RentNoticeEvent`/`RentNoticePayment`, `Account`/`JournalEntry`/`JournalEntryLine`/`ClosedAccountingPeriod`, `BankTransaction`/`BankStatementImport`, `Deposit`, `RentIncrease`, `TerminationRequest`, `MaintenanceTicket`(+Image/Comment), `MaintenancePlan`, `Inspection`(+Item/Image), `KeyHandover`, `Meter`/`MeterReading`/`ConsumptionTariff`/`ConsumptionCharge`, `Document`, `NewsPost`/`SentMessage`/`Notification`, AI-tabeller, `PlatformUser`/`PlatformInvoice`, `ErrorLog`/`FailedEmail`/`ImpersonationLog`, `LegalChunkEmbedding` (vector(1024)).

### Kommunikation frontend ↔ backend

- Axios-klient (`apps/web/src/lib/api.ts`), baseURL `/api/v1`, JWT Bearer-interceptor, **token-refresh-kö** mot 401-race. Typade helpers (`get/post/patch/del`) packar upp `data.data`.
- **Svarskontrakt:** `{ success:true, data:T }` / `{ success:false, error:{code,message,details?,path,timestamp} }`. 500-fel → Sentry + `ErrorLog`.
- Vite-proxy i dev, Vercel rewrites i prod.

### Arkitekturstil

- **Modulär monolit** (en Fastify-instans, en Postgres, inga service-to-service-RPC). pnpm 10.23 workspaces + Turbo 2.3. `packages/shared` = enda sanningskälla för typer/scheman/utils/konstanter.
- **Externa tjänster:** Redis/Bull (mail-köer i 3 prioriteter, PDF-kö), Resend (e-post + Svix-webhooks), Puppeteer (PDF, semafor 5 sidor), Cloudflare R2 (filer), Anthropic SDK (AI), Voyage (embeddings), Sentry (observability).

---

## 2. AI-systemet

**AI:n är en agent, inte en chatbot.** Den både läser data och utför affärsåtgärder bakom bekräftelse.

### Verktyg (57 totalt, `apps/api/src/ai/tools/ai-tools.definition.ts`)

- **~26 läsverktyg** (ingen bekräftelse): dashboard, förfallna fakturor, utgående avtal, hyresgäster, fakturor, fastigheter, intäktsrapport, lediga objekt, underhåll, besiktningar, hyresavier, banktransaktioner, omatchade transaktioner, avstämningsöversikt, underhållsplan, verifikat, kontosaldo, momsrapport, RR, BR, påminnelsestatus, betalningsbeteende, periodjämförelse, kassaflödesprognos, optimeringsmöjligheter.
- **~31 actionverktyg** (kräver bekräftelse): create_invoice / create_bulk_invoices / mark_invoice_paid / send_invoice_email / send_overdue_reminders; create_lease / create_tenant_and_lease / transition_lease_status / update_tenant / generate_lease_contract; calculate_rent_increases / apply_rent_increase (54 a §-buffert); send_document_to_tenant / compose_and_send_email; create_property / create_unit; create_maintenance_ticket / update_maintenance_status / create_inspection; generate_rent_notices; match_bank_transaction / import_bgmax_file / unmatch_transaction / create_journal_entry / record_expense / close_period; pause_reminders / resume_reminders / export_for_collection / mark_sent_to_collection; export_sie4.
- **Dubbelbekräftelse** för: faktura >50 000 kr, alla bulk-fakturor, avtalsuppsägning, verifikat >100 000 kr, utgift >100 000 kr, **all** periodstängning, **all** inkasso-export, unmatch >30 dagar, bulk-mejl >10 mottagare.
- **Hyresgäst-AI** (separat, jailbreak-skyddad): 8 verktyg (eget avtal, fakturor, betalhistorik, dokument, fastighetsinfo, felanmälningar, skapa felanmälan, begär uppsägning).

### Modeller (`ai.config.ts`)

- Chat/analys/vision: `claude-sonnet-4-5`. Minne + juridisk relevansdomare: `claude-haiku-4-5`. Vision för kontrakt/bankutdrag/inspektionsfoton.

### Memory (`memory.service.ts`)

- `AiMemory` per `(org, user, key)`. Fyra typer: preference, fact, relationship, convention. Haiku extraherar minnen fire-and-forget efter varje svar; injiceras som eget systemblock nästa chatt.

### Historik & kontext

- `AiConversation`/`AiMessage` (sparar Anthropic content-blocks för rekonstruktion). **Sliding window:** >30 meddelanden → senaste 20 i klartext, äldre Haiku-sammanfattas (cachas i `summary`). Sparar ~100k → ~8k tokens/turn för power-users.

### Knowledge base / RAG (juridik)

- **Hybrid retrieval:** BM25 (i minnet) + semantik (Voyage `voyage-4`, 1024-dim, pgvector HNSW) → RRF-fusion (k=60) → topp-3.
- **Tvåstegs grind:** heuristik (`isLegalQuestion`) → BM25-golv → Haiku-relevansdomare (temp=0). JA → grundning med kod-bunden källhänvisning; NEJ → ärlig "miss" utan påhittat lagrum.
- **Stale-hash-vakt** (sha256) per vektor. **GDPR-gräns:** retrieval får bara `query:string` – ingen PII till Voyage. Lagtexter: hyreslagen, bostadsrättslagen, diskrimineringslagen, bokföringslagen, mervärdesskattelagen, räntelagen m.fl.

### Dokumenttolkning (Claude Vision)

- **Bankutdrag-PDF** → strukturerad JSON (`ParsedBankStatement`), instruktionshierarki (PDF = ren data), HARD_CAP-beloppsvalidering. **Kontraktsskanning** (batch, deterministisk unit-matchning + operatörsgodkännande). **Inspektionsfoton** → skadeanalys + reparationskostnad SEK.

### Loggning & kostnad

- `AiUsageLog` (input/cache-read/cache-write/output-tokens, costUsd/costSek, source, isAutomated) per anrop. `AiToolExecution` loggar varje verktygsanrop. Kvotsystem: org-dagscap, per-user 50 SEK/dag, hyresgäst 50 anrop/dag.
- **Prompt caching i 3 nivåer:** systemprompt+portföljdata, tools-block (~10k tokens), juridisk lagtext.

### Data-context (`data-context.service.ts`)

- Injicerar realtidssammanfattning: portföljmetrik, top-50 hyresgäster (m. betalningsbeteende), top-20 fastigheter, top-30 aktiva avtal, fakturastatus. Datumblock hålls ocachat för att inte invalidera cachen.

---

## 3. Fastighetsdomänen

### Hyresgäster — BYGGT

- `Tenant`: personnummer (nullable), namn/företag, kontakt, OCR, typ (INDIVIDUAL/COMPANY), portal-aktivering (passwordHash bcrypt-12, aktiverings-/reset-tokens hashade), massinbjudan-fält (Resend message-id @unique för webhook-korrelation). Relationer till i stort sett allt.
- `Customer`: separat – externa parter (leverantörer/mäklare), ingen portal/avtal, bara fakturering. `SAFE_TENANT_SELECT` döljer hashade fält.

### Fastigheter/lägenheter — BYGGT

- `Property` (typ, beteckning, area, byggår, generiska kontraktsfält, IMD-läge) **1→N** `Unit` (typ, status, area, våning, rum, månadshyra, balkong/förråd/p-plats, **frivillig skattskyldighet endast för lokaler**). **Ingen mellannivå** (byggnad/våning/uppgång) modellerad.

### Kontrakt — BYGGT

- `Lease`: rik modell (status, typ, hyra netto/brutto-gate JB 12:19, deposition, vad som ingår, tilläggshyror, husdjurspolicy, andrahand, **indexklausul** KPI/förhandlad/marknad med bas-år/tak/golv, försäkringskrav, särskilda villkor, kontraktsnummer KONT-{år}-{löpnr}).
- **PDF-generering:** `contracts/` (residential/commercial-mallar, Puppeteer).
- **Digital signering:** via `Document` (signaturnamn, IP, user-agent, SHA-256 contentHash, `locked`, versionskedja). Sker i **tenant-portal med e-postauth** – **ingen BankID/Scrive**.
- **Uppsägning:** `TerminationRequest` (hyresgäst begär → hyresvärd godkänner/avslår → avtalet termineras + mejl).
- **Hyreshöjning:** `RentIncrease` (KPI/förhandlad/marknad, avisering → accept/avslag → uppdaterar avtal).

### Ekonomi — OMFATTANDE BYGGT

- **Fakturering:** `Invoice` (flexibel mottagare tenant/customer/lease, OCR, tracking-token för öppning/PDF-klick, påminnelse-/inkassofält) + `InvoiceLine` + **append-only `InvoiceEvent`** (21 event-typer, actorType USER/SYSTEM/WEBHOOK). `PaymentReminder` med idempotens.
- **Hyresavier:** `RentNotice` (OCR, proration, moms, förbrukningsbelopp, påminnelseavgift 60 kr, kumulativ dröjsmålsränta, kravtrappa-fält, R2-nyckel för påminnelse-PDF) + rader + **append-only events** + **`RentNoticePayment`** (granulär betalningsallokering, `bankTransactionId @unique` = ingen dubbelallokering, stöder delbetalning). Skuld = beräknat tillstånd, inte cache.
- **Bokföring:** `Account` (BAS-hierarki), `JournalEntry` (källa, idempotens-sourceId, **verifikationsnummerserie race-safe via SELECT FOR UPDATE**, fiscalYear härlett), `JournalEntryLine` (Restrict – raderas aldrig), `ClosedAccountingPeriod`. Genererar verifikat för fakturor, betalningar, avier, förbrukning, deposition, hyreshöjning. SIE4-export.
- **Bankavstämning:** `BankTransaction` (XOR-match invoice/rentNotice), `BankStatementImport` (AI-tolkat PDF, `originalParsedData` immutable för BFL). Auto-match referens → OCR → fuzzy.
- **Inkasso:** kravtrappa NONE → REMINDED → INKASSO_READY → WRITTEN_OFF/probable-loss, export (PDF+CSV zip) för externt bolag. **Ingen auto-avhysning** (hyresvärdens egen process).
- **Depositioner:** `Deposit` (max 3 mån bostad-validering, 2890-flöde, återbetalning med avdrag).
- **IMD/förbrukning:** `Meter`/`MeterReading` (append-only, källagnostisk MANUAL/IMPORT/API, idempotens via externalId)/`ConsumptionTariff` (scope-hierarki + historik)/`ConsumptionCharge` (moms-status snapshotad). Levereras som avirad eller separat faktura. **Momsfrågor öppna** (varmvatten, separat faktura).
- **Integrationer:** Resend, R2, Puppeteer funna. **Fortnox/PSD2/BankID/Scrive ej implementerade** (PSD2 antytt via `paymentDataThrough`-fält).

### Ärendehantering — BYGGT

- **Felanmälan:** `MaintenanceTicket` (UND-nr, kategori, prioritet, status, bilder, kommentarer med `isInternal`, tenantToken). **Underhållsplan:** `MaintenancePlan` (per fastighet, kategori, budget, intervall). **Besiktning:** `Inspection` (MOVE_IN/OUT/PERIODIC/DAMAGE, items med skick + reparationskostnad, AI-bildanalys, PDF). **Kommunikation:** `SentMessage`, `NewsPost`, `Notification` (13 typer inkl. AI morning/weekly/monthly). **Dokument:** polymorf koppling + signering/versionskedja. **Nycklar:** `KeyHandover` (append-only, bevis vid depositionstvist).

---

## 4. Data och skalbarhet

### Klarar 100 enheter? — JA, med god marginal

Org-scopade index, plan-limiter (TRIAL 100 / STARTER 5 / PRO 300 objekt), linjär index-struktur. Inga arkitektoniska hinder.

### Klarar 10 000 enheter? — DELVIS, kräver arbete

Tre konkreta hinder:

1. **Saknad paginering** på list-endpoints. `invoices.service.ts` `findMany()` har inget `take/skip` → en org med 10 000 fakturor laddar allt i minnet/till frontend.
2. **Saknade kompositindex.** `BankTransaction` och `RentNotice` har separata `@@index([status])` men inte `([organizationId, status, createdAt])` → risk för full table scan på vanliga filterkombinationer i stora org.
3. **Cron utan partitionering/timeout.** `avisering.scheduler` itererar alla aktiva org och genererar avier per org utan progress-tracking/timeout; mass-mejl köas direkt. AI-usage-cron count-queryar per org. Tunga org kan slå timeout / överbelasta mail-kön.

### Datamodellproblem

- I grunden sund: append-only audit, idempotensnycklar, race-safe sekvenser, korrekt `Restrict` vs `Cascade`. Huvudbristen är **index-täckning för läsmönster i skala**, inte modelleringsfel. Ingen byggnads-/uppgångsnivå (kan behövas för riktigt stora bestånd).

### AI i skala

- Verktygen hämtar utan limit → vid 1000+ objekt skickas allt till modellen. Behöver paginering i list-verktyg + utnyttja pgvector för semantisk drill-down (infra finns). Tillräckligt för 100–500 enheter, behöver arbete för 10k+.

---

## 5. Säkerhet

| Område         | Status | Detalj                                                                                                                                                                                              |
| -------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RBAC           | ★★★★☆  | 5-nivå hierarki OWNER>ADMIN>MANAGER>ACCOUNTANT>VIEWER, `userLevel >= required` i `roles.guard.ts`                                                                                                   |
| Auth           | ★★★★☆  | JWT 15 min + refresh 30 d (SHA-256-hashad i DB, roteras), bcrypt-12. **Ingen BankID.**                                                                                                              |
| Multi-tenant   | ★★★★☆  | Explicit `organizationId`-filter i services, `@@unique([orgId, …])`. **Men ingen central middleware** – scoping är per-utvecklares ansvar (tidigare global-nummer-bug visar att mönstret är skört). |
| Audit/loggning | ★★★★★  | Append-only `InvoiceEvent`/`RentNoticeEvent`/`AiToolExecution`/`ImpersonationLog`/`ErrorLog` + Sentry                                                                                               |
| GDPR/PII       | ★★☆☆☆  | **Personnummer i klartext** (ingen kryptering-at-rest). AI-redaction bra (whitelist + rekursiv redact).                                                                                             |
| Backup         | ★☆☆☆☆  | **Ingen backupkod.** Möjligen Railway-managed men ej dokumenterat/verifierat. R2 utan backup-strategi.                                                                                              |
| Hemligheter    | ★★★★☆  | Inga hårdkodade secrets funna; `.env` gitignorerad; plattformar håller secrets. Saknar rotationspolicy.                                                                                             |

**Soft-delete:** ej implementerat – `Restrict` på bokföringsdata (7-års-retention BFL ✅), `Cascade` på tokens (✅).

---

## 6. Produktanalys (konkurrens)

**Jämfört med Vitec, Momentum, Fastighetsägarnas system, Hyresbostäder-verktyg, Boriva m.fl.:**

### Unikt

- **AI-agent som faktiskt utför arbete** (57 verktyg, human-in-the-loop), inte en bolt-on chatbot. Detta är 1–2 produktgenerationer före etablerade aktörer.
- **Juridik-RAG med källhänvisning + ärlig "miss"** – AI hittar aldrig på lagrum, en avgörande trovärdighetsfaktor i svensk hyresrätt.
- **Skuld som beräknat tillstånd** (RentNoticePayment-allokering) – härdat mot felaktig inkasso.

### Starkt

- BFL-korrekt dubbel bokföring + verifikationsserier + SIE4 (de flesta enkla verktyg outsourcar detta).
- Komplett inkasso-trappa, automatisk avisering (cron), IMD, batch-kontraktsskanning, AI-bankavstämning från PDF.
- Genomtänkt designsystem ("Hade Fortnox godkänt detta?").

### Saknas (mot kategoriledare)

- **Automatisk bankkoppling (PSD2)** – manuell filuppladdning är den svagaste länken i ett "självgående" system.
- **BankID** för både hyresvärd och hyresgäst-signering (förväntad standard i Sverige).
- **Mobilapp** för hyresgäst (portal är webb).
- **Backup/DR + GDPR-härdning** – tröskelkrav för B2B-försäljning.
- **Öppna integrationer** (Fortnox/Visma-export, Kronofogden, energibolag-API:er, Loggamera för IMD).

### Vad gör detta till kategoriledare

Stäng operativa/regulatoriska hålen (backup, PSD2, BankID, GDPR) → kombinationen _fullständig bokförings-/inkassokärna_ + _AI som faktiskt sköter det löpande_ är en position ingen svensk konkurrent har idag. Berättelsen "Fortnox för fastigheter, men självgående" är trovärdig på kodnivå.

---

## 7. AI-möjligheter som saknas (framtid – ej byggt)

- **AI-fastighetschef:** proaktiv daglig drift ("3 avtal löper ut, 2 avier obetalda, en mätaravvikelse – vill du att jag agerar?") med autonoma men bekräftade arbetsflöden.
- **Automatisk hyresanalys/bruksvärde:** AI jämför hyror mot marknad/bestånd, föreslår höjningar med juridiskt underlag.
- **AI-ekonom:** prognoser, budgetavvikelse, skatteoptimering, automatisk månadsavstämning + bokslutsförberedelse.
- **AI-jurist (utöka RAG):** generera uppsägningar/förelägganden med korrekt frist (process-vägledning uppmaning→frist nämns redan i backlog), tvistehantering, hyresnämndsunderlag.
- **Prediktivt underhåll:** koppla `MaintenanceTicket`-historik + `MeterReading`-trender + byggår → föreslå underhållsplan och budget innan haveri.
- **Automatisk dokumenttolkning i bredd:** alla inkommande dokument (försäkringsbrev, energideklarationer, leverantörsfakturor) klassas och bokförs.
- **Proaktiv problemlösning:** anomalidetektion på betalflöden/förbrukning (vattenläcka via förbrukningsspik), mätaravvikelser.
- **Konversationell hyresgästupplevelse:** hyresgäst-AI som bokar hantverkare, förklarar avier, hanterar ärenden end-to-end.

---

## 8. Kritiska frågor

### 10 största riskerna

1. **Ingen databasbackup/DR** – produktionsdata oskyddad. Existentiell.
2. **Personnummer i klartext** – GDPR-brott, blockerar B2B-försäljning och kan ge sanktion.
3. **Manuell bankavstämning (ingen PSD2)** – bryter kärnlöftet "självgående"; mänsklig flaskhals + felkälla.
4. **Saknad paginering** – minnes-/prestandakollaps vid stora org.
5. **Multi-tenant-scoping utan central enforcement** – varje glömt `organizationId` = potentiell dataläcka mellan kunder.
6. **Ingen BankID** – signeringens juridiska bärkraft och svensk marknadsförväntan.
7. **Cron utan partitionering/timeout** – avisering/mejl kan haverera när beståndet växer.
8. **AI-actions med ekonomisk/juridisk verkan** – bekräftelse finns, men en felaktig auto-bokföring/inkasso mot betalande hyresgäst är hög-impact (delvis redan härdat).
9. **Saknade kompositindex** – tysta full table scans som degraderar i skala.
10. **Leverantörsberoende** (Anthropic, Voyage, Resend, R2, Railway) utan fallback/kostnadstak-haveri-plan.

### 10 viktigaste att bygga först

1. **Automatisk databasbackup + verifierad restore** (PITR/WAL).
2. **Kryptering-at-rest för PII** (pgcrypto/kolumnkryptering av personnummer).
3. **PSD2-bankkoppling** (Tink/Enable Banking) – ersätter manuell import.
4. **Paginering på alla list-endpoints + list-verktyg.**
5. **Kompositindex** `(organizationId, status, createdAt)` på `RentNotice`/`BankTransaction`/m.fl.
6. **BankID** (inloggning + signering).
7. **Central tenant-scoping** (Prisma-middleware/extension som tvingar `organizationId`).
8. **Cron-härdning** (batchning, timeout, progress, köutjämning för mejl).
9. **NOT NULL-hårdning + dataintegritet** (kundnummer-backlog m.fl.).
10. **Juridisk slutgenomgång** av avtalsmallar/uppsägning/inkasso (gatas redan).

### Vad gör störst skillnad för att vinna marknaden

**PSD2 + verklig autonomi.** Kärnvisionen är "luta dig tillbaka medan systemet sköter det löpande". Idag bryts den kedjan vid bankavstämningen (manuell fil). Med automatisk bankkoppling blir avisering→betalning→avstämning→bokföring→inkasso en obruten självgående loop – och AI-agenten kan då faktiskt vara fastighetschef, inte assistent. Det är den enskilt största hävstången, tätt följt av backup+GDPR (säljbarhetsgrind) och BankID (marknadsförväntan).

### Vad du sannolikt har missat

- **Operativ mognad ≠ funktionell mognad.** Domänen är imponerande färdig, men drift (backup, observability-larm, runbooks, lasttestning vid 10k enheter) är underinvesterad relativt funktionsbredden.
- **Central tenant-isolation saknas** – lätt att glömma när 81 services skrivs av olika händer; en enda miss kan sänka förtroendet permanent.
- **AI-kostnadstak vid skala** – kvoter finns per org/user, men en plötslig volymökning (många automatiska anrop) saknar tydligt globalt haveriskydd.
- **`apps/landing` skräp** + temp-scripts (`measure-*-tmp.ts`) i repot – städning innan due diligence.
- **Förbruknings-momsfrågorna är öppna** (varmvatten, separat faktura) – juridisk risk om IMD säljs in innan de är låsta.
- **Ingen byggnads-/uppgångsnivå** i datamodellen kan bli en begränsning för större bestånd/BRF:er.

---

_Rapporten är en ögonblicksbild baserad på koden 2026-06-16. Inga filer ändrades under analysen._
