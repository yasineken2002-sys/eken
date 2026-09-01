# Eken – CLAUDE.md

## Vision & mål

_Eveno_ — fastighetsförvaltnings-SaaS för svenska privata hyresvärdar och mindre bolag (1–50 enheter).

**Kärnvision:** maximal automatisering. En hyresvärd ska kunna luta sig tillbaka medan systemet sköter det löpande — avisering, påminnelser, bankavstämning, bokföring, kravhantering — automatiskt. AI är hyresvärdens assistent: den gör det repetitiva och föreslår det svåra, så att människan bara behöver fatta de verkligt bindande besluten. Ersätter tunga system (Vitec, Momentum) med något enklare, smartare och mer självgående.

**Byggt och i main:** förvaltning (fastigheter/lägenheter/hyresgäster/avtal), automatisk hyresavisering (cron), IMD/förbruknings-debitering, AI-driven kontrakts-onboarding, dubbel bokföring, komplett inkasso-trappa (avi→påminnelse→ränta→inkasso-ready→export→kundförlust, automatisk), och härdad bankavstämning (skuld som beräknat tillstånd: INV-S→D→A→B).

**Återstår före lansering (gatas av bolagsregistrering):** DB-backup, BankID-inloggning, automatisk bankkoppling (PSD2 — ersätter manuell filuppladdning, en nyckel för att avstämningen ska vara självgående), juridisk slutgenomgång.

> **Mätt status per post: [`docs/revision-status.md`](./docs/revision-status.md).** Varje rad bär den commit-sha den mättes mot. Läs regeln överst i filen innan du bygger på en rad — den är ett spår, inte ett faktum.

**Bärande principer:** automatisera det repetitiva, men maskinen _föreslår_ och människan _bekräftar_ det bindande (avtal, hyreshöjning, inkasso-export, avskrivning). Skuld är ett beräknat tillstånd, aldrig en flagga. AI skriver aldrig SFS-nummer/lagrum i produktionskod — verifieras av människa.

> **"Fortnox för fastigheter"** – Enterprise-grade fastighetssystem. Varje beslut ska hålla Fortnox-standard.

---

## Primärregel

**Claude är utvecklaren. Användaren skriver aldrig kommandon själv.**

- Kör alla kommandon, migreringar, builds, tester och serveromstarter via Bash-verktyget
- Verifiera alltid att ett fix fungerar (hälsokontroll, curl-test) innan du rapporterar klart
- Fråga aldrig användaren att köra något manuellt

---

## Dev-miljö – starta och hantera

### Starta dev-servrar

```bash
# API (NestJS/Fastify) – port 3000, watch mode
cd /workspaces/eken/apps/api && npm run dev > /tmp/api-dev.log 2>&1 &

# Web (Vite/React) – port 5173, HMR
cd /workspaces/eken/apps/web && npm run dev > /tmp/web-dev.log 2>&1 &
```

> **Obs:** `pnpm dev` (Turbo) avslutas direkt i miljöer utan persistent TTY. Starta alltid processerna ovan individuellt.

### Stäng ned och starta om

```bash
kill $(lsof -ti:3000) 2>/dev/null; kill $(lsof -ti:5173) 2>/dev/null
```

### Verifiera att allt körs

```bash
# -f = fäll på HTTP-fel, -sS = tyst men visa transportfel. Utan -f/-S blir en
# nedstängd server TOM UTDATA i stället för ett fel — och en pipe (| head, | jq)
# gör dessutom exitkoden till det sista kommandots, så inget kan fälla alls.
curl -fsS http://localhost:3000/v1/health   # OK: { success: true, data: { status: "ok" } }
curl -fsS -o /dev/null -w '%{http_code}\n' http://localhost:5173   # OK: 200
```

Misslyckande ser ut så här — synligt fel **och** nollskild exitkod:

```
curl: (7) Failed to connect to localhost port 3000 after 0 ms: Connection refused
$? = 7   # 7 = servern svarar inte, 22 = HTTP 4xx/5xx
```

### Loggar

```bash
tail -f /tmp/api-dev.log   # NestJS-output
tail -f /tmp/web-dev.log   # Vite-output
```

### Databas & Redis

```bash
# Postgres: postgresql://eken:eken@localhost:5432/eken_dev
# Redis:    redis://localhost:6379
# Miljöfil: /workspaces/eken/apps/api/.env

# Root-scripts (turbo, filtrerade till @eken/api):
pnpm db:migrate        # prisma migrate dev (skapar ny migration)
pnpm db:studio         # Prisma Studio GUI

# Övriga db-scripts finns ENDAST i apps/api/package.json — kör dem därifrån
# (pnpm db:generate från root finns inte och misslyckas):
cd apps/api && pnpm db:migrate:deploy   # prisma migrate deploy (applicerar pending)
cd apps/api && pnpm db:generate         # prisma generate (uppdaterar klient)
cd apps/api && pnpm db:seed             # ts-node prisma/seed.ts (även db:seed:platform, db:seed:properties)
```

### API-nycklar i `apps/api/.env`

**Prod-nyckeln får ALDRIG läggas i `apps/api/.env`.** Dev-körningar hamnar då på
produktionskvoten, och `AiQuotaService` stoppar organisationer som överskrider sin
månadsbudget — en skenande dev-loop kan alltså slå ut riktiga kunder. En prod-
credential på en utvecklarmaskin är dessutom en onödig exponering, och så länge den
fungerar som reserv märks det inte att dev-miljön är trasig. Dev ska ha en **egen**
nyckel med egen kvot. (Regeln kommer ur #385, där dev-nyckeln var död i två månader.)

Behöver en nyckel bara gälla för en enstaka körning: en explicit satt miljövariabel
vinner över `node --env-file-if-exists=.env` (verifierat empiriskt).

```bash
ANTHROPIC_API_KEY=… pnpm --filter @eken/api knowledge:eval
```

**Att byta en nyckel i `.env` — vägen som fungerar.** Filen är gitignorerad
(rot-`.gitignore` rad 7, `.env`) och därmed **inte spårad**: den finns inte på
github.com och går inte att redigera i webbläsaren. Redigera den i codespacets egen
terminal:

```bash
sed -i 's|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=sk-ant-…|' /workspaces/eken/apps/api/.env
```

Verifiera sedan **utan att skriva ut nyckeln** — ett sha256-prefix räcker för att se
att den faktiskt byttes, och ett gratis `GET /v1/models` för att se att den accepteras:

```bash
cd /workspaces/eken/apps/api
node --env-file-if-exists=.env -e 'console.warn(require("crypto").createHash("sha256").update(process.env.ANTHROPIC_API_KEY.trim()).digest("hex").slice(0,16))'
```

`scripts/preflight-keys.ts` skiljer dessutom de tre tillstånden åt — SAKNAS,
FELFORMAD, OGILTIG — och körs före allt arbete i `knowledge:eval`/`knowledge:embed`,
så en trasig nyckel kostar noll Voyage-anrop.

### Övriga kommandon

```bash
pnpm typecheck   # TypeScript – kör alltid innan du anser en uppgift klar
pnpm lint        # ESLint
pnpm build       # Full production build
pnpm format      # Prettier
```

### Testsviten – kör HELA den, inte modulgrupper

```bash
cd apps/api && npx jest          # 300 sviter, 3070 tester, 1,5–2 min
```

Mätt 2026-08-20 i codespace (8 GB), 300/300 sviter gröna i båda lägena och ingen
OOM: seriellt (`--runInBand`) **85,5 s**, parallellt (default) **117,9 s**.

Seriellt är alltså numera SNABBARE än parallellt på den här maskinen — omvänt mot
mätningen 2026-08-14 (69,5 s resp. 67,7 s), då lägena låg jämnt. Sviten har vuxit
med 45 sviter och 523 tester sedan dess; workerstarten betalar inte längre av sig
i ett codespace med få kärnor. Kör det läge du vill — båda är gröna, och skillnaden
är en halv minut, inte en täckningsskillnad.

`pnpm test:ci` (= `jest --ci --runInBand`) är seriellt av ett **CI-runner**-skäl —
runnern har färre kärnor och mindre RAM, och dess OOM-hanterare dödar parallella
workers mitt i körningen (`ci.yml:76-84`). Det skälet gäller inte din maskin.

**Kör aldrig bara den modul du ändrat.** En modulavgränsad körning är en
täckningsgräns, inte en prestandainställning: den som kör per modul vet inte vad
hen inte kört. Uppmätt kostnad (#449): en rolländring i `ai-usage/` verifierades
mot fem modulgrupper, alla gröna — assertionen som föll låg i `common/guards/` och
fastnaglade beslutet ändringen upphävde. Bara CI såg den. Hela sviten hade tagit
ett par minuter.

**Och vad en SHARDAD körning inte bevisar.** `--shard=1/4` … `4/4` kör hela
mängden och bryter alltså inte mot regeln ovan — täckningen är fullständig, det
är inte en modulavgränsning. Men det är **fyra processer, inte en**: en svit som
passerar isolerat men fallerar i sällskap av en annan syns inte. För den här
kodbasen är skillnaden liten — enhetstester med egna mockar — men den är verklig,
och den får inte döljas av att talen summerar rätt.

**Shardning är en minnesåtgärd, inte ett likvärdigt körsätt** — och den räcker
inte alltid. Uppmätt i en session där en främmande process tog 1,9 GB på en
8 GB-maskin:

```
--runInBand, hela sviten      SIGTERM efter  32 sviter
--shard=1/4                   SIGTERM efter  11 sviter
--shard=2/4                   SIGTERM efter  34 sviter      ← 130 MB fritt
```

Att dela upp körningen sänker toppen per process, men inte den totala
efterfrågan när något annat redan tagit minnet. Kör du shardat: skriv ut att det
var shardat, och att en summa på rätt tal är en bekräftelse — inte samma bevis
som en körning i en process.

### En tung körning i taget på den här maskinen

Mekanik, inte artighet. Codespacet har **två kärnor och ~2,5 GB ledigt** när
inget annat kör. Sviten behöver mer än så tillsammans med något annat, och
utfallet är inte långsamhet utan **SIGTERM mitt i körningen** — vilket ser ut som
ett svitfel och inte som ett resursfel.

Uppmätt under en dag med två parallella sessioner: **sex SIGTERM-dödade
körningar.** Jämförelsetalen som visar hur snävt det är:

```
CI, ensam runner        78–85 s   fullbordar alltid
lokalt, ensam           101 s     fullbordar
lokalt, samtidigt med typecheck / en annan sessions svit   SIGTERM
```

Skillnaden mellan att fungera och att dö är alltså inte marginell i tid men
absolut i utfall. Att starta om en dödad körning utan att först ta bort
konkurrensen är att upprepa något som inte kan lyckas.

**Kontrollen före start är att TITTA, inte att hoppas:**

```bash
free -m | head -2                       # 'available' — under ~2,5 GB: vänta
pgrep -af "jest|tsc" | head             # kör något redan? starta inte till
```

Kör aldrig `pnpm typecheck` och sviten samtidigt. De är båda tunga, och den som
startas sist dödar oftast den andra i stället för sig själv.

**Och när maskinen inte räcker alls: låt CI köra sviten.** `Tests`-jobbet kör
hela sviten på en ren runner och är required check. Att öppna PR:en för att få
den körningen är rätt åtgärd — det är inte att kringgå kravet, det är att flytta
mätningen till en maskin som kan utföra den. Det som ALDRIG är rätt är att
redovisa ett tal man inte mätt, eller att kalla en avbruten körning grön.

---

## Arkitektur

```
eken/                         # pnpm monorepo (Turborepo)
├── apps/
│   ├── api/                  # NestJS 10 + Fastify (REST) – port 3000 lokalt / 8080 i prod-container (Railway)
│   ├── web/                  # Huvud-SPA: React 18 + Vite + TanStack Router – port 5173 (Vercel)
│   ├── admin/                # Plattforms-/superadmin-SPA: React 18 + Vite + react-router-dom – port 5175 (Vercel)
│   ├── portal/              # Hyresgästportal-SPA: React 18 + Vite + react-router-dom – port 5174 (Vercel)
│   └── landing/             # ÖVERGIVEN (Next.js) – ingen package.json/src kvar, bara byggartefakter
├── packages/
│   └── shared/               # Typer, Zod-scheman, utils, konstanter (delas av api + alla SPA)
├── docker-compose.yml        # Lokal fullstack (postgres, redis, api, web)
├── turbo.json
├── railway.toml / railway.json
└── CLAUDE.md
```

> **Apparna:** `web` (operatör/fastighetsägare), `admin` (Eveno-plattformsadmin: org-hantering,
> fakturering, fel/AI-statistik) och `portal` (hyresgäst: avier, felanmälan, dokument, nyheter)
> är tre SEPARATA SPA:er. Bara `web` använder TanStack Router; `admin` och `portal` kör
> `react-router-dom`. `landing` är övergiven (ersatt av portal-redesign).

### Paketnamn (workspace-alias)

| Package           | Alias          |
| ----------------- | -------------- |
| `apps/api`        | `@eken/api`    |
| `apps/web`        | `@eken/web`    |
| `apps/admin`      | `@eken/admin`  |
| `apps/portal`     | `@eken/portal` |
| `packages/shared` | `@eken/shared` |

---

## Backend – `apps/api`

### Stack

- **NestJS 10** med **Fastify**-adapter (inte Express – aldrig blanda ihop)
- **Prisma 5** → PostgreSQL
- **Bull + Redis** för jobbköer (e-post, PDF-jobb, schemalagda cron)
- **Resend** för e-post (köas via Bull → `mail.worker`; inkommande leveransstatus via `webhooks`-modulen, Svix-signerad). _OBS: inte Nodemailer/SMTP._
- **Puppeteer** för PDF-generering (Chromium i Docker) – async via `pdf-jobs`-kön
- **Anthropic SDK** (`@anthropic-ai/sdk`) för AI-assistenten + verktyg (`ai`-modulen)
- **Cloudflare R2** (S3-kompatibel) för fillagring (`storage`-modulen) – inte lokal disk
- **Sentry** för felspårning (`instrument.ts`)
- **Swagger** på `http://localhost:3000/api/docs` i dev (avstängt i produktion)

### API-svarsmönster (TransformInterceptor + HttpExceptionFilter)

Varje svar wrappas automatiskt. Förvänta dig alltid:

```typescript
// Lyckat svar
{ success: true, data: T }

// Felsvar
{ success: false, error: { code: string, message: string, details?: unknown, path: string, timestamp: string } }
```

Axel-hjälparna i `apps/web/src/lib/api.ts` packar upp `data.data` automatiskt.

### Versioning

Alla endpoints prefix: `/v1/` (URI-versioning, `defaultVersion: '1'`).
Vite-proxyn rewritar `/api/v1/foo` → `http://localhost:3000/v1/foo`.

### Autentisering & auktorisering

- **JWT** (Bearer, 15 min) + **Refresh token** (UUID i DB, 30 dagar, roteras vid varje refresh)
- Lösenord: bcryptjs, 12 salt rounds
- Alla routes skyddade som standard via `JwtAuthGuard` (global)
- Publika routes markeras med `@Public()`-dekoratorn
- Rollbaserad: `@Roles(UserRole.OWNER, UserRole.ADMIN)` via `RolesGuard`

**Rollhierarki (högst → lägst):**

```
OWNER → ADMIN → MANAGER → ACCOUNTANT → VIEWER
```

### Multi-tenant-mönster

Varje entitet har `organizationId`. Alla queries ska scopas till `organizationId` från JWT-payload.
Hämta med `@OrgId()`-dekoratorn i controllers: `@OrgId() orgId: string`.

### NestJS-moduler

46 modulkataloger i `apps/api/src/`. Kärndomänerna (en rad var):

| Modul                                                               | Ansvar                                                                                                                                                                                  |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AuthModule`                                                        | Register, login, refresh, logout (JWT + RefreshToken)                                                                                                                                   |
| `OrganizationsModule`                                               | Organisationsinställningar                                                                                                                                                              |
| `PropertiesModule` / `UnitsModule`                                  | Fastigheter resp. lägenheter/lokaler                                                                                                                                                    |
| `TenantsModule` / `CustomersModule`                                 | Hyresgäster resp. övriga kunder/motparter                                                                                                                                               |
| `LeasesModule`                                                      | Hyresavtal + statushantering                                                                                                                                                            |
| `InvoicesModule`                                                    | Fakturor + append-only händelselogg (`InvoiceEvent`)                                                                                                                                    |
| `AccountingModule`                                                  | BAS-kontoplanen + journalposter + verifikationsnummer-serie                                                                                                                             |
| `AviseringModule`                                                   | **Hyresavi-livscykel + inkasso-kravtrappa** (avi→påminnelse→ränta→inkasso-redo→befarad kundförlust); `RentDebtService`/`RentReminderService`/`RentInterestService`/`RentBadDebtService` |
| `CollectionsModule`                                                 | Inkasso-export (grindar på faktisk skuld, INV-D)                                                                                                                                        |
| `ReconciliationModule`                                              | **Bankavstämning** (CSV/BgMax/PDF-import, OCR-matchning, partiell betalning, unmatch); `BankTransaction`/`BankStatementImport`                                                          |
| `PaymentFreshnessModule`                                            | Färskhetsgrind: pausar kravtrappans cron + larmar vid inaktuell betalningsdata (INV-B)                                                                                                  |
| `ConsumptionModule`                                                 | **IMD** (individuell mätning/debitering el/vatten): mätare, avläsning, tariff, förbrukningsdebitering                                                                                   |
| `DepositsModule`                                                    | Depositioner (1510/2890-flöde)                                                                                                                                                          |
| `ContractsModule` / `ImportModule`                                  | Hyreskontrakt + **batch-kontraktsskanning** (AI)                                                                                                                                        |
| `TerminationsModule`                                                | Uppsägningar                                                                                                                                                                            |
| `RentIncreasesModule`                                               | Hyreshöjningar                                                                                                                                                                          |
| `TenantPortalModule`                                                | Hyresgästportalens API (magic-link-auth, avier, dokument)                                                                                                                               |
| `AiModule` / `AiUsagePageModule`                                    | AI-assistent (Anthropic) + verktyg, samt förbrukningsloggning                                                                                                                           |
| `PlatformModule`                                                    | **SaaS-plattform**: prenumeration, plattformsfakturering, superadmin (egen JWT)                                                                                                         |
| `MaintenanceModule` / `MaintenancePlanModule` / `InspectionsModule` | Felanmälan, underhållsplan, besiktningar                                                                                                                                                |
| `MailModule`                                                        | E-postköande (Resend via Bull)                                                                                                                                                          |
| `WebhooksModule`                                                    | Inkommande webhooks (Resend leveransstatus, Svix-signerad)                                                                                                                              |
| `StorageModule`                                                     | Fillagring (Cloudflare R2)                                                                                                                                                              |
| `PdfQueueModule` (`pdf-jobs`)                                       | Async PDF-generering (Puppeteer-worker)                                                                                                                                                 |
| `NotificationsModule`                                               | Schemalagda påminnelser + förfallomarkering (cron)                                                                                                                                      |
| `DashboardModule`                                                   | Aggregerad statistik                                                                                                                                                                    |
| `MessagesModule` / `NewsModule` / `DocumentsModule` / `KeysModule`  | Meddelanden, nyheter, dokument, nyckelkvittens                                                                                                                                          |

> Övriga stöd-moduler: `UsersModule`, `HealthModule`, `OcrModule`, `RedisModule`, `PublicPlansModule`.

### DTO-regel (kritisk)

DTOs i NestJS måste importeras som **värden**, aldrig som typer:

```typescript
// ✅ Korrekt – NestJS kan läsa reflect-metadata
import { RegisterDto } from './dto/register.dto'

// ❌ Fel – klassen försvinner i runtime, ValidationPipe tappar all metadata
import type { RegisterDto } from './dto/register.dto'
```

`import type` är rätt för interfaces/typer från `@eken/shared`. Fel för NestJS DTOs.

### Common-lager (`src/common/`)

- `@Public()` – markerar route som publik
- `@CurrentUser()` – injecterar JwtPayload i parameter
- `@Roles(...roles)` – rollkrav på route
- `@OrgId()` – extraherar `organizationId` från JWT
- `PrismaService` – singleton Prisma-klient
- `TransformInterceptor` – wrappa svar i `{ success, data }`
- `HttpExceptionFilter` – formaterar alla fel konsekvent

### Testa endpoints lokalt

```bash
# OBS om pipen till jq: `-f` ger curl nollskild exitkod, men en pipe gör $? till
# SISTA kommandots — alltså jq:s. `-sS` räddar det som betyder mest här (felet
# skrivs synligt till stderr i stället för att ge tom utdata), men ska exitkoden
# betyda något: kör utan pipe, eller `set -o pipefail` först. Uppmätt:
#   curl -fsS <nedstängd> | jq .                      → exit 0   (tyst framgång)
#   set -o pipefail; curl -fsS <nedstängd> | jq .     → exit 7

# Hälsokontroll
curl -fsS http://localhost:3000/v1/health | jq .

# Registrera konto. --fail-with-body i stället för -f: vi vill BÅDE ha nollskild
# exitkod på 4xx OCH se API:ets felsvar ({ success: false, error: { … } }).
curl -sS --fail-with-body -X POST http://localhost:3000/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.se","password":"Test123!","firstName":"Test","lastName":"User","organizationName":"Test AB","orgNumber":"556000-0001"}' | jq .

# Logga in och hämta token. Kontrollen är inte pynt: misslyckas inloggningen blir
# TOKEN tom eller "null", och nästa anrop svarar 401 — ett fel som ser ut att
# handla om behörighet i stället för om inloggningen.
TOKEN=$(curl -sS --fail-with-body -X POST http://localhost:3000/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.se","password":"Test123!"}' | jq -r '.data.accessToken')
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || echo "INLOGGNING MISSLYCKADES — TOKEN är '$TOKEN'" >&2

# Autentiserad request
curl -sS --fail-with-body http://localhost:3000/v1/properties \
  -H "Authorization: Bearer $TOKEN" | jq .
```

---

## Frontend – `apps/web`

### Stack

- **React 18** + **Vite 5** (SWC-transformer, inte Babel)
- **Routing:** **TanStack Router** (URL-baserad, `createRouter`/`RouterProvider` i `src/app/router.tsx`). _OBS: den gamla `useState<Route>`-routern är borttagen._
- **Server state:** React Query (`@tanstack/react-query`, staleTime 60s)
- **Client state:** Zustand (persisteras till localStorage som `eken-auth`)
- **Formulär:** React Hook Form + `@hookform/resolvers/zod`
- **Animationer:** Framer Motion 12

### Routing (TanStack Router)

Rutter definieras i `src/app/router.tsx` (route-träd) och navigeras via TanStack Routers
`Link`/`useNavigate` med riktiga URL:er — **inte** den gamla `onNavigate`-callbacken.

Vyerna speglar `features/`-katalogen (~30 sidor), bl.a.: `dashboard`, `overview`,
`properties`, `units`, `tenants`, `customers`, `leases`, `invoices`, `accounting`,
`reports`, `deposits`, `rent-increases`, `terminations`, **`avisering`** (hyresavier),
**`collections`** (inkasso), **`reconciliation`** (bankavstämning), **`consumption`** (IMD),
`documents`, `import`/`contract-batches`, `ai`, `maintenance`, `inspections`,
`maintenance-plan`, `news`, `messages`, `notifications`, `settings` + auth-sidor.

> `admin` och `portal` är egna SPA:er med `react-router-dom` (separata route-träd).

### Katalogstruktur

```
src/
├── app/router.tsx             # TanStack Router – route-träd + RouterProvider
├── main.tsx                   # QueryClientProvider + RouterProvider
├── components/
│   ├── layout/
│   │   ├── AppLayout.tsx      # Sidebar + topbar (autentiserade sidor)
│   │   └── AuthLayout.tsx     # Centrerad kortlayout (login/register)
│   └── ui/                    # Delade UI-komponenter
│       ├── Button.tsx
│       ├── Input.tsx
│       ├── Modal.tsx
│       ├── Badge.tsx
│       ├── DataTable.tsx
│       ├── PageHeader.tsx
│       └── PageWrapper.tsx
├── features/                  # Feature-scoped moduler
│   └── {feature}/
│       ├── {Feature}Page.tsx  # Sidhuvudkomponent
│       ├── api/               # Axios-anrop (get/post/patch/del-helpers)
│       ├── hooks/             # React Query-wrappers
│       └── components/        # Feature-specifika komponenter
├── stores/
│   └── auth.store.ts          # Zustand – user, tokens, isAuthenticated
└── lib/
    ├── api.ts                 # Axios-instans + interceptors
    └── cn.ts                  # cn() helper (clsx + tailwind-merge)
```

### API-lager

```typescript
// lib/api.ts – baseURL: '/api/v1' (proxyas till :3000/v1)
import { get, post, patch, del } from '@/lib/api'

// Typade helpers – packar automatiskt upp { data: T }
const properties = await get<Property[]>('/properties')
const created = await post<Property>('/properties', payload)
const updated = await patch<Property>(`/properties/${id}`, payload)
await del(`/properties/${id}`)
```

### Feature-fil – standardmönster

```
features/properties/
├── PropertiesPage.tsx         # Använder hooks, renderar UI
├── api/
│   └── properties.api.ts      # get/post/patch/del-anrop, typade
├── hooks/
│   └── useProperties.ts       # useQuery/useMutation-wrappers
└── components/
    ├── PropertyCard.tsx
    └── PropertyModal.tsx
```

### Vite-proxy (dev)

```
Webbläsare:  /api/v1/auth/login
→ Vite dev:  rewrite → /v1/auth/login
→ API:       http://localhost:3000/v1/auth/login
```

I produktion gör Vercels `rewrites` (per app `vercel.json`) samma sak mot API:ets publika URL.

---

## Shared – `packages/shared`

Importeras som `@eken/shared` i API:et och alla SPA:er (web/admin/portal).

```typescript
import type { Property, Invoice, UserRole } from '@eken/shared'
import { formatCurrency, formatDate, formatOrgNumber } from '@eken/shared'
import { RegisterSchema, CreatePropertySchema } from '@eken/shared'
import { VAT_RATES, DEFAULT_PAGE_SIZE, INVOICE_TRANSITIONS } from '@eken/shared'
```

### Exports (urval — listan nedan är inte uttömmande)

| Export       | Innehåll                                                                                                                                                                                                                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types/`     | Alla domänmodeller, `JwtPayload`, `TokenPair`, `ApiResponse<T>`                                                                                                                                                                                                                                                              |
| `schemas/`   | Zod-scheman + infererade TypeScript-typer (`RegisterInput` etc.)                                                                                                                                                                                                                                                             |
| `utils/`     | `formatCurrency`, `formatDate`, `formatOrgNumber`, `calculateVat`/`calculateTotal`, OCR (`generateOcrNumber`/`isValidOcrNumber`), svensk kalender (`rentDueDateForMonth`, `isSwedishBusinessDay`), ID-validering (personnr/orgnr), lösenordsstyrka, hyresberäkning (`calculateProratedRent`, `calculateFirstPaymentDueDate`) |
| `constants/` | `VAT_RATES` + typade momssatser (bostad/lokal), `LOCALE`, `CURRENCY`, BAS (`ACCOUNT_CLASS_RANGES`, `RENT_REVENUE_ACCOUNTS`, `CORE_ACCOUNTS`), `INVOICE_TRANSITIONS`/`STATUS_TO_EVENT`/`isValidTransition`, `USER_ROLES`, plans/platform                                                                                      |

**Regel:** Aldrig duplicera typer eller formatfunktioner. `@eken/shared` är den enda källan till sanning.

---

## Databas – Prisma + PostgreSQL

### Prisma-schema (`apps/api/prisma/schema.prisma`)

Schemat har 84 modeller. Kärnan (alla scopade på `organizationId`):

```
Organization 1──* User
Organization 1──* Property 1──* Unit 1──* Lease
Organization 1──* Tenant / Customer   *──* Lease
Organization 1──* Invoice 1──* InvoiceLine
                  Invoice 1──* InvoiceEvent   ← append-only audit log
Organization 1──* Account
Organization 1──* JournalEntry 1──* JournalEntryLine
```

Övriga domängrupper (utöver fakturadelen ovan):

- **Hyresavi/inkasso:** `RentNotice` 1──\* `RentNoticeLine` / `RentNoticeEvent` / `RentNoticePayment`
  (granulär betalningsallokering — bankavstämnings-härdningens sanningskälla)
- **Bankavstämning:** `BankTransaction`, `BankStatementImport`
- **IMD/förbrukning:** `Meter` 1──\* `MeterReading`, `ConsumptionCharge`, `ConsumptionTariff`
- **Depositioner:** `Deposit`
- **Kontrakt/import:** `Contract`, `ContractImportBatch` 1──\* `ContractImportRow`
- **Underhåll/besiktning:** `MaintenanceTicket`(+Comment/Image), `MaintenancePlan`, `Inspection`(+Item/Image)
- **Övrigt:** `Termination`, `RentIncrease`, `Document`, `KeyHandover`, `NewsPost`, `Notification`,
  nummersekvenser (`*Sequence`), `RefreshToken`/`TenantMagicLink`/`TenantSession`
- **AI:** `AiConversation`/`AiMessage`/`AiMemory`/`AiToolExecution`/`AiUsageLog` (m.fl.)
- **Plattform/SaaS:** `PlatformUser`, `PlatformInvoice`, `PlatformRefreshToken`
- **Observability:** `ErrorLog`, `FailedEmail`, `ImpersonationLog`

### Viktiga mönster

- **Multi-tenant:** `organizationId` på alla entiteter utom `User.organization`
- **Append-only audit:** `InvoiceEvent` har ingen `updatedAt`, aldrig UPDATE/DELETE
- **Statusmaskin:** `INVOICE_TRANSITIONS` från `@eken/shared` styr giltiga övergångar
- **Soft-delete:** Ej implementerat – Cascade-delete vid org-borttagning
- **UUID som primärnycklar** (`@default(uuid())`) på alla modeller

### Migration-workflow

```bash
# 1. Ändra schema.prisma
# 2. Kör migration (skapar SQL-fil + uppdaterar DB) — root-script
pnpm db:migrate

# 3. Regenerera Prisma-klient (apps/api-script, kör därifrån)
cd apps/api && pnpm db:generate
```

---

## Kod-konventioner

### TypeScript

- `strict: true` + `exactOptionalPropertyTypes: true` – inga undantag
- `import type { X }` för rena typer, vanlig `import { X }` för värden/klasser
- Undvik `any` – använd `unknown` + type guards
- Aldrig `console.log` – använd `console.warn` / `console.error`

### React-komponenter

- Alltid funktionella komponenter
- Props-interface definieras direkt ovanför komponenten
- `cn()` från `@/lib/cn` för all className-sammansättning
- Inline-stilar endast i Framer Motion `whileHover`/`whileTap`

### Import-ordning

```typescript
// 1. React core
import React, { useState, useEffect } from 'react'
// 2. Tredjepartsbibliotek
import { motion } from 'framer-motion'
import { Building2 } from 'lucide-react'
// 3. UI-komponenter
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
// 4. Layout-komponenter
import { PageWrapper } from '@/components/layout/PageWrapper'
// 5. Feature-specifika komponenter
import { PropertyCard } from './components/PropertyCard'
// 6. Hooks, stores, lib
import { useProperties } from './hooks/useProperties'
import { useAuthStore } from '@/stores/auth.store'
// 7. Typer (alltid sist)
import type { Property } from '@eken/shared'
```

### Svenska i UI

- Alla labels, rubriker, felmeddelanden, knappar, toasts: **svenska**
- Valutor: `formatCurrency(amount)` från `@eken/shared` → SEK-format
- Datum: `formatDate(date)` från `@eken/shared` → sv-SE locale
- Felmeddelanden ska vara specifika: "Organisationsnummer måste ha formatet 556xxx-xxxx"

---

## Designsystem

Varje sida och komponent **måste** följa detta. Fråga alltid: **"Hade Fortnox godkänt detta?"**

### Färgpalett – tokens, aldrig hex

Paletten ägs av `packages/ui/src/tokens.ts` (`EVENO_PALETTE`, 9 semantiska tokens).
Därifrån genereras `tokens.css` (`pnpm --filter @eken/ui gen:tokens`) och Tailwind-
preseten (`tailwind-preset.ts`) mappar samma CSS-variabler till utility-namn.
`@eken/shared/branding.ts` läser `DEFAULT_BRAND_COLOR` ur samma fil, så UI, PDF och
mejl inte kan glida isär.

**Skriv aldrig en färg i kod.** `scripts/check-design-tokens.mjs` är en BLOCKERANDE
CI-check (`design-token-guard` står i `ci-passed`:s `needs`) och ingår dessutom i
`pnpm lint`. Den fäller rå hex, `rgb()`/`rgba()`/`hsl()` och Tailwind-arbitraries
(`text-[#2563EB]`) i `apps/{web,admin,portal}/src`, `apps/api/src` och
`packages/shared/src`. En färg som inte finns i dess klassificering faller som
**NY FÄRG** och kan inte ens allowlistas.

| Roll               | Tailwind (web/admin)      | CSS-variabel (portal + alla) |
| ------------------ | ------------------------- | ---------------------------- |
| App-bakgrund       | `bg-canvas`               | `var(--ev-bg)`               |
| Yta (kort/panel)   | `bg-surface`              | `var(--ev-surface)`          |
| Kant               | `border-line`             | `var(--ev-border)`           |
| Fältkant           | `border-input`            | `var(--ev-input-border)`     |
| Text primär        | `text-ink`                | `var(--ev-text)`             |
| Text dämpad        | `text-ink-muted`          | `var(--ev-text-muted)`       |
| Varumärke / primär | `bg-brand` / `text-brand` | `var(--ev-brand)`            |
| Success            | `bg-success`              | `var(--ev-status-success)`   |
| Warning            | `bg-warning`              | `var(--ev-status-warning)`   |
| Danger             | `bg-danger`               | `var(--ev-status-danger)`    |

**De gamla Tailwind-familjerna är omdirigerade, inte förbjudna.** Web och admin
pekar i sin `tailwind.config.ts` hela familjer på @eken/ui:s härledda skalor, så
befintliga klasser fortsätter fungera och blir varma av sig själva:

```
gray-*     → var(--ev-neutral-*)     blue-*   → varumärkesskalan (GRÖN sedan F5)
emerald-*  → success-skalan          amber-*  → warning-skalan     red-* → danger-skalan
```

> ⚠️ **`blue-*` är inte blått.** Efter färgflippen (F5) slår `bg-blue-600` upp
> varumärkesgrönt. Skriv hellre `bg-brand`. En yta som ska vara neutral ska INTE
> använda `blue-*` — se info-nivån under Badges.

**Skalsteg med regler** (härledda i `tokens.ts`, ingen egen hex):

```
neutral-300  avdelare och dekor — INTE text
neutral-400  tertiär text (tidsstämplar, metadata, hjälptext). Framräknat till
             WCAG AA: 4.65:1 mot kanvas. Svagaste LÄSBARA nivån.
neutral-500  dämpad text        neutral-900  primär text
status 50–400  YT-steg (tinter) — bär text, är inte text
status 500/600 förgrund när statusfärgen ska vara text eller ikon
```

**Komponent-variabler** (utanför den låsta 9-token-paletten, men alltid med
palett-härledd default — aldrig egen hex): `--ev-row-hover`, `--ev-row-border`,
`--ev-input-border`.

**Mörka ytor** (sidomeny, marknadspanel): `--ev-dark`, `--ev-dark-elevated`,
`--ev-dark-text`, `--ev-dark-text-muted`. Varm kolsvart, inte kall blåsvart.

**Behöver alfa?** En hex bakom `var()` går inte att dela upp. Använd kanalformen:
`rgb(var(--ev-brand-500-ch) / 0.12)`. Grinden känner igen den.

<details>
<summary>Målvärdena som referens – <b>får aldrig skrivas i kod</b></summary>

Enbart för att känna igen paletten i en skärmdump eller ett designverktyg. Varje
värde nedan är hårdkodat exakt det som `palette-hex`-regeln fäller utanför
`packages/ui` — den regeln har ingen tolerans och kan inte tystas.

```
brand / status-success  #1a6b3c     bg (kanvas)   #f6f4f0
surface                 #ffffff     text (bläck)  #241f1a
text-muted              #5a5248     border        #ece7e0
status-warning          #b8791a     status-danger #c6402f
mörk bas                #1f1a16
```

Den GAMLA paletten (`#F7F8FA`, `#EAEDF0`, `#DDDFE4`, `#111827`, `#6B7280`,
`#9CA3AF`, `#2563EB`, `#1D4ED8`) stod här fram till 2026-08-20. Den är inte bara
otidsenlig utan aktivt röd i CI. `#F7F8FA` är dessutom så avlagt att det inte ens
finns i grindens klassificering — det faller som NY FÄRG.

</details>

### Typografi (Poppins, self-hostad)

Poppins 400/500/600/700, woff2 i `packages/ui/src/fonts/`, laddad via
`@eken/ui/fonts.css` som också definierar `--ev-font-sans`. Inga CDN-anrop.
**Inter är borttaget** ur samtliga `index.html` (F4) — nämn det inte ens som
fallback, kedjan går till systemtypsnitt.

```
Sidtitel (PageHeader):   text-[26px] font-bold tracking-tight leading-tight
Sidbeskrivning:          text-[14px] text-gray-500
Sektionsrubrik:          text-[14px] font-semibold
Kortinnehåll primärt:    text-[13.5px] font-medium
Brödtext:                text-[13px]
Etikett / caption:       text-[12px]
Mikro / badge-text:      text-[11px]
KPI-värde:               text-[26px] font-semibold tracking-tight
```

### Komponenter

**Kort**

```
bg-surface rounded-2xl border border-line
hover: shadow-sm transition-shadow
whileHover={{ y: -2, boxShadow: '0 8px 24px rgba(0,0,0,0.08)' }}
padding: p-4 (kompakt) | p-5 (standard)
```

**Tabeller**

Använd den delade `<DataTable>` från `@eken/ui/react` – handrulla inte tabeller.
Specen nedan beskriver vad den komponenten faktiskt gör; webs stil är baslinjen
(beslut 2026-07-24, löser PR6:s öppna punkt – specen ska följa koden, inte tvärtom).

```
Wrapper:       overflow-hidden rounded-2xl border border-gray-100 bg-white
               shadow-[0_1px_4px_rgba(0,0,0,0.04)]
Tabell:        w-full text-[13.5px]   ← storleken ärvs av cellerna
Kolumnrubrik:  text-[11.5px] font-semibold uppercase tracking-wider text-gray-400
Rubrikrad:     border-b border-gray-100 bg-gray-50/60
Rad-hover:     hover:bg-[var(--ev-row-hover)]
Radborder:     border-b border-[var(--ev-row-border)] last:border-0
Cellhöjd:      py-3.5 (default) | py-3 (density="compact")
Klickbar rad:  tabIndex 0 + Enter/Blanksteg + focus-visible:outline (INTE ring)
```

**Knappar** (`components/ui/Button.tsx` – `variant` × `size`)

```
Bas:       rounded-[10px] font-medium transition-all duration-150
           focus-visible:ring-2 focus-visible:ring-blue-500/40 ring-offset-1
           active:scale-[0.97]   ← CSS transform, INTE Framer Motion på knappar
Primary:   bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800
           + skugga i kanalform: rgb(var(--ev-brand-500-ch)/0.3)
Secondary: bg-white text-gray-700 border border-gray-200 hover:bg-gray-50
Outline:   bg-transparent text-blue-600 border border-blue-200 hover:bg-blue-50
Ghost:     text-gray-600 hover:bg-gray-100 hover:text-gray-900
Danger:    bg-red-500 text-white hover:bg-red-600 active:bg-red-700

Storlekar: xs h-7 px-2.5 text-[12px] | sm h-8 px-3.5 text-[13px]
           md h-9 px-4 text-[13.5px]  ← default
```

> `variant` defaultar till `secondary`, inte `primary`.

**Input / Select** (`components/ui/Input.tsx`)

```
h-10 w-full rounded-xl border bg-white px-3.5 text-[13.5px] text-gray-900
placeholder:text-gray-400
Normal:  border-gray-200 hover:border-gray-300
Fokus:   focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15
Fel:     border-red-300 focus:border-red-400 focus:ring-red-500/15
Disabled: border-line bg-gray-100/70 text-gray-500
Label:   text-[13px] font-medium text-gray-700
Fel/hint: text-[12px] text-red-500 / text-gray-400
```

**Modals** – delad `<Modal>` från `@eken/ui/react`

```
Backdrop:   bg-black/25 backdrop-blur-[2px]
Panel:      bg-white rounded-2xl border border-line shadow-xl
            max-h-[calc(100vh-80px)] overflow-hidden
Animation:  scale 0.96→1 + y 8→0, spring { stiffness: 400, damping: 30 }
Rubrik:     text-[17px] font-semibold text-gray-900
Beskrivning: text-[13px] text-gray-500
Stängknapp: h-8 w-8 rounded-lg text-gray-400 hover:bg-gray-100
Header/footer i panelen: border-line px-5, pt-4 pb-4 / py-4
<ModalFooter> (i innehållet): mt-5 border-t border-line pt-4 justify-end gap-2
```

**Badges**

```
Base:     inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5
          text-[12px] font-medium
Dot:      h-1.5 w-1.5 rounded-full (prop `dot`)

Success:  bg-emerald-50 text-emerald-700
Warning:  bg-amber-50   text-amber-700
Danger:   bg-red-50     text-red-600
Info:     bg-gray-200   text-gray-500   ← NEUTRALT, inte blått (6.24:1)
Default:  bg-gray-100   text-gray-600
Ghost:    border border-gray-200 text-gray-500 bg-transparent
Purple:   bg-purple-50  text-purple-700  ⚠️ se nedan
```

> **Info är neutralt.** Ett neutralt tillstånd ("Skickad", "Pågår", "Bokförd")
> påstår ingenting om utfallet och får därför neutralskalans grå. Signalfärgerna
> — grön, gul, röd — är reserverade för faktiska signaler. Skriv aldrig
> `bg-blue-50` för info: det är dels fel semantik, dels grönt sedan F5.
>
> **`purple` är designskuld.** `purple-*` är INTE mappad till någon @eken/ui-skala
> i vare sig webs eller admins config, så varianten renderar Tailwinds kalla
> stock-lila i en varm palett. Den är osynlig för färggrinden (ingen rå hex).
> Använd den inte i ny kod.

**Filterflikar**

```
Wrapper: bg-gray-100 rounded-xl p-1 w-fit flex gap-1
Aktiv:   bg-white shadow-sm text-gray-900 rounded-lg h-8 px-3
Inaktiv: text-gray-500 hover:text-gray-700 rounded-lg h-8 px-3
Text:    text-[13px] font-medium
```

### Domän-badges – återanvänd alltid

```tsx
<UnitStatusBadge status={unit.status} />
<InvoiceStatusBadge status={invoice.status} />
<LeaseStatusBadge status={lease.status} />
<PropertyTypeBadge type={property.type} />
```

### Ikoner – Lucide React

```
strokeWidth: 1.8 (standard) | 2.2 (aktiva nav-items)
Sidebar nav:        16px
Tabeller/kort:      12–14px
Tomma tillstånd:    24px
```

---

## Animationer – Framer Motion

### Sidövergång (varje sida)

```tsx
// Varje feature-sida wrappas i <PageWrapper id="page-name">
<motion.div
  initial={{ opacity: 0, y: 10 }}
  animate={{ opacity: 1, y: 0 }}
  exit={{ opacity: 0, y: -6 }}
  transition={{ duration: 0.2 }}
>
```

### Stagger-listor (alltid på grid/listor)

```tsx
const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
}
const item = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
}

<motion.div variants={container} initial="hidden" animate="show">
  {items.map(i => <motion.div key={i.id} variants={item}>...</motion.div>)}
</motion.div>
```

### Modal-spring

```tsx
initial={{ opacity: 0, scale: 0.96, y: 8 }}
animate={{ opacity: 1, scale: 1, y: 0 }}
exit={{ opacity: 0, scale: 0.96, y: 8 }}
transition={{ type: 'spring', stiffness: 400, damping: 30 }}
```

### Timing

```
Snabba övergångar:  0.15–0.2s duration
Spring:             stiffness 300–400, damping 28–32
Stagger per barn:   0.04–0.07s
```

---

## Sidlayout – standardmönster

Varje feature-sida ska ha exakt denna struktur:

```tsx
<PageWrapper id="properties">           {/* 1. Framer Motion wrapper */}
  <PageHeader
    title="Fastigheter"
    description="Hantera dina fastigheter"
    action={<Button variant="primary">Lägg till fastighet</Button>}
  />

  {/* 2. KPI-kort (mt-6, 2–4 kolumner) */}
  <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
    ...
  </div>

  {/* 3. Filterflikar (mt-6) */}
  <div className="mt-6">...</div>

  {/* 4. Datatabell eller kortgrid (mt-4) */}
  <div className="mt-4">...</div>

  {/* 5. Tom state */}
  <EmptyState icon={Building2} title="Inga fastigheter" description="..." action={...} />

  {/* 6. Modal: skapa + detalj/redigera */}
  <CreatePropertyModal open={...} onClose={...} />
</PageWrapper>
```

---

## Vakter: en kontroll som inte kan falla mäter ingenting

Kodbasen har ett tiotal automatiska vakter — kolumnpartitioner, mönsterkontroller,
golden-filer — som ska bli RÖDA när någon flyttar en gräns. Den vanligaste
defekten i dem är inte att de har fel, utan att de går BLINDA: slutar mäta, utan
att sluta vara gröna.

**Namngivna negativkontroller skyddar mot SPECIFIKA återfall. De upptäcker inte
att mekanismen gått blind.** `expect(valda).not.toContain('passwordHash')` fångar
att just det fältet återinförs — men inte att partitionen som skulle fånga alla
andra fält har slutat fungera.

En delad vakt behöver därför en **kanariefågel**: en kontroll som matar in något
som MÅSTE ge utslag, och kräver att det gör det. Bryts mekanismen blir varje
konsument röd, inte bara hjälparens egen spec.

Belägget är uppmätt (#463), inte resonerat:

```
trasig hjälpare + verklig oklassad kolumn i schemat
  före kanariefågeln   →  4/4 konsumenter GRÖNA
  efter                →  4/4 konsumenter RÖDA
```

Samma princip gäller utanför testerna. Ett CI-jobb som tyst hoppar över sina steg
är grönt för alltid; ett fail-fast som aldrig prövats i det läge det ska fånga är
en kommentar. **Fråga alltid: vad skulle få den här kontrollen att falla — och
har jag sett den falla?**

---

## En förbehandlad indata är bara de filer kontrollen klarade att läsa

Direkt syskon till kanariefågeln ovan. En kontroll som **förbehandlar** sin
indata — strippar kommentarer, blankar stränginnehåll, normaliserar escapade
tecken — mäter inte källan. Den mäter sin egen tolkning av källan. Tolkar den
fel blir utfallet inte ett fel, utan **tystnad**.

Uppmätt i PDF-mallvakten (#567). Skannern blankar stränginnehåll för att en `//`
inne i en mall ska kunna vara `https://` och inte en kommentar. Den kände inte
regex-literaler, och läste därför `"` i

```js
.replace(/"/g, '&quot;')
```

som en strängstart — och blankade allt fram till nästa `"`:

```
11 629 tecken av platform-invoices.service.ts maskerade
  → renderingsanropet försvann ur mängden
  → vakten var GRÖN om HELA den filen
```

Ingen befintlig regel föll. Vakten hade inte fel om något; den hade slutat läsa.

**Regeln:** en kontroll som förbehandlar sin indata måste ha en kanariefågel som
matar in **exakt det mönster som kan lura förbehandlingen** — inte bara ett
positivt fall. Den i #567 matar in en regex-literal följd av en mall med extern
referens och kräver att mallen fortfarande hittas. Utan den mäter kontrollen
bara de filer den råkar klara av att läsa, och man vet inte vilka de är.

---

## En regel som frågar prosa i stället för kod är alltid uppfylld

Två varianter av samma defekt, båda mätta, båda funna genom att någon **bröt
regeln med flit** — ingen av dem hittades genom läsning. Det är poängen: de ser
riktiga ut i koden.

**Variant 1 — villkoret läser en kommentar.** `check-transaction-limits`
frågade `kropp.includes('PAYMENT_TX_LIMITS')` på RÅTEXTEN, medan dess
parentesmatchning med flit hoppade över kommentarer. Halva funktionen visste att
prosa inte är kod; den andra halvan gjorde det inte. Isolerat till en variabel:

```
gränsen borttagen, kommentaren kvar  →  vakten GRÖN   (blind)
gränsen borttagen, kommentaren också →  vakten RÖD
```

Mönstret fanns redan på riktigt: raden ovanför spridningen i
`markAsPaidManually` är en kommentar som förklarar var talen bor och därför
NÄMNER identifieraren, inne i samma parentes. En refaktorering som tar bort
spridningen men behåller förklaringen — det troliga — hade släppts igenom.

**Variant 2 — sökfönstret avgränsas av något som ligger INUTI det man letar
efter.** En regel skulle kräva att en fråga ställs före ett påstående, och att
det finns en utgång emellan. Den mätte fönstret fram till strängen
`'redan utförd'` — som står i `throw new ConflictException('…redan utförd…')`.
Fönstret innehöll därför alltid det `throw` regeln krävde, oavsett vad koden
gjorde. Regeln var grön av sin egen avgränsare.

**Regeln, i två delar:**

1. **Ställ frågan mot KOD.** Gå via `codeMask(...)` i
   `scripts/lib/source-scan.mjs` — kommentarer och stränginnehåll blankade,
   avgränsare och radbrytningar kvar, så radnumren fortfarande pekar på råfilen.
   Skriv aldrig en egen förbehandlare; `check-guard-preprocessors` finns för
   det, och kräver dessutom att du kör den delade skannerns kanariefåglar.
2. **En fönsteravgränsare får aldrig vara en delsträng av villkoret.** Välj en
   avgränsare som är STRUKTURELL — blockslut, funktionsslut, satsens början —
   aldrig innehållslig. Frågar du "finns ett `throw` före X", får fönstret inte
   sluta inuti det `throw` som skriver X.

**Kanariefågeln som krävs:** mata in samma anrop två gånger, där den enda
skillnaden är att identifieraren står i en kommentar respektive i kod, och kräv
motsatt utfall. Ett prov som bara visar det positiva fallet skiljer inte en
läsande regel från en blind.

### Men EN VY PER FRÅGA — `codeMask` överallt gör vakten stum

Punkt 1 ovan är rätt och farlig på samma gång. Läst som "byt allt till
`codeMask`" tar den bort skärpan i stället för att lägga till den, och resultatet
ser MODERNT ut: vakten går via den delade skannern, kör dess kanariefåglar och
är grön. Den mäter bara ingenting längre.

Uppmätt i tre av tio migrerade vakter. Skarpast i `check-redact-copies`, där
fältnamnen ÄR strängar:

```
fältnamn ur SENSITIVE_FIELD_NAMES   råtext 11 · blankComments 11 · codeMask 11
```

Elva även med `codeMask` — men **alla elva är blanksteg**. `/'([^']+)'/` matchar
`'              '` lika gärna som `'personalNumber'`. Med den ändringen inlagd
förblev den skarpa körningen grön och skrev fortfarande "11 fältnamn", medan
fältöverlappet aldrig mer kunde bli sant.

**Välj vy efter vad frågan handlar om:**

| vy                         | svarar på                                         | exempel                                                                                         |
| -------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `codeMask`                 | är det här ett ANROP, en definition, ett villkor? | `platformInvoice.create(`, `function redactSensitive`, parentes- och klammermatchning           |
| `blankComments`            | det som BOR i en sträng                           | rå SQL (`INSERT INTO "…"`), fältnamn, låsnycklar, nollställning i strängform (`feeAmount: '0'`) |
| `tokenize` → kommentarerna | markörer som med FLIT är kommentarer              | `redact-copy-allow:`, `KLASSIFICERING: B`                                                       |

Alla tre bevarar längd och radbrytningar, så radnumren pekar på råfilen och
samma index kan användas i flera vyer av samma fil.

**Frågan att ställa innan du byter mask:** var bor det jag letar efter — i kod,
i en sträng, eller i en kommentar? Svarar du "i en sträng" är `codeMask` fel
verktyg, och felet är tyst.

**Och en mask räcker sällan.** `check-reminder-fee-source` behöver båda samtidigt:
närhetsfönstret måste läsa KOD (annars uppfyller en kommentar som nämner
resolvern kravet), medan nollställningen måste läsa STRÄNGAR (annars blir
`feeAmount: '0'` ett falskt larm). Lösningen är två positionsbevarande masker och
ett INTERVALL i stället för en delsträng, så samma index gäller i båda.

---

## Ett för svagt prov ser ut precis som blindhet

När en negativkontroll INTE fäller finns två förklaringar, och de ser likadana
ut: vakten är blind, eller sonden var för svag. Antar man det första bygger man
om något som fungerar.

Uppmätt: `check-redact-copies` skulle prövas mot en fil under
`apps/api/src/inspections/`. Sonden räknade upp `personalNumber`, `passwordHash`
och tre påhittade fältnamn — **två** kanoniska mot vaktens tröskel
`MIN_FIELD_OVERLAP = 3`. Vakten var grön, och det såg ut som exakt den blindhet
jag letade efter. Med fem kanoniska namn föll den direkt.

**Regeln: läs tröskeln UR KODEN innan du bygger sonden, och visa att sonden
överskrider den.** Tröskeln kan vara ett antal (`MIN_FIELD_OVERLAP`), en längd
(`MIN_REASON`), ett beloppsspann eller en tidsgräns. Skriv ut både tröskeln och
sondens värde i mätningen — annars kan ingen skilja "vakten såg inget" från
"det fanns inget att se".

---

## En första beskrivning är ett STICKPROV, inte en uppräkning

Det man först ser är det fall man råkade snubbla på. Det är nästan alltid sant
och nästan aldrig hela mängden — och skillnaden mellan de två är inte en
noggrannhetsfråga, den är en arbetssättsfråga: **beskriv inte fyndet, bygg
instrumentet och låt det räkna upp mängden.**

Tre instanser från en och samma dag, alla mätta:

| första beskrivningen                                       | vad instrumentet gav                                                                                             |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| "ett hål i regex-läget, **14 854** tecken slutar maskeras" | **sju** hål, **704 188** tecken — blockkommentar-läget ensamt var 650 563                                        |
| "tio vakter gör rå textmatchning"                          | rätt antal, men **tre av dem** hade blivit STUMMA av den uppenbara fixen (codeMask blankar de strängar de mäter) |
| "låsnyckeln **kan** stå kvar i en loggsträng"              | **varje** klass-A-nyckel står så — alla sju jobben, alltid exakt två förekomster                                 |

Skillnaden mellan 14 854 och 704 188 är hela skillnaden mellan de två
arbetssätten. Ingen av de tre första beskrivningarna var fel; alla tre var för
snäva, och alla tre hade lett till en fix som täckte det man sett.

**Regeln:** när du hittar ett fall — skriv den kod som räknar upp ALLA fall av
samma form, och redovisa talet. En mutationsrigg, ett svep över trädet, en
uppräkning ur schemat. Först då vet du om du har ett fynd eller ett mönster.

Och notera vilket håll osäkerheten lutar åt: en första beskrivning är för snäv,
inte för bred. Det gör den farlig, eftersom en fix som täcker det beskrivna
fallet ser färdig ut.

## En uppräkning krymper tyst — av ett tak ELLER av ett filter

Samma familj: mängden ser fullständig ut därför att det som föll bort inte
lämnade något spår.

**Taket** är det uppenbara: `head`, `tail`, `-m`, en `LIMIT`. En uppräkning som
ska vara uttömmande får aldrig passera ett tak. Räkna först, jämför antalet mot
källan, och **skriv ut antalet** — en trunkering syns bara om talet står där.

**Filtret är det farliga**, för det ser omsorgsfullt ut. Uppmätt i #567:
uppräkningen av PDF-flöden filtrerades med `grep -v spec` för att utesluta
testfiler. Den uteslöt också **hela `apps/api/src/inspections/`** — katalognamnet
bär delsträngen `spec`:

```
in[spec]tions

grep -rn "generateFromHtml" … | grep -c inspections            → 7
grep -rn "generateFromHtml" … | grep -v spec | grep -c inspec…  → 0
```

Bland de sju låg `inspections.service.ts:434` — ett riktigt PDF-flöde
(besiktningsprotokollet), som föll ur mängden tillsammans med sex spec-rader.
Det saknades i BÅDA uppräkningarna och kom tillbaka först när mallmängden
härleddes ur koden i stället för att listas.

**Ett `-v`-mönster är en delsträngsmatchning mot hela sökvägen, inte mot
filtypen.** Ska testfiler uteslutas: matcha formen (`\.spec\.ts$`), inte ordet.

En efterräkning till. Jag rapporterade först `| head -12` som orsaken. Listan var
åtta rader — taket klippte ingenting. **Orsaken var gissad, inte mätt**, och en
gissad orsak leder nästa person till fel åtgärd. Belägg den, eller skriv
"oklart".

---

## Ett bekräftat TAL kan ändå styra fel lista — jämför medlemmarna

Planen sa "fem utåtriktade verktyg". En omräkning gav fem. Talet var ändå fel:
`export_for_collection` stod med och skulle inte (den laddar upp till R2 — ingen
mottagare), och `prepare_contract_signing` saknades och skulle stå med (den
dispatchar till signeringsprovidern). **En falsk positiv och en falsk negativ tog
ut varandra i summan**, så siffran såg bekräftad ut medan medlemslistan var fel —
och det var listan som styrde vad som aldrig får delegeras.

**Byter en mängd härledningsmetod: diffa MEDLEMMARNA, aldrig bara antalet.**
Skriv ut båda listorna och jämför namn mot namn. Ett oförändrat antal är inget
belägg för en oförändrad mängd.

Samma dag gav en tjänstenivå-analys 23 "externa" verktyg och en metodnivå-analys 7. Skillnaden var inte brus utan fråga: en tjänst som _injicerar_ `MailService` är
inte extern om metoden bara skriver i databasen.

---

## Skriv i varje vakt vad den INTE kan se

En kopplingskontroll är inte en beteendekontroll, och båda ser likadana ut i CI.
Två mätningar samma dag:

```
persisteringen av AiToolEffect helt bortkopplad
  → check-ai-tool-effects GRÖN · hela sviten GRÖN (338/338)

sänkans skrivning gjord till no-op
  → check-cron-error-sink GRÖN · cron-error-sink.spec GRÖN (5/5)
  → bara db-riggarna föll
```

Ingen av vakterna hade fel. De läser källtext och mäter att mekanismen är
PÅKOPPLAD — de kan per konstruktion inte se en runtime-no-op.

**Skriv gränsen i vaktens egen fil, som ett eget stycke.** Inte i PR-texten: den
läses en gång. Formen som fungerar är två meningar — "den här mäter X" och "den
kan inte se Y; det ägs av Z". Utan den läser nästa person grönt som mer än det är,
och bygger ovanpå.

---

## När två luckor är lika otäckta: laga den vars data FÖRSVINNER

Prioriteringsordningen är återvinningsbart mot förlorat, inte allvarligt mot
lindrigt.

Mätt två gånger samma dag. Ett cron-fel i Sentry finns kvar och blir läsbart den
dag ett token finns; samma fel i den lokala loggen är borta vid nästa deploy — och
det blev ordningen att laga sänkan först. Och `sendInvoiceEmail` returnerade ett
`jobId` som kastades bort: det sparas nu, trots att ingen frågekod finns, eftersom
**ett handtag som inte sparas är förlorat för alltid medan en frågeväg går att
bygga när som helst**.

Följdregeln åt andra hållet: bygg INTE frågevägen samtidigt. En frågeväg utan
anropare är en vakt med tom mängd.

---

## Två strömmar i ett träd: återställ aldrig brett

Kör två sessioner i samma arbetskatalog delar de HEAD och index. Uppmätt: ett
`git add -A` från den ena svepte med den andras ocommittade fil, och ett
`git checkout -b` skapade en gren mitt i den andras commit-kedja.

```bash
pwd -P && git status --short          # FÖRE varje återställning
git checkout -- <namngivna filer>     # aldrig `.`, aldrig en katalog
```

Namnge filerna. `git status --short` före OCH efter, så en tom diff inte
förväxlas med en lyckad återställning. Arbeta helst i en egen worktree
(`git worktree add`) — den har eget HEAD och eget index, och delar bara
objektdatabasen.

---

## En rad i en statuslista är ett spår, inte ett faktum

**Mät premissen mot aktuell `main` innan du bygger på en revisions- eller
backlograd.** Raden säger var någon en gång hittade något — inte att det finns
kvar.

Kostnaden är uppmätt, inte befarad. Revisionslistan skrevs före 2026-08-16 och
uppdaterades aldrig efter en batch om SEXTON PR:er samma dag, som löste sju av
dess poster. Fyra halva sessioner gick åt till att upptäcka en post i taget att
arbetet redan var gjort — med en stående risk att någon "lagar" fungerande kod.
Listan var dessutom delvis historik redan när den skrevs: H2:s radlåsning (#109)
landade två månader tidigare.

Därför bär varje rad i [`docs/revision-status.md`](./docs/revision-status.md) en
**commit-sha**, inte bara ett datum. Ett datum säger när någon skrev raden; en
sha säger vilket tillstånd raden beskriver:

```bash
git merge-base --is-ancestor <sha-i-raden> HEAD   # mätt mot en förfader?
git log --oneline <sha-i-raden>..HEAD -- <filerna raden pekar på>
```

Har något landat i de filerna sedan dess — mät om posten från KODEN. Visar
mätningen att den redan är löst: skriv det, uppdatera raden, bygg inte om den.

**Och referera till sakfrågan, aldrig till bokstaven.** Minst tre H1–H5-serier är
i omlopp samtidigt (SIE4-auditen i `docs/accounting-fix-status.md`, OCR-serien i
#553/#554, och revisionslistan). Samma bokstav betyder olika saker i olika
omgångar, och har redan lett fel.

## Spärrar är riktade: fråga alltid efter den omvända riktningen

**Bygger du en spärr mot att göra X på något som redan är Y — fråga om spärren
mot att göra Y på något som redan är X också behövs.** Den frågan är billig att
ställa och dyr att hoppa över.

Belägget är två fall samma vecka, båda funna av granskning och inte av tester:

| Ärende | Spärren som byggdes            | Spärren som glömdes            |
| ------ | ------------------------------ | ------------------------------ |
| #517   | kreditera en makulerad faktura | makulera en krediterad faktura |
| #518   | kreditera en annullerad avi    | annullera en krediterad avi    |

Samma orsak i båda: **två verifikat i olika `sourceId`-namnrymder rör samma
fordran.** Reverseringen slår upp sin egen namnrymd, hittar originalet orört och
speglar HELA beloppet en andra gång. Utfallet är en negativ kundfordran och en
negativ intäkt på det dubbelräknade beloppet.

Varje enskilt verifikat balanserar. Felet uppstår först i **sekvensen** — och
därför fångar ingen verifikat-kontroll det, inte heller den globala balansgrinden.

**Den skarpa formen av frågan:** kan de två operationerna reversera in i SAMMA
namnrymd är de ofarliga — `createNumberedEntry` är idempotent per
`(org, source, sourceId)`, så den andra körningen hittar den befintliga posten
och bokför ingenting. (Så är det för påminnelseavgiften: både `cancelNotice` och
den manuella strykningen skriver `reminder-fee-reversal:<id>`.) Skiljer sig
namnrymderna åt finns inget skydd alls, och då MÅSTE båda riktningarna spärras.

## Kvalitetschecklist

Kör detta mentalt innan varje feature anses klar:

```
[ ] PageWrapper med id + enter/exit-animation
[ ] PageHeader: titel, beskrivning, primär action-knapp
[ ] KPI-kort om relevant (2–4 kolumner, responsive grid)
[ ] Stagger-animation på alla listor och grids
[ ] Filterflikar om mer än 2 statusar är relevanta
[ ] Datatabell: rounded-2xl border, korrekt rubrikstil, rad-hover
[ ] Modal: skapa nytt + detalj/redigera
[ ] Tomt tillstånd med EmptyState-komponent
[ ] Alla belopp via formatCurrency(), alla datum via formatDate()
[ ] Domän-badges (UnitStatusBadge etc.) istället för råtext
[ ] Svenska labels, rubriker och felmeddelanden
[ ] pnpm typecheck – noll TypeScript-fel
[ ] Inga console.log (bara console.warn/console.error)
[ ] Responsive: grid-cols-1 sm:grid-cols-2 lg:grid-cols-X
[ ] Verifiera mot live API med curl om ny endpoint skapats
```

---

## Deployment

> **Full deploy-guide: [`DEPLOYMENT.md`](./DEPLOYMENT.md)** (tjänster, env-vars, CI). Sammanfattning:

- **API** → **Railway** (Docker: `apps/api/Dockerfile` → `apps/api/scripts/migrate-and-start.sh`,
  som kör `prisma migrate deploy` + `node dist/main.js`; containern exponerar port 8080).
- **web / admin / portal** → **Vercel** (Vite-builds; API-proxy via varje apps `vercel.json`-rewrite).
  Deployas av `.github/workflows/deploy.yml` på push till `main` (CI = `ci.yml`: typecheck + lint).
- **Postgres + Redis** → Railway-plugins.

### `--delete-branch` på en PR som är BAS för en annan stänger den beroende PR:en

Mekaniken, inte en tillsägelse. En stackad PR har `base` satt till den andra PR:ens
gren i stället för `main`. Raderas den grenen — vilket `gh pr merge --delete-branch`
gör som en del av merge:n — förlorar den beroende PR:en sin bas. GitHub stänger den
då automatiskt, och den går **inte** att återöppna:

```
gh pr view  <n>  → {"state":"CLOSED","mergeStateStatus":"DIRTY"}
gh pr reopen <n> → GraphQL: Could not open the pull request.
gh pr edit <n> --base main
                 → GraphQL: Cannot change the base branch of a closed pull request.
```

Commitsen är oskadda — bara PR:en är borta. Återställning: rebasa grenen på main
och öppna en **ny** PR. Beskrivning, granskningskommentarer och CI-historik följer
inte med.

**Se det i förväg.** Innan du mergar med `--delete-branch`, lista vilka öppna
PR:er som inte utgår från `main`:

```bash
gh pr list --json number,title,headRefName,baseRefName \
  --jq '.[] | select(.baseRefName != "main") | "\(.number) bas=\(.baseRefName)"'
```

Tom utdata = inga stackar, `--delete-branch` är riskfritt. Står din grens namn i
`bas=`-kolumnen är den bas för någon annan: merga utan `--delete-branch`, merga
den beroende PR:en först, eller rikta om dess bas till `main` (`gh pr edit <n>
--base main`) **innan** du rör basgrenen — det går bara medan PR:en är öppen.

Hände i #447 (bas var #446:s gren), ersatt av #448.

### Frontend-deployer kan vara strypta i 24 timmar

Vercel rate-limitar builds (`upgradeToPro=build-rate-limit`). När taket slås i
failar `Vercel – eken-web/admin/portal` medan `CI passed` förblir grön — **en
grön required-check betyder alltså inte att webben är ute**.

Det är samma form som avsnittet om Railway ovan, fast åt andra hållet: där
deployas MER än man tror (Railway lyssnar på `main` utan att bry sig om CI), här
MINDRE (bygget körs aldrig). Båda gör `CI passed` till ett svagt bevis om vad som
faktiskt kör.

Kontrollera `deploy.yml`-körningen för squash-commiten innan du påstår att en
frontend-ändring är ute.

### `gh pr checks <nummer>` kan svara om en ÄLDRE körning

Den fjärde varianten av samma tema. De tre andra handlar om att `CI passed` säger
för mycket eller för lite om vad som DEPLOYAS. Den här handlar om att
checklistan kan beskriva en **annan commit än den du tror** — och då är det inte
deployen som är fel, utan din bild av vad som ens testats.

`gh pr checks <nummer>` frågar på PR:en, inte på ett sha. Precis efter en push
— och särskilt efter `git merge origin/main` in i grenen — hinner GitHub svara
med den föregående körningen. Utfallet är en helgrön lista som saknar det jobb
du just lade till, vilket ser ut som "jobbet kördes inte" i stället för "du
frågade om fel commit".

Uppmätt 2026-08-21 på #546, som mergade in main (med ett nytt vaktjobb i
`ci-passed`:s `needs`) och pushades:

```
gh pr checks 546                 → 14 gröna, UTAN "Redaction single-source guard"
körningen för merge-commitens sha → 15 gröna, MED den
```

**Fråga på SHAN efter varje push och varje merge från main:**

```bash
SHA=$(git rev-parse HEAD)
RUN=$(gh run list --workflow ci.yml --json databaseId,headSha \
  --jq "[.[] | select(.headSha==\"$SHA\")][0].databaseId")
gh run view "$RUN" --json jobs --jq '.jobs[] | "\(.conclusion // .status)\t\(.name)"'
```

Samma regel gäller när du läser antalet jobb: härled det ur körningen eller ur
`toJSON(needs)`, aldrig ur en lista du råkade titta på vid fel tidpunkt.

### Railways byggkonfiguration kan glida ifrån `railway.toml`

Den TREDJE varianten av samma tema. De två ovan handlar om att `CI passed` säger
för mycket (Railway deployar utan att bry sig om checkar) eller för lite (Vercel
strypt). Den här handlar om att bygget kan köra **fel sak, eller ingenting alls**,
utan att vare sig CI eller repot märker något.

Hände 2026-08-18: tjänstens builder hade bytts från Dockerfile till **RAILPACK**,
och `healthcheckPath` försvunnit. `railway.toml` sa fortfarande `builder =
"DOCKERFILE"` — men `railwayConfigFile` stod på `None`, så filen lästes inte.
Tre deployer i rad föll, utan att en enda rad kod var inblandad.

**Två fällor som kostade en timme:**

1. **`railway redeploy` läser INTE om konfigurationen.** Den spelar om en sparad
   byggplan. Manifestet får `reason: redeploy` och behåller den gamla byggaren,
   oavsett vad man just ändrat. En konfigurationsändring kräver en KÄLLBASERAD
   deploy — konsolens _Deploy latest commit_, eller:

   ```bash
   railway api 'mutation { serviceInstanceDeployV2(serviceId: "…", environmentId: "…", commitSha: "…") }'
   ```

   Manifestet ska då säga `reason: deploy`.

2. **`Builder`-enumen har inget `DOCKERFILE`-värde.** Den är
   `['HEROKU','NIXPACKS','PAKETO','RAILPACK']`, och `builder: DOCKERFILE` avvisas.
   Railway modellerar Dockerfile via **`dockerfilePath`**, inte via byggaren. Efter
   en lyckad återställning läser tjänstens `builder` alltså fortfarande `RAILPACK`
   medan deployens manifest säger `DOCKERFILE`. Det ser fel ut och är rätt.

Läs byggkonfigurationen så här (inga variabelvärden — jfr `railway variables`):

```bash
railway api 'query { service(id: "<id>") { serviceInstances { edges { node {
  builder dockerfilePath healthcheckPath railwayConfigFile buildCommand startCommand
} } } } }'
```

**En misslyckad deploy river inte den körande versionen.** Prod fortsatte serva
föregående revision och svara `ok` under hela incidenten. Det är ett stopp, inte
ett avbrott — men main och prod glider isär, och varje efterföljande merge hade
också fallit.

**Kontrollen är densamma som alltid:** `/v1/health`-fältet `revision`. Det är
enda beviset för vad som faktiskt kör, oavsett vilken av de tre varianterna som
slagit till.

### Committa före VARJE negativkontroll — inte bara den första

En negativkontroll innebär att man med flit bryter något och sedan återställer med
`git checkout --`. Det kommandot tar med sig **allt** ocommittat i filen, inte
bara det man nyss bröt. Har man gjort fler ändringar efter förra commiten
försvinner de tyst.

Hände tre gånger på en dag. Commita, bryt, mät, återställ — i den ordningen, varje
gång.

### `${VAR:?}` i varje destruktivt kommando

Skriv `"${SP:?}"`, aldrig `$SP`:

```bash
rm -f "${SP:?}"/*.out        # avbryter om SP är tom eller osatt
rm -f $SP/*.out              # expanderar till /*.out om SP är tom
```

`:?` gör skalet självt till spärren — en osatt variabel ger ett fel i stället för
att radera fel saker. Gäller `rm`, `shred`, `mv` och omdirigering. Citera
dessutom alltid, så ett mellanslag i sökvägen inte splittar argumentet.

Skyddet ligger då i kommandot i stället för i att någon läste det noga, vilket
gör felet omöjligt i stället för osannolikt.

### Ett variabelnamn med å/ä/ö är inte ett variabelnamn

Mekanik, inte stilfråga. Ett skalvariabelnamn får bara innehålla `[A-Za-z_]`
följt av `[A-Za-z0-9_]`. `MÅL=abc` är alltså ingen tilldelning — skalet läser det
som ett KOMMANDO:

```bash
MÅL=4dfefbc
# bash: MÅL=4dfefbc: command not found     ← går till stderr, exitkod 127
```

Det farliga är vad som händer sedan — och det är INTE det man gissar. Jag skrev
först "expanderar till tom sträng" här. Mätningen sa annat:

```bash
MÅL=4dfefbc                      # bash: MÅL=4dfefbc: command not found  (exit 127)
rev=4dfefbc
[ "$rev" = "$MÅL" ] && echo MATCH || echo "jamfor mot: \"$MÅL\""
# → jamfor mot: "ÅL"
```

**Namnet slutar vid första tecknet som inte är `[A-Za-z0-9_]`.** `$MÅL` läses
alltså som `${M}` följt av literalen `ÅL` — `M` är osatt, så kvar blir `ÅL`.
Jämförelsen sker mot en skräpsträng, inte mot ingenting. Utfallet är detsamma
(alltid falskt) men spåret är ett annat, och den som letar efter en tom sträng
letar fel.

Samma sak syns i utskrifter: `printf '%s' "$LÄGE"` skriver `ÄGE` på varje rad,
vilket ser ut som ett trunkeringsfel i formatsträngen och inte som ett
variabelnamn som aldrig fanns.

I aritmetik faller det högt i stället för tyst — men räknaren står ändå stilla:

```bash
RÖDA=$((RÖDA+1))
# bash: RÖDA+1: syntax error: invalid arithmetic operator (error token is "ÖDA+1")
```

Det bet mig **tre gånger på en dag** — i en resultattabell (`LÄGE` blev `ÄGE` i
varje rad), i en räknare (`RÖDA` räknade aldrig), och i en prod-bevakning som
pollade `/v1/health` i tjugo minuter utan att någonsin kunna matcha. Tre gånger
på en dag i en kodbas som skriver allt annat på svenska är inte otur; det är ett
mönster.

**Regeln: ASCII i skalvariabler, svenska i strängarna.** `MAL`, `LAGE`, `RODA` —
utskriften får gärna heta "läge", variabeln får inte.

```bash
# FEL — tyst alltid-falskt
MÅL=$(git rev-parse HEAD); [ "$rev" = "$MÅL" ] && echo klart

# RÄTT
MAL=$(git rev-parse HEAD); [ "$rev" = "$MAL" ] && echo klart
```

Samma familj som `${VAR:?}` ovan: båda handlar om att en variabel som inte kan
sättas expanderar till NÅGOT ANNAT än det du menade i stället för att stoppa
körningen. `:?` gör det till ett fel; här går det rakt in i ett villkor. Och
felmeddelandet finns — det går bara till stderr, i en loop där tjugo andra rader
skrivs, och exitkoden 127 tillhör en tilldelning ingen kontrollerar.

### `&` binder till HELA kedjan — inte till ledet före det

`cd X && kommando &` bakgrundar `cd X && kommando`. Skalet SJÄLVT står kvar i sin
ursprungliga katalog, så allt som kommer EFTER `&` — nästa led i kedjan, en
heredoc, ett `python3 -` — körs där, inte i `X`. Uppmätt:

```bash
cd /workspaces/eken-strom-c && echo "bakgrundsledet: $PWD" &
wait
python3 - <<'PY'
import os; print("heredoc-python:", os.getcwd())
PY
# bakgrundsledet: /workspaces/eken-strom-c
# heredoc-python: /tmp/…/scratchpad/a      ← skalets gamla katalog
```

Redigeringen LYCKAS och skriver "klart" — i fel katalog. Kostnaden i mätningen
raden kommer ur: en ändring rapporterad som "landade aldrig", en andra
omskrivning av samma fil, och en ocommittad fil som låg kvar i den delade
worktreen i sex timmar.

**Gör något av tre — inte "var försiktig":**

```bash
# 1. Låt kommandot självt intyga sin katalog (`pwd` som FÖRSTA led).
pwd -P && sed -i 's/x/y/' fil.ts

# 2. Absolut sökväg — då spelar skalets katalog ingen roll.
sed -i 's/x/y/' /workspaces/eken-strom-c/apps/api/src/fil.ts

# 3. Gruppera, så `&` binder till gruppen i stället för till kedjan.
( cd /workspaces/eken-strom-c && npm run dev ) &
```

Samma familj som `${VAR:?}` och å/ä/ö ovan: ett kommando som gör NÅGOT ANNAT än
du menade i stället för att stanna. Skillnaden är att här finns inget
felmeddelande att missa — utfallet är ett LYCKAT kommando i fel katalog.

### En grön check efter en edit betyder inget om diffen är tom

`cd` som faller i en kommandokedja, en `python3 -c` som körs från fel katalog, en
`sed` vars mönster inte matchar — alla ger tyst ingen ändring. Kör man då
`pnpm typecheck` och får grönt är det inte en bekräftelse: det är en check som
inte kunde falla.

Kontrollera att ändringen **landade** — `git status --short`, en `grep` efter det
nya innehållet — innan du tolkar grönt som bevis.

### `railway variables` skriver ut VÄRDEN — inte bara namn

`railway variables --service <namn>` och `--kv`/`--json` dumpar varje hemlighet i
klartext till terminalen. Det står i CLI:ns egen hjälptext (`-k, --kv … This
prints raw values`), men flaggnamnet antyder det inte, och `| head -40` räddar
ingenting — de första raderna ÄR hemligheterna.

Kostnaden är inte teoretisk: 2026-08-15 hamnade åtta prod-credentials i en
sessionslogg på det viset och fick roteras.

**Prod-hemligheter ska aldrig passera en terminal vars utdata sparas.** Det gäller
den här sessionen, CI-loggar och delade skärmar lika mycket.

Behöver du veta VILKA variabler som finns — nästan alltid det man faktiskt är ute
efter:

```bash
railway variables --service eken --kv | sed 's/=.*//' | sort
```

Behöver du veta OM ett värde är rätt: jämför hash mot hash, aldrig värde mot
värde. Värdet går in i hashningen, aldrig till stdout:

```bash
railway variables --service eken --kv \
  | python3 -c 'import hashlib,sys; [print(k, hashlib.sha256(v.encode()).hexdigest()[:16]) for k,v in (l.rstrip("\n").split("=",1) for l in sys.stdin if "=" in l)]'
```

Behöver du SÄTTA ett värde: `--stdin`, så att det aldrig står på kommandoraden
(som sparas i historik och i sessionsloggen):

```bash
openssl rand -base64 48 | railway variable set JWT_SECRET --service eken --stdin --skip-deploys
```

`--skip-deploys` på alla utom den sista, så tre variabelbyten ger en omstart och
inte tre.

Samma fälla som `gh`: **`railway` kräver den länkade katalogen som cwd.** Körs den
från `/tmp` blir svaret `No linked project found` — och i en `$(...)` blir
resultatet tom sträng i stället för ett synligt fel.

### Återställ ALLTID från repo-roten

`git checkout -- apps/api/src/...` kört **från `apps/api`** misslyckas TYST:
sökvägen är rot-relativ, matchar ingenting, och kommandot returnerar utan att
återställa något.

```bash
cd /workspaces/eken                 # ALLTID roten först
git checkout -- apps/api/src/...    # sökvägen är rot-relativ
git status --short                  # och verifiera att trädet faktiskt är rent
```

Det farliga är var det används: mellan negativkontroller. Misslyckas
återställningen ligger injektionen kvar, nästa injektion läggs ovanpå, och
utfallet blir obegripligt — eller värre, ser rimligt ut.

Samma familj: **branch FÖRST, commit sedan.** Committat PR-arbete direkt på
`main` upptäcktes bara för att `git pull --ff-only` vägrade.

### `git checkout <ref> -- <fil>` är INTE ett sätt att läsa en annan version

Avsnittet ovan handlar om att en återställning ska LYCKAS. Det här handlar om
att den inte ska ske alls.

`git checkout <ref> -- <fil>` **skriver över arbetskopian OCH stagar den**. Det
är inte en biverkning utan hela kommandots uppgift — men det är sällan det man
är ute efter när man skriver det. Det vanliga ärendet är "jag vill se hur den
här filen såg ut i `main`", och då är kommandot fel verktyg med ett namn som
inte antyder det.

Uppmätt:

```bash
git checkout HEAD~1 -- f.txt
git status --short
# M  f.txt        ← M i FÖRSTA kolumnen = INDEX. Ändringen är redan stagad.

git show HEAD~1:f.txt
# skriver innehållet till stdout; arbetskopian orörd, git status 0 rader
```

**Tecknet att titta efter är kolumnen.** ` M` (mellanslag först) är en
arbetskopieändring du gjort. `M ` (M först) betyder att något redan lagt den i
indexet åt dig — och nästa `git commit` tar med den utan att fråga.

Kostnaden är mätt, inte befarad: en läsning av `main`s version av
`check-cron-classification.mjs` för att belägga ett ärende tog samtidigt bort en
nyss committad ändring i samma fil och stagade återställningen. Det fångades
bara av ett `git status` direkt efteråt.

**De två ärendena, och kommandot för vart och ett:**

```bash
git show <ref>:<fil>            # LÄSA en annan version — skriver inget, stagar inget
git show <ref>:<fil> > /tmp/x   # …och spara den vid sidan av, utan att röra trädet
git checkout <ref> -- <fil>     # ÄNDRA arbetskopian till den versionen (stagas)
git restore --source=<ref> -- <fil>          # samma sak, men utan att staga
git restore --staged --worktree --source=HEAD -- <fil>   # ångra det du just gjorde
```

Behöver du köra en gammal version av ett skript — inte bara läsa den — skriv ut
den till scratchpad-katalogen och kör den därifrån. Trädet ska aldrig behöva
byta version för att du ska kunna jämföra två.

### Worktrees delar `.git` — `reset --soft origin/main` drar in den andra strömmens arbete som BORTTAGNINGAR

Två worktrees är två arbetskataloger på **ett** `.git`. Refs och objekt är
gemensamma, alltså är `origin/main` gemensam. Mergar den andra strömmen sin PR
och någon fetchar, **flyttar sig `origin/main` under dig** — mitt i din session,
utan att något i din katalog ändras.

Det gör `git reset --soft origin/main` farligt. Kommandot flyttar HEAD men
lämnar index och arbetsträd orörda, alltså vid DITT träd:

```
HEAD  → nya origin/main   (innehåller ström A:s filer)
index → ditt träd          (innehåller dem INTE — du grenade före A:s merge)
```

`git diff --cached` blir då skillnaden från A:s arbete till ditt träd — och A:s
filer står som **raderade**. Committar du det ser commiten ut som ditt arbete
plus en tyst revert av någon annans.

Uppmätt: det fångades bara för att någon körde `git diff --name-only` före push
och såg filer hen aldrig rört.

**Reglerna:**

```bash
# FEL när basen kan ha flyttat sig
git reset --soft origin/main

# RÄTT — grenpunkten är stabil även när origin/main flyttar sig
git reset --soft "$(git merge-base HEAD origin/main)"

# Och ALLTID före push, oavsett metod: står det filer du inte äger — stanna
git diff --name-only "$(git merge-base HEAD origin/main)"..HEAD
```

`merge-base` är rätt referens därför att den inte påverkas av att den andra
strömmen mergar: A:s merge-commit är ingen förfader till din gren, så
grenpunkten ligger kvar där den låg.

Vill du ta in A:s arbete är verktyget `git merge origin/main` eller en rebase —
aldrig ett `reset` mot en referens som rört sig.

### "Tom diff mot main" håller bara för den gren som mergades SIST

Samma orsak, annan konsekvens. Kriteriet före en grenradering brukar vara att
`git diff main..min-gren` är tom: är trädena identiska ligger allt inne.

Det mäter **trädlikhet**, inte att ditt arbete är inne. Med parallella strömmar
är svaret förorenat av den andra strömmens commits: mergar A efter dig blir
diffen icke-tom trots att varenda rad du skrev ligger i `main` — skillnaden är
A:s filer, som ur din grens perspektiv ser ut att saknas. Kriteriet håller alltså
bara i det enda fall där ingen annan hunnit merga efter dig.

Läser man den icke-tomma diffen som "mitt arbete kom aldrig in" och pushar om
grenen, är utfallet exakt defekten i avsnittet ovan.

**Rätt fråga är inte "skiljer sig grenarna" utan "finns någon skillnad som är
MIN?"** — alltså: avgränsa till de sökvägar du äger.

```bash
# FEL med parallella strömmar — svaret bär den ANDRA strömmens arbete
git diff main..min-gren

# RÄTT — bara MINA FILER; tom ⇒ mitt arbete är inne ⇒ grenen kan raderas
git diff main..min-gren -- $(git diff --name-only main...min-gren | tr '\n' ' ')
```

**Och avgränsa till FILERNA, inte till katalogen du tror är din.** Den regeln
skrevs först med katalognamn (`-- apps/api/scripts CLAUDE.md`) och fallerade
samma dag: den andra strömmen lade en ny vakt i `apps/api/scripts`, och ur min
grens perspektiv såg den ut som en borttagning.

```
git diff main..min-gren -- apps/api/scripts                  → 403 rader  (allt den ANDRAS)
git diff main..min-gren -- apps/api/scripts/check-cron-…mjs  →   0 rader  (svaret)
```

Ägarskapsgränser flyttar sig under arbetet; filerna din gren faktiskt rörde gör
det inte. Härled listan ur grenen (`git diff --name-only main...min-gren`) i
stället för att skriva den.

Sökvägsavgränsningen är också det enda kriteriet som överlever en
**squash-merge**: efter en squash är din grens commits inte förfäder till
`main`, så `git log main..min-gren` och `git diff main...min-gren` (tre punkter,
mot grenpunkten) visar ditt arbete som omergat trots att innehållet ligger inne.
Innehållsjämförelsen på dina egna sökvägar gör det inte.

### En negativkontrolls sond ska ha ett namn som bevisligen inte finns

Injicerar du en påhittad kolumn, fil eller flagga för att se att vakten fäller
den: **sök på namnet först**. En sond som råkar heta samma sak som något
befintligt gör din egen verifiering tvetydig — du kan inte skilja din injektion
från det som redan fanns.

Hände med `totpSecret`, som redan låg på `PlatformUser`. Kontrollen av att
schemat var återställt gav då en träff som inte var min.

### CI-skyddet slutar vid merge-punkten — inte vid deploy

`main` skyddas av rulesetet **`main`** (active, tom bypass-lista) med **`CI passed`**
som required check — och bara den; klassisk branch protection är av. **Varje**
jobb i `ci-passed`:s `needs` måste ge `success` innan en PR kan mergas; GitHub
blockerar merge-knappen annars (`mergeStateStatus: BLOCKED`). Uppmätt i #405.
Antalet står med flit inte här — `ci-passed` härleder det ur `toJSON(needs)`, och
ett tal i prosan hade blivit fel första gången någon lade till ett jobb (senast
`schema-drift-guard`, #512).

`E2E` är ett av dem. Det infördes 2026-08-14 som icke-blockerande med ett
utgångsdatum och **befordrades 2026-08-18** på 52/52 gröna mainline-körningar,
noll flakes och en körtid på 2,4 min i median. Beslutsprotokollet står i `ci.yml`.
Jobbet kör hela `apps/web/e2e/` utom det som `testIgnore` i
`apps/web/playwright.config.ts` lyfter ut (50x-bevisriggarna, och
ai-attachment-composer tills #477 gett CI R2-nycklar). En kanariefågel kräver att
Playwright hittar exakt `E2E_EXPECTED_TESTS` tester — ändrar du uteslutningarna
ska talet ändras i samma PR.

**Men skyddet gäller bara fram till merge.** `deploy.yml` bygger de tre SPA:erna och
har `needs: ci` — **API:t deployas av Railways egen git-integration**, som lyssnar
direkt på `main` och inte känner till GitHubs checkar. Hamnar något på `main` ändå,
går det ut.

Praktiskt betyder det två saker:

1. **En required check är en spärr mot att fel kod _mergas_, inte mot att den
   _deployas_.** För frontend är kedjan mekanisk; för API:t bryts den efter merge.
2. **`/v1/health`-fältet `revision` är enda sättet att se vad som faktiskt kör.**
   Det är därför fältet finns. Efter varje merge:

   ```bash
   curl -fsS https://eken-production.up.railway.app/v1/health \
     | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["revision"])'
   ```

   Matchar det inte squash-commiten är antingen deployen inte klar, eller så kör prod
   något annat än du tror.

### Docker Compose (lokal fullstack)

```bash
docker-compose up           # Startar postgres, redis, api, web
docker-compose up postgres redis  # Bara databaser
```
