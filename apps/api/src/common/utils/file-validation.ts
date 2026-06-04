import { BadRequestException } from '@nestjs/common'

/**
 * Magic-byte- och storleksvalidering för filuppladdningar (H3, OWASP A04/A08).
 *
 * Den klient-deklarerade Content-Type:n (multipart-partens `mimetype`) går
 * ALDRIG att lita på — en angripare kan döpa om en `.exe`/`.html`/`.svg` till
 * `.pdf` och sätta `mimetype: application/pdf`. Här läser vi de faktiska
 * magiska byten i filhuvudet och validerar mot en allowlist.
 *
 * Vi detekterar enbart det fåtal format som faktiskt laddas upp i Eveno
 * (PDF, bilder, Office, ZIP/OOXML) i stället för att dra in ett tredjeparts-
 * bibliotek — detektionen nedan är liten, deterministisk och utan beroenden.
 */

// ── Storleksgränser (bytes) ──────────────────────────────────────────────────
// Globala Fastify-multipart-taket i main.ts är 20 MB; dessa app-lagergränser
// är striktare per filtyp och hålls konsekventa mellan controller och service.
export const MAX_PDF_BYTES = 20 * 1024 * 1024 // PDF: 20 MB
export const MAX_CSV_BYTES = 10 * 1024 * 1024 // CSV/Excel/BgMax: 10 MB
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024 // Dokumentarkiv: 20 MB
export const MAX_CONTRACT_BYTES = 10 * 1024 * 1024 // Hyreskontrakt (PDF/bild): 10 MB

// ── Detekterade MIME-typer (faktiskt innehåll, inte deklarerat) ──────────────
export const DETECTED_PDF_TYPES = ['application/pdf'] as const

// Kontraktsskanning tar både PDF och bild (foto av kontrakt). Samma binär-
// format som ContractScannerService skickar till vision-modellen.
export const DETECTED_CONTRACT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const

// Dokumentarkivet: bilder + PDF + Office. Gamla Office (.doc/.xls) detekteras
// som CFB (OLE Compound File); nya (.docx/.xlsx) som ZIP/OOXML-container.
export const DETECTED_DOCUMENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/zip',
  'application/x-cfb',
] as const

// Excel-import (.xlsx = ZIP, .xls = CFB). Ren CSV är text utan signatur och
// tillåts via allowTextWithoutSignature i anropet.
export const DETECTED_SPREADSHEET_TYPES = ['application/zip', 'application/x-cfb'] as const

/**
 * Läs de magiska byten i filhuvudet och returnera en kanonisk MIME-typ, eller
 * `null` om signaturen inte känns igen (t.ex. rena textfiler som CSV/BgMax).
 */
export function detectMimeFromMagicBytes(buf: Buffer): string | null {
  if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return 'application/pdf' // "%PDF"
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg'
  }
  // WEBP: "RIFF"...."WEBP"
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp'
  }
  // ZIP / OOXML (.docx/.xlsx/.pptx är zip-containrar): "PK" + (03 04 | 05 06 | 07 08)
  if (
    buf.length >= 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07) &&
    (buf[3] === 0x04 || buf[3] === 0x06 || buf[3] === 0x08)
  ) {
    return 'application/zip'
  }
  // CFB / OLE2 (legacy .doc/.xls): D0 CF 11 E0 A1 B1 1A E1
  if (
    buf.length >= 8 &&
    buf[0] === 0xd0 &&
    buf[1] === 0xcf &&
    buf[2] === 0x11 &&
    buf[3] === 0xe0 &&
    buf[4] === 0xa1 &&
    buf[5] === 0xb1 &&
    buf[6] === 0x1a &&
    buf[7] === 0xe1
  ) {
    return 'application/x-cfb'
  }
  return null
}

export interface MagicByteValidationOptions {
  /** Tillåtna *detekterade* MIME-typer (binärformat). */
  allowedDetectedMimes: readonly string[]
  /** Övre storleksgräns i bytes. */
  maxBytes: number
  /**
   * Tillåt en fil utan känd binär signatur (detektion → null). Sätt `true`
   * för rena textformat (CSV, BgMax-`.txt`) som saknar magiska byten. Default
   * `false` — en okänd/saknad signatur avvisas (skydd för binära format).
   */
  allowTextWithoutSignature?: boolean
}

/**
 * Validera en uppladdad fil mot dess faktiska innehåll (magiska byten) och
 * storlek. Kastar `BadRequestException` vid avvikelse.
 *
 * Returnerar den *detekterade* (kanoniska) MIME-typen så att anroparen kan
 * använda den i stället för den opålitliga klient-deklarerade Content-Type:n —
 * utan att behöva köra `detectMimeFromMagicBytes` en andra gång. Returnerar
 * `null` endast för tillåten textfil utan binär signatur
 * (`allowTextWithoutSignature: true`).
 */
export function validateUploadedFile(
  buffer: Buffer,
  opts: MagicByteValidationOptions,
): string | null {
  if (buffer.length === 0) {
    throw new BadRequestException('Filen är tom')
  }
  if (buffer.length > opts.maxBytes) {
    const mb = (opts.maxBytes / 1024 / 1024).toFixed(0)
    throw new BadRequestException(`Filen är för stor (max ${mb} MB)`)
  }

  const detected = detectMimeFromMagicBytes(buffer)

  if (detected === null) {
    if (opts.allowTextWithoutSignature) return null
    throw new BadRequestException(
      'Filinnehållet kunde inte verifieras — filen är skadad eller har fel format',
    )
  }

  if (!opts.allowedDetectedMimes.includes(detected)) {
    throw new BadRequestException(`Filinnehållet (${detected}) matchar inte en tillåten filtyp`)
  }

  return detected
}
