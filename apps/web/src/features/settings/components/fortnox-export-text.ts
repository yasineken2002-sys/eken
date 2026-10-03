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
