import {
  detectMimeFromMagicBytes,
  extensionForDetectedMime,
  validateUploadedFile,
  DETECTED_TICKET_IMAGE_TYPES,
  DETECTED_WEB_IMAGE_TYPES,
  MAX_TICKET_IMAGE_BYTES,
} from './file-validation'

/**
 * HEIC/HEIF-detektering + ändelse ur validerad typ.
 *
 * HEIC lades till för att hyresgästportalen använder `accept="image/*"` och en
 * iPhone levererar HEIC som standard. Utan detektion hade magic-byte-kravet
 * brutit den vanligaste vägen in för en hyresgäst — därför är det HÄR
 * regressionen ska fångas, inte i produktion.
 *
 * Den känsliga punkten: HEIC delar container (ISO-BMFF) med MP4/MOV. Skillnaden
 * ligger ENBART i varumärket på offset 8, så en för bred matchning gör en
 * videofil till en "bild".
 */

/** ISO-BMFF-huvud: [storlek][ftyp][varumärke][version][kompatibla]. */
function isoBmff(brand: string, compatible = 'mif1'): Buffer {
  const box = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftyp', 'latin1'),
    Buffer.from(brand, 'latin1'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from(compatible, 'latin1'),
  ])
  return Buffer.concat([box, Buffer.alloc(64)])
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64)])
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
])
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.alloc(4),
  Buffer.from('WEBP', 'latin1'),
  Buffer.alloc(64),
])
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
const HTML = Buffer.from('<!doctype html><script>alert(1)</script>')

describe('detectMimeFromMagicBytes — HEIC/HEIF', () => {
  it('känner igen de varumärken en iPhone skriver', () => {
    for (const brand of ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs']) {
      expect(detectMimeFromMagicBytes(isoBmff(brand))).toBe('image/heic')
    }
  })

  it('känner igen den generiska HEIF-containern', () => {
    expect(detectMimeFromMagicBytes(isoBmff('mif1'))).toBe('image/heif')
    expect(detectMimeFromMagicBytes(isoBmff('msf1'))).toBe('image/heif')
  })

  it('gör INTE video till bild — MP4/MOV delar container med HEIC', () => {
    for (const brand of ['isom', 'mp42', 'mp41', 'qt  ', 'avc1', 'M4V ', '3gp5']) {
      expect(detectMimeFromMagicBytes(isoBmff(brand))).toBeNull()
    }
  })

  it('kräver "ftyp" på rätt offset — inte var som helst i filen', () => {
    const fake = Buffer.concat([Buffer.from('XXXXXXXXftypheic', 'latin1'), Buffer.alloc(32)])
    expect(detectMimeFromMagicBytes(fake)).toBeNull()
  })

  it('kraschar inte på en avhuggen fil', () => {
    expect(detectMimeFromMagicBytes(Buffer.from('ftyp', 'latin1'))).toBeNull()
    expect(detectMimeFromMagicBytes(Buffer.alloc(0))).toBeNull()
  })

  it('rör inte de format som redan detekterades', () => {
    expect(detectMimeFromMagicBytes(JPEG)).toBe('image/jpeg')
    expect(detectMimeFromMagicBytes(PNG)).toBe('image/png')
    expect(detectMimeFromMagicBytes(WEBP)).toBe('image/webp')
    expect(detectMimeFromMagicBytes(Buffer.from('%PDF-1.7'))).toBe('application/pdf')
  })
})

describe('extensionForDetectedMime', () => {
  it('ger ändelsen som hör till den VALIDERADE typen', () => {
    expect(extensionForDetectedMime('image/jpeg')).toBe('jpg')
    expect(extensionForDetectedMime('image/png')).toBe('png')
    expect(extensionForDetectedMime('image/webp')).toBe('webp')
    expect(extensionForDetectedMime('image/heic')).toBe('heic')
    expect(extensionForDetectedMime('application/pdf')).toBe('pdf')
  })

  it('faller tillbaka på "bin" — aldrig på något klienten hittat på', () => {
    expect(extensionForDetectedMime(null)).toBe('bin')
    expect(extensionForDetectedMime('application/x-msdownload')).toBe('bin')
  })
})

describe('allowlistorna per väg', () => {
  it('ärendebilder (felanmälan + portal) släpper in HEIC', () => {
    for (const buf of [JPEG, PNG, WEBP, isoBmff('heic')]) {
      expect(() =>
        validateUploadedFile(buf, {
          allowedDetectedMimes: DETECTED_TICKET_IMAGE_TYPES,
          maxBytes: MAX_TICKET_IMAGE_BYTES,
        }),
      ).not.toThrow()
    }
  })

  it('besiktning/logotyp släpper INTE in HEIC — varken webbläsare eller vision läser den', () => {
    expect(() =>
      validateUploadedFile(isoBmff('heic'), {
        allowedDetectedMimes: DETECTED_WEB_IMAGE_TYPES,
        maxBytes: MAX_TICKET_IMAGE_BYTES,
      }),
    ).toThrow(/matchar inte en tillåten filtyp/)
  })

  it('SVG och HTML avvisas på ALLA bildvägar — de har ingen binär signatur', () => {
    for (const allowed of [DETECTED_TICKET_IMAGE_TYPES, DETECTED_WEB_IMAGE_TYPES]) {
      for (const buf of [SVG, HTML]) {
        expect(() =>
          validateUploadedFile(buf, {
            allowedDetectedMimes: allowed,
            maxBytes: MAX_TICKET_IMAGE_BYTES,
          }),
        ).toThrow(/kunde inte verifieras/)
      }
    }
  })

  it('en PDF avvisas på bildvägarna — allowlistan är per väg, inte global', () => {
    expect(() =>
      validateUploadedFile(Buffer.from('%PDF-1.7\n'), {
        allowedDetectedMimes: DETECTED_WEB_IMAGE_TYPES,
        maxBytes: MAX_TICKET_IMAGE_BYTES,
      }),
    ).toThrow(/application\/pdf/)
  })
})
