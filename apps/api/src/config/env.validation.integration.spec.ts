/**
 * Integrationsbevis: NestJS `ConfigModule.forRoot({ validate: validateEnv })` kör
 * FAKTISKT valideringen vid boot. Skyddar också mot att någon råkar ta bort
 * `validate:`-inkopplingen i framtiden (då failar detta test).
 *
 * `ignoreEnvFile: true` så den riktiga apps/api/.env inte läcker in i asserterna.
 */

import { ConfigModule } from '@nestjs/config'
import { Test } from '@nestjs/testing'
import { VALIDATED_ENV_VARS, validateEnv } from './env.validation'
import {
  PLACEHOLDER_CHECKED_VARS,
  PLACEHOLDER_WORD_THRESHOLD,
  SECRET_FORM_VARS,
  placeholderWordHits,
} from './env-placeholders'

/**
 * Nycklarna som MÅSTE finnas i produktion — speglar `CRITICAL` i
 * env.validation.ts och används bara för att läsa fixturen nedan.
 */
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

// Mängden som måste nollställas är varje variabel `validateEnv` LÄSER —
// `process.env` vinner över `ConfigModule.forRoot({ load })`, så en variabel i
// utvecklarens egen miljö avgör annars utfallet (#685).
//
// Den här listan räknades tidigare upp här, härledd ur `PLACEHOLDER_CHECKED_VARS
// ∪ SECRET_FORM_VARS`. Det är en DELMÄNGD av vad validateEnv läser: 27 av 37.
// Tio nycklar stod utanför, och två av dem kan ge FEL — `SIGNING_PII_KEY_OLD`
// och `E2E_RELAX_AUTH_THROTTLE` — alltså fälla den här filen hos den som råkar
// ha dem satta lokalt, med ett felmeddelande om ett värde testet aldrig valt.
//
// Mängden läses nu ur `VALIDATED_ENV_VARS`, som härleds på andra sidan ur samma
// strukturer loopen går igenom. En uppräkning på det här stället skulle vara en
// andra sanning, och två uppräkningar som ska vara lika glider isär.
const RENSADE_KEYS: readonly string[] = VALIDATED_ENV_VARS

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

/**
 * De tio nycklar som stod UTANFÖR den gamla rensningsmängden.
 *
 * Uppräknade ur koden mot `1f52369`: `validateEnv` läste 37 nycklar, specen
 * rensade 27. Åtta av de tio ligger i `OPTIONAL_FORMAT` och kan bara ge
 * varningar; två kan ge FEL och fällde alltså den här filen hos den som råkar
 * ha dem satta lokalt. De står med namn därför att ett TAL inte fångar ett
 * återfall — en nyckel som faller ur mängden och en som tillkommer tar ut
 * varandra i en summa.
 */
const TIDIGARE_ORENSADE = [
  // OPTIONAL_FORMAT — bara varningar
  'ALLOWED_ORIGINS',
  'BACKUP_RETENTION_DAYS',
  'MAIL_FROM',
  'PORT',
  'PSD2_APP_RETURN_URL',
  'PSD2_CALLBACK_URL',
  'THROTTLE_LIMIT',
  'THROTTLE_TTL',
  // Kan ge FEL, och fällde alltså specen av utvecklarens egen miljö
  'E2E_RELAX_AUTH_THROTTLE',
  'SIGNING_PII_KEY_OLD',
]

describe('rensningsmängden härleds ur det validateEnv faktiskt läser', () => {
  it('täcker de tio nycklar som stod utanför de två platshållar-arrayerna', () => {
    for (const nyckel of TIDIGARE_ORENSADE) {
      expect(RENSADE_KEYS).toContain(nyckel)
      // Var utanför den GAMLA härledningen — annars mäter provet ingenting.
      expect([...PLACEHOLDER_CHECKED_VARS, ...SECRET_FORM_VARS]).not.toContain(nyckel)
    }
  })

  it('täcker fortfarande allt den gamla härledningen täckte', () => {
    for (const nyckel of [...CRITICAL_KEYS, ...PLACEHOLDER_CHECKED_VARS, ...SECRET_FORM_VARS]) {
      expect(RENSADE_KEYS).toContain(nyckel)
    }
  })

  it('prod-fixturen levererar varje alltid-kritisk nyckel', () => {
    for (const nyckel of CRITICAL_KEYS) expect(Object.keys(FULL_PROD)).toContain(nyckel)
  })
})

/**
 * ── KANARIEFÅGEL: mäter rensningen fortfarande något? ────────────────────────
 *
 * `RENSADE_KEYS` ovan HÄRLEDS ur `PLACEHOLDER_CHECKED_VARS ∪ SECRET_FORM_VARS`
 * i stället för att räknas upp för hand (#685). Härledningen är rätt — och
 * osynlig. Slutar den betyda något blir de tre proven ovan gröna av fel skäl:
 * de säger då bara att `validateEnv` accepterar FULL_PROD i en miljö där
 * ingenting kunde läcka in, vilket är sant oavsett om nollställningen sker.
 *
 * VAD DEN HÄR PRÖVAR: att läckvägen är LEVANDE. En nyckel som `validateEnv`
 * granskar men som `RENSADE_KEYS` inte täcker ska nå steg 3 med utvecklarens
 * värde och FÄLLA boot. Går den igenom är det inte rensningen som gör de tre
 * proven gröna, och de mäter ingenting.
 *
 * Fallet konstrueras genom att sonden skjuts in i `SECRET_FORM_VARS` EFTER
 * modulinladdning: `RENSADE_KEYS` är ett ögonblicksvärde taget vid import,
 * medan `validateEnv` bygger sin `checked`-mängd vid varje anrop. Divergensen
 * blir därmed exakt den form regeln handlar om — granskad, men inte rensad.
 *
 * VAD DEN INTE SER, och det är avsiktligt utskrivet:
 *
 *   • Den bevisar INTE att en nyckel som läggs till i KÄLLKODEN skulle missas.
 *     Härledningen är levande, så en ny post i endera arrayen städas
 *     automatiskt. Den formen kan inte återuppstå så länge härledningen står
 *     kvar — och det är just härledningens fortlevnad kanariefågeln vaktar.
 *   • Den ser inte de nycklar `validateEnv` läser UTANFÖR de två arrayerna.
 *     Uppräknat mot `1f52369`: 37 nycklar läses, 27 rensas, **10 står
 *     utanför** — `ALLOWED_ORIGINS`, `BACKUP_RETENTION_DAYS`,
 *     `E2E_RELAX_AUTH_THROTTLE`, `MAIL_FROM`, `PORT`, `PSD2_APP_RETURN_URL`,
 *     `PSD2_CALLBACK_URL`, `SIGNING_PII_KEY_OLD`, `THROTTLE_LIMIT`,
 *     `THROTTLE_TTL`. Åtta av dem ligger i `OPTIONAL_FORMAT` och kan bara ge
 *     VARNINGAR. Två kan ge FEL, och fäller alltså specen hos den som råkar ha
 *     dem satta: `SIGNING_PII_KEY_OLD` (satt men inte 64 hex → fel i alla
 *     miljöer) och `E2E_RELAX_AUTH_THROTTLE` (`'true'` + `NODE_ENV=production`,
 *     vilket FULL_PROD sätter → fel). Det är samma felform som #685 löste, på
 *     nycklar utanför de två arrayerna, och det är ett EGET beslut — inte
 *     något den här filen tyst utvidgar sig till.
 */

const KANARIENYCKEL = 'KANARIE_ORENSAD_HEMLIGHET'
/** Tre ord ur PLACEHOLDER_WORDS ("change", "secret", "placeholder") — tröskeln är två. */
const KANARIEVARDE = 'change-me-secret-placeholder'

describe('kanariefågel: en granskad nyckel utanför rensningsmängden fäller boot', () => {
  const sparat = process.env[KANARIENYCKEL]

  afterEach(() => {
    const i = (SECRET_FORM_VARS as string[]).indexOf(KANARIENYCKEL)
    if (i >= 0) (SECRET_FORM_VARS as string[]).splice(i, 1)
    if (sparat === undefined) delete process.env[KANARIENYCKEL]
    else process.env[KANARIENYCKEL] = sparat
  })

  // Tröskeln läses UR KODEN och sonden ställs mot den, så "vakten såg inget"
  // inte kan förväxlas med "det fanns inget att se".
  it('sonden är entydig och överskrider tröskeln den ska fällas av', () => {
    expect(RENSADE_KEYS).not.toContain(KANARIENYCKEL)
    expect(PLACEHOLDER_CHECKED_VARS).not.toContain(KANARIENYCKEL)
    expect(SECRET_FORM_VARS).not.toContain(KANARIENYCKEL)
    expect(placeholderWordHits(KANARIEVARDE).length).toBeGreaterThanOrEqual(
      PLACEHOLDER_WORD_THRESHOLD,
    )
  })

  it('läckvägen är levande: värdet i process.env når steg 3 och avbryter uppstarten', async () => {
    ;(SECRET_FORM_VARS as string[]).push(KANARIENYCKEL)
    process.env[KANARIENYCKEL] = KANARIEVARDE
    // FULL_PROD levererar INTE den här nyckeln. Rensningen är därför det enda
    // som skulle kunna ta bort utvecklarens värde — och den täcker den inte.
    await expect(boot({ ...FULL_PROD })).rejects.toThrow(new RegExp(KANARIENYCKEL))
  })
})
