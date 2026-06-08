# Driftsättning

Eveno deployas på **två plattformar**:

| Del                        | Plattform | Hur                                             |
| -------------------------- | --------- | ----------------------------------------------- |
| **API** (`apps/api`)       | Railway   | Docker (`apps/api/Dockerfile`) – NestJS/Fastify |
| **PostgreSQL + Redis**     | Railway   | Railway-plugins                                 |
| **web** (`apps/web`)       | Vercel    | Vite-SPA (huvudapp)                             |
| **admin** (`apps/admin`)   | Vercel    | Vite-SPA (plattforms-/superadmin)               |
| **portal** (`apps/portal`) | Vercel    | Vite-SPA (hyresgästportal)                      |

> `apps/landing` är övergiven och deployas inte. Det finns en gammal `apps/web/Dockerfile`
> (Railway/nginx) men web körs numera på Vercel — Dockerfilen är legacy.

CI/CD: `.github/workflows/ci.yml` kör typecheck + lint på alla PR. `.github/workflows/deploy.yml`
deployar web/admin/portal till Vercel vid push till `main` (med `turbo-ignore` för att hoppa
oförändrade appar). API:et deployas av Railway direkt från GitHub.

---

## 1. Railway — API + databaser

### PostgreSQL & Redis

- **New → Database → PostgreSQL** respektive **Redis** i Railway-dashboarden.
- Kopiera `DATABASE_URL` och `REDIS_URL` från **Variables** till API-tjänsten.

### API-tjänst (`apps/api`)

- **New → GitHub Repo** → välj detta repo.
- **Root Directory** `.` (monorepo-root), **Dockerfile Path** `apps/api/Dockerfile`.
- Containern exponerar **port 8080** (`EXPOSE 8080`). Sätt `PORT=8080` (appen läser `PORT`,
  default 3000 lokalt) så Railways router och containern matchar.
- Startkommandot är `apps/api/scripts/migrate-and-start.sh`, som kör
  `prisma migrate deploy` (applicerar pending migrationer) och sedan `node dist/main.js`.

> **Obs:** databasmigreringar körs automatiskt vid varje deploy via startskriptet.

#### Miljövariabler (API)

`apps/api/.env.example` är den **auktoritativa listan**. Grupperat:

| Grupp             | Variabler                                                                                                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kärna             | `NODE_ENV`, `PORT` (8080), `DATABASE_URL`, `REDIS_URL`                                                                                                                                                |
| JWT (operatör)    | `JWT_SECRET`, `JWT_ACCESS_EXPIRES_IN` (15m), `JWT_REFRESH_EXPIRES_IN` (30d)                                                                                                                           |
| JWT (plattform)   | `PLATFORM_JWT_SECRET`, `PLATFORM_JWT_REFRESH_SECRET`, `PLATFORM_JWT_ACCESS_EXPIRES_IN`, `PLATFORM_JWT_REFRESH_EXPIRES_IN`, `PLATFORM_SEED_EMAIL`/`PLATFORM_SEED_FIRST_NAME`/`PLATFORM_SEED_LAST_NAME` |
| URL:er & CORS     | `APP_URL`, `API_URL`, `ADMIN_URL`, `PORTAL_URL`, `WEB_URL`, `ALLOWED_ORIGINS`                                                                                                                         |
| E-post (Resend)   | `RESEND_API_KEY`, `MAIL_FROM`, `RESEND_WEBHOOK_SECRET` (Svix-signering av leveransstatus-webhook)                                                                                                     |
| AI                | `ANTHROPIC_API_KEY`                                                                                                                                                                                   |
| Fillagring (R2)   | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` (Cloudflare R2)                                                                                                         |
| Felspårning       | `SENTRY_DSN`, `SENTRY_RELEASE`                                                                                                                                                                        |
| Plattform/billing | `AUTO_SEND_PLATFORM_INVOICES`, `TRIAL_GRACE_PERIOD_DAYS`                                                                                                                                              |
| Rate limiting     | `THROTTLE_TTL` (ms), `THROTTLE_LIMIT`                                                                                                                                                                 |

> **E-post sker via Resend, inte SMTP.** Det finns inga `SMTP_*`-variabler.

---

## 2. Vercel — web / admin / portal

Tre separata Vercel-projekt, ett per SPA. Varje app har en `vercel.json` som proxar
`/api/*` till API:ets publika Railway-URL (rewrite) och faller tillbaka på `index.html` (SPA):

```jsonc
// apps/web/vercel.json (admin/portal identiska, egen API-URL)
{
  "rewrites": [
    { "source": "/api/:path*", "destination": "https://<api>.up.railway.app/:path*" },
    { "source": "/(.*)", "destination": "/index.html" },
  ],
}
```

- SPA:erna anropar `/api/v1/...` (axios `baseURL = '/api/v1'`); rewriten strippar `/api` →
  `https://<api>/v1/...`. `portal` kan alternativt sätta `VITE_API_URL` (byggtids-arg) i stället
  för rewriten.
- Vercel-projekten kopplas via secrets i `deploy.yml`: `VERCEL_TOKEN`, `VERCEL_ORG_ID` och
  `VERCEL_PROJECT_ID_WEB` / `VERCEL_PROJECT_ID_ADMIN` / `VERCEL_PROJECT_ID_PORTAL`.

---

## 3. CI/CD (`.github/workflows`)

- **`ci.yml`** — på PR och push till `main`: `pnpm typecheck` + `pnpm lint`.
- **`deploy.yml`** — på push till `main`: kör CI och deployar sedan web/admin/portal var för sig
  med `vercel pull/build/deploy --prebuilt --prod`. `npx turbo-ignore @eken/<app>` hoppar appar
  vars kod inte ändrats. API:et deployas separat av Railways GitHub-integration.

---

## Driftsättningschecklista

- [ ] Railway: PostgreSQL- och Redis-plugin tillagda, `DATABASE_URL`/`REDIS_URL` på API-tjänsten
- [ ] Railway: API-tjänst med Dockerfile `apps/api/Dockerfile`, `PORT=8080`
- [ ] Alla API-env-vars satta enligt `apps/api/.env.example` (särskilt `JWT_SECRET`, `RESEND_API_KEY`, `R2_*`, `ALLOWED_ORIGINS`)
- [ ] `ALLOWED_ORIGINS` / `APP_URL` / `ADMIN_URL` / `PORTAL_URL` pekar på Vercel-domänerna
- [ ] Vercel: tre projekt (web/admin/portal), `vercel.json`-rewrite pekar på API:ets Railway-URL
- [ ] GitHub-secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID_{WEB,ADMIN,PORTAL}`
- [ ] Första API-deploy körd — kontrollera att migreringar körde i Railway-loggen
- [ ] `GET /v1/health` svarar `{ success: true, data: { status: "ok" } }`

---

## Felsökning

**API startar inte:** Kontrollera `DATABASE_URL` och att PostgreSQL-plugin ligger i samma
Railway-projekt. Verifiera att `PORT=8080` matchar `EXPOSE 8080`.

**SPA når inte API (CORS/404):** Kontrollera att `vercel.json`-rewriten pekar på rätt Railway-URL
och att API:ets `ALLOWED_ORIGINS` innehåller Vercel-domänen.

**E-post skickas inte:** Kontrollera `RESEND_API_KEY` och `MAIL_FROM`. Leveransstatus kommer via
Resend-webhooken (`webhooks`-modulen) som verifieras med `RESEND_WEBHOOK_SECRET`.

**Migreringar misslyckas:** Se API-tjänstens Railway-logg (`migrate-and-start.sh` kör
`prisma migrate deploy` före start).
