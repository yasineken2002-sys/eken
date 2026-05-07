/**
 * Normalisera en e-postadress till en kanonisk form: trim:ad och lowercase.
 *
 * E-post är konceptuellt case-insensitive — RFC 5321 säger att domän-delen
 * ALLTID ska tolkas case-insensitivt och i praktiken behandlar samtliga
 * mailservrar även local-part så. Vi följer "stora aktörers" konvention
 * (Google, Microsoft, Apple) och lagrar alltid lowercase. Det:
 *
 *   1. Förhindrar dubletter som "Anna@x.se" + "anna@x.se" som annars
 *      skulle räknas som olika konton i unique-constraints.
 *   2. Gör login case-insensitivt utan att läsförfrågningarna måste
 *      använda Postgres-`mode: 'insensitive'` (som sätter funktionsindex
 *      ur spel och blir sekvensskanning).
 *
 * Använd vid varje plats som SKRIVER e-post till DB, samt som första
 * steg när email kommer in från extern input (DTOs, AI-tools).
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}
