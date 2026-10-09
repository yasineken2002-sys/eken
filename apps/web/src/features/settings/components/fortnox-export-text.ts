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
  UNKNOWN: 'Leta upp verifikatet i Fortnox och ange dess år-id, serie och nummer nedan.',
  REJECTED:
    'Kontrollera i Fortnox att verifikatet inte finns, eller ange dess identitet om det finns.',
  RECEIPT_MISMATCH:
    'Granska posten i Fortnox och ange identiteten för den post som motsvarar underlaget.',
  RECEIPT_IDENTIFIED: 'Kontrollera posten i Fortnox för att bekräfta den.',
}

/**
 * TESTKUND-016: avvisningens art ur lastOutcome. Bara en innehållsavvisning med Fortnox-kod
 * (4xx utom 429) kan frisläppas här; övriga stäms av eller kräver ett eget beslut.
 */
export function rejectionKind(
  lastOutcome: string | null | undefined,
): { kind: 'CONTENT'; http: number; code: number } | { kind: 'RATE_LIMIT' | 'NO_CODE' | 'LEGACY' } {
  const m = /^REJECTED_(\d{3}|NA)_(\d+|NA)$/.exec(lastOutcome ?? '')
  if (!m) return { kind: 'LEGACY' }
  if (m[1] === '429') return { kind: 'RATE_LIMIT' }
  const http = m[1] === 'NA' ? NaN : Number(m[1])
  if (!(http >= 400 && http <= 499) || http === 408 || m[2] === 'NA') return { kind: 'NO_CODE' }
  return { kind: 'CONTENT', http, code: Number(m[2]) }
}

export const REJECTION_TEXT = {
  RATE_LIMIT:
    'Fortnox svarade 429 (för många anrop). Det är ingen innehållsavvisning och kan inte frisläppas här.',
  NO_CODE: 'Fortnox avvisade utan felkod. Ingen innehållsavvisning är belagd – stäm av i Fortnox.',
  LEGACY:
    'Äldre avvisning utan sparad Fortnox-kod. Ägaren kan frisläppa den med ett granskat externt avvisningskvitto.',
} as const
