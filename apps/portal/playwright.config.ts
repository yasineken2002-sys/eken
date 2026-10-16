import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.PWA_TEST_PORT ?? 4179)
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH

// Bygg dist först. Den här riggen startar ingen Vite-/API-/databasserver.
export default defineConfig({
  testDir: './e2e',
  testMatch: 'portal-installation.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  outputDir: process.env.PORTAL_PWA_OUTPUT_DIR ?? 'test-results/pwa',
  reporter: process.env.PORTAL_PWA_REPORT_PATH
    ? [['list'], ['json', { outputFile: process.env.PORTAL_PWA_REPORT_PATH }]]
    : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'],
    },
  },
  projects: [{ name: 'chromium-pwa', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node e2e/fixture-server.mjs',
    url: `http://127.0.0.1:${port}/__fixture/health`,
    reuseExistingServer: false,
    timeout: 15_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
