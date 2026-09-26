/**
 * ÅTERFÖRSÖK AV BESIKTNINGSANALYS — samma bilaga får inte lagras två gånger (OB5).
 *
 * ── FYNDET ──────────────────────────────────────────────────────────────────
 *
 * `POST /inspections/:id/analyze` sparar bilderna FÖRE AI-anropet
 * (`saveAnalysisImages` → `analyzeImages`). Svarar AI:n fel blir svaret 400,
 * men bilden finns redan som `InspectionImage` + lagringsobjekt. Webben behöll
 * filen i kön, och nästa klick laddade upp samma bild igen: ny uuid, nytt
 * objekt, ny rad.
 *
 * ── MODELLEN SOM PRÖVAS ─────────────────────────────────────────────────────
 *
 * Webben ger varje användarVAL en återförsöksnyckel (UUID) och skickar den som
 * `uploadKey_<i>`. Samma köpost som skickas igen bär samma nyckel; ett nytt val
 * av samma fil får en ny. Servern slår upp en befintlig bilaga bara inom den
 * besiktning som `findOneUnsigned(id, orgId)` redan verifierat, och bara under
 * nyckelns prefix — aldrig på klientens bild-id och aldrig på bytes globalt.
 *
 * ── VAD PROVET INTE KAN SE ──────────────────────────────────────────────────
 *
 *   • HTTP-lagret (roller, org ur JWT). Controllern anropas direkt med `orgId`
 *     och en attrapp av Fastifys `request.parts()`. Webbläsarsonden i
 *     slutpaketet bär HTTP-vägen.
 *   • En verklig R2. Lagringen är en räknande attrapp; "objekt" betyder här
 *     nycklar i attrappens karta, och det är de som räknas.
 *   • En verklig AI. Analysatorn är en attrapp som kastar eller svarar.
 */
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { createHash, randomUUID } from 'node:crypto'

import { BadRequestException, NotFoundException } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

import { InspectionsController } from './inspections.controller'
import { InspectionsService } from './inspections.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

/** En giltig PNG-signatur följd av `n` utfyllnadsbyten — olika `n` ger olika bytes. */
const png = (fyll: number) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, fyll),
  ])
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

type Del =
  | { type: 'file'; filename: string; mimetype: string; toBuffer: () => Promise<Buffer> }
  | { type: 'field'; fieldname: string; value: string }

/** Efterliknar Fastifys `request.parts()`: filer + fält (bildtext och ev. nyckel) per index. */
function begaran(filer: Array<{ buffer: Buffer; caption?: string; nyckel?: string }>) {
  const delar: Del[] = []
  filer.forEach((f, i) => {
    delar.push({
      type: 'file',
      filename: `bild-${i}.png`,
      mimetype: 'image/png',
      toBuffer: () => Promise.resolve(f.buffer),
    })
    if (f.caption) delar.push({ type: 'field', fieldname: `caption_${i}`, value: f.caption })
    if (f.nyckel) delar.push({ type: 'field', fieldname: `uploadKey_${i}`, value: f.nyckel })
  })
  return {
    parts: () =>
      (async function* () {
        for (const d of delar) yield d
      })(),
  } as never
}

medDb('OB5 — återförsök av besiktningsanalys', () => {
  let prisma: PrismaClient
  let service: InspectionsService
  let orgA: string
  let orgB: string
  let propA: string
  let unitA: string
  let propB: string
  let unitB: string

  /** Räknande lagringsattrapp: nyckel → bytes. `kasta` simulerar fel FÖRE lagring. */
  const lagring = {
    objekt: new Map<string, Buffer>(),
    uppladdningar: 0,
    raderingar: 0,
    kasta: false,
    uploadFile: jest.fn(async (buf: Buffer, key: string) => {
      if (lagring.kasta) throw new Error('lagringen svarar inte')
      lagring.uppladdningar++
      lagring.objekt.set(key, buf)
      return `https://lokal/${key}`
    }),
    deleteFile: jest.fn(async (key: string) => {
      lagring.raderingar++
      lagring.objekt.delete(key)
    }),
  }
  /** Analysattrapp: kastar samma 400 som den riktiga vid AI-fel, eller svarar. */
  const ai = {
    lage: 'fel' as 'fel' | 'ok',
    analyzeImages: jest.fn(async () => {
      if (ai.lage === 'fel') {
        throw new BadRequestException(
          'Kunde inte analysera bilderna. Kontrollera att bilderna är tydliga.',
        )
      }
      return {
        overallCondition: 'God',
        notes: 'AI-anteckning',
        urgentIssues: [],
        estimatedTotalCost: 0,
        items: [
          {
            room: 'Kök',
            item: 'Golv',
            condition: 'DAMAGED',
            notes: 'Repa enligt bild',
            repairCost: null,
          },
        ],
      }
    }),
  }
  let controller: InspectionsController
  const anvandare = (org: string) =>
    ({ sub: randomUUID(), role: 'ADMIN', organizationId: org }) as never

  const nyOrg = async (märke: string) => {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `${märke}-${sfx}`,
        email: `${märke}-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
      select: { id: true },
    })
    return org.id
  }
  const nyFastighet = async (organizationId: string) => {
    const sfx = randomUUID().slice(0, 8)
    const p = await prisma.property.create({
      data: {
        organizationId,
        name: `Fastighet ${sfx}`,
        propertyDesignation: `Eken ${sfx}`,
        type: 'RESIDENTIAL',
        street: 'Ekgatan 1',
        city: 'Stockholm',
        postalCode: '11111',
        totalArea: 500,
      },
      select: { id: true },
    })
    const u = await prisma.unit.create({
      data: {
        propertyId: p.id,
        name: 'Lgh 1001',
        unitNumber: '1001',
        type: 'APARTMENT',
        area: 62,
        monthlyRent: 9500,
      },
      select: { id: true },
    })
    return { propertyId: p.id, unitId: u.id }
  }
  const nyBesiktning = async (org: string, propertyId: string, unitId: string) => {
    const insp = await prisma.inspection.create({
      data: {
        organizationId: org,
        propertyId,
        unitId,
        type: 'MOVE_OUT',
        status: 'IN_PROGRESS',
        scheduledDate: new Date('2026-09-26T09:00:00Z'),
      },
      select: { id: true },
    })
    await prisma.inspectionItem.create({
      data: { inspectionId: insp.id, room: 'Kök', item: 'Golv' },
    })
    return insp.id
  }
  const bilder = (inspectionId: string) =>
    prisma.inspectionImage.findMany({ where: { inspectionId }, orderBy: { createdAt: 'asc' } })
  const objektFor = (nyckel: string) =>
    [...lagring.objekt.keys()].filter((k) => k.includes(`/${nyckel}/`))

  /** Ett analysförsök; ett 400 från AI:n räknas som utfall, inte som provfel. */
  const forsok = async (org: string, id: string, filer: Parameters<typeof begaran>[0]) => {
    try {
      return {
        ok: true as const,
        svar: await controller.analyze(begaran(filer), org, anvandare(org), id),
      }
    } catch (e) {
      return { ok: false as const, fel: e }
    }
  }

  beforeAll(async () => {
    prisma = new PrismaClient()
    await prisma.$connect()
    service = new InspectionsService(
      prisma as never,
      {} as never,
      lagring as never,
      {
        kontrolleraBilder: async () => [],
        sammanfatta: () => 'INGA_BILDER',
      } as never,
    )
    controller = new InspectionsController(service, ai as never, lagring as never)
    orgA = await nyOrg('ob5-a')
    orgB = await nyOrg('ob5-b')
    ;({ propertyId: propA, unitId: unitA } = await nyFastighet(orgA))
    ;({ propertyId: propB, unitId: unitB } = await nyFastighet(orgB))
  })

  afterAll(async () => {
    for (const id of [orgA, orgB])
      await prisma.organization.delete({ where: { id } }).catch(() => undefined)
    await prisma.$disconnect()
  })

  beforeEach(() => {
    lagring.objekt.clear()
    lagring.uppladdningar = 0
    lagring.raderingar = 0
    lagring.kasta = false
    ai.lage = 'fel'
  })

  it('R1+R2: AI-fel två gånger och sedan lyckat återförsök — EN rad, ETT objekt, samma bytes och bildtext, analysen tillämpad', async () => {
    const id = await nyBesiktning(orgA, propA, unitA)
    const nyckel = randomUUID()
    const fil = { buffer: png(1), caption: 'Repa vid diskbänken', nyckel }

    const f1 = await forsok(orgA, id, [fil])
    const f2 = await forsok(orgA, id, [fil])
    expect(f1.ok).toBe(false)
    expect(f2.ok).toBe(false)
    let rader = await bilder(id)
    expect(rader).toHaveLength(1)
    expect(objektFor(nyckel)).toHaveLength(1)
    expect(rader[0]!.contentSha256).toBe(sha(fil.buffer))
    expect(rader[0]!.caption).toBe('Repa vid diskbänken')
    const sparadId = rader[0]!.id

    ai.lage = 'ok'
    const f3 = await forsok(orgA, id, [fil])
    expect(f3.ok).toBe(true)
    rader = await bilder(id)
    expect(rader).toHaveLength(1)
    expect(objektFor(nyckel)).toHaveLength(1)
    expect(rader[0]!.id).toBe(sparadId)
    expect(f3.ok && (f3.svar as { bildIds?: string[] }).bildIds).toEqual([sparadId])
    const post = await prisma.inspectionItem.findFirst({
      where: { inspectionId: id, room: 'Kök', item: 'Golv' },
    })
    expect(post!.condition).toBe('DAMAGED')
    // AI:n fick samma bytes vid återförsöket som vid första försöket.
    const skickat = ai.analyzeImages.mock.calls.at(-1) as unknown as [Array<{ buffer: Buffer }>]
    expect(sha(skickat[0][0]!.buffer)).toBe(sha(fil.buffer))
  })

  it('R3: fel FÖRE lagring lämnar inget — nästa försök sparar exakt en gång', async () => {
    const id = await nyBesiktning(orgA, propA, unitA)
    const fil = { buffer: png(3), nyckel: randomUUID() }
    lagring.kasta = true
    const f1 = await forsok(orgA, id, [fil])
    expect(f1.ok).toBe(false)
    expect(await bilder(id)).toHaveLength(0)
    lagring.kasta = false
    await forsok(orgA, id, [fil])
    expect(await bilder(id)).toHaveLength(1)
    expect(objektFor(fil.nyckel)).toHaveLength(1)
  })

  it('R4: två separata VAL av samma fil (olika nycklar) blir två bilagor — ingen global byte-dedupe', async () => {
    const id = await nyBesiktning(orgA, propA, unitA)
    const bytes = png(4)
    await forsok(orgA, id, [{ buffer: bytes, nyckel: randomUUID() }])
    await forsok(orgA, id, [{ buffer: bytes, nyckel: randomUUID() }])
    expect(await bilder(id)).toHaveLength(2)
  })

  it('R5: samma nyckel med ANDRA bytes avvisas, inget skrivs', async () => {
    const id = await nyBesiktning(orgA, propA, unitA)
    const nyckel = randomUUID()
    await forsok(orgA, id, [{ buffer: png(5), nyckel }])
    const före = lagring.uppladdningar
    const f2 = await forsok(orgA, id, [{ buffer: png(6), nyckel }])
    expect(f2.ok).toBe(false)
    expect((f2 as { fel: { getStatus?: () => number } }).fel.getStatus?.()).toBe(409)
    expect(await bilder(id)).toHaveLength(1)
    expect(lagring.uppladdningar).toBe(före)
  })

  it('R6: annan org kan inte referera A:s besiktning med A:s nyckel — 404, inga rader', async () => {
    const id = await nyBesiktning(orgA, propA, unitA)
    const nyckel = randomUUID()
    await forsok(orgA, id, [{ buffer: png(7), nyckel }])
    const f = await forsok(orgB, id, [{ buffer: png(7), nyckel }])
    expect(f.ok).toBe(false)
    expect((f as { fel: unknown }).fel).toBeInstanceOf(NotFoundException)
    expect(await bilder(id)).toHaveLength(1)
    const idB = await nyBesiktning(orgB, propB, unitB)
    expect(await bilder(idB)).toHaveLength(0)
  })

  it('R7: samma org, ANNAN besiktning, samma nyckel — ny bilaga där, den första orörd', async () => {
    const id1 = await nyBesiktning(orgA, propA, unitA)
    const id2 = await nyBesiktning(orgA, propA, unitA)
    const nyckel = randomUUID()
    await forsok(orgA, id1, [{ buffer: png(8), nyckel }])
    const förstaRad = (await bilder(id1))[0]!
    await forsok(orgA, id2, [{ buffer: png(8), nyckel }])
    expect(await bilder(id2)).toHaveLength(1)
    const efter = await bilder(id1)
    expect(efter).toHaveLength(1)
    expect(efter[0]!.id).toBe(förstaRad.id)
    expect((await bilder(id2))[0]!.id).not.toBe(förstaRad.id)
  })

  it('R8: två SAMTIDIGA försök med samma nyckel (dubbelklick/okänt nätutfall) — en rad, inget föräldralöst objekt', async () => {
    const id = await nyBesiktning(orgA, propA, unitA)
    const fil = { buffer: png(9), nyckel: randomUUID() }
    await Promise.all([forsok(orgA, id, [fil]), forsok(orgA, id, [fil])])
    expect(await bilder(id)).toHaveLength(1)
    expect(objektFor(fil.nyckel)).toHaveLength(1)
  })

  it('R9: utan nyckel (äldre klient) — oförändrat beteende, en ny bilaga per anrop', async () => {
    const id = await nyBesiktning(orgA, propA, unitA)
    await forsok(orgA, id, [{ buffer: png(10) }])
    await forsok(orgA, id, [{ buffer: png(10) }])
    expect(await bilder(id)).toHaveLength(2)
  })

  it('en nyckel som inte är en UUID avvisas före lagring', async () => {
    const id = await nyBesiktning(orgA, propA, unitA)
    const f = await forsok(orgA, id, [{ buffer: png(11), nyckel: '../../annan-org' }])
    expect(f.ok).toBe(false)
    expect((f as { fel: unknown }).fel).toBeInstanceOf(BadRequestException)
    expect(await bilder(id)).toHaveLength(0)
    expect(lagring.uppladdningar).toBe(0)
  })
})
