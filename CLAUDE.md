# Eken – CLAUDE.md

## Vision & mål

_Eveno_ — fastighetsförvaltnings-SaaS för svenska privata hyresvärdar och mindre bolag (1–50 enheter).

**Kärnvision:** maximal automatisering. En hyresvärd ska kunna luta sig tillbaka medan systemet sköter det löpande — avisering, påminnelser, bankavstämning, bokföring, kravhantering — automatiskt. AI är hyresvärdens assistent: den gör det repetitiva och föreslår det svåra, så att människan bara behöver fatta de verkligt bindande besluten. Ersätter tunga system (Vitec, Momentum) med något enklare, smartare och mer självgående.

**Byggt och i main:** förvaltning (fastigheter/lägenheter/hyresgäster/avtal), automatisk hyresavisering (cron), IMD/förbruknings-debitering, AI-driven kontrakts-onboarding, dubbel bokföring, komplett inkasso-trappa (avi→påminnelse→ränta→inkasso-ready→export→kundförlust, automatisk), och härdad bankavstämning (skuld som beräknat tillstånd: INV-S→D→A→B).

**Återstår före lansering (gatas av bolagsregistrering):** DB-backup, BankID-inloggning, automatisk bankkoppling (PSD2 — ersätter manuell filuppladdning, en nyckel för att avstämningen ska vara självgående), juridisk slutgenomgång.

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
curl -s http://localhost:3000/v1/health   # Förväntat: { success: true, data: { status: "ok" } }
curl -s http://localhost:5173 | head -c 50 # Förväntat: <!doctype html>
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

### Övriga kommandon

```bash
pnpm typecheck   # TypeScript – kör alltid innan du anser en uppgift klar
pnpm lint        # ESLint
pnpm build       # Full production build
pnpm format      # Prettier
```

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

~40 moduler i `apps/api/src/`. Kärndomänerna (en rad var):

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
# Hälsokontroll
curl -s http://localhost:3000/v1/health | jq .

# Registrera konto
curl -s -X POST http://localhost:3000/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.se","password":"Test123!","firstName":"Test","lastName":"User","organizationName":"Test AB","orgNumber":"556000-0001"}' | jq .

# Logga in och hämta token
TOKEN=$(curl -s -X POST http://localhost:3000/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.se","password":"Test123!"}' | jq -r '.data.accessToken')

# Autentiserad request
curl -s http://localhost:3000/v1/properties \
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

Schemat har ~70 modeller. Kärnan (alla scopade på `organizationId`):

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

### Färgpalett

```
Bakgrund (app):    #F7F8FA
Yta (kort/panel):  #FFFFFF
Border:            #EAEDF0
Border (input):    #DDDFE4

Text primär:       #111827
Text sekundär:     #6B7280
Text tertiär:      #9CA3AF

Primary:           #2563EB  (blue-600)
Primary hover:     #1D4ED8  (blue-700)

Success:  emerald-600 / bg emerald-50
Warning:  amber-600   / bg amber-50
Danger:   red-600     / bg red-50
Info:     blue-600    / bg blue-50
```

### Typografi (Inter var)

```
Sidtitel (PageHeader):   text-[22px] font-semibold tracking-tight
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
bg-white rounded-2xl border border-[#EAEDF0]
hover: shadow-sm transition-shadow
whileHover={{ y: -2, boxShadow: '0 8px 24px rgba(0,0,0,0.08)' }}
padding: p-4 (kompakt) | p-5 (standard)
```

**Tabeller**

```
Wrapper:       overflow-hidden rounded-2xl border border-[#EAEDF0] bg-white
Kolumnrubrik:  text-[12px] font-semibold text-gray-400 uppercase tracking-wide
Rad-hover:     hover:bg-gray-50/80
Radborder:     border-b border-[#EAEDF0] last:border-0
```

**Knappar**

```
Primary:   bg-blue-600 text-white rounded-lg h-9 px-4 text-[13.5px] shadow-sm hover:bg-blue-700
Secondary: bg-white border border-[#DDDFE4] text-gray-700 rounded-lg h-9 px-4 hover:bg-gray-50
Small:     h-8 px-3 text-[13px]
Active:    active:scale-[0.97]  ← CSS transform, INTE Framer Motion på knappar
```

**Input / Select**

```
h-9 rounded-lg border border-[#DDDFE4] text-[13.5px]
focus: ring-2 ring-blue-500 border-blue-500
Label: text-[13px] font-medium text-gray-700
```

**Modals**

```
Backdrop:   bg-black/25 backdrop-blur-[2px]
Panel:      bg-white rounded-2xl shadow-xl border border-[#EAEDF0]
Animation:  scale 0.96→1 + y 8→0, spring { stiffness: 400, damping: 30 }
Rubrik:     text-[17px] font-semibold
Stängknapp: h-7 w-7 rounded-lg, top-right
Footer:     border-t border-[#EAEDF0] pt-5 mt-5 flex justify-end gap-2
```

**Badges**

```
Base:     rounded-full px-2.5 py-0.5 text-[12px] font-medium
Dot:      h-1.5 w-1.5 rounded-full inline-block mr-1.5

Success:  bg-emerald-50 text-emerald-700
Warning:  bg-amber-50   text-amber-700
Danger:   bg-red-50     text-red-600
Info:     bg-blue-50    text-blue-700
Default:  bg-gray-100   text-gray-700
Ghost:    border border-gray-200 text-gray-500
```

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

### Docker Compose (lokal fullstack)

```bash
docker-compose up           # Startar postgres, redis, api, web
docker-compose up postgres redis  # Bara databaser
```
