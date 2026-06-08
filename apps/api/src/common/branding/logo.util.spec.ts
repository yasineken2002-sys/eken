/**
 * getLogoDataUrl — den samlade helpern (Steg 3, PR 2). Tidigare fanns två
 * ordagrant identiska kopior (avisering.service.ts + contract-template.service.ts).
 * Dessa tester låser fast det beteende båda gamla anroparna hade, så att
 * samlingen är beteende-identisk: rätt MIME per filändelse, null vid saknad
 * nyckel, och null (aldrig kast) vid lagringsfel.
 */

jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))

import { getLogoDataUrl } from './logo.util'

function makeStorage(buffer: Buffer | Error) {
  return {
    getFileBuffer: jest
      .fn()
      .mockImplementation(() =>
        buffer instanceof Error ? Promise.reject(buffer) : Promise.resolve(buffer),
      ),
  }
}

describe('getLogoDataUrl', () => {
  it('null när ingen logo-nyckel finns (ingen lagringsanrop)', async () => {
    const storage = makeStorage(Buffer.from('x'))
    expect(await getLogoDataUrl(storage as never, null)).toBeNull()
    expect(storage.getFileBuffer).not.toHaveBeenCalled()
  })

  it('png-nyckel → image/png data-URL', async () => {
    const storage = makeStorage(Buffer.from('PNGDATA'))
    const res = await getLogoDataUrl(storage as never, 'logos/org-1.png')
    expect(res).toBe(`data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`)
  })

  it('webp-nyckel → image/webp data-URL', async () => {
    const storage = makeStorage(Buffer.from('WEBP'))
    const res = await getLogoDataUrl(storage as never, 'logos/org-1.webp')
    expect(res).toBe(`data:image/webp;base64,${Buffer.from('WEBP').toString('base64')}`)
  })

  it('jpg/okänd ändelse → image/jpeg data-URL (default-MIME, som förut)', async () => {
    const storage = makeStorage(Buffer.from('JPG'))
    expect(await getLogoDataUrl(storage as never, 'logos/org-1.jpg')).toBe(
      `data:image/jpeg;base64,${Buffer.from('JPG').toString('base64')}`,
    )
    const storage2 = makeStorage(Buffer.from('NOEXT'))
    expect(await getLogoDataUrl(storage2 as never, 'logos/org-1')).toBe(
      `data:image/jpeg;base64,${Buffer.from('NOEXT').toString('base64')}`,
    )
  })

  it('lagringsfel → null, aldrig kast (logga får inte fälla PDF:en)', async () => {
    const storage = makeStorage(new Error('R2 nere'))
    await expect(getLogoDataUrl(storage as never, 'logos/org-1.png')).resolves.toBeNull()
  })
})
