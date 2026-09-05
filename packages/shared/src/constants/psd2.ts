/**
 * BANKKOPPLINGENS (PSD2) SÄKRA FÄLTMÄNGD — EN LISTA, INTE TVÅ.
 *
 * ── VARFÖR DEN FLYTTADES HIT ────────────────────────────────────────────────
 *
 * Mängden fanns i två kopior: `SAFE_BANK_CONSENT_SELECT` i
 * `apps/api/src/psd2/psd2-consent.service.ts` (det som FAKTISKT avgör vad som
 * lämnar servern) och `SAFE_BANK_CONSENT_FIELDS` i
 * `apps/web/src/features/reconciliation/api/psd2.api.ts` (en spegling som gjorde
 * avsikten läsbar). Webbens egen spec skrev ut problemet i klartext:
 *
 *     "Att SAFE_BANK_CONSENT_FIELDS här och SAFE_BANK_CONSENT_SELECT i backend
 *      är samma mängd. De är två uppräkningar i två paket, och ingen vakt binder
 *      ihop dem i dag."
 *
 * Två uppräkningar som ska vara lika är inte en uppräkning. Nu härleder båda
 * sidor ur den här listan, och stycket ovan är struket ur specen.
 *
 * ── VAD SOM STÅR UTANFÖR, OCH VARFÖR ────────────────────────────────────────
 *
 * `BankConsent` bär `accessTokenEnc`, `refreshTokenEnc`, `scope`, `syncCursor`,
 * `consentId`, `organizationId` och `createdByUserId`. Inget av dem får nå
 * frontend eller AI. Tokens är uppenbara; de tre andra mindre:
 *
 *   • `scope` säger vad vi har rätt att hämta hos banken — en uppgift om vår
 *     integration, inte om hyresvärdens ekonomi.
 *   • `syncCursor` är aggregatorns opaka markör och kan bära bankinternt id.
 *   • `consentId` är bankens handtag för samtycket, alltså det som tillsammans
 *     med en token skulle räcka för att agera i kundens namn.
 *
 * ── VAD DEN HÄR LISTAN INTE KAN GÖRA ────────────────────────────────────────
 *
 * Den kan inte hindra att någon lägger en ny kolumn på `BankConsent` och glömmer
 * bestämma vilken sida av gränsen den hör till. Det ägs av partitionsprovet i
 * `psd2-consent-leak.spec.ts`, som läser modellens FAKTISKA kolumner ur Prismas
 * DMMF och kräver att varje kolumn står i exakt en av två mängder. En ny kolumn
 * blir röd där, inte här.
 */

/** De ENDA `BankConsent`-fält som får lämna backend, i visningsordning. */
export const SAFE_BANK_CONSENT_FIELDS = [
  'id',
  'provider',
  'status',
  'expiresAt',
  'lastSyncedAt',
  'revokedAt',
  'createdAt',
] as const

export type SafeBankConsentField = (typeof SAFE_BANK_CONSENT_FIELDS)[number]

/**
 * Kolumner som MEDVETET står utanför den säkra mängden. Listan är inte dekoration:
 * partitionsprovet kräver att varje kolumn på modellen står i exakt en av de två,
 * så en ny kolumn måste klassas — den kan inte tyst hamna mellan dem.
 */
export const UNSAFE_BANK_CONSENT_FIELDS = [
  // Hemliga: skulle tillsammans räcka för att agera i kundens namn hos banken.
  'accessTokenEnc',
  'refreshTokenEnc',
  'consentId',
  // Integrationsinterna: säger något om VÅR koppling, inte om hyresvärdens ekonomi.
  'scope',
  'syncCursor',
  // Interna nycklar: multi-tenant-scoping respektive vem som startade samtycket.
  // Org-id:t kommer redan ur JWT:n hos mottagaren; att eka tillbaka det är att
  // skriva ut en identifierare klienten inte behöver.
  'organizationId',
  'createdByUserId',
  // INTE hemlig — men inte heller vald. `updatedAt` säger när raden RÖRDES, vilket
  // inte är samma sak som något hyresvärden kan handla på; `lastSyncedAt` är det
  // datum som betyder något och står i den säkra mängden. Den ligger här för att
  // partitionen ska vara total: en kolumn utan klassning är precis det hålet
  // provet finns för att stänga.
  'updatedAt',
] as const

export type UnsafeBankConsentField = (typeof UNSAFE_BANK_CONSENT_FIELDS)[number]
