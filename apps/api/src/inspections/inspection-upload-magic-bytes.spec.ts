jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { BadRequestException } from '@nestjs/common'
import { InspectionsController } from './inspections.controller'

/**
 * Besiktningsvägen (`POST /inspections/:id/analyze`) — revisionens fjärde
 * flagga.
 *
 * Den var den mest exponerade av de fyra: klientens `part.mimetype` styrde
 * BÅDE lagringens Content-Type OCH `media_type` till vision-modellen. Och till
 * skillnad från de andra hade den inget storlekstak alls — 10 bilder × Fastifys
 * 20 MB.
 */

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64)])
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
])
const HTML = Buffer.from('<!doctype html><script>alert(1)</script>')

/** Efterliknar Fastifys `request.parts()`-iterator. */
function fakeRequest(files: Array<{ filename: string; mimetype: string; buffer: Buffer }>) {
  return {
    parts: () =>
      (async function* () {
        for (const f of files) {
          yield {
            type: 'file' as const,
            filename: f.filename,
            mimetype: f.mimetype,
            toBuffer: () => Promise.resolve(f.buffer),
          }
        }
      })(),
  }
}

function makeController() {
  const inspectionsService = {
    findOne: jest.fn().mockResolvedValue({ id: 'insp-1', items: [] }),
  }
  const analyzerService = {
    analyzeImages: jest.fn().mockResolvedValue({ items: [], summary: '', totalRepairCost: 0 }),
  }
  const prisma = {
    inspectionImage: { create: jest.fn().mockResolvedValue({}) },
    inspectionItem: { update: jest.fn(), create: jest.fn() },
    inspection: { update: jest.fn().mockResolvedValue({}) },
  }
  const storage = { uploadFile: jest.fn().mockResolvedValue('https://r2/obj') }
  const controller = new InspectionsController(
    inspectionsService as never,
    analyzerService as never,
    prisma as never,
    storage as never,
  )
  return { controller, storage, prisma, analyzerService }
}

const user = { sub: 'user-1', role: 'ADMIN', organizationId: 'org-1' } as never

describe('besiktningsbilder (POST /inspections/:id/analyze)', () => {
  it('AVVISAR en HTML-fil som utger sig för att vara JPEG — inget lagras, inget skickas till modellen', async () => {
    const { controller, storage, analyzerService } = makeController()
    await expect(
      controller.analyze(
        fakeRequest([{ filename: 'rum.jpg', mimetype: 'image/jpeg', buffer: HTML }]) as never,
        'org-1',
        user,
        'insp-1',
      ),
    ).rejects.toThrow(BadRequestException)
    expect(storage.uploadFile).not.toHaveBeenCalled()
    expect(analyzerService.analyzeImages).not.toHaveBeenCalled()
  })

  it('släpper igenom äkta bilder och skickar den VALIDERADE typen till vision-modellen', async () => {
    const { controller, storage, analyzerService } = makeController()
    await controller.analyze(
      fakeRequest([
        // Klienten ljuger om båda: säger png för en JPEG och tvärtom.
        { filename: 'kok.png', mimetype: 'image/png', buffer: JPEG },
        { filename: 'bad.jpg', mimetype: 'image/jpeg', buffer: PNG },
      ]) as never,
      'org-1',
      user,
      'insp-1',
    )

    const uploads = storage.uploadFile.mock.calls as Array<[Buffer, string, string]>
    expect(uploads.map((c) => c[2])).toEqual(['image/jpeg', 'image/png'])
    // Nyckelns ändelse följer innehållet, inte det klienten kallade filen.
    expect(uploads[0]![1].endsWith('.jpg')).toBe(true)
    expect(uploads[1]![1].endsWith('.png')).toBe(true)

    const [imageInputs] = analyzerService.analyzeImages.mock.calls[0] as [
      Array<{ mimeType: string }>,
    ]
    expect(imageInputs.map((i) => i.mimeType)).toEqual(['image/jpeg', 'image/png'])
  })

  it('AVVISAR en PDF — vägen är till för bilder', async () => {
    const { controller } = makeController()
    await expect(
      controller.analyze(
        fakeRequest([
          {
            filename: 'protokoll.pdf',
            mimetype: 'application/pdf',
            buffer: Buffer.from('%PDF-1.7\n'),
          },
        ]) as never,
        'org-1',
        user,
        'insp-1',
      ),
    ).rejects.toThrow(/application\/pdf/)
  })

  it('har NU ett storlekstak — vägen hade inget alls', async () => {
    const { controller, storage } = makeController()
    const big = Buffer.concat([JPEG, Buffer.alloc(16 * 1024 * 1024)])
    await expect(
      controller.analyze(
        fakeRequest([{ filename: 'stor.jpg', mimetype: 'image/jpeg', buffer: big }]) as never,
        'org-1',
        user,
        'insp-1',
      ),
    ).rejects.toThrow(/för stor/)
    expect(storage.uploadFile).not.toHaveBeenCalled()
  })

  it('validerar ALLA bilder före den första laddas upp', async () => {
    const { controller, storage } = makeController()
    await expect(
      controller.analyze(
        fakeRequest([
          { filename: 'ok.jpg', mimetype: 'image/jpeg', buffer: JPEG },
          { filename: 'ond.jpg', mimetype: 'image/jpeg', buffer: HTML },
        ]) as never,
        'org-1',
        user,
        'insp-1',
      ),
    ).rejects.toThrow(BadRequestException)
    // Allt-eller-inget: valideringen sker i ett svep före första uppladdningen,
    // så ingenting hamnar i lagringen när någon fil i satsen är förfalskad.
    // (Samma regel gäller felanmälans/portalens väg.)
    expect(storage.uploadFile).not.toHaveBeenCalled()
  })

  it('behåller taket på 10 bilder', async () => {
    const { controller } = makeController()
    const many = Array.from({ length: 11 }, (_, i) => ({
      filename: `b${i}.jpg`,
      mimetype: 'image/jpeg',
      buffer: JPEG,
    }))
    await expect(
      controller.analyze(fakeRequest(many) as never, 'org-1', user, 'insp-1'),
    ).rejects.toThrow(/Max 10 bilder/)
  })
})
