# E2E-tester (Playwright)

End-to-end-tester som verifierar kritiska hyresvärds-flöden genom **hela kedjan**:
webbläsare → Vite-proxy → NestJS-API → Postgres. Till skillnad från enhets- och
RTL-testerna kör de mot en levande stack och fångar regressioner som bara syns
när alla lager pratar med varandra.

Flöden som täcks:

| Fil                          | Flöde                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `create-base-data.spec.ts`   | Logga in → skapa fastighet → enhet → hyresgäst + kontrakt → verifiera "Aktivt" |
| `avi-paid-flow.spec.ts`      | Logga in → generera hyresavi → markera betald → verifiera "Betald"             |
| `portal-tenant-flow.spec.ts` | Hyresgäst-portal (:5174): logga in → se avi → felanmälan → logga ut            |

## Förutsättningar

1. **Postgres + Redis igång** (dev-stacken):
   ```bash
   docker-compose up -d postgres redis
   ```
2. **Databasen migrerad** (testet sår sin egen data via API:t, men schemat måste finnas):
   ```bash
   pnpm db:migrate:deploy
   ```
3. **Webbläsar-binärer för Playwright** (engångsinstallation per maskin):
   ```bash
   cd apps/web && npx playwright install chromium
   ```
4. **`psql` tillgängligt** — portal-seedningen skriver en aktiverings-token-hash
   direkt till DB (se nedan). Ingår i `postgresql-client`.

API (`:3000`), web (`:5173`) och portal (`:5174`) startas automatiskt av
Playwright om de inte redan kör (`webServer` i `playwright.config.ts`), och
redan körande dev-servrar återanvänds.

## Köra

```bash
cd apps/web

npm run test:e2e          # kör alla E2E-tester (headless)
npm run test:e2e:ui       # interaktivt UI-läge (Playwright UI)
npm run test:e2e:report   # öppna senaste HTML-rapporten
```

## Hur testdatan sätts upp

`helpers/seed.ts` skapar en **helt färsk organisation per körning** (unik
e-post) via det riktiga API:t. Eftersom varje körning är isolerad behövs ingen
separat test-databas och inga andra orgs data påverkas. Två varianter:

- `registerOrg()` — registrerar bara en tom org (ägare + inloggning). Används av
  `create-base-data.spec.ts` som bygger all grunddata via UI:t.
- `seedActiveLease()` — registrerar org OCH provisionerar
  `Fastighet → Enhet → Hyresgäst → AKTIVT kontrakt`, så att
  `avi-paid-flow.spec.ts` kan fokusera på avi-flödet.
- `seedPortalTenant()` — som ovan plus: en BETALD avi (syns i portalen) och ett
  aktiverat portal-konto, så att `portal-tenant-flow.spec.ts` kan logga in.

**Deterministisk hantering av async-/flaky beroenden:**

- _avi-flödet_: avin genereras för en period två månader bak → alltid förfallen,
  så den kan markeras betald direkt utan den asynkrona skicka-vägen (PDF i en
  Bull-worker).
- _kontrakts-flödet_: "Skapa & aktivera direkt" gör DRAFT → ACTIVE synkront i
  samma request; välkomstmejl och kontrakts-PDF köas i bakgrunden och påverkar
  inte statusen, så "Aktivt" syns direkt utan att vänta på någon worker.
- _portal-aktivering_: portalen har inget lösenord vid kontraktsskapande —
  hyresgästen aktiverar via en mejllänk (token vars SHA-256-hash lagras; råtoken
  finns bara i mejlet). Seedningen genererar en token, skriver hashen till DB
  (`psql`) och anropar sedan det riktiga `/tenant-portal/activate` (som bcrypt:ar
  lösenordet) → en hyresgäst som kan logga in.
- _CPU-mättnad (viktigast för stabilitet)_: API-aktivering av ett kontrakt köar
  en Puppeteer-kontrakts-PDF som dessutom failar + retrear 5× när R2-lagring inte
  är konfigurerad i dev — det mättar CPU och gör hela sviten flaky. Seed-helprarna
  aktiverar därför kontraktet via en DB-`UPDATE` (de testar inte aktiveringen).
  Den RIKTIGA aktiveringsvägen täcks ändå av `create-base-data.spec.ts` (UI).

> **Obs:** seedade test-organisationer ligger kvar i dev-databasen efter
> körningen. Det är ofarligt (egna, isolerade orgs) men kan städas vid behov.

## Felsökning

- **Timeout vid uppstart av servrar** – starta API/web manuellt enligt
  `CLAUDE.md` och kör om; Playwright återanvänder dem då.
- **`browserType.launch: Executable doesn't exist`** – kör
  `npx playwright install chromium`.
- **Registrering misslyckas (400)** – kontrollera att API:t kör mot en migrerad
  databas (`pnpm db:migrate:deploy`).
