// Lagringsmodulen dras in som VÄRDE av DI-metadatan, och drar i sin tur in
// AWS-SDK:n med ESM-beroenden jest inte transformerar. Samma mock som de andra
// specarna i katalogen använder; kontrollen får sin lagring via konstruktorn.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { createHash } from 'node:crypto'

import { InspectionImageIntegrityService } from './inspection-image-integrity.service'

/**
 * KONTROLLEN SOM MÅSTE KUNNA GE FYRA OLIKA SVAR.
 *
 * ── DET RÖDA PROVET ─────────────────────────────────────────────────────────
 *
 * `AVVIKANDE` nedan är provet som ska falla om jämförelsen någonsin slutar
 * läsa tillbaka bytena — till exempel om någon "optimerar" genom att lita på
 * den lagrade digesten. Riggen byter innehållet BAKOM nyckeln utan att röra
 * raden, vilket är exakt den manöver kolumnkommentaren beskriver:
 * "`PutObject` mot samma nyckel byter bytes utan att något annat fält ändras".
 *
 * ── EN SOND SOM GER NOLL MÅSTE KUNNA GE NÅGOT ANNAT ────────────────────────
 *
 * Därför prövas alla fyra utfallen mot SAMMA rigg, med bara indata ändrat. En
 * kontroll som alltid svarar `VERIFIERAD` hade passerat ett prov som bara
 * mäter det gröna fallet.
 *
 * ── VAD PROVET INTE SER ─────────────────────────────────────────────────────
 *
 *   • Ingenting om den riktiga lagringen. `getFileBuffer` är stubbad; att R2
 *     svarar som stubben antar ägs av storage-sviten.
 *   • Ingenting om VEM som bytte bytena. Digesten säger att innehållet skiljer
 *     sig, inte vem som skrev.
 *   • Ingenting om tiden mellan två kontroller. Utfallet gäller ögonblicket.
 */

const INNEHÅLL = Buffer.from('bild-bytes-original')
const DIGEST = createHash('sha256').update(INNEHÅLL).digest('hex')

function rigg(lagring: Record<string, Buffer>) {
  const getFileBuffer = jest.fn(async (key: string) => {
    const bytes = lagring[key]
    if (!bytes) throw new Error(`NoSuchKey: ${key}`)
    return bytes
  })
  const service = new InspectionImageIntegrityService({ getFileBuffer } as never)
  return { service, getFileBuffer }
}

const bild = (över: Record<string, unknown> = {}) => ({
  id: 'img-1',
  filename: 'kok.jpg',
  storageKey: 'inspections/org-1/kok.jpg',
  contentSha256: DIGEST,
  ...över,
})

describe('bildkontroll — fyra utfall', () => {
  it('VERIFIERAD när bytena lästes och digesten stämmer', async () => {
    const { service, getFileBuffer } = rigg({ 'inspections/org-1/kok.jpg': INNEHÅLL })
    const utfall = await service.kontrolleraBild(bild())

    expect(utfall.utfall).toBe('VERIFIERAD')
    expect(utfall.faktiskDigest).toBe(DIGEST)
    expect(utfall.forvantadDigest).toBe(DIGEST)
    // Ordet "verifierad" får bara stå efter en UTFÖRD läsning.
    expect(getFileBuffer).toHaveBeenCalledWith('inspections/org-1/kok.jpg')
  })

  it('AVVIKANDE när objektet bakom nyckeln bytts ut — raden är oförändrad', async () => {
    const { service } = rigg({
      'inspections/org-1/kok.jpg': Buffer.from('nagon-annan-bild'),
    })
    const utfall = await service.kontrolleraBild(bild())

    expect(utfall.utfall).toBe('AVVIKANDE')
    expect(utfall.forvantadDigest).toBe(DIGEST)
    expect(utfall.faktiskDigest).not.toBe(DIGEST)
    expect(utfall.faktiskDigest).not.toBeNull()
  })

  it('SAKNAS när objektet inte går att läsa — och kastar INTE', async () => {
    const { service } = rigg({})
    const utfall = await service.kontrolleraBild(bild())

    expect(utfall.utfall).toBe('SAKNAS')
    expect(utfall.faktiskDigest).toBeNull()
    // Den förväntade digesten finns kvar: vi vet vad vi letade efter.
    expect(utfall.forvantadDigest).toBe(DIGEST)
  })

  it('DIGEST_SAKNAS när raden aldrig fick en digest — ingen läsning görs alls', async () => {
    const { service, getFileBuffer } = rigg({ 'inspections/org-1/kok.jpg': INNEHÅLL })
    const utfall = await service.kontrolleraBild(bild({ contentSha256: null }))

    expect(utfall.utfall).toBe('DIGEST_SAKNAS')
    expect(utfall.forvantadDigest).toBeNull()
    expect(utfall.faktiskDigest).toBeNull()
    // Att hämta bytena hade varit meningslöst arbete: det finns inget att
    // jämföra med, och en uträknad digest här hade sett ut som ett facit.
    expect(getFileBuffer).not.toHaveBeenCalled()
  })

  it('utfallet bär tidpunkten kontrollen utfördes', async () => {
    const { service } = rigg({ 'inspections/org-1/kok.jpg': INNEHÅLL })
    const före = Date.now()
    const utfall = await service.kontrolleraBild(bild())
    const efter = Date.now()

    expect(utfall.kontrolleradAt.getTime()).toBeGreaterThanOrEqual(före)
    expect(utfall.kontrolleradAt.getTime()).toBeLessThanOrEqual(efter)
  })
})

describe('sammanfattningen av ett helt protokoll', () => {
  const service = () => rigg({ 'inspections/org-1/kok.jpg': INNEHÅLL }).service
  const u = (utfall: string) =>
    ({
      imageId: 'x',
      filename: 'x.jpg',
      utfall,
      kontrolleradAt: new Date(),
      forvantadDigest: null,
      faktiskDigest: null,
    }) as never

  it('INGA_BILDER när det inte finns något att kontrollera — inte VERIFIERAD', () => {
    // Tomhet är inget godkännande. Ett protokoll utan bilagor har inte
    // verifierade bilagor; det har inga.
    expect(service().sammanfatta([])).toBe('INGA_BILDER')
  })

  it('VERIFIERAD kräver att ALLA bilder verifierades', () => {
    expect(service().sammanfatta([u('VERIFIERAD'), u('VERIFIERAD')])).toBe('VERIFIERAD')
  })

  it('ETT avvikande färgar hela protokollet', () => {
    expect(service().sammanfatta([u('VERIFIERAD'), u('AVVIKANDE'), u('VERIFIERAD')])).toBe(
      'AVVIKANDE',
    )
  })

  it('AVVIKANDE går före SAKNAS och DIGEST_SAKNAS', () => {
    expect(service().sammanfatta([u('DIGEST_SAKNAS'), u('SAKNAS'), u('AVVIKANDE')])).toBe(
      'AVVIKANDE',
    )
  })

  it('en saknad bild gör inte protokollet verifierat — nio av tio räcker inte', () => {
    expect(service().sammanfatta([u('VERIFIERAD'), u('SAKNAS')])).toBe('SAKNAS')
  })

  it('en bilaga utan digest gör protokollet okänt, inte godkänt', () => {
    expect(service().sammanfatta([u('VERIFIERAD'), u('DIGEST_SAKNAS')])).toBe('DIGEST_SAKNAS')
  })
})
