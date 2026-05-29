# Eveno — Design Decisions

> Senast uppdaterad: 2026-05-29

Detta dokument förklarar **varför** vi valt vissa arkitekturmönster — inte bara **vad** vi gjort. Användbart för att avgöra om en föreslagen ändring respekterar den ursprungliga motiveringen eller om förutsättningarna ändrats.

Format: varje beslut har **Beslut**, **Alternativ vi övervägde**, **Varför vi valde det vi valde**, **När bör vi ompröva**.

---

## 1. OCR per-tenant (inte per-faktura globalt)

### Beslut

Varje **tenant** (hyresgäst) får ett unikt OCR-prefix; varje faktura ärver detta prefix + appenderar sekvensnummer. OCR är alltså:

```
<tenant-prefix>-<faktura-sekvens>-<checksumma>
```

Två tenants i samma organization har olika prefix; två tenants i olika orgs kan teoretiskt ha samma prefix men matchning är alltid org-scopad.

### Alternativ vi övervägde

1. **Globalt unikt per-faktura OCR** — varje faktura får en unik OCR oavsett tenant
2. **Per-org OCR-serie** — varje org har en sekvens, alla fakturor numreras inom org

### Varför vi valde per-tenant

- **Återanvändning av betalningsuppgift:** hyresgäster betalar samma OCR månad efter månad om de använder autogiro/stående överföring. Per-faktura-OCR tvingar dem att ändra varje gång.
- **Mänsklig matchning vid felregistrering:** om en kund skriver fel OCR (vanligt) är prefixet ändå rätt → systemet kan föreslå rätt tenant och låta operatören välja faktura.
- **Felisolation:** en kollision i en organisation påverkar inte en annan.

### Trade-off

- Måste ha kollissionssäkring inom org (idempotency när tenant skapas)
- Bank-importen måste matcha mot tenant först, sedan FIFO mot fakturor (FIX 6)

### När bör vi ompröva

- Om vi börjar erbjuda e-fakturering där OCR sätts per faktura av bank (då är globalt unikt naturligare)
- Om vi får regulatoriskt krav på unika nationella betalningsreferenser

---

## 2. `InvoiceEvent`, `JournalEntry`, `JournalEntryLine` = `onDelete: Restrict`

### Beslut

Audit- och bokföringsmodeller har `onDelete: Restrict` på sina relationer till föräldraobjekt. En faktura som har historik kan **inte** raderas direkt — den måste soft-delete:as (`deletedAt`) och historiken bevaras.

### Alternativ vi övervägde

1. **`onDelete: Cascade`** — enklast, men FIX 3 visade att detta bryter mot BFL
2. **`onDelete: SetNull`** — historik bevaras men kopplingen tappas → svår att förstå historiskt
3. **Soft-delete på Invoice + Cascade på events** — soft-delete bevarar bara fakturan, inte audit-kedjan

### Varför vi valde Restrict + soft-delete

- **Bokföringslagen 7 kap 2 §** kräver bevarande av räkenskapsinformation i 7 år
- Audit-trail för fakturahändelser är **del av räkenskapsinformationen** — får inte raderas
- `Restrict` förhindrar att en utvecklingsbug oavsiktligt raderar audit-data
- Soft-delete på fakturan (men inte på audit-raderna) ger UX för "borttagen faktura" utan att kompromissa juridik

### Trade-off

- API-koden måste hantera `deletedAt`-filtrering i alla `findMany`
- Disk-utrymme växer (kompromiss vi accepterar mot juridik)
- Komplexare återställning vid faktiskt borttagning av kunddata (GDPR right-to-erasure → måste anonymisera istället för radera)

### När bör vi ompröva

- Aldrig medan BFL gäller i nuvarande form
- Eventuellt om regulatorisk klarsignal kommer för digital arkivering hos tredjepart (då kan vi exportera + delete)

---

## 3. `Document.onDelete` — TBD (öppen fråga)

### Beslut

Tills vidare: `Cascade` när dokumentet är genererat från en faktura (PDF kan regenereras); `Restrict` när det är uppladdat originalkontrakt (kan inte regenereras).

**Detta är inte fullt utrett** — varje ny Document-typ kräver beslut.

### Alternativ

1. **Allt Restrict** — säkraste, men växer disk
2. **Allt Cascade** — enklare, men förstör originalkontrakt om man råkar radera fastigheten
3. **Per-typ avgörande (nuvarande)** — pragmatiskt men kräver disciplin

### Varför vi valde per-typ

- Genererade PDF:er är effektivt cache — kan alltid genereras om från Invoice/JournalEntry-data
- Originalkontrakt och scannade ID-handlingar är **källdata** — får inte raderas

### Trade-off

- Devs måste välja `onDelete` medvetet vid varje ny Document-typ
- Risk att fel default väljs → vi behöver lint/granskning vid nya schema-ändringar

### När bör vi ompröva

- När vi har > 10 Document-typer och beslutet blir för komplext → flytta till explicit `documentType`-enum med policy-tabell
- Eller när vi lägger in arkiveringsstrategi (S3 Glacier för gamla originalkontrakt)

---

## 4. Synkrona PDF-nedladdningar, asynkrona PDF-utskick

### Beslut

- **Synkront** (Puppeteer direkt i request-tråden): användaren klickar "Ladda ner faktura PDF" → får filen direkt
- **Asynkront** (Bull queue): bulk-faktureringsutskick, massbilagor → enqueue:as och worker processar

### Alternativ vi övervägde

1. **Allt synkront** — enklast, men FIX 4 visade att det inte skalar för bulk
2. **Allt asynkront** — alltid via queue → konsekvent men sämre UX för enskild nedladdning (måste polla)
3. **Hybrid (nuvarande)** — bästa UX per use-case

### Varför vi valde hybrid

- Enskild PDF tar < 2 sekunder → vänta synkront är OK
- Bulk (200+ fakturor) tar > 5 minuter → måste vara async, annars timeout + duplicates
- Frontend-komplexitet stannar låg för det vanliga fallet

### Trade-off

- Två kodvägar (sync controller + async worker)
- Behöver disciplin: nya bulk-features ska gå via queue, inte synkront

### När bör vi ompröva

- Om Puppeteer ersätts av snabbare PDF-lib (Lambda, react-pdf-renderer) — då kanske allt kan bli synkront igen
- Om vi får krav på audit-trail för PDF-genereringar → då vill vi alltid via queue (loggar bättre)

---

## 5. Fastify istället för Express som NestJS-adapter

### Beslut

`NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter())` — vi kör **Fastify**, inte default Express.

### Alternativ vi övervägde

1. **Express** — NestJS default, mest community-stöd, fler integrationer
2. **Fastify** — snabbare, lägre overhead, modernare arkitektur

### Varför vi valde Fastify

- 2-3× snabbare throughput än Express → bättre per-dollar på Railway
- Native schema-validering via Ajv (vi använder inte detta — class-validator istället — men det finns)
- Modern async-arkitektur, ingen Express-baggage
- Bättre streaming-stöd för PDF-nedladdningar

### Trade-off

- **Vissa Express-paket fungerar inte** (multer, vissa middlewares) — vi använder `@fastify/multipart` istället
- **Raw body-hantering** skiljer sig (viktigt för webhooks med signaturverifiering)
- Mindre community-stöd för specifika integrationer
- **Devs som copy-pastar från NestJS-dokumentation måste vara medvetna** — många exempel är Express-only

### När bör vi ompröva

- Om vi behöver Express-specifika paket som inte har Fastify-motsvarighet
- Om Fastify-projektet stagnerar

---

## 6. TanStack Router (URL-baserad) istället för egen `useState`-router

### Beslut

`apps/web` och `apps/portal` använder TanStack Router med file-based routing (`app/routes/...`).

### Alternativ vi övervägde

1. **Egen router** (initial implementation, FIX 5) — låg överhead, ingen lib
2. **React Router** — mest använt i industrin
3. **TanStack Router** — type-safe, loaders, modern arkitektur

### Varför vi valde TanStack Router

- **URL är källan till sanning** — back/forward, delade länkar, refresh fungerar
- **Type-safe paths** — kompileringsfel om man navigerar till en route som inte finns
- **Loaders** preloadar data deklarativt — bättre UX, mindre boilerplate
- **Bundling** av routes — bra för code-splitting

### Trade-off

- Ny mental modell för devs som kommer från React Router
- File-based routing kräver disciplin (felplacerad fil → felaktig route)
- Mer setup än useState-routern (initial cost)

### När bör vi ompröva

- Bara om TanStack Router-projektet dör eller om vi byter till SSR-framework (Next.js, Remix) där deras router är default

---

## 7. Append-only audit-modeller (InvoiceEvent etc.)

### Beslut

`InvoiceEvent`, `JournalEntry`, `JournalEntryLine` — inga UPDATE eller DELETE från app-koden. Endast INSERT. Felbokningar rättas med **motverifikation** (reverseringsentry).

### Alternativ vi övervägde

1. **Full CRUD** — enkelt, men förstör audit-trail och bryter mot BFL
2. **UPDATE med audit-historik** — komplext, dubbel datalagring
3. **Append-only (nuvarande)** — Bokföringsstandard sedan århundraden

### Varför vi valde append-only

- **BFL 5 kap 6-9 §** kräver att verifikationer ska kunna spåras och är immutable de facto
- **Dubbel bokföringens grundprincip** — felbokningar rättas med motverifikation, aldrig genom att ändra historik
- Revisor förväntar sig detta — bryter vi mönstret blir vi inte audit-godkända
- Förenklar reasoning om finansiell data — "vad var saldot 2025-12-31?" går att svara exakt

### Trade-off

- Bugfixar i bokföringskoden är jobbiga (måste reversera + ny entry, inte UPDATE)
- Tabellerna växer linjärt och kan inte minskas
- UI måste tydligt visa "korrigerad" vs "ursprunglig"

### När bör vi ompröva

- Aldrig medan BFL gäller
- Om vi skulle hosta data i jurisdiktion med andra regler (osannolikt)

---

## 8. NestJS-modul per domän (inte per teknisk lager)

### Beslut

Backend organiseras per **domän** (`invoices/`, `tenants/`, `leases/`), inte per teknisk lager (`controllers/`, `services/`, `repos/`).

### Varför

- Domänkohesion — när du läser kod för "fakturor" hittar du allt i `invoices/`
- Lätt att hitta blame-ägare per modul
- Mindre fil-hoppande vid bugfix

### Trade-off

- Tvärgående features (t.ex. sökning över allt) kräver mer koordinering
- Risk för cirkulära beroenden om moduler är tätt kopplade — vi använder DI för att lösa

---

## 9. JWT 15 min + Refresh 30 d (UUID, roterad)

### Beslut

- Access-token: JWT, 15 min livstid, signerad med HS256
- Refresh-token: UUID (inte JWT), 30 dagar, lagrad i DB, **roteras vid varje refresh**

### Alternativ

1. **Långlivad JWT** (24h+) — enkelt men säkerhetsrisk vid stöld
2. **Sessions-cookies** — kräver server-state, CSRF-risk
3. **Kortlivad JWT + lång refresh (nuvarande)** — balans

### Varför

- 15 min betyder att en stulen access-token är värdelös snabbt
- Refresh-rotation gör att stulen refresh upptäcks (gammal token blir ogiltig vid första rotation efter stöld)
- UUID istället för JWT för refresh = mindre angreppsyta (inget kryptoknäckande)
- DB-lagring → kan revokeras manuellt

### Trade-off

- Behöver hantera refresh-flödet på frontend (race conditions om flera requests samtidigt får 401)
- DB-läsning vid varje refresh (cache via Redis kan optimera vid behov)

### När bör vi ompröva

- Om vi behöver SSO (då vill vi nog till externt IdP via OAuth)
- Om DB-overhead för refresh blir mätbar (osannolikt på vår skala)

---

## 10. `@eken/shared` som enda källa till sanning för domäntyper

### Beslut

Alla domäntyper, Zod-scheman, formatters, konstanter bor i `packages/shared`. **Aldrig** duplicera i `apps/api` eller `apps/web`.

### Varför

- En förändring (ny enum-value, ny fält) blir en commit, inte tre
- Type-mismatch mellan backend/frontend upptäcks vid TypeScript-kompilering
- Konsekvent formatering (SEK, datum) över alla apps

### Trade-off

- Cirkulära beroenden om `shared` läcker in app-specifik kod (regel: shared får aldrig importera från apps)
- Build-ordning: shared måste byggas före api/web (Turborepo löser via `dependsOn`)

---

## Sammanfattning — heuristik vid nya beslut

När du står inför ett nytt arkitekturval, fråga:

1. **Bryter det mot lag?** (BFL, ML, GDPR, JB 12 kap) — då är svaret enkelt
2. **Försämrar det multi-tenant-säkerhet?** — vi kompromissar aldrig här
3. **Skapar det dubbel sanning?** — undvik. En källa per domän.
4. **Kan en jr-dev förstå koden inom 5 minuter?** — om inte: överväg ett enklare mönster
5. **Är optimeringen mätbar?** — annars: skriv enklast tänkbara först, mät, optimera senare

Om du är osäker — dokumentera beslutet här som "öppen fråga" snarare än att smyga in en oprövad lösning.
