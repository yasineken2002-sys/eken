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

// AI-chattens bilagor. Två tak, för de har OLIKA orsaker:
//  • Bild 5 MB — Anthropics API avvisar en enskild bild över 5 MB. Ett högre
//    tak här hade bara flyttat felet till modellanropet, efter uppladdningen.
//  • PDF 20 MB — samma tak som dokumentarkivet och Fastifys multipart-gräns.
//    Anthropics 32 MB gäller HELA requesten (alla bilagor + historiken), och
//    är därför inte ett per-fil-tak; det taket hör till B2/B3.
export const MAX_AI_IMAGE_BYTES = 5 * 1024 * 1024
// Anthropic tar emot max 600 sidor per PDF. Räknas vid uppladdning
// (`countPdfPages`) så att en för lång fil avvisas när användaren väljer den —
// inte vid modellanropet, efter uppladdning och betald överföring.
export const MAX_AI_PDF_PAGES = 600
// Felanmälans/portalens bilder (befintligt tak, flyttat hit så alla tak bor
// på ett ställe) och besiktningsbilder (SAKNADE ett tak helt — 10 bilder ×
// Fastifys 20 MB var 200 MB per analys).
export const MAX_TICKET_IMAGE_BYTES = 15 * 1024 * 1024
export const MAX_INSPECTION_IMAGE_BYTES = 15 * 1024 * 1024
export const MAX_LOGO_BYTES = 2 * 1024 * 1024
export const MAX_AI_ATTACHMENT_BYTES = 20 * 1024 * 1024

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

// AI-chattens bilagor. MEDVETET SMALARE än dokumentarkivet: bara det Anthropics
// API faktiskt kan läsa som `document`- eller `image`-block. Office-filer och
// ZIP finns inte med — de skulle laddas upp, lagras och sedan visa sig omöjliga
// att skicka till modellen. Hellre ett tydligt fel vid uppladdningen.
export const DETECTED_AI_CHAT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const

// Felanmälan + hyresgästportalens bilder. HEIC/HEIF ingår för att portalen
// använder `accept="image/*"` och en iPhone levererar HEIC som standard — att
// avvisa dem hade brutit den vanligaste vägen in för en hyresgäst.
export const DETECTED_TICKET_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const

// Besiktningsbilder och organisationens logotyp: bara det som säkert går att
// visa och (för besiktningar) skicka till vision-modellen. HEIC ingår INTE —
// varken webbläsare eller vision-modellen läser den, och operatörens
// filväljare erbjuder den inte.
export const DETECTED_WEB_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

// Excel-import (.xlsx = ZIP, .xls = CFB). Ren CSV är text utan signatur och
// tillåts via allowTextWithoutSignature i anropet.
export const DETECTED_SPREADSHEET_TYPES = ['application/zip', 'application/x-cfb'] as const

// ISO-BMFF-varumärken. `heic`/`heix` är HEVC-kodad HEIF (vad en iPhone
// skriver); `mif1`/`msf1` är den generiska HEIF-containern. Listorna är
// avsiktligt SLUTNA — allt annat med "ftyp" (video) faller igenom som okänt.
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs'])
const HEIF_BRANDS = new Set(['mif1', 'msf1'])

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
  // HEIC/HEIF (iPhone-foton): ISO-BMFF med "ftyp" på offset 4 och varumärket på
  // offset 8. Varumärket måste matchas mot en LISTA — samma containerformat
  // används av MP4/MOV (brands "isom", "mp42", "qt  "), så en bredare match
  // hade släppt igenom videofiler som "bild".
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12)
    if (HEIC_BRANDS.has(brand)) return 'image/heic'
    if (HEIF_BRANDS.has(brand)) return 'image/heif'
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

/**
 * Filändelse per DETEKTERAD MIME-typ.
 *
 * Finns för att INGEN uppladdningsväg ska härleda sin lagringsnyckel ur
 * klientens filnamn. Gör man det får en fil som klienten döpte till
 * "faktura.exe" en .exe-nyckel i lagringen — ett namn som säger emot filens
 * verifierade innehåll. Visningsnamnet får gärna behålla originalet; NYCKELN
 * ska följa innehållet.
 */
const EXTENSION_BY_DETECTED_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/zip': 'zip',
  'application/x-cfb': 'doc',
}

/**
 * Ändelse (utan punkt) för en validerad MIME-typ. `bin` för det som saknar
 * mappning — hellre en intetsägande ändelse än klientens påhitt.
 */
export function extensionForDetectedMime(detectedMime: string | null): string {
  return (detectedMime && EXTENSION_BY_DETECTED_MIME[detectedMime]) || 'bin'
}
