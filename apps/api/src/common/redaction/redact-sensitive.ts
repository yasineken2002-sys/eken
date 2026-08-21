import { Prisma } from '@prisma/client'

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
