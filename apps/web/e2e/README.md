# E2E-tester (Playwright)

End-to-end-tester som verifierar kritiska hyresvärds-flöden genom **hela kedjan**:
webbläsare → Vite-proxy → NestJS-API → Postgres. Till skillnad från enhets- och
RTL-testerna kör de mot en levande stack och fångar regressioner som bara syns
när alla lager pratar med varandra.

I denna första iteration finns **ett** flöde:

| Fil                     | Flöde                                                              |
| ----------------------- | ------------------------------------------------------------------ |
| `avi-paid-flow.spec.ts` | Logga in → generera hyresavi → markera betald → verifiera "Betald" |

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

API (`:3000`) och web (`:5173`) startas automatiskt av Playwright om de inte
redan kör (`webServer` i `playwright.config.ts`), och redan körande dev-servrar
återanvänds.

## Köra

```bash
cd apps/web

npm run test:e2e          # kör alla E2E-tester (headless)
npm run test:e2e:ui       # interaktivt UI-läge (Playwright UI)
npm run test:e2e:report   # öppna senaste HTML-rapporten
```

## Hur testdatan sätts upp

`helpers/seed.ts` skapar en **helt färsk organisation per körning** (unik
e-post) via det riktiga API:t och bygger kedjan
`Organisation → Fastighet → Enhet → Hyresgäst → AKTIVT kontrakt`. Eftersom varje
körning är isolerad behövs ingen separat test-databas och inga andra orgs data
påverkas. Avin genereras för en period två månader bak, så att den alltid är
förfallen — då går den att markera betald direkt utan den asynkrona skicka-vägen
(PDF-rendering i en Bull-worker), vilket håller testet snabbt och stabilt.

> **Obs:** seedade test-organisationer ligger kvar i dev-databasen efter
> körningen. Det är ofarligt (egna, isolerade orgs) men kan städas vid behov.

## Felsökning

- **Timeout vid uppstart av servrar** – starta API/web manuellt enligt
  `CLAUDE.md` och kör om; Playwright återanvänder dem då.
- **`browserType.launch: Executable doesn't exist`** – kör
  `npx playwright install chromium`.
- **Registrering misslyckas (400)** – kontrollera att API:t kör mot en migrerad
  databas (`pnpm db:migrate:deploy`).
