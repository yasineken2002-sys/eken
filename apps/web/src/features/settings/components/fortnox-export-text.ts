import { arBelagdInnehallsavvisning } from '@eken/shared'
import type { FortnoxExportRow } from '../api/fortnox-export.api'

/** Kundens text för varje exportläge. READY är ALDRIG "skickat" eller "bokfört". */
export const EXPORT_STATE_TEXT: Record<FortnoxExportRow['state'], string> = {
  DRY_RUN_READY: 'Förhandskontrollen godkänd – utkastet är INTE skickat eller bokfört i Fortnox.',
  BLOCKED: 'Spärrad – verifikatet kan inte exporteras som det ser ut nu.',
  SENDING: 'Skickas just nu. Vänta på utfallet.',
  UNKNOWN: 'Okänt utfall – kräver manuell avstämning. Ingen ny kontroll eller sändning görs.',
  REJECTED:
    'Fortnox avvisade verifikatet. Det kan ändå inte skickas om automatiskt – stäm av i Fortnox.',
  RECEIPT_IDENTIFIED:
    'Fortnox svarade med ett verifikatnummer. Posten är ännu inte kontrollerad mot underlaget.',
  RECEIPT_MISMATCH: 'Posten i Fortnox stämmer inte med underlaget – kräver manuell avstämning.',
  CONFIRMED: 'Bekräftad i Fortnox. Posten rörs inte.',
}

/** Nästa tillåtna handling, i klartext. */
export const EXPORT_NEXT_STEP: Partial<Record<FortnoxExportRow['state'], string>> = {
  UNKNOWN:
    'Låt Eveno söka efter verifikatet i Fortnox, eller leta upp det själv och ange dess år-id, serie och nummer nedan.',
  REJECTED:
    'Kontrollera i Fortnox att verifikatet inte finns, eller ange dess identitet om det finns.',
  RECEIPT_MISMATCH:
    'Granska posten i Fortnox och ange identiteten för den post som motsvarar underlaget.',
  RECEIPT_IDENTIFIED: 'Kontrollera posten i Fortnox för att bekräfta den.',
}

/** TESTKUND-035: varför utfallet är okänt, när orsaken är känd. */
export function unknownReasonText(lastOutcome: string | null | undefined): string | null {
  if (lastOutcome === 'UNKNOWN_429')
    return 'Fortnox svarade 429 (för många anrop) när verifikatet skickades. Det går inte att veta om Fortnox ändå skapade posten, så Eveno skickar inte om det.'
  return null
}

/** TESTKUND-035: sökningen hittade ingen post. Det är inte ett bevis för att posten saknas. */
export function scanAbsentText(r: {
  at: string
  financialYear: number
  verifikatLasta: number
}): string {
  const tid = new Date(r.at).toLocaleString('sv-SE')
  return `Ingen post från det här verifikatet hittades i Fortnox (räkenskapsår-id ${r.financialYear}, alla serier, ${r.verifikatLasta} verifikat lästa ${tid}). Utfallet är fortfarande okänt – det bevisar inte att posten saknas. Sök igen senare eller ange postens identitet nedan om du hittar den. Bokför inte verifikatet för hand i Fortnox; det kan ge dubbel bokföring.`
}

/**
 * TESTKUND-016/020: avvisningens art ur lastOutcome. Bara ett BELAGT (status, kod)-par
 * (FORTNOX_BELAGDA_INNEHALLSAVVISNINGAR, i dag 400/2000359) är en innehållsavvisning som kan
 * frisläppas här; övriga stäms av eller kräver ett eget beslut.
 */
export type RejectionKind =
  | { kind: 'CONTENT'; http: number; code: number }
  | { kind: 'RATE_LIMIT' | 'LEGACY' }
  | { kind: 'NOT_PROVEN'; http: number | null; code: number | null }

export function rejectionKind(lastOutcome: string | null | undefined): RejectionKind {
  const m = /^REJECTED_(\d{3}|NA)_(\d+|NA)$/.exec(lastOutcome ?? '')
  if (!m) return { kind: 'LEGACY' }
  if (m[1] === '429') return { kind: 'RATE_LIMIT' }
  const http = m[1] === 'NA' ? null : Number(m[1])
  const code = m[2] === 'NA' ? null : Number(m[2])
  if (http !== null && code !== null && arBelagdInnehallsavvisning(http, code))
    return { kind: 'CONTENT', http, code }
  return { kind: 'NOT_PROVEN', http, code }
}

export function rejectionText(r: RejectionKind): string {
  if (r.kind === 'RATE_LIMIT')
    return 'Fortnox svarade 429 (för många anrop). Det är ingen innehållsavvisning och kan inte frisläppas här.'
  if (r.kind === 'LEGACY')
    return 'Äldre avvisning utan sparad Fortnox-kod. Ägaren kan frisläppa den bara med ett granskat externt kvitto som visar HTTP 400 med Fortnox-kod 2000359.'
  if (r.kind === 'NOT_PROVEN')
    return `Avvisningen är inte en belagd innehållsavvisning (http ${r.http ?? 'okänd'}, kod ${r.code ?? 'okänd'}). Stäm av med Fortnox eller Fortnox support; den kan inte frisläppas här.`
  return ''
}
