import { defineConfig, devices } from '@playwright/test'

/**
 * Eveno – E2E-konfiguration (Playwright)
 *
 * Verifierar kritiska hyresvärds-flöden genom hela kedjan:
 *   webbläsare → Vite-proxy → NestJS-API → Postgres
 *
 * Körs mot en LEVANDE lokal miljö (api på :3000, web på :5173) med
 * Postgres + Redis igång (docker-compose up postgres redis). `webServer`
 * nedan startar api/web automatiskt om de inte redan kör, och återanvänder
 * redan startade dev-servrar (reuseExistingServer) så att iterering går fort.
 *
 * Se e2e/README.md för förutsättningar och felsökning.
 */

const WEB_URL = 'http://localhost:5173'
const PORTAL_URL = 'http://localhost:5174'
const API_HEALTH_URL = 'http://localhost:3000/v1/health'

export default defineConfig({
  testDir: './e2e',

  // ── VAD CI KÖR — OCH VAD SOM ÄR UTLYFT ─────────────────────────────────────
  //
  // `testIgnore` gäller BARA när CI är satt. Lokalt körs allt, även det som är
  // utlyft: en spec som inte går att köra för hand är inte utlyft, den är död.
  // Vill du reproducera CI:s urval exakt: `CI=1 npx playwright test`.
  //
  // Uteslutningarna matchar på FORM där det går (`*-50x`), inte på uppräknade
  // filnamn — en ny bevisrigg ska fångas av mönstret utan att någon minns att
  // uppdatera en lista.
  //
  // 1. De tre 50x-riggarna körs INTE i CI, och det är ett beslut och inte en
  //    glömska: avi-pdf-50x, bank-reconciliation-50x och tenant-creation-50x
  //    bevisar en invariant EN gång genom att upprepa ett flöde femtio gånger.
  //    De är bevistester, inte regressionstester — de tar minuter, säger samma
  //    sak varje körning, och att köra dem i CI vore att betala den tiden per
  //    push för information vi redan har. LÄGG INTE TILL DEM utan att först
  //    skriva varför invarianten behöver bevisas om vid varje ändring.
  //
  // 2. ai-attachment-composer kräver S3-kompatibel fillagring (R2). CI har inga
  //    R2-nycklar — det är #477, som väntar på Cloudflare-konsolen och därför
  //    inte går att lösa härifrån. Specen hoppade tidigare över SIG SJÄLV via en
  //    runtime-`test.skip` när uppladdningen svarade 500: jobbet rapporterade
  //    "8 tests", körde 7, och var grönt i 56 körningar av 56 utan att någon
  //    kunde se det. Uteslutningen står nu här i stället, där den syns och
  //    räknas av kanariefågeln i ci.yml.
  //    TILLBAKA NÄR #477 ÄR LÖST: ta bort raden nedan OCH höj
  //    `E2E_EXPECTED_TESTS` i .github/workflows/ci.yml från 7 till 8.
  testIgnore: process.env.CI ? ['**/*-50x.spec.ts', '**/ai-attachment-composer.spec.ts'] : [],
  // Ett enda kritiskt flöde i denna första PR — kör seriellt och utan
  // parallellism så att test-data och assertions blir deterministiska.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // Live-stack mot en dev-server: första anropet efter att API:t legat idle kan
  // svara långsamt/transient-faila (nest-watch + Prisma-pool värms upp), vilket
  // kan fälla en seed (beforeAll). Ett omförsök absorberar den kallstarten —
  // varma körningar passerar på första försöket. (CI får två.)
  retries: process.env.CI ? 2 : 1,
  // Flödet inkluderar Puppeteer-PDF-rendering i en Bull-worker (skicka avi),
  // vilket tar några sekunder — tillåt gott om tid per test.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: WEB_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  // Startar dev-servrarna vid behov. Redan körande servrar återanvänds.
  webServer: [
    {
      command: 'npm run dev',
      cwd: '../api',
      url: API_HEALTH_URL,
      reuseExistingServer: true,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev',
      url: WEB_URL,
      reuseExistingServer: true,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev',
      cwd: '../portal',
      url: PORTAL_URL,
      reuseExistingServer: true,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
})
