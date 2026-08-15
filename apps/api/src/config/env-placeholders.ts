/**
 * Avvisning av platshållarvärden i miljövariabler.
 *
 * Bakgrund: `env.validation.ts` kontrollerade FORM (längd, hex, url) men aldrig
 * INNEHÅLL. En hemlighet på 42 tecken passerade `min(16)` oavsett om den var
 * slumpad eller hette `eken-super-secret-jwt-key-2026-change-this`. Prod stod på
 * just sådana strängar för JWT_SECRET, JWT_REFRESH_SECRET och
 * PLATFORM_JWT_SECRET (superadmin) tills de roterades 2026-08-15.
 *
 * ── Varför TVÅ regler, och inte bara listan ur .env.example ──────────────────
 *
 * Den självklara regeln är "avvisa värdena som står i .env.example". Uppmätt mot
 * de tre värden som faktiskt låg i prod fångar den 0 av 3 — prod stod på en ANNAN
 * platshållarfamilj än den dokumenterade. En ren uppräkning hade alltså varit
 * grön hela vägen genom incidenten den skulle ha förhindrat.
 *
 * Därför speglar den här filen repots egen läxa (spärra formen, inte
 * uppräkningen) med två regler som täcker olika saker:
 *
 *   A. EXAKT: värdet är identiskt med .env.example-värdet för SAMMA variabel.
 *      Fångar den som kopierat exempelfilen och glömt fylla i. Per variabel, inte
 *      mot en platt mängd — `R2_BUCKET_NAME=eken-documents` är identiskt i
 *      exempel och prod, och en platt mängd hade blockerat boot på ett korrekt
 *      värde.
 *
 *   B. FORM: värdet innehåller minst två ord ur `PLACEHOLDER_WORDS`. Fångar
 *      familjen. Uppmätt: 3 av 3 av de verkliga prod-värdena, och 0 falsklarm på
 *      5500 realistiska hemligheter (base64-48, hex-32, sk-ant-*, re_*,
 *      postgresql://…).
 *
 * Entropi PRÖVADES och förkastades: de tre platshållarna låg på H=3,85–4,34 per
 * tecken, medan en legitim `openssl rand -hex 16`-pepper ligger på H=3,66 —
 * alltså UNDER dem. Ett entropigolv hade avvisat en korrekt pepper och släppt
 * igenom en platshållare. Alfabetsstorleken förvirrar måttet; ordregeln gör det
 * inte.
 *
 * ── Varför en committad konstant och inte en runtime-läsning av .env.example ──
 *
 * `.env.example` kopieras INTE in i runner-imagen (apps/api/Dockerfile:87-95 tar
 * dist, package.json, node_modules, packages, prisma, scripts — inget mer). En
 * `readFileSync('.env.example')` vid boot hade alltså kastat, eller — värre — i
 * ett try/catch tyst gjort kontrollen till en no-op i EXAKT den miljö den ska
 * skydda. Kontrollen hade varit grön för alltid.
 *
 * Listan nedan är därför speglad, inte hittepå, och `env-placeholders.spec.ts`
 * läser `.env.example` och kräver att de är identiska — med golv och
 * kanariefågel, så en parser som slutar hitta något faller i stället för att tiga.
 */

/**
 * Variabler vars värde är en KREDENTIAL eller en förbindelsesträng med
 * inbäddade uppgifter. Bara dessa platshållar-kontrolleras — `R2_BUCKET_NAME`,
 * `MAIL_FROM` och URL:erna får legitimt vara identiska med exempelfilen.
 */
export const PLACEHOLDER_CHECKED_VARS: readonly string[] = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'PLATFORM_JWT_SECRET',
  'PLATFORM_JWT_REFRESH_SECRET',
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
  'ANTHROPIC_API_KEY',
  'VOYAGE_API_KEY',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BACKUP_ACCOUNT_ID',
  'R2_BACKUP_ACCESS_KEY_ID',
  'R2_BACKUP_SECRET_ACCESS_KEY',
  'SIGNING_PII_KEY',
  'SIGNING_PII_PEPPER',
  'PSD2_TOKEN_KEY',
]

/**
 * Delmängd av ovanstående som dessutom formkontrolleras (regel B). URL:erna
 * står utanför: en förbindelsesträng bär legitimt ord som `default` eller ett
 * databasnamn som `test`, och två sådana träffar räcker för att fälla.
 */
export const SECRET_FORM_VARS: readonly string[] = [
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'PLATFORM_JWT_SECRET',
  'PLATFORM_JWT_REFRESH_SECRET',
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
  'ANTHROPIC_API_KEY',
  'VOYAGE_API_KEY',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BACKUP_ACCOUNT_ID',
  'R2_BACKUP_ACCESS_KEY_ID',
  'R2_BACKUP_SECRET_ACCESS_KEY',
  'SIGNING_PII_KEY',
  'SIGNING_PII_PEPPER',
  'PSD2_TOKEN_KEY',
]

/**
 * Ord som en slumpad hemlighet i praktiken aldrig innehåller, men som en
 * handskriven platshållare nästan alltid gör. Två träffar krävs — ett ensamt
 * ord kan uppstå av slump i en tillräckligt lång sträng.
 */
export const PLACEHOLDER_WORDS: readonly string[] = [
  'change',
  'secret',
  'password',
  'passwd',
  'placeholder',
  'example',
  'dummy',
  'sample',
  'todo',
  'xxx',
  'jwt',
  'platform',
  'eken',
  'eveno',
  'random',
  'string',
  'insecure',
  'default',
  'test',
  'demo',
  'prod',
]

/** Antal ordträffar som krävs för att formregeln ska fälla. */
export const PLACEHOLDER_WORD_THRESHOLD = 2

/**
 * Platshållarvärdena i `apps/api/.env.example`, per variabel.
 *
 * SPEGLAD, inte handskriven — `env-placeholders.spec.ts` läser exempelfilen och
 * kräver exakt likhet. Ändras exempelfilen utan att den här kartan följer med
 * blir testet rött. Variabler som står tomma i exempelfilen (`SIGNING_PII_KEY=`)
 * saknas här med flit: tomt värde hanteras redan av `saknas`-kontrollen.
 */
export const ENV_EXAMPLE_VALUES: Readonly<Record<string, string>> = {
  DATABASE_URL: 'postgresql://eken:eken@localhost:5432/eken_dev',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'change-me-in-production-use-a-long-random-string',
  JWT_REFRESH_SECRET: 'change-this-to-another-random-string',
  PLATFORM_JWT_SECRET: 'change-me-to-a-separate-long-random-string',
  PLATFORM_JWT_REFRESH_SECRET: 'change-me-to-another-separate-long-random-string',
  RESEND_API_KEY: 're_your_resend_api_key',
  RESEND_WEBHOOK_SECRET: 'whsec_your_resend_webhook_secret',
  ANTHROPIC_API_KEY: 'sk-ant-your-key-here',
  VOYAGE_API_KEY: 'pa-your-voyage-key-here',
  R2_ACCOUNT_ID: 'your-cloudflare-account-id',
  R2_ACCESS_KEY_ID: 'your-r2-access-key-id',
  R2_SECRET_ACCESS_KEY: 'your-r2-secret-access-key',
}

/** Ordträffarna i ett värde — exponerad så felmeddelandet kan visa VARFÖR. */
export function placeholderWordHits(value: string): string[] {
  const lower = value.toLowerCase()
  return PLACEHOLDER_WORDS.filter((w) => lower.includes(w))
}

/**
 * Varför ett värde avvisas, eller `null` om det passerar.
 *
 * Returnerar en förklaring i stället för en boolean: felmeddelandet vid boot ska
 * säga vilken regel som fällde, aldrig återge värdet.
 */
export function placeholderRejection(name: string, value: string): string | null {
  if (PLACEHOLDER_CHECKED_VARS.includes(name)) {
    const example = ENV_EXAMPLE_VALUES[name]
    if (example !== undefined && value === example) {
      return 'är oförändrat platshållarvärde ur .env.example'
    }
  }
  if (SECRET_FORM_VARS.includes(name)) {
    const hits = placeholderWordHits(value)
    if (hits.length >= PLACEHOLDER_WORD_THRESHOLD) {
      return `ser ut som en platshållare (innehåller ${hits.map((h) => `"${h}"`).join(', ')})`
    }
  }
  return null
}
