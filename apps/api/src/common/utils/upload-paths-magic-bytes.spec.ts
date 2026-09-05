jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))

import { BadRequestException } from '@nestjs/common'
import { MaintenanceService } from '../../maintenance/maintenance.service'
import { OrganizationsService } from '../../organizations/organizations.service'

/**
 * Revisionens flagga: fyra uppladdningsvägar litade på klientens Content-Type.
 *
 * Den här sviten vaktar de tre som går via en service (felanmälan, portalen och
 * organisationens logotyp). Besiktningsvägen ligger i en controller och testas
 * i inspections-svitens egen fil.
 *
 * Varje väg prövas på tre saker:
 *   1. En OMDÖPT fil avvisas — och når aldrig lagringen.
 *   2. En ÄKTA fil går igenom.
 *   3. Lagringsnyckelns ändelse följer den VALIDERADE typen, inte filnamnet.
 */

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64)])
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
])
const HTML = Buffer.from('<!doctype html><script>alert(1)</script>')
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
const EXE = Buffer.concat([Buffer.from('MZ', 'latin1'), Buffer.alloc(64)])
const HEIC = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypheic', 'latin1'),
  Buffer.alloc(64),
])

// ── Felanmälan + hyresgästportalen (delar addImages) ────────────────────────

function makeMaintenance() {
  const prisma = {
    maintenanceImage: {
      count: jest.fn().mockResolvedValue(0),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'img-1', ...data }),
        ),
    },
  }
  const storage = {
    uploadFile: jest.fn().mockResolvedValue('https://r2/obj'),
    getPresignedUrl: jest.fn().mockResolvedValue('https://r2/signed'),
  }
  // Ordning: (prisma, notificationsService, storage, aiShadowQueue, shadowOutcome)
  const service = new MaintenanceService(
    prisma as never,
    {} as never,
    storage as never,
    {
      // Skuggkön (etapp 6). Attrappen räcker: specen prövar bilduppladdning,
      // och `create` — den enda väg som köar — anropas aldrig här.
      enqueue: async () => 'x',
    } as never,
    {
      // Skuggfacit (etapp 6 PR 3). Attrappen räcker: `update` med COMPLETED nås
      // inte i det här provet.
      skrivFacitForArende: async () => 0,
    } as never,
  )
  return { service, prisma, storage }
}

describe('felanmälan + portalen (MaintenanceService.addImages)', () => {
  it('AVVISAR en HTML-fil som utger sig för att vara PNG — och lagrar ingenting', async () => {
    const { service, storage } = makeMaintenance()
    await expect(
      service.addImages('t1', [{ filename: 'bild.png', mimetype: 'image/png', buffer: HTML }]),
    ).rejects.toThrow(BadRequestException)
    expect(storage.uploadFile).not.toHaveBeenCalled()
  })

  it('AVVISAR en SVG — den kan bära script och har ingen binär signatur', async () => {
    const { service, storage } = makeMaintenance()
    await expect(
      service.addImages('t1', [{ filename: 'logo.svg', mimetype: 'image/svg+xml', buffer: SVG }]),
    ).rejects.toThrow(/kunde inte verifieras/)
    expect(storage.uploadFile).not.toHaveBeenCalled()
  })

  it('AVVISAR en .exe oavsett vad klienten kallar den', async () => {
    const { service, storage } = makeMaintenance()
    await expect(
      service.addImages('t1', [{ filename: 'foto.jpg', mimetype: 'image/jpeg', buffer: EXE }]),
    ).rejects.toThrow(BadRequestException)
    expect(storage.uploadFile).not.toHaveBeenCalled()
  })

  it('släpper igenom en äkta JPEG och lagrar den som image/jpeg', async () => {
    const { service, storage } = makeMaintenance()
    await service.addImages('t1', [
      { filename: 'foto.jpg', mimetype: 'application/octet-stream', buffer: JPEG },
    ])
    const [, key, mime] = storage.uploadFile.mock.calls[0] as [Buffer, string, string]
    // Klienten sa octet-stream; innehållet avgjorde.
    expect(mime).toBe('image/jpeg')
    expect(key.endsWith('.jpg')).toBe(true)
  })

  it('släpper igenom HEIC — portalens `accept="image/*"` ger iPhone-foton', async () => {
    const { service, storage } = makeMaintenance()
    await service.addImages('t1', [{ filename: 'IMG_0042.HEIC', mimetype: '', buffer: HEIC }])
    const [, key, mime] = storage.uploadFile.mock.calls[0] as [Buffer, string, string]
    expect(mime).toBe('image/heic')
    expect(key.endsWith('.heic')).toBe(true)
  })

  it('NYCKELN följer innehållet, inte filnamnet — "foto.exe" med PNG-innehåll blir .png', async () => {
    const { service, storage } = makeMaintenance()
    await service.addImages('t1', [{ filename: 'foto.exe', mimetype: 'image/png', buffer: PNG }])
    const [, key] = storage.uploadFile.mock.calls[0] as [Buffer, string, string]
    expect(key.endsWith('.png')).toBe(true)
    expect(key).not.toContain('.exe')
  })

  it('behåller storlekstaket (15 MB)', async () => {
    const { service, storage } = makeMaintenance()
    const big = Buffer.concat([JPEG, Buffer.alloc(16 * 1024 * 1024)])
    await expect(
      service.addImages('t1', [{ filename: 'stor.jpg', mimetype: 'image/jpeg', buffer: big }]),
    ).rejects.toThrow(/för stor/)
    expect(storage.uploadFile).not.toHaveBeenCalled()
  })

  it('avvisar HELA satsen om EN av flera bilder är förfalskad — inget hamnar i lagringen', async () => {
    const { service, storage } = makeMaintenance()
    await expect(
      service.addImages('t1', [
        { filename: 'ok.jpg', mimetype: 'image/jpeg', buffer: JPEG },
        { filename: 'ond.png', mimetype: 'image/png', buffer: HTML },
      ]),
    ).rejects.toThrow(BadRequestException)
    // Allt valideras före första uppladdningen: annars hade den giltiga filen
    // legat kvar i R2 utan en rad som pekar på den.
    expect(storage.uploadFile).not.toHaveBeenCalled()
  })
})

// ── Organisationens logotyp ────────────────────────────────────────────────

function makeOrganizations() {
  const prisma = {
    organization: {
      findUnique: jest.fn().mockResolvedValue({ logoStorageKey: null }),
      update: jest.fn().mockResolvedValue({ id: 'org-1' }),
    },
  }
  const storage = {
    uploadFile: jest.fn().mockResolvedValue('https://r2/logo'),
    deleteFile: jest.fn().mockResolvedValue(undefined),
    getPresignedUrl: jest.fn().mockResolvedValue('https://r2/signed'),
  }
  const service = new OrganizationsService(prisma as never, storage as never)
  return { service, prisma, storage }
}

describe('organisationens logotyp (OrganizationsService.uploadLogo)', () => {
  it('AVVISAR en SVG — den hade renderats i fakturor och PDF:er', async () => {
    const { service, storage } = makeOrganizations()
    await expect(
      service.uploadLogo('org-1', { toBuffer: () => Promise.resolve(SVG) }),
    ).rejects.toThrow(/kunde inte verifieras/)
    expect(storage.uploadFile).not.toHaveBeenCalled()
  })

  it('AVVISAR HTML som påstår sig vara PNG', async () => {
    const { service, storage } = makeOrganizations()
    await expect(
      service.uploadLogo('org-1', { toBuffer: () => Promise.resolve(HTML) }),
    ).rejects.toThrow(BadRequestException)
    expect(storage.uploadFile).not.toHaveBeenCalled()
  })

  it('AVVISAR HEIC — logotypen ska kunna visas i en webbläsare', async () => {
    const { service } = makeOrganizations()
    await expect(
      service.uploadLogo('org-1', { toBuffer: () => Promise.resolve(HEIC) }),
    ).rejects.toThrow(/matchar inte en tillåten filtyp/)
  })

  it('släpper igenom en äkta PNG och ger nyckeln .png', async () => {
    const { service, storage } = makeOrganizations()
    await service.uploadLogo('org-1', { toBuffer: () => Promise.resolve(PNG) })
    const [, key, mime] = storage.uploadFile.mock.calls[0] as [Buffer, string, string]
    expect(key).toBe('logos/org-1.png')
    expect(mime).toBe('image/png')
  })

  it('ger en JPEG nyckeln .jpg — ändelsen är härledd, inte gissad', async () => {
    const { service, storage } = makeOrganizations()
    await service.uploadLogo('org-1', { toBuffer: () => Promise.resolve(JPEG) })
    const [, key] = storage.uploadFile.mock.calls[0] as [Buffer, string, string]
    expect(key).toBe('logos/org-1.jpg')
  })

  it('taket på 2 MB gäller nu FAKTISKT — den gamla kollen läste bytesRead före strömmen', async () => {
    const { service, storage } = makeOrganizations()
    const big = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)])
    await expect(
      service.uploadLogo('org-1', { toBuffer: () => Promise.resolve(big) }),
    ).rejects.toThrow(/för stor/)
    expect(storage.uploadFile).not.toHaveBeenCalled()
  })

  it('städar den gamla logotypen när ändelsen ändras', async () => {
    const { service, prisma, storage } = makeOrganizations()
    prisma.organization.findUnique.mockResolvedValue({ logoStorageKey: 'logos/org-1.jpg' })
    await service.uploadLogo('org-1', { toBuffer: () => Promise.resolve(PNG) })
    expect(storage.deleteFile).toHaveBeenCalledWith('logos/org-1.jpg')
  })
})
