# Eveno — Arkitektur

> Senast uppdaterad: 2026-05-29
> Källa: kodbas + CLAUDE.md + git history

Eveno är ett **enterprise-grade fastighetssystem** för svenska hyresvärdar och fastighetsbolag. Positionering: "Fortnox för fastigheter". Bygger en komplett vertikal SaaS som ersätter ad-hoc Excel + Fortnox + e-postlådor med ett integrerat system för uthyrning, redovisning, fakturering, avstämning och kundkommunikation.

## Topologi

```
eken/                              # pnpm + Turborepo monorepo
├── apps/
│   ├── api/                       # NestJS 10 + Fastify  (port 3000)
│   ├── web/                       # React 18 + Vite + TanStack Router (port 5173)
│   ├── portal/                    # Hyresgästportal — separat app, Eveno-designsystem
│   ├── landing/                   # Marknadsföringssida (statisk)
│   └── admin/                     # Intern admin (Eveno-teamet, ej kunder)
├── packages/
│   └── shared/                    # @eken/shared — typer, Zod-scheman, formatters, konstanter
├── docker-compose.yml             # postgres + redis + api + web för lokal stack
├── turbo.json                     # Turborepo task graph
├── railway.toml                   # Railway production config (API + DB)
└── CLAUDE.md                      # Projektkonventioner (källkodsnära)
```

### Workspace-alias

| Path              | Alias           | Roll                                 |
| ----------------- | --------------- | ------------------------------------ |
| `apps/api`        | `@eken/api`     | Backend                              |
| `apps/web`        | `@eken/web`     | Hyresvärds-app (privata bolag)       |
| `apps/portal`     | `@eken/portal`  | Hyresgästportal (slutkunders kunder) |
| `apps/landing`    | `@eken/landing` | Marknadssida (eveno.se)              |
| `apps/admin`      | `@eken/admin`   | Intern admin (Eveno-personal)        |
| `packages/shared` | `@eken/shared`  | Domäntyper, Zod, utils, konstanter   |

### Deployment

- **API + Postgres + Redis:** Railway (Dockerfile i `apps/api/Dockerfile`, `scripts/migrate-and-start.sh` kör `prisma migrate deploy` + `node dist/main.js`).
- **Web/Portal/Landing:** Vercel (Vite-build → SPA, nginx-proxy i Dockerfile för Railway-fallback).
- **Migreringar:** automatiska via `migrate-and-start.sh` vid container-start.

## Backend — `apps/api`

### Stack

- **NestJS 10** med **Fastify**-adapter (inte Express — viktigt: request lifecycle, raw-body-hantering, streaming skiljer sig)
- **Prisma 5** → PostgreSQL 16
- **Bull + Redis** för jobbköer (PDF-generering, e-postutskick, batch-import)
- **Nodemailer** för transaktionell e-post
- **Puppeteer** för PDF-rendering (Chromium i Docker-image)
- **Swagger** på `http://localhost:3000/api/docs` i dev

### Moduler (faktiska, ej från CLAUDE.md som är out-of-date)

```
apps/api/src/
├── accounting/          # BAS-kontoplan, journalposter, rapporter
├── ai/                  # AI-tjänster (PDF-parsing av bankutdrag — se FIX 7)
├── ai-usage/            # Spårning av AI-användning för fakturering
├── auth/                # Register, login, refresh, logout
├── avisering/           # Påminnelser, krav, dröjsmål
├── collections/         # Inkasso, anmälan till socialnämnd
├── common/              # Guards, dekoratorer, interceptors, filter
├── contracts/           # Avtalsmallar, generering, signering
├── customers/           # CRM-laget för leadhantering (B2B)
├── dashboard/           # Aggregerad statistik
├── deposits/            # Depositionshantering
├── documents/           # Filuppladdning, S3/Vercel Blob
├── import/              # CSV/SIE-import från äldre system
├── inspections/         # Lägenhetsinspektioner
├── invoices/            # Fakturor + InvoiceEvent (append-only)
├── leases/              # Hyresavtal + statusmaskin
├── mail/                # E-postutskick (Nodemailer)
├── maintenance/         # Felanmälan
├── maintenance-plan/    # Underhållsplaner
├── messages/            # Intern meddelandetjänst
├── news/                # Nyhetsbrev till hyresgäster
├── notifications/       # Schemalagda notifikationer
├── organizations/       # Tenant-organisation, inställningar
├── pdf-jobs/            # Bull queue för PDF-generering (FIX 4)
├── platform/            # Eveno-intern plattformsadmin
├── properties/          # Fastigheter
├── public/              # Publikt exponerade endpoints (signed URLs etc.)
└── ...
```

### API-mönster

**Svarsformat (TransformInterceptor + HttpExceptionFilter):**

```typescript
// Lyckat
{ success: true, data: T }

// Fel
{ success: false, error: { code, message, details?, path, timestamp } }
```

**Versioning:** alla endpoints prefixas `/v1/` (`defaultVersion: '1'`, URI-versioning).

**Auth-stack (i ordning på request lifecycle):**

1. `JwtAuthGuard` (global) — validerar Bearer-token, populerar `req.user`
2. `@Public()` — skipper guard
3. `RolesGuard` — kontrollerar `@Roles(...)`-deklarationer
4. `@CurrentUser()`, `@OrgId()` — extraherar från `req.user` (JwtPayload)

**Rollhierarki:** OWNER > ADMIN > MANAGER > ACCOUNTANT > VIEWER

**Multi-tenant-mönster (KRITISKT):**

Varje domänentitet har `organizationId`. Varje Prisma-query MÅSTE inkludera `organizationId` i `where`. Hämta från `@OrgId()` i controller, propagera till service.

```typescript
// Controller
@Get(':id')
async findOne(@Param('id') id: string, @OrgId() orgId: string) {
  return this.service.findOne(id, orgId)
}

// Service
async findOne(id: string, orgId: string) {
  const property = await this.prisma.property.findFirst({
    where: { id, organizationId: orgId },
  })
  if (!property) throw new NotFoundException()
  return property
}
```

**DTO-regel (kritisk):** importera DTOs som **värden**, inte typer.

```typescript
import { RegisterDto } from './dto/register.dto' // ✅
import type { RegisterDto } from './dto/register.dto' // ❌ — class-validator tappar metadata
```

## Frontend — `apps/web`

### Stack

- **React 18** + **Vite 5** (SWC, inte Babel)
- **TanStack Router** (URL-baserad — se FIX 5 där vi migrerade från `useState<Route>`)
- **TanStack Query** (React Query) — `staleTime: 60s`
- **Zustand** för auth-state (persisteras till localStorage som `eken-auth`)
- **React Hook Form** + `@hookform/resolvers/zod`
- **Framer Motion 12** för animationer
- **Tailwind CSS 3** med custom palette från CLAUDE.md

### Katalogstruktur

```
src/
├── app/                          # Route-tree (TanStack Router)
├── components/
│   ├── layout/                   # AppLayout, AuthLayout
│   └── ui/                       # Button, Input, Modal, DataTable, etc.
├── features/
│   └── {feature}/
│       ├── {Feature}Page.tsx
│       ├── api/                  # axios-anrop
│       ├── hooks/                # React Query-wrappers
│       └── components/
├── hooks/                        # Globala hooks
├── lib/
│   ├── api.ts                    # axios-instans + interceptors
│   └── cn.ts                     # clsx + tailwind-merge
├── stores/
│   └── auth.store.ts             # Zustand
└── types/
```

### API-lager — `lib/api.ts`

Axios-instans med:

- `baseURL: '/api/v1'` (Vite-proxy rewrite till `:3000/v1`)
- Request-interceptor: bifogar `Authorization: Bearer <token>` från Zustand
- Response-interceptor: packar upp `{ success, data }` → returnerar `data`
- 401-hantering: triggar refresh-flöde, retry, eller logout

Helpers: `get<T>`, `post<T>`, `patch<T>`, `del`.

### React Query — nyckelkonvention

Memory `feedback_query_keys`: list- och detalj-nycklar **måste vara disjunkta**.

```typescript
// ✅ Korrekt
useQuery({ queryKey: ['tenants', 'list'], queryFn: () => get('/tenants') })
useQuery({ queryKey: ['tenant', 'detail', id], queryFn: () => get(`/tenants/${id}`) })

// ❌ Fel — list cache invalideras när detail-mutation körs
useQuery({ queryKey: ['tenants'], queryFn: () => get('/tenants') })
useQuery({ queryKey: ['tenants', id], queryFn: () => get(`/tenants/${id}`) })
```

## Shared — `packages/shared`

Importeras som `@eken/shared`. **Enda källan till sanning** för domäntyper, scheman, formatters, konstanter.

```typescript
// Typer
import type { Property, Invoice, UserRole, JwtPayload, ApiResponse } from '@eken/shared'

// Zod-scheman + infererade typer
import { RegisterSchema, CreatePropertySchema } from '@eken/shared'
type RegisterInput = z.infer<typeof RegisterSchema>

// Utils
import {
  formatCurrency,
  formatDate,
  formatOrgNumber,
  calculateVat,
  generateOcrNumber,
} from '@eken/shared'

// Konstanter
import { VAT_RATES, LOCALE, CURRENCY, INVOICE_TRANSITIONS } from '@eken/shared'
```

**Regel:** aldrig duplicera typer eller formatfunktioner i `api/` eller `web/`. Bryr du dig om SEK-format, hämta från `@eken/shared`.

## Databas — Prisma + PostgreSQL

### Centrala entiteter

```
Organization
  └─ User (rolle: OWNER, ADMIN, MANAGER, ACCOUNTANT, VIEWER)
  └─ Property
       └─ Unit
            └─ Lease (status: DRAFT → ACTIVE → ENDED)
                 └─ Invoice (DRAFT → SENT → PARTIALLY_PAID → PAID / OVERDUE / CANCELLED)
                      └─ InvoiceLine
                      └─ InvoiceEvent  [append-only audit log]
  └─ Tenant (privat/företag)  *──*  Lease
  └─ Account (BAS-konto)
  └─ JournalEntry
       └─ JournalEntryLine
  └─ Document (PDF, kontrakt, ID)
  └─ Deposit
```

### Multi-tenant-invariant

Varje icke-User-entitet har `organizationId`. Cascade-delete vid Organization-borttagning **utom** på audit-modeller (InvoiceEvent, JournalEntry) som har `onDelete: Restrict` enligt FIX 3 (förhindrar förlust av bokföringskedjan vilket bryter mot BFL 7 kap).

### Append-only-invariant

`InvoiceEvent`, `JournalEntry`, `JournalEntryLine` — aldrig UPDATE eller DELETE. Felbokningar rättas med reverseringsentry.

### Migration-workflow

```bash
pnpm db:migrate          # prisma migrate dev (skapar SQL-fil + uppdaterar DB)
pnpm db:migrate:deploy   # prisma migrate deploy (i CI/prod)
pnpm db:generate         # uppdaterar Prisma-klient
pnpm db:seed             # seed-script
pnpm db:studio           # Prisma Studio GUI
```

Lokal dev har vissa indexdrifters mot prod — se `dev_db_index_drift` memory.

## Background jobs — Bull + Redis

| Queue            | Användning                                        | Concurrency | Retries |
| ---------------- | ------------------------------------------------- | ----------- | ------- |
| `pdf-generation` | Renderar fakturor, kontrakt, påminnelser till PDF | 4           | 3       |
| `email-send`     | Transaktionell e-post via Nodemailer              | 8           | 5       |
| `bulk-invoice`   | Bulk-faktureringsjobb (FIX 4)                     | 2           | 3       |
| `bulk-pdf-send`  | Massutskick av PDF-bilagor                        | 2           | 3       |
| `bank-import`    | AI-parsing av bankutdrag (FIX 7)                  | 1           | 2       |
| `notifications`  | Schemalagda påminnelser, dröjsmålspåminnelser     | 4           | 3       |

Synkrona endpoints (t.ex. enskild PDF-nedladdning) kör Puppeteer direkt. Asynkrona (massutskick) går via queue. Beslut motiverat i `design-decisions.md`.

## Testning

- **Unit:** Jest, för pure logic (formatters, beräkningar, statusövergångar)
- **Integration:** Jest + supertest mot in-memory NestJS-instans, riktig Postgres via testcontainer
- **E2E:** Playwright, för kritiska användarflöden (registrering, fakturering, betalningsmatchning)

Kör: `pnpm test`, `pnpm test:integration`, `pnpm test:e2e`.

## CI/CD

- **GitHub Actions:** lint, typecheck, test, build på varje PR
- **Railway:** auto-deploy från `main`-branch
- **Vercel:** preview-deployments per PR för `apps/web` och `apps/portal`

## Observability

- **Sentry** för error tracking (`instrument.ts` i både api och web)
- **Strukturerad logging:** Pino i NestJS (JSON-format för prod, pretty i dev)
- **Audit-log:** alla mutationer på Invoice, Lease, Tenant skriver till `InvoiceEvent` eller motsvarande audit-tabell

## Säkerhet (sammanfattning)

- JWT 15 min + refresh 30 dagar (UUID, roteras)
- bcryptjs 12 rounds
- Alla routes default-protected (`JwtAuthGuard` global)
- `@Roles(...)` för RBAC
- Multi-tenant-scope obligatoriskt (`organizationId` i varje query)
- `class-validator` på alla DTOs (kräver `import { Dto }` — inte `type`)
- Prisma-parametrisering (ingen `$queryRawUnsafe`)
- HTTPS-only i prod (Railway terminerar TLS)
- Sentry scrubbing av PII konfigurerad

För säkerhetsgranskning, se `security-auditor`-agenten och `standarder/owasp-top10.md`.
