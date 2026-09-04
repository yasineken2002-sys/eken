import { Prisma } from '@prisma/client'
import { isValidOcrNumber } from '@eken/shared'

/**
 * MASKERINGSLAGRET — EN kopia, för alla vägar (#545).
 *
 * Låg tidigare i två exemplar: `ai/tools/tool-executor.service.ts` (ägar-AI) och
 * `ai/tools/tenant-tool-executor.service.ts` (hyresgäst-AI). Fältlistorna var
 * identiska, men funktionerna var det inte — och skillnaden var inte ett val.
 *
 * `Prisma.Decimal`-grenen lades till i **#168** (main `9f61bf1`) för att
 * `redactSensitive` annars rekurserade IN i Decimalens interna
 * `{s,e,d}`-representation och matade modellen decimal.js-internaler i stället
 * för belopp. Den rättelsen nådde bara ägar-kopian. Hyresgäst-kopian stod kvar
 * utan den i sju månader, och ingenting i kodbasen kunde se det.
 *
 * Det är hela skälet till att en maskeringsregel inte får finnas i två exemplar:
 * den dag ett mönster läggs till i den ena tror alla att det gäller överallt, och
 * den yta som glömdes läcker tyst.
 *
 * ── Vad lagret gör ──────────────────────────────────────────────────────────
 *
 * Två saker, båda defense-in-depth:
 *
 * 1. **Tar bort kända farliga fältnamn** ur allt som returneras. Tool-svaren
 *    whitelistar redan sina fält; det här fångar den dag en författare glömmer.
 * 2. **Normaliserar `Prisma.Decimal` till `number`.** Utan den grenen blir ett
 *    belopp som slinker igenom till `{s,e,d}` — en tyst hallucinationskälla för
 *    ett bokförings-AI, eftersom objektet SER strukturerat ut.
 *
 * ── Vad lagret INTE gör ─────────────────────────────────────────────────────
 *
 * Det maskerar inte fritext. Personnummer, adresser och namn som står i en
 * MENING passerar orörda — lagret arbetar på fältnamn, inte på innehåll. Den
 * frågan hör till #507 (maskering vid visning och export), som ska bygga på det
 * HÄR lagret i stället för att välja mellan två.
 *
 * ── Om du lägger till ett fältnamn ──────────────────────────────────────────
 *
 * Lägg det i `SENSITIVE_FIELD_NAMES` nedan. Skapa ALDRIG en andra kopia av
 * funktionen eller listan någon annanstans — `check-redact-copies.mjs` fäller på
 * det, och den finns just för att den här filen ska förbli den enda.
 */

/**
 * Fältnamn som aldrig får lämna systemet i ett AI-svar.
 *
 * Listan är oförändrad från de två kopiorna — de var redan identiska, mätt
 * fält för fält.
 */
export const SENSITIVE_FIELD_NAMES: ReadonlySet<string> = new Set([
  'personalNumber',
  'personalNumberEnc',
  'personalNumberHash',
  'passwordHash',
  'activationToken',
  'activationTokenExpiresAt',
  'sessionToken',
  'refreshToken',
  'magicLinkToken',
  'token', // PasswordResetToken / TenantSession / etc.
  'apiKey',
])

export function redactSensitive<T>(value: T, depth = 0): T {
  if (depth > 12) return value
  if (value === null || value === undefined) return value
  // Prisma Decimal är ett objekt — utan denna vakt rekurserar vi in i dess interna
  // {s,e,d}-representation och matar AI:n decimal.js-internaler i stället för belopp
  // (tyst hallucinationskälla för ett bokförings-AI). Konvertera till number, samma
  // som get_bank_transactions redan gör med Number(t.amount). Se #168.
  if (value instanceof Prisma.Decimal) return value.toNumber() as unknown as T
  if (Array.isArray(value)) {
    return value.map((v) => redactSensitive(v, depth + 1)) as unknown as T
  }
  if (typeof value === 'object' && !(value instanceof Date) && !(value instanceof Buffer)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_FIELD_NAMES.has(k)) continue
      out[k] = redactSensitive(v, depth + 1)
    }
    return out as unknown as T
  }
  return value
}

// ─── FRITEXT ────────────────────────────────────────────────────────────────
//
// Lagret ovan arbetar på FÄLTNAMN. Det som följer arbetar på INNEHÅLL, och det
// är en annan fråga: ett personnummer i ett felmeddelande har inget fältnamn att
// stryka. Båda bor i den här filen av samma skäl som fältlistan gör det — den
// dag ett mönster läggs till ska det gälla överallt, och en andra kopia gör att
// den yta som glömdes läcker tyst (#545).
//
// FÖRSTA ANROPAREN är Sentry-skrubbningen i `instrument.ts`: ett `beforeSend`
// som filtrerade brus men inte personuppgifter, så ett fel i en väg som hanterar
// en hyresgäst kunde bära namn, e-post eller personnummer till en extern tjänst.
//
// ÖVERMASKERING ÄR RÄTT RIKTNING HÄR. Ett maskerat felmeddelande är obekvämt att
// felsöka; ett omaskerat är en personuppgiftsincident. Där reglerna nedan är
// trubbiga lutar de åt att maskera för mycket.

/** Vad varje mönster ersätts med. Etiketten säger VAD som togs bort, aldrig värdet. */
const MASK = {
  epost: '[e-post]',
  personnummer: '[personnummer]',
  ocr: '[ocr]',
} as const

/**
 * E-postadress. Avsiktligt tolerant: hellre en träff för mycket än en läckt
 * adress. Kräver `@` och en punkt i domändelen.
 */
const EPOST = /[^\s<>()[\]{},;:"']+@[^\s<>()[\]{},;:"']+\.[\p{L}]{2,}/gu

/**
 * Svenskt personnummer/samordningsnummer: 10 eller 12 siffror, med valfri
 * avgränsare (`-` eller `+`) före de fyra sista. Gränserna är LOOKAROUND mot
 * siffra, inte `\b` — en ordgräns hade träffat mitt i en längre siffersekvens
 * och maskerat tio av tjugo siffror, vilket ser ut som en maskering men lämnar
 * resten.
 */
const PERSONNUMMER = /(?<!\d)(\d{8}|\d{6})[-+]?(\d{4})(?!\d)/g

/**
 * OCR-nummer. Siffersekvenser av OCR-längd som FAKTISKT passerar Luhn — inte
 * varje lång siffersekvens.
 *
 * Skälet är precision: ett belopp i ören, ett tidsstämpel-millisekundtal och ett
 * fakturanummer är också långa siffersekvenser, och att maskera dem hade gjort
 * felmeddelanden obrukbara utan att skydda något. Luhn-kontrollen är samma
 * funktion som genererar numren (`@eken/shared`), inte en egen tolkning av
 * formen.
 */
const SIFFERSEKVENS = /(?<!\d)\d{8,25}(?!\d)/g

/**
 * Maskerar personuppgifter i fritext.
 *
 * ORDNINGEN BÄR: personnummer före den generiska siffersekvensen, annars
 * etiketteras ett personnummer som `[ocr]` — samma maskering men fel besked till
 * den som läser felet.
 */
export function maskSensitiveText(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text
  let ut = text.replace(EPOST, MASK.epost)
  ut = ut.replace(PERSONNUMMER, MASK.personnummer)
  ut = ut.replace(SIFFERSEKVENS, (m) => (isValidOcrNumber(m) ? MASK.ocr : m))
  return ut
}

/**
 * HTTP-huvuden som aldrig får följa med ut. Egen lista och inte
 * `SENSITIVE_FIELD_NAMES`, därför att de svarar på olika frågor: fältlistan
 * gäller domänobjekt som returneras, den här gäller transporten. Att låna den
 * ena för den andra vore samma fel som #680.
 */
export const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'proxy-authorization',
])

/**
 * Fältnamnsstrykning OCH fritextmaskering i ett svep, för godtyckligt djupa
 * strukturer. Det är den form en Sentry-payload har: objekt med strängar i.
 */
export function deepScrub<T>(value: T, depth = 0): T {
  if (depth > 12) return value
  if (typeof value === 'string') return maskSensitiveText(value) as unknown as T
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((v) => deepScrub(v, depth + 1)) as unknown as T
  if (typeof value === 'object' && !(value instanceof Date) && !(value instanceof Buffer)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_FIELD_NAMES.has(k)) continue
      if (SENSITIVE_HEADER_NAMES.has(k.toLowerCase())) continue
      out[k] = deepScrub(v, depth + 1)
    }
    return out as unknown as T
  }
  return value
}
