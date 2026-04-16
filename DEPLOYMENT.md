# Driftsättning — Railway

## Tjänster att skapa i Railway

### 1. PostgreSQL

- Klicka **New** → **Database** → **PostgreSQL** i Railway-dashboarden
- Kopiera `DATABASE_URL` från fliken **Variables** på PostgreSQL-tjänsten

### 2. Redis

- Klicka **New** → **Database** → **Redis** i Railway-dashboarden
- Kopiera `REDIS_URL` från fliken **Variables** på Redis-tjänsten

### 3. API (`apps/api`)

- Klicka **New** → **GitHub Repo** → välj detta repo
- Sätt **Root Directory** till `.` (monorepo-root) och **Dockerfile Path** till `apps/api/Dockerfile`
- Lägg till följande miljövariabler:

| Variabel                 | Exempel / Standardvärde                 | Beskrivning                        |
| ------------------------ | --------------------------------------- | ---------------------------------- |
| `NODE_ENV`               | `production`                            | Körmiljö                           |
| `PORT`                   | `3000`                                  | Port som API lyssnar på            |
| `DATABASE_URL`           | _(kopiera från PostgreSQL-plugin)_      | PostgreSQL-anslutningssträng       |
| `REDIS_URL`              | _(kopiera från Redis-plugin)_           | Redis-anslutningssträng            |
| `JWT_SECRET`             | _(generera lång slumpmässig sträng)_    | Hemlig nyckel för JWT-signering    |
| `JWT_ACCESS_EXPIRES_IN`  | `15m`                                   | Livslängd för access token         |
| `JWT_REFRESH_EXPIRES_IN` | `30d`                                   | Livslängd för refresh token        |
| `APP_URL`                | `https://din-web.up.railway.app`        | Publik URL till webbappen          |
| `API_URL`                | `https://din-api.up.railway.app`        | Publik URL till API:et             |
| `SMTP_HOST`              | `smtp.gmail.com`                        | SMTP-server för e-post             |
| `SMTP_PORT`              | `587`                                   | SMTP-port                          |
| `SMTP_USER`              | `din@email.com`                         | SMTP-användare                     |
| `SMTP_PASS`              | _(app-lösenord)_                        | SMTP-lösenord                      |
| `SMTP_FROM`              | `"Eken Fastigheter <no-reply@eken.se>"` | Avsändaradress                     |
| `THROTTLE_TTL`           | `60000`                                 | Rate limit-fönster i millisekunder |
| `THROTTLE_LIMIT`         | `100`                                   | Max antal requests per fönster     |

> **Obs:** Databasmigreringar körs automatiskt vid varje deploy via `prisma migrate deploy` i startskriptet.

### 4. Webb (`apps/web`)

- Klicka **New** → **GitHub Repo** → välj detta repo (samma repo, annan tjänst)
- Sätt **Root Directory** till `.` och **Dockerfile Path** till `apps/web/Dockerfile`
- Lägg till följande miljövariabler:

| Variabel       | Exempel                          | Beskrivning                                  |
| -------------- | -------------------------------- | -------------------------------------------- |
| `VITE_API_URL` | `https://din-api.up.railway.app` | API-URL inbakad vid byggtid (Vite build arg) |
| `API_URL`      | `https://din-api.up.railway.app` | API-URL för nginx reverse proxy vid körtid   |

> **Obs:** `VITE_API_URL` används under Docker-bygget (`ARG`). `API_URL` används av nginx via `envsubst` när containern startar. Båda ska peka på API-tjänstens publika Railway-URL.

---

## Driftsättningschecklista

- [ ] PostgreSQL-plugin tillagt och `DATABASE_URL` kopierad till API-tjänsten
- [ ] Redis-plugin tillagt och `REDIS_URL` kopierad till API-tjänsten
- [ ] `JWT_SECRET` satt till ett starkt, unikt värde (minst 32 tecken)
- [ ] `APP_URL` och `API_URL` satta till korrekta Railway-URLer
- [ ] SMTP-variabler konfigurerade (eller inaktiverade om e-post inte används)
- [ ] `VITE_API_URL` och `API_URL` satta på webb-tjänsten
- [ ] Första deploy av API körd — kontrollera att migreringar körde i loggen
- [ ] Första deploy av webb körd — verifiera att `/api/health` svarar via webb-proxyn

---

## Felsökning

**API startar inte:** Kontrollera att `DATABASE_URL` är korrekt och att PostgreSQL-plugin är i samma Railway-projekt.

**Webb kan inte nå API:** Kontrollera att `API_URL` i webb-tjänstens variabler pekar på API:ets publika URL (inte intern Railway-URL).

**Migreringar misslyckas:** Kontrollera Railway-loggen för API-tjänsten — kör `railway logs` lokalt eller se Deployments-fliken i dashboarden.
