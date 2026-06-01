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
