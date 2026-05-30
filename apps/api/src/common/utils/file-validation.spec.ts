/**
 * SECURITY (H3) — magic-byte- och storleksvalidering för filuppladdningar.
 *
 * Verifierar att validateUploadedFile():
 *   • avvisar en fil vars FAKTISKA innehåll inte matchar allowlisten även om
 *     den klient-deklarerade typen skulle vara tillåten (förfalskad mimetype)
 *   • släpper igenom en äkta PDF / PNG
 *   • tillåter signaturlös text (CSV/BgMax) endast när allowTextWithoutSignature
 *   • avvisar binärt innehåll i ett textflöde (omdöpt bild → BgMax)
 *   • hävdar storlekstaket och tom fil
 */

import { BadRequestException } from '@nestjs/common'
import {
  validateUploadedFile,
  detectMimeFromMagicBytes,
  DETECTED_PDF_TYPES,
  DETECTED_DOCUMENT_TYPES,
  MAX_PDF_BYTES,
} from './file-validation'

const PDF_BYTES = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<< >>\nendobj\n', 'latin1')
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
])
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
// ELF-binär (Linux-exe): okänd signatur → null (behandlas som "ej textfil").
const ELF_BYTES = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0])
const CSV_TEXT = Buffer.from('datum;belopp;referens\n2026-01-01;1000;OCR123\n')

describe('detectMimeFromMagicBytes', () => {
  it('känner igen kända format och returnerar null för text', () => {
    expect(detectMimeFromMagicBytes(PDF_BYTES)).toBe('application/pdf')
    expect(detectMimeFromMagicBytes(PNG_BYTES)).toBe('image/png')
    expect(detectMimeFromMagicBytes(JPEG_BYTES)).toBe('image/jpeg')
    expect(detectMimeFromMagicBytes(CSV_TEXT)).toBeNull()
    expect(detectMimeFromMagicBytes(ELF_BYTES)).toBeNull()
  })
})

describe('validateUploadedFile (H3)', () => {
  it('släpper igenom en äkta PDF', () => {
    expect(() =>
      validateUploadedFile(PDF_BYTES, {
        allowedDetectedMimes: DETECTED_PDF_TYPES,
        maxBytes: MAX_PDF_BYTES,
      }),
    ).not.toThrow()
  })

  it('avvisar en förfalskad PDF (ELF-binär med okänd signatur)', () => {
    expect(() =>
      validateUploadedFile(ELF_BYTES, {
        allowedDetectedMimes: DETECTED_PDF_TYPES,
        maxBytes: MAX_PDF_BYTES,
      }),
    ).toThrow(BadRequestException)
  })

  it('avvisar en bild som skickas till ett PDF-only-flöde', () => {
    expect(() =>
      validateUploadedFile(JPEG_BYTES, {
        allowedDetectedMimes: DETECTED_PDF_TYPES,
        maxBytes: MAX_PDF_BYTES,
      }),
    ).toThrow(BadRequestException)
  })

  it('tillåter en PNG i dokumentflödet', () => {
    expect(() =>
      validateUploadedFile(PNG_BYTES, {
        allowedDetectedMimes: DETECTED_DOCUMENT_TYPES,
        maxBytes: MAX_PDF_BYTES,
      }),
    ).not.toThrow()
  })

  it('avvisar signaturlös text när allowTextWithoutSignature inte är satt', () => {
    expect(() =>
      validateUploadedFile(CSV_TEXT, {
        allowedDetectedMimes: DETECTED_PDF_TYPES,
        maxBytes: MAX_PDF_BYTES,
      }),
    ).toThrow(BadRequestException)
  })

  it('tillåter signaturlös text (CSV/BgMax) när allowTextWithoutSignature är satt', () => {
    expect(() =>
      validateUploadedFile(CSV_TEXT, {
        allowedDetectedMimes: [],
        maxBytes: MAX_PDF_BYTES,
        allowTextWithoutSignature: true,
      }),
    ).not.toThrow()
  })

  it('avvisar binärt innehåll i ett textflöde (omdöpt bild som BgMax)', () => {
    expect(() =>
      validateUploadedFile(JPEG_BYTES, {
        allowedDetectedMimes: [],
        maxBytes: MAX_PDF_BYTES,
        allowTextWithoutSignature: true,
      }),
    ).toThrow(BadRequestException)
  })

  it('avvisar en fil över storlekstaket', () => {
    const big = Buffer.concat([PDF_BYTES, Buffer.alloc(100)])
    expect(() =>
      validateUploadedFile(big, { allowedDetectedMimes: DETECTED_PDF_TYPES, maxBytes: 10 }),
    ).toThrow(BadRequestException)
  })

  it('avvisar en tom fil', () => {
    expect(() =>
      validateUploadedFile(Buffer.alloc(0), {
        allowedDetectedMimes: DETECTED_PDF_TYPES,
        maxBytes: MAX_PDF_BYTES,
      }),
    ).toThrow(BadRequestException)
  })
})
