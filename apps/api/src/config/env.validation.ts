import { z } from 'zod'
import { E2E_AUTH_THROTTLE_FLAG, authThrottleRelaxed } from '../common/throttler/auth-throttle-mode'
import { BANKID_PROVIDER_VAR, bankIdMockRequested } from '../bankid/bankid-provider-mode'
import {
  PLACEHOLDER_CHECKED_VARS,
  SECRET_FORM_VARS,
  placeholderRejection,
} from './env-placeholders'

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
  // Personnummer-kryptering (Tenant/Customer at-rest + signeringsbevisen).
  // Var tidigare flagg-villkorad på SIGNING_ENABLED — men hyresgäster finns
  // oavsett om e-signering är på, så utan nycklarna går det inte att spara ett
  // personnummer alls. Fail-closed med flit: alternativet vore att tyst falla
  // tillbaka på klartext.
  SIGNING_PII_KEY: z.string().regex(hex64, '64 hex-tecken (32 byte)'),
  SIGNING_PII_PEPPER: secret16,
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
/**
 * De flagg-villkorade nycklarna, som en egen konstant därför att
 * `collectFeatureFlagErrors` läser dem med namn i stället för i en loop — de
 * finns alltså inte i någon `Record` att räkna upp. Funktionen nedan läser
 * GENOM den här konstanten, så den inte kan bli en parallell lista som glider
 * ifrån vad koden faktiskt gör.
 */
export const FLAG_CONDITIONAL_VARS = {
  BANKID_ENABLED: 'BANKID_ENABLED',
  PSD2_ENABLED: 'PSD2_ENABLED',
  PSD2_TOKEN_KEY: 'PSD2_TOKEN_KEY',
  SIGNING_ENABLED: 'SIGNING_ENABLED',
  SIGNING_PII_KEY: 'SIGNING_PII_KEY',
  SIGNING_PII_PEPPER: 'SIGNING_PII_PEPPER',
  SIGNING_PII_KEY_OLD: 'SIGNING_PII_KEY_OLD',
} as const

/**
 * VARJE miljövariabel `validateEnv` läser — den enda källan för "vad påverkar
 * utfallet av en boot-validering".
 *
 * Varför den finns: `env.validation.integration.spec.ts` måste nollställa
 * process.env innan den bootar, därför att `process.env` vinner över
 * `ConfigModule.forRoot({ load })` och utvecklarens egen miljö annars avgör
 * utfallet (#685). Den nollställningen härleddes ur `PLACEHOLDER_CHECKED_VARS ∪
 * SECRET_FORM_VARS`, alltså ur en DELMÄNGD av vad den här filen läser — 27 av
 * 37 nycklar. Tio stod utanför, och två av dem kan ge FEL och alltså fälla
 * specen hos den som råkar ha dem satta: `SIGNING_PII_KEY_OLD` (satt men inte
 * 64 hex → fel i alla miljöer) och `E2E_RELAX_AUTH_THROTTLE` (`'true'` +
 * `NODE_ENV=production`, vilket specens prod-fixtur sätter).
 *
 * Mängden HÄRLEDS därför här, ur samma strukturer loopen faktiskt går igenom,
 * och specen läser den i stället för att räkna upp en egen. Två uppräkningar
 * som ska vara lika är inte en uppräkning — de glider isär, och det syns inte
 * förrän någon har rätt variabel satt lokalt.
 *
 * VAD DEN INTE KAN SE: att någon läser en variabel ur `config` utan att gå via
 * `CRITICAL`, `OPTIONAL_FORMAT`, `FLAG_CONDITIONAL_VARS`, de två
 * platshållar-arrayerna, `E2E_AUTH_THROTTLE_FLAG` eller `BANKID_PROVIDER_VAR`.
 * Just de sex är uttömmande i dag därför att loopar och namngivna läsningar går
 * genom dem — lägger du till en sjunde läsväg hör den hemma här också, annars
 * öppnas hålet ovan igen. Felriktningen är den milda: en nyckel för MYCKET i
 * mängden gör bara att specen nollställer något ofarligt.
 *
 * (`BANKID_PROVIDER_VAR` var den sjätte, tillagd med mock-vägen i #745 PR 3. Den
 * är ett belägg för att raden ovan behövs: variabeln kan FÄLLA en boot — 'mock'
 * i produktion — och en spec som inte nollställer den blir röd hos den som råkar
 * ha den satt lokalt, med ett meddelande om ett värde testet aldrig valde.)
 */
export const VALIDATED_ENV_VARS: readonly string[] = [
  ...new Set<string>([
    'NODE_ENV',
    ...Object.keys(CRITICAL),
    ...Object.keys(OPTIONAL_FORMAT),
    ...Object.values(FLAG_CONDITIONAL_VARS),
    ...PLACEHOLDER_CHECKED_VARS,
    ...SECRET_FORM_VARS,
    E2E_AUTH_THROTTLE_FLAG,
    BANKID_PROVIDER_VAR,
  ]),
]

function collectFeatureFlagErrors(config: EnvRecord): string[] {
  const errs: string[] = []

  if (String(config[FLAG_CONDITIONAL_VARS.PSD2_ENABLED]) === 'true') {
    const key = config[FLAG_CONDITIONAL_VARS.PSD2_TOKEN_KEY]
    if (typeof key !== 'string' || !hex64.test(key)) {
      errs.push('  • PSD2_ENABLED=true men PSD2_TOKEN_KEY saknas/ogiltig (kräver 64 hex-tecken)')
    }
  }

  // SIGNING_PII_KEY/_PEPPER ligger sedan personnummer-krypteringen ÄVEN i
  // CRITICAL (de behövs för Tenant/Customer oavsett signeringsflaggan). Den här
  // grenen behålls ändå: CRITICAL felar bara i produktion, medan en påslagen
  // SIGNING_ENABLED ska fail-fasta i ALLA miljöer — precis som modul-factoryn.
  if (String(config[FLAG_CONDITIONAL_VARS.SIGNING_ENABLED]) === 'true') {
    const key = config[FLAG_CONDITIONAL_VARS.SIGNING_PII_KEY]
    if (typeof key !== 'string' || !hex64.test(key)) {
      errs.push(
        '  • SIGNING_ENABLED=true men SIGNING_PII_KEY saknas/ogiltig (kräver 64 hex-tecken)',
      )
    }
    const pepper = config[FLAG_CONDITIONAL_VARS.SIGNING_PII_PEPPER]
    if (typeof pepper !== 'string' || pepper.length < 16) {
      errs.push('  • SIGNING_ENABLED=true men SIGNING_PII_PEPPER saknas/för kort (≥16 tecken)')
    }
  }

  // BANKID_ENABLED bär SAMMA krav som SIGNING_ENABLED, och delar nycklarna med
  // flit: identitetsbindningen mot BankID-personnumret går genom blind-indexet
  // (HMAC-SHA256 med SIGNING_PII_PEPPER), alltså exakt den mekanism signeringen
  // redan använder för att binda en part till en `Tenant`-rad. Två pepprar hade
  // gett två index över samma personnummer, och då hade en matchning kunnat
  // lyckas i det ena och missa i det andra.
  //
  // EGEN FLAGGA ÄNDÅ: BankID-INLOGGNING kräver inget signeringsavtal, och
  // signering kräver ingen inloggningsadapter. Att de delar nycklar betyder inte
  // att de ska tändas tillsammans. Grenen är därför en egen och inte ett
  // `||`-tillägg i den ovan — annars hade `SIGNING_ENABLED=true` tyst uppfyllt
  // BankID:s krav, och tvärtom.
  //
  // Villkoret upprepar modul-factoryns `crypto.configured` med flit: den fäller
  // vid DI-bygget, den här vid ConfigModule-valideringen. Den som deployar ska
  // få veta av det FÖRSTA felet, med variabelnamnet i klartext, inte av ett
  // DI-spår.
  if (String(config[FLAG_CONDITIONAL_VARS.BANKID_ENABLED]) === 'true') {
    const key = config[FLAG_CONDITIONAL_VARS.SIGNING_PII_KEY]
    if (typeof key !== 'string' || !hex64.test(key)) {
      errs.push('  • BANKID_ENABLED=true men SIGNING_PII_KEY saknas/ogiltig (kräver 64 hex-tecken)')
    }
    const pepper = config[FLAG_CONDITIONAL_VARS.SIGNING_PII_PEPPER]
    if (typeof pepper !== 'string' || pepper.length < 16) {
      errs.push('  • BANKID_ENABLED=true men SIGNING_PII_PEPPER saknas/för kort (≥16 tecken)')
    }
  }

  // SIGNING_PII_KEY_OLD är VALFRI: den ska bara finnas under en pågående
  // nyckelrotation, och frånvarande är normaltillståndet — ingen varning, inget
  // fel. SATT OCH FELFORMAD är däremot alltid ett fel, och medvetet ett KAST och
  // inte en varning.
  //
  // Skälet är att felet annars är osynligt tills det blir oåterkalleligt.
  // `SigningCryptoService` behandlar en ogiltig _OLD som "ingen fallback", så
  // appen kör vidare som om rotationen vore möjlig: operatören deployar steg 1,
  // ser inget fel, skriver om rader i steg 2 — och upptäcker först i steg 5, när
  // den gamla nyckeln kastats, att fallbacken aldrig fanns. Då är datan förlorad.
  // En varning duger inte: den läses inte i tid av någon.
  //
  // Att kasta flyttar felet till den enda tidpunkt där det är gratis — deploy av
  // steg 1, innan en enda rad skrivits om. Samma kriterium som #466: appen skulle
  // annars KÖRA i ett tillstånd operatören tror är säkert men inte är det.
  const previousKey = config[FLAG_CONDITIONAL_VARS.SIGNING_PII_KEY_OLD]
  if (typeof previousKey === 'string' && previousKey !== '' && !hex64.test(previousKey)) {
    errs.push(
      '  • SIGNING_PII_KEY_OLD är satt men ogiltig (kräver 64 hex-tecken). ' +
        'Den läses som "ingen fallback", så en nyckelrotation skulle se ut att ' +
        'fungera ända tills den gamla nyckeln tas bort. Rätta eller ta bort den.',
    )
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

  // 3. Platshållarvärden: en hemlighet som passerar formkontrollen men är
  //    oförändrad från exempelfilen — eller ser ut som en handskriven
  //    platshållare — är lika illa som en saknad. Prod → error, dev/test →
  //    varning: `.env.example` ÄR platshållare, och en lokal utvecklare ska inte
  //    blockeras av att ha kopierat den. Se env-placeholders.ts för de två
  //    reglerna och varför uppräkningen ensam inte räcker.
  const checked = new Set([...PLACEHOLDER_CHECKED_VARS, ...SECRET_FORM_VARS])
  for (const name of checked) {
    const raw = config[name]
    if (typeof raw !== 'string' || raw.length === 0) continue // saknas → punkt 1
    const why = placeholderRejection(name, raw)
    if (why) (isProd ? errors : warnings).push(`  • ${name} ${why}`)
  }

  // 4. Flagg-villkorade: hård fail-fast i alla miljöer (speglar modul-factoryn).
  errors.push(...collectFeatureFlagErrors(config))

  // 5. E2E-uppmjukad auth-strypning får ALDRIG gälla i produktion. Kontrollen
  //    ligger här för att den ska smälla vid boot, före första requesten —
  //    samma skäl som SIGNING_ENABLED-kontrollen ovan. Guardens konstruktor gör
  //    samma kontroll som andra lager; den här ger det tidigare och tydligare
  //    felet. `authThrottleRelaxed` kastar bara i just den otillåtna
  //    kombinationen, så anropet är en no-op i alla andra lägen.
  try {
    authThrottleRelaxed(config as NodeJS.ProcessEnv)
  } catch (err) {
    errors.push(`  • ${err instanceof Error ? err.message : String(err)}`)
  }

  // 6. BankID:s MOCK-provider får ALDRIG väljas i produktion. Samma form och
  //    samma skäl som punkt 5 — men OBEROENDE av BANKID_ENABLED, med flit: en
  //    produktionsmiljö som bär BANKID_PROVIDER=mock är felkonfigurerad redan
  //    när variabeln sätts, inte först den dag någon tänder flaggan. Att vänta
  //    på flaggan hade lagt upptäckten i den sämsta av stunder.
  //    `bankIdMockRequested` kastar bara i just den otillåtna kombinationen, så
  //    anropet är en no-op i alla andra lägen.
  try {
    bankIdMockRequested(config as NodeJS.ProcessEnv)
  } catch (err) {
    errors.push(`  • ${err instanceof Error ? err.message : String(err)}`)
  }

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
