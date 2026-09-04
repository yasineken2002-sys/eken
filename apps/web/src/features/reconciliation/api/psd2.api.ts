import { del, get, post } from '@/lib/api'

/**
 * BANKKOPPLING (PSD2) — webbens sida av `/v1/reconciliation/psd2`.
 *
 * ── VAD SOM ALDRIG FÅR KOMMA HIT ────────────────────────────────────────────
 *
 * `BankConsent` bär `accessTokenEnc`, `refreshTokenEnc`, `scope` och
 * `syncCursor`. Backend har en allow-list — `SAFE_BANK_CONSENT_SELECT` i
 * `psd2-consent.service.ts` — och de fyra står MEDVETET utanför den. Typen nedan
 * speglar allow-listen fält för fält, så en framtida utvidgning av backend-
 * selecten inte tyst blir synlig i UI:t bara för att den råkar komma med i
 * svaret.
 *
 * Typen ensam är förstås inget skydd i runtime — TypeScript raderas. Skyddet är
 * att `consentDisplayFields` nedan är den ENDA vägen från ett samtycke till
 * något som renderas, och att `psd2.spec.ts` matar in ett objekt med extra fält
 * och kräver att de inte kommer ut.
 */
export const SAFE_BANK_CONSENT_FIELDS = [
  'id',
  'provider',
  'status',
  'expiresAt',
  'lastSyncedAt',
  'revokedAt',
  'createdAt',
] as const

export type BankConsentStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'ERROR'

export interface BankConsent {
  id: string
  provider: string
  status: BankConsentStatus
  expiresAt: string | null
  lastSyncedAt: string | null
  revokedAt: string | null
  createdAt: string
}

export interface BeginConsentResult {
  authUrl: string
}

export interface SyncEnqueuedResult {
  enqueued: boolean
  jobId: string
}

// ─── Anrop ────────────────────────────────────────────────────────────────────

export function getBankConsents(): Promise<BankConsent[]> {
  return get<BankConsent[]>('/reconciliation/psd2/consents')
}

export function beginBankConsent(): Promise<BeginConsentResult> {
  return post<BeginConsentResult>('/reconciliation/psd2/consents')
}

export function revokeBankConsent(id: string): Promise<void> {
  return del(`/reconciliation/psd2/consents/${id}`)
}

export function enqueueBankSync(): Promise<SyncEnqueuedResult> {
  return post<SyncEnqueuedResult>('/reconciliation/psd2/sync')
}

// ─── Rena funktioner (allt som går att pröva utan DOM) ────────────────────────

/**
 * Kvittensen efter bankens SCA. Backend redirectar till
 * `PSD2_APP_RETURN_URL?psd2=ok|error` (`appReturnUrl` i psd2-consent.service.ts).
 *
 * OKÄNT VÄRDE BLIR `null`, INTE `error`. Skillnaden är inte kosmetisk: `null`
 * betyder "ingen bank har skickat tillbaka någon", och den som öppnar
 * /reconciliation/settings från menyn ska inte mötas av ett felmeddelande om ett
 * samtycke hen aldrig startade. Att tolka allt okänt som fel hade gjort en
 * bokmärkt URL till ett larm.
 */
export type Psd2Kvittens = 'ok' | 'error' | null

export function tolkaPsd2Kvittens(raw: unknown): Psd2Kvittens {
  if (raw === 'ok') return 'ok'
  if (raw === 'error') return 'error'
  return null
}

/**
 * De fält som får visas för ett samtycke, i visningsordning. ENDA vägen från ett
 * `BankConsent` till något som renderas.
 *
 * VARFÖR EN FUNKTION OCH INTE JSX SOM LÄSER OBJEKTET DIREKT: webs vitest kör med
 * `environment: 'node'` och renderar ingenting (se apps/web/vitest.config.ts).
 * Ett prov på "listan visar aldrig ett token" måste därför ställas mot en ren
 * funktion. Att lägga uppackningen här i stället för i komponenten gör frågan
 * prövbar — och den kostar en indirektion, som är hela priset.
 *
 * VAD PROVET PÅ DEN HÄR FUNKTIONEN INTE KAN SE: att `BankConsentRow` faktiskt
 * går genom den. Går någon förbi och läser `consent.scope` direkt i JSX är
 * funktionen fortfarande korrekt och provet fortfarande grönt. Det bärs av att
 * raden tar `ConsentVisning` — INTE ett `BankConsent` — som prop, så det finns
 * inget objekt att gå förbi till.
 */
export interface ConsentVisning {
  id: string
  provider: string
  status: BankConsentStatus
  rader: Array<{ etikett: string; varde: string }>
}

function datum(raw: string | null): string | null {
  if (!raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('sv-SE')
}

export function consentDisplayFields(consent: BankConsent): ConsentVisning {
  const rader: Array<{ etikett: string; varde: string }> = []
  const anslutet = datum(consent.createdAt)
  if (anslutet) rader.push({ etikett: 'Ansluten', varde: anslutet })
  const giltigt = datum(consent.expiresAt)
  // "Giltigt t.o.m." är den enda datering som kräver en handling av hyresvärden
  // (PSD2 tvingar omcertifiering ~var 90:e dag), så den står med även när den
  // saknas — en tom rad säger "banken har inte angett något", vilket är ett
  // annat besked än att raden inte finns.
  rader.push({ etikett: 'Giltigt t.o.m.', varde: giltigt ?? 'Okänt' })
  const synkad = datum(consent.lastSyncedAt)
  rader.push({ etikett: 'Senast synkad', varde: synkad ?? 'Aldrig' })
  const aterkallat = datum(consent.revokedAt)
  if (aterkallat) rader.push({ etikett: 'Återkallad', varde: aterkallat })

  return {
    id: consent.id,
    provider: consent.provider,
    status: consent.status,
    rader,
  }
}

/** Antalet samtycken som faktiskt kan mata avstämningen just nu. */
export function aktivaSamtycken(consents: readonly BankConsent[]): number {
  return consents.filter((c) => c.status === 'ACTIVE').length
}
