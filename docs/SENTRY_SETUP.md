# Sentry-setup för Eveno (för Yasin)

Koden är redan instrumenterad i alla fyra apparna. Det enda som saknas
är **DSN-värdena** från sentry.io. När du gjort stegen nedan börjar
Sentry rapportera fel automatiskt — inga ytterligare kodändringar behövs.

## 1. Skapa Sentry-konto

1. Gå till <https://sentry.io/signup/>
2. Välj **gratis-tier** (5 000 fel/månad räcker till långt fler kunder än vi
   har de första 12 månaderna)
3. När kontot är skapat hamnar du i en organisation. Notera **slug:en**
   som syns i URL:en, t.ex. `https://eveno-xyz.sentry.io/` → `eveno-xyz`

## 2. Skapa fyra projekt

I Sentry-dashbordet, klicka **Projects → Create Project** fyra gånger.
Välj plattform och namn enligt nedan:

| Projektnamn    | Plattform        | Vad det är                      |
| -------------- | ---------------- | ------------------------------- |
| `eveno-api`    | Node.js / NestJS | Backend (apps/api)              |
| `eveno-web`    | React            | Huvudappen (apps/web)           |
| `eveno-portal` | React            | Hyresgästportalen (apps/portal) |
| `eveno-admin`  | React            | Super-admin (apps/admin)        |

För varje projekt visar Sentry en setup-sida med en **DSN-sträng** som
ser ut så här:

```
https://abc123def456@o1234567.ingest.sentry.io/9876543
```

Kopiera DSN:en — det är den enda värdet du behöver för varje projekt.
**Du behöver INTE följa kodexemplen som Sentry visar** — koden är redan
färdiginstrumenterad.

## 3. Lägg in DSN i Railway (backend)

1. Logga in på Railway → välj API-projektet (`apps/api`)
2. Gå till **Variables**
3. Lägg till:

   | Variable         | Value                            |
   | ---------------- | -------------------------------- |
   | `SENTRY_DSN`     | (DSN från `eveno-api`-projektet) |
   | `SENTRY_RELEASE` | `${{ RAILWAY_GIT_COMMIT_SHA }}`  |

   `RAILWAY_GIT_COMMIT_SHA` är en automatisk Railway-variabel som
   peka ut den deploy:ade commiten — Sentry kopplar då varje incident
   till exakt rätt release.

4. Tryck **Deploy** så plockar nästa deploy upp variablerna.

## 4. Lägg in DSN i Vercel (frontends)

För varje av de tre frontend-projekten i Vercel:

| Vercel-projekt | DSN-källa               |
| -------------- | ----------------------- |
| eveno-web      | `eveno-web` i Sentry    |
| eveno-portal   | `eveno-portal` i Sentry |
| eveno-admin    | `eveno-admin` i Sentry  |

Steg per projekt:

1. Vercel-dashboard → välj projektet → **Settings → Environment Variables**
2. Lägg till:

   | Variable              | Value                                 | Environment |
   | --------------------- | ------------------------------------- | ----------- |
   | `VITE_SENTRY_DSN`     | (DSN från motsvarande Sentry-projekt) | Production  |
   | `VITE_GIT_COMMIT_SHA` | `${{ VERCEL_GIT_COMMIT_SHA }}`        | Production  |

3. Tryck **Save** och rebuild det senaste deploymentet (Deployments →
   senaste → "..." → **Redeploy**) så plockar Vite upp variablerna.

> **Obs:** Vite injicerar `VITE_*`-variabler vid build-tid, INTE runtime.
> Du måste därför rebuilda för att DSN:en ska komma in. En vanlig deploy
> efter nästa commit räcker också.

## 5. Verifiera att det fungerar

### Backend

1. När API:t startat, kolla Railway-loggarna för raden:
   ```
   [bootstrap] entering main.ts
   ```
2. Trigga ett kontrollerat fel via Swagger eller en testrequest som
   t.ex. försöker dela på noll i en endpoint.
3. Inom ~30s ska felet dyka upp i Sentry-projektet `eveno-api`.

### Frontend

1. Öppna prod-appen i webbläsaren
2. Öppna DevTools → Console
3. Kör manuellt: `throw new Error('Sentry-test')` i konsolen — gärna i
   en knapp-onClick så ErrorBoundary fångar det
4. Felet ska dyka upp i motsvarande Sentry-projekt inom ~30s

## 6. Inställningar i Sentry-dashbordet

Per projekt, gå till **Settings**:

- **Alerts**: aktivera default-regeln "A new issue is created" så att
  du får mejl direkt vid första gången ett fel inträffar.
- **Issue Grouping → Custom rules**: tillåt default — Sentry grupperar
  identiska fel automatiskt.
- **Releases**: koden skickar redan `release` baserat på git-sha. För
  source maps i frontends kan du senare addera `@sentry/vite-plugin`
  (kräver `SENTRY_AUTH_TOKEN` i build-stegen) — inte nödvändigt för
  första launchen.

## Vad är redan implementerat i koden

- **Sample rate**: 10 % i prod, 0 % i dev (sparar Sentry-kvot under
  utveckling)
- **Performance monitoring**: aktiverat (`tracesSampleRate: 0.1`)
- **Filter**: 401, 403, samt nätverksfel (ECONNREFUSED, ETIMEDOUT,
  ENOTFOUND, EAI_AGAIN, ECONNRESET) skickas inte — det är förväntat
  kontrollflöde, inte incidenter
- **User context**: id + email sätts automatiskt vid login i alla tre
  frontends; rensas vid logout
- **Org-context**: `organizationId` sätts som tag i web-appen så du kan
  filtrera "alla fel för organisation X"
- **React stack traces**: ErrorBoundary skickar `componentStack` med så
  Sentry kan peka ut exakt vilken komponent som kraschade
- **Releases**: kopplas till git commit-sha så incidenter automatiskt
  knyts till rätt deploy
