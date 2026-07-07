import { z } from 'zod'

/**
 * Boot-validering av miljövariabler (launch-readiness #1).
 *
 * Problem som detta stänger: `ConfigModule` hade inget valideringsschema, så en
 * saknad kritisk variabel i produktion kraschade INTE appen — den bootade och gav
 * tysta fel först i drift (hyresgäster fick `localhost`-länkar i aktiveringsmejl,
 * R2-saknad dödade alla PDF:er/dokument vid första anrop, `REDIS_URL`-fallback
 * gjorde att köer dog tyst). "Funkar i dev, dör tyst i prod."
 *
 * Beteende:
 * - `NODE_ENV=production`: appen VÄGRAR STARTA (fail-fast) om någon alltid-kritisk
 *   variabel saknas/är ogiltig. Alla fel samlas och rapporteras i ETT tydligt
 *   felmeddelande — operatören ser allt på en gång.
 * - dev/test: mildare — varnar (`console.warn`) men blockerar INTE, så lokal
 *   utveckling och testsviten inte bryts.
 * - Flagg-villkorade variabler (PSD2/SIGNING): krävs bara när sin flagga är på och
 *   valideras då i ALLA miljöer — speglar (dubblar inte) den befintliga fail-fast
 *   i `psd2.module.ts` / `signing.module.ts`. Ger bara ett tidigare + tydligare
 *   boot-fel än modul-factory-kastet.
 *
 * Additivt: när alla variabler finns bootar appen exakt som förut. `validate`
 * returnerar den oförändrade env-recorden (ren grind — muterar inte config).
 */

type EnvRecord = Record<string, unknown>

const url = z.string().url()
const nonEmpty = z.string().min(1)
const secret16 = z.string().min(16, 'minst 16 tecken')
const hex64 = /^[0-9a-fA-F]{64}$/
const positiveInt = z.coerce.number().int().positive()

/**
 * Alltid-kritiska variabler: appen bootar men felar tyst i drift utan dem.
 * Namn → format-validator. I produktion krävs BÅDE närvaro OCH giltigt format;
 * i dev/test blir samma brister varningar.
 */
const CRITICAL: Record<string, z.ZodTypeAny> = {
  // Kärn-infra
  DATABASE_URL: nonEmpty,
  REDIS_URL: nonEmpty, // annars fallback redis://localhost:6379 → köer dör tyst
  // Auth-secrets (JWT_SECRET/PLATFORM_JWT_SECRET failar redan via getOrThrow —
  // schemat ger ett tydligare, samlat fel + min-längd-krav)
  JWT_SECRET: secret16,
  PLATFORM_JWT_SECRET: secret16,
  // E-post (Resend) — annars tyst 'missing-key' + döda bounce-webhooks
  RESEND_API_KEY: nonEmpty,
  RESEND_WEBHOOK_SECRET: nonEmpty,
  // AI (Claude) — kärnfunktion (assistent, PDF-avstämning, kontraktsskanning m.m.)
  ANTHROPIC_API_KEY: nonEmpty,
  // Fillagring (Cloudflare R2) — annars bootar friskt men PDF/dokument/logotyper dör
  R2_ACCOUNT_ID: nonEmpty,
  R2_ACCESS_KEY_ID: nonEmpty,
  R2_SECRET_ACCESS_KEY: nonEmpty,
  R2_BUCKET_NAME: nonEmpty,
  // Publika URL:er — annars localhost-länkar i mejl + felaktig CORS i prod
  APP_URL: url, // kund-webb (CORS + länkar)
  WEB_URL: url, // reset-/inbjudningslänkar
  ADMIN_URL: url, // admin-SPA (CORS)
  PORTAL_URL: url, // hyresgästportal — aktiverings-/reset-länkar
}

/**
 * Valfria variabler som har vettig default i koden. Validera bara FORMAT om de är
 * satta (fånga t.ex. `PORT=abc`), blockera aldrig boot — saknad = default används.
 */
const OPTIONAL_FORMAT: Record<string, z.ZodTypeAny> = {
  MAIL_FROM: nonEmpty, // default: 'Eveno Fastigheter <noreply@eveno.se>'
  ALLOWED_ORIGINS: nonEmpty,
  PORT: positiveInt,
  THROTTLE_TTL: positiveInt,
  THROTTLE_LIMIT: positiveInt,
  BACKUP_RETENTION_DAYS: positiveInt,
  PSD2_CALLBACK_URL: url,
  PSD2_APP_RETURN_URL: url,
}

/**
 * Flagg-villkorad validering. Speglar den befintliga fail-closed-logiken:
 * - PSD2: `psd2.module.ts:50-52` + `bank-consent-crypto.service.ts:24` (64 hex)
 * - SIGNING: `signing.module.ts:36-39` + `signing-crypto.service.ts:26-27`
 *   (nyckel 64 hex, pepper ≥16)
 * Kastar i ALLA miljöer (som modul-factoryn), inte bara prod. BACKUP hanteras
 * medvetet INTE här: `backup.service.ts:74-93` är en avsiktlig fail-closed no-op +
 * error-logg (appen ska fortsätta köra utan backup) — ett boot-krasch här skulle
 * MOTSÄGA den logiken.
 */
function collectFeatureFlagErrors(config: EnvRecord): string[] {
  const errs: string[] = []

  if (String(config.PSD2_ENABLED) === 'true') {
    const key = config.PSD2_TOKEN_KEY
    if (typeof key !== 'string' || !hex64.test(key)) {
      errs.push('  • PSD2_ENABLED=true men PSD2_TOKEN_KEY saknas/ogiltig (kräver 64 hex-tecken)')
    }
  }

  if (String(config.SIGNING_ENABLED) === 'true') {
    const key = config.SIGNING_PII_KEY
    if (typeof key !== 'string' || !hex64.test(key)) {
      errs.push(
        '  • SIGNING_ENABLED=true men SIGNING_PII_KEY saknas/ogiltig (kräver 64 hex-tecken)',
      )
    }
    const pepper = config.SIGNING_PII_PEPPER
    if (typeof pepper !== 'string' || pepper.length < 16) {
      errs.push('  • SIGNING_ENABLED=true men SIGNING_PII_PEPPER saknas/för kort (≥16 tecken)')
    }
  }

  return errs
}

function checkString(name: string, raw: unknown, schema: z.ZodTypeAny): string | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    return `  • ${name} saknas`
  }
  const res = schema.safeParse(raw)
  if (!res.success) {
    return `  • ${name} ogiltig (${res.error.issues[0]?.message ?? 'ogiltigt värde'})`
  }
  return null
}

/**
 * `validate`-hook för `ConfigModule.forRoot`. Får den fullt upplösta env-recorden
 * (process.env + .env). Returnerar den OFÖRÄNDRAD — validering är en ren grind.
 */
export function validateEnv(config: EnvRecord): EnvRecord {
  const nodeEnv = typeof config.NODE_ENV === 'string' ? config.NODE_ENV : 'development'
  const isProd = nodeEnv === 'production'

  const errors: string[] = []
  const warnings: string[] = []

  // 1. Alltid-kritiska: prod → error, dev/test → warning.
  for (const [name, schema] of Object.entries(CRITICAL)) {
    const issue = checkString(name, config[name], schema)
    if (issue) (isProd ? errors : warnings).push(issue)
  }

  // 2. Valfria med default: bara format om satta, aldrig blockerande.
  for (const [name, schema] of Object.entries(OPTIONAL_FORMAT)) {
    const raw = config[name]
    if (typeof raw !== 'string' || raw.length === 0) continue
    const res = schema.safeParse(raw)
    if (!res.success) {
      warnings.push(`  • ${name} ogiltig (${res.error.issues[0]?.message ?? 'ogiltigt värde'})`)
    }
  }

  // 3. Flagg-villkorade: hård fail-fast i alla miljöer (speglar modul-factoryn).
  errors.push(...collectFeatureFlagErrors(config))

  if (warnings.length > 0) {
    console.warn(
      `[env] ⚠️  ${warnings.length} miljövariabel-varning(ar) (NODE_ENV=${nodeEnv}, blockerar ej):\n` +
        warnings.join('\n'),
    )
  }

  if (errors.length > 0) {
    throw new Error(
      `[env] Uppstart avbruten — ${errors.length} kritiskt miljövariabel-fel (NODE_ENV=${nodeEnv}):\n` +
        errors.join('\n') +
        '\n\nSätt variablerna (Railway/.env) och starta om. ' +
        'Se docs/launch-readiness-atgardslista.md #1.',
    )
  }

  return config
}
