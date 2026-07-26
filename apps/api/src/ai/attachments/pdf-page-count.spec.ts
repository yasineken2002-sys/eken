import { deflateSync } from 'node:zlib'
import { countPdfPages } from './pdf-page-count'

/**
 * B3 — sidräkningen. Poängen är att en 601-sidig PDF ska avvisas när
 * användaren väljer den, inte vid modellanropet.
 *
 * Två familjer av PDF måste fungera:
 *   • OKOMPRIMERADE (äldre verktyg, vissa scanners) — sidträdet står i klartext.
 *   • OBJEKTSTRÖMMAR (PDF 1.5+, allt Word/Chrome/Puppeteer gör) — sidträdet
 *     ligger deflate-komprimerat. Utan inflate-steget hade räknaren svarat
 *     `null` för i praktiken alla PDF:er en användare faktiskt har.
 */

function plainPdf(pages: number): Buffer {
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(' ')
  const objs = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    `2 0 obj<</Type/Pages/Kids[${kids}]/Count ${pages}>>endobj`,
    ...Array.from(
      { length: pages },
      (_, i) => `${3 + i} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj`,
    ),
  ]
  return Buffer.from(`%PDF-1.4\n${objs.join('\n')}\ntrailer<</Root 1 0 R>>\n`, 'latin1')
}

/** Sidträdet gömt i en deflate-komprimerad objektström, som PDF 1.5+ gör. */
function compressedPdf(pages: number): Buffer {
  const inner = `<</Type/Pages/Count ${pages}/Kids[]>>`
  const stream = deflateSync(Buffer.from(inner, 'latin1'))
  return Buffer.concat([
    Buffer.from('%PDF-1.5\n4 0 obj<</Type/ObjStm/Filter/FlateDecode>>stream\n', 'latin1'),
    stream,
    Buffer.from('\nendstream endobj\ntrailer<</Root 1 0 R>>\n', 'latin1'),
  ])
}

describe('countPdfPages', () => {
  it('räknar okomprimerade PDF:er exakt', () => {
    expect(countPdfPages(plainPdf(1))).toBe(1)
    expect(countPdfPages(plainPdf(12))).toBe(12)
    expect(countPdfPages(plainPdf(600))).toBe(600)
    expect(countPdfPages(plainPdf(601))).toBe(601)
  })

  it('läser sidträdet ur en komprimerad objektström', () => {
    expect(countPdfPages(compressedPdf(7))).toBe(7)
    expect(countPdfPages(compressedPdf(650))).toBe(650)
  })

  it('förväxlar inte /Type /Pages med /Type /Page', () => {
    // En PDF med BARA trädnoden och inga sidobjekt ska ge trädets Count,
    // inte antalet /Type/Pages-förekomster.
    const onlyTree = Buffer.from(
      '%PDF-1.4\n2 0 obj<</Type/Pages/Kids[]/Count 42>>endobj\n',
      'latin1',
    )
    expect(countPdfPages(onlyTree)).toBe(42)
  })

  it('tar den STÖRSTA Count:en — nästlade Pages-noder bär delsummor', () => {
    const nested = Buffer.from(
      '%PDF-1.4\n' +
        '2 0 obj<</Type/Pages/Count 100/Kids[3 0 R 4 0 R]>>endobj\n' +
        '3 0 obj<</Type/Pages/Count 60/Parent 2 0 R>>endobj\n' +
        '4 0 obj<</Type/Pages/Count 40/Parent 2 0 R>>endobj\n',
      'latin1',
    )
    expect(countPdfPages(nested)).toBe(100)
  })

  it('returnerar null för det som inte är PDF', () => {
    expect(countPdfPages(Buffer.from('<html><body>hej</body></html>'))).toBeNull()
    expect(countPdfPages(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull()
    expect(countPdfPages(Buffer.alloc(0))).toBeNull()
  })

  it('returnerar null — INTE 0 — för en PDF vars sidträd inte går att läsa', () => {
    // Skillnaden är hela poängen: null betyder "vet inte" och släpps fram,
    // 0 hade betytt "noll sidor" och sett ut som ett giltigt svar.
    expect(countPdfPages(Buffer.from('%PDF-1.7\nbara skräp här\n', 'latin1'))).toBeNull()
  })

  it('kraschar inte på en trasig ström som utger sig för att vara komprimerad', () => {
    const broken = Buffer.concat([
      Buffer.from('%PDF-1.5\n1 0 obj<</Filter/FlateDecode>>stream\n', 'latin1'),
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00, 0x01]),
      Buffer.from('\nendstream\n', 'latin1'),
    ])
    expect(() => countPdfPages(broken)).not.toThrow()
    expect(countPdfPages(broken)).toBeNull()
  })

  it('går inte i oändlig loop på en ström utan endstream', () => {
    const truncated = Buffer.from('%PDF-1.5\n1 0 obj<</Filter/FlateDecode>>stream\nabc', 'latin1')
    expect(countPdfPages(truncated)).toBeNull()
  })
})
