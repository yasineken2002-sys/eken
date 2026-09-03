/**
 * Integrationsbevis: NestJS `ConfigModule.forRoot({ validate: validateEnv })` kör
 * FAKTISKT valideringen vid boot. Skyddar också mot att någon råkar ta bort
 * `validate:`-inkopplingen i framtiden (då failar detta test).
 *
 * `ignoreEnvFile: true` så den riktiga apps/api/.env inte läcker in i asserterna.
 */

import { ConfigModule } from '@nestjs/config'
import { Test } from '@nestjs/testing'
import { validateEnv } from './env.validation'
import { PLACEHOLDER_CHECKED_VARS, SECRET_FORM_VARS } from './env-placeholders'

const CRITICAL_KEYS = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'PLATFORM_JWT_SECRET',
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
  'ANTHROPIC_API_KEY',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'APP_URL',
  'WEB_URL',
  'ADMIN_URL',
  'PORTAL_URL',
  // Alltid-kritiska sedan personnummer krypteras at-rest på Tenant/Customer.
  'SIGNING_PII_KEY',
  'SIGNING_PII_PEPPER',
]

const FULL_PROD: Record<string, string> = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@h:5432/db',
  REDIS_URL: 'redis://h:6379',
  JWT_SECRET: 'x'.repeat(32),
  PLATFORM_JWT_SECRET: 'y'.repeat(32),
  RESEND_API_KEY: 're_live',
  RESEND_WEBHOOK_SECRET: 'whsec',
  ANTHROPIC_API_KEY: 'sk-ant',
  R2_ACCOUNT_ID: 'acc',
  R2_ACCESS_KEY_ID: 'akid',
  R2_SECRET_ACCESS_KEY: 'sec',
  R2_BUCKET_NAME: 'bucket',
  APP_URL: 'https://app.eveno.se',
  WEB_URL: 'https://app.eveno.se',
  ADMIN_URL: 'https://admin.eveno.se',
  PORTAL_URL: 'https://portal.eveno.se',
  SIGNING_PII_KEY: 'a'.repeat(64),
  SIGNING_PII_PEPPER: 'p'.repeat(16),
}

// Mängden som måste nollställas är INTE bara CRITICAL_KEYS. validateEnv steg 3
// granskar dessutom PLACEHOLDER_CHECKED_VARS ∪ SECRET_FORM_VARS, och en variabel
// som bara står i den mängden läcker in från utvecklarens egen miljö —
// process.env vinner över det testet sätter. Uppmätt: sju nycklar låg utanför
// listan (bl.a. PLATFORM_JWT_REFRESH_SECRET), och den som råkade vara satt
// fällde "prod + allt satt" med ett platshållarfel om ett värde testet aldrig
// valt. Härledd ur koden, inte listad, så en ny nyckel i endera arrayen städas
// automatiskt i stället för att tyst öppna hålet igen.
const RENSADE_KEYS: readonly string[] = [
  ...new Set<string>([
    ...CRITICAL_KEYS,
    ...PLACEHOLDER_CHECKED_VARS,
    ...SECRET_FORM_VARS,
    'NODE_ENV',
    'PSD2_ENABLED',
    'SIGNING_ENABLED',
  ]),
]

async function boot(env: Record<string, string>) {
  for (const k of RENSADE_KEYS) delete process.env[k]
  Object.assign(process.env, env)
  const mod = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, validate: validateEnv })],
  }).compile()
  await mod.close()
}

describe('ConfigModule ↔ validateEnv (boot-integration, #1)', () => {
  const saved = { ...process.env }
  let warnSpy: jest.SpyInstance

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    warnSpy.mockRestore()
    // återställ process.env exakt
    for (const k of RENSADE_KEYS) delete process.env[k]
    Object.assign(process.env, saved)
  })

  it('prod + saknad kritisk var → ConfigModule vägrar boota (kastar vid compile)', async () => {
    const env = { ...FULL_PROD }
    delete (env as Record<string, string | undefined>).R2_BUCKET_NAME
    await expect(boot(env)).rejects.toThrow(/R2_BUCKET_NAME saknas/)
  })

  it('prod + allt satt → bootar (compile resolvar)', async () => {
    await expect(boot({ ...FULL_PROD })).resolves.toBeUndefined()
  })

  it('dev + inget satt → bootar (varnar, blockerar ej)', async () => {
    await expect(boot({ NODE_ENV: 'development' })).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
  })
})
