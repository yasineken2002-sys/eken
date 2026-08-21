// redact-copy-allow: TENANT_CREDENTIAL_KEYS är portalens autentiseringskolumner
// (activationTokenHash, passwordResetTokenHash m.fl.) med en egen fullständighets-
// spec mot schema.prisma. Överlappar redact-sensitive på fyra namn, men är en annan
// lista för ett annat ändamål — och redan enda källan för sitt.
/**
 * TENANT-KOLUMNER SOM ALDRIG FÅR SERIALISERAS — EN LISTA, INTE TVÅ.
 *
 * Kolumnerna finns i DB för portalens autentisering och för
 * personnummerhanteringen, men får aldrig nå ett svar. Två funktioner strippar
 * dem: `mapTenant` (hyresvärds-API:t) och `stripTenantCredentials`
 * (portalsessionen).
 *
 * ── Varför listan flyttades hit ──────────────────────────────────────────────
 *
 * Den fanns i TVÅ kopior — `tenants.service.ts` och `tenant-auth.service.ts` —
 * med kommentaren "Speglar TENANT_CREDENTIAL_KEYS i tenants.service.ts" i den
 * andra. Den speglade inte längre: portalkopian saknade `personalNumberEnc` och
 * `personalNumberHash`, som lades till i tenants-kopian när personnumret
 * krypterades (#255/#284) utan att portalkopian följde med.
 *
 * Följden var inte en läcka men en LATENT sådan. `createSession` bygger sitt
 * svar från en läsning med bar `include` — alltså alla skalärer, inklusive båda
 * personnummerkolumnerna — och strippade fem av sju. Att det inte syntes berodde
 * på att alla tre anropsställena råkade gå genom `tenantSummary`, en allow-list
 * med fem fält. En ofullständig blocklist maskerad av en allow-list längre ned.
 *
 * `personalNumberHash` är ett deterministiskt HMAC blind-index: den som har
 * hashen kan verifiera en GISSNING genom att hasha ett misstänkt personnummer
 * och jämföra. Svagare än klartext, inte ingenting.
 *
 * ── Vad den här filen INTE löser ────────────────────────────────────────────
 *
 * Att listan är FULLSTÄNDIG bevakas av tenant-credential-keys.spec.ts, som
 * partitionerar Tenant-modellen mot schema.prisma. Att den TILLÄMPAS gör den
 * inte — en komplett lista som en väg går runt är fortfarande en läcka, och det
 * är precis B1-misstaget som `stripTenantCredentials` docstring själv anger som
 * skälet den funktionen finns. Den halvan bärs av typspärren, se #445.
 */
export const TENANT_CREDENTIAL_KEYS = [
  // Portalens autentisering
  'passwordHash',
  'activationTokenHash',
  'activationTokenExpiresAt',
  'passwordResetTokenHash',
  'passwordResetTokenExpiresAt',
  // Personnummer: chiffertext och blind-index. Klartexten läggs tillbaka som
  // `personalNumber` av den som faktiskt ska visa den, via
  // PersonalNumberService.reveal() — aldrig genom att kolumnen slinker med.
  'personalNumberEnc',
  'personalNumberHash',
] as const

export type TenantCredentialKey = (typeof TENANT_CREDENTIAL_KEYS)[number]

/**
 * Tar bort credential-kolumnerna ur ett tenant-objekt.
 *
 * Delad av båda strippningsvägarna, så att en kolumn som läggs till i listan
 * ovan omedelbart gäller på båda. Muterar inte indata.
 */
export function stripTenantCredentialKeys<T extends Record<string, unknown>>(tenant: T): T {
  const kopia = { ...tenant }
  for (const key of TENANT_CREDENTIAL_KEYS) {
    delete (kopia as Record<string, unknown>)[key]
  }
  return kopia
}
