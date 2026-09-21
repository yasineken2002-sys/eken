/**
 * VISAD VERSION MOT SIGNERAD VERSION — mot riktig Postgres.
 *
 * ── VAD SOM VAR FEL ─────────────────────────────────────────────────────────
 *
 * Radlåset (F025 steg 1) serialiserar samtidiga skrivare. Det upptäcker INTE
 * att den som signerar läste protokollet för fem minuter sedan. A läste `GOOD`,
 * B vände posten till `DAMAGED` med 18 000 kr medan protokollet var öppet — helt
 * tillåtet — och A:s signering band därefter B:s innehåll. Signaturen intygade
 * uppgifter A aldrig sett, och `signedContentHash` var internt konsistent med
 * dem, så ingenting i datan avslöjade det.
 *
 * ── VAD PROVEN MÄTER ────────────────────────────────────────────────────────
 *
 * Utfallet i DATABASEN: vilken status raden har, om `signedAt` är satt, och
 * exakt vilket innehåll den lagrade hashen motsvarar. Inte att en metod
 * anropades.
 *
 * ── VAD DE INTE BEVISAR ─────────────────────────────────────────────────────
 *
 *   • Ingenting över HTTP. `@Roles` och ValidationPipe ägs av andra sviter.
 *   • Ingenting om vem som signerade. `SIGNED` är fortfarande hyresvärdens
 *     knapptryck, inte hyresgästens underskrift.
 *   • Förutsättningen skyddar mot att signera OSEDD data. Den gör inte
 *     protokollet sant.
 */
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { createHash, randomUUID } from 'node:crypto'

import { BadRequestException, ConflictException } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

import { InspectionsService } from './inspections.service'
import { BESIKTNING_SIGNERAD_MEDDELANDE, computeSignedContentHash } from './inspection-signature'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('signeringens förutsättning — visad version mot signerad version', () => {
  let prisma: PrismaClient
  let service: InspectionsService
  let orgA: string
  let propA: string
  let unitA: string
  let userA: string

  beforeAll(async () => {
    prisma = new PrismaClient()
    await prisma.$connect()
    service = new InspectionsService(
      prisma as never,
      {} as never,
      {} as never,
      { kontrolleraBilder: async () => [], sammanfatta: () => 'INGA_BILDER' } as never,
    )

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `f025b-${sfx}`,
        email: `f025b-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
      select: { id: true },
    })
    orgA = org.id
    const p = await prisma.property.create({
      data: {
        organizationId: orgA,
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
    propA = p.id
    const u = await prisma.unit.create({
      data: {
        propertyId: propA,
        name: 'Lgh 1001',
        unitNumber: '1001',
        type: 'APARTMENT',
        area: 62,
        monthlyRent: 9500,
      },
      select: { id: true },
    })
    unitA = u.id
    const usr = await prisma.user.create({
      data: {
        organizationId: orgA,
        email: `f025b-${sfx}@x.se`,
        firstName: 'Besiktnings',
        lastName: 'Ansvarig',
        role: 'ADMIN',
      },
      select: { id: true },
    })
    userA = usr.id
  })

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: orgA } }).catch(() => undefined)
    await prisma.$disconnect()
  })

  const nyBesiktning = async () => {
    const insp = await prisma.inspection.create({
      data: {
        organizationId: orgA,
        propertyId: propA,
        unitId: unitA,
        inspectedById: userA,
        type: 'MOVE_OUT',
        status: 'COMPLETED',
        scheduledDate: new Date('2026-03-02T09:00:00Z'),
        completedAt: new Date('2026-03-02T10:30:00Z'),
      },
      select: { id: true },
    })
    await prisma.inspectionItem.createMany({
      data: [
        { inspectionId: insp.id, room: 'Kök', item: 'Golv' },
        { inspectionId: insp.id, room: 'Badrum', item: 'Golv' },
      ],
    })
    const poster = await prisma.inspectionItem.findMany({
      where: { inspectionId: insp.id },
      orderBy: { item: 'asc' },
    })
    return { id: insp.id, poster }
  }

  const helRad = (id: string) =>
    prisma.inspection.findUniqueOrThrow({ where: { id }, include: { items: true, images: true } })

  /** Signerar med en FÄRSK vy — samma väg webben går. */
  const signera = async (id: string) => {
    const vy = await service.findOne(id, orgA)
    return service.update(
      id,
      { status: 'SIGNED', expectedContentHash: vy.contentHash } as never,
      orgA,
    )
  }

  // ══ SCENARIOT UR GRANSKNINGEN ═════════════════════════════════════════════

  it('A läser GOOD, B sätter DAMAGED/18000, A:s gamla vy AVVISAS — inget signeras', async () => {
    const { id, poster } = await nyBesiktning()

    const aVy = await service.findOne(id, orgA)
    expect(aVy.items.find((i) => i.id === poster[0]!.id)!.condition).toBe('GOOD')

    await service.updateItem(
      id,
      poster[0]!.id,
      { condition: 'DAMAGED', repairCost: 18000 } as never,
      orgA,
    )

    await expect(
      service.update(id, { status: 'SIGNED', expectedContentHash: aVy.contentHash } as never, orgA),
    ).rejects.toBeInstanceOf(ConflictException)

    // INGEN SIGNERINGSSIDOEFFEKT — mätt på raden, inte på anropet.
    const efter = await helRad(id)
    expect(efter.status).toBe('COMPLETED')
    expect(efter.signedAt).toBeNull()
    expect(efter.signedContentHash).toBeNull()
    // B:s ändring står kvar; nekandet rullade inte tillbaka någon annans arbete.
    expect(efter.items.find((i) => i.id === poster[0]!.id)!.condition).toBe('DAMAGED')
  })

  it('OMLÄST vy lyckas, och hashen binder det A då faktiskt såg', async () => {
    const { id, poster } = await nyBesiktning()
    const aVy = await service.findOne(id, orgA)
    await service.updateItem(
      id,
      poster[0]!.id,
      { condition: 'DAMAGED', repairCost: 18000 } as never,
      orgA,
    )
    await expect(
      service.update(id, { status: 'SIGNED', expectedContentHash: aVy.contentHash } as never, orgA),
    ).rejects.toBeInstanceOf(ConflictException)

    // A läser om, ser nu DAMAGED/18000, och signerar det.
    const omläst = await service.findOne(id, orgA)
    expect(omläst.items.find((i) => i.id === poster[0]!.id)!.condition).toBe('DAMAGED')
    await service.update(
      id,
      { status: 'SIGNED', expectedContentHash: omläst.contentHash } as never,
      orgA,
    )

    const efter = await helRad(id)
    expect(efter.status).toBe('SIGNED')
    expect(efter.signedContentHash).toBe(computeSignedContentHash(efter as never))
    expect(efter.signedContentHash).toBe(omläst.contentHash)
  })

  it('FÄRSK vy lyckas direkt', async () => {
    const { id } = await nyBesiktning()
    const vy = await service.findOne(id, orgA)
    await service.update(
      id,
      { status: 'SIGNED', expectedContentHash: vy.contentHash } as never,
      orgA,
    )
    const efter = await helRad(id)
    expect(efter.status).toBe('SIGNED')
    expect(efter.signedContentHash).toBe(vy.contentHash)
  })

  it('SAKNAD förutsättning → 400, ingenting signeras', async () => {
    const { id } = await nyBesiktning()
    await expect(service.update(id, { status: 'SIGNED' } as never, orgA)).rejects.toBeInstanceOf(
      BadRequestException,
    )
    const efter = await helRad(id)
    expect(efter.status).toBe('COMPLETED')
    expect(efter.signedAt).toBeNull()
  })

  // ══ VAD SOM RÄKNAS SOM RELEVANT ÄNDRING ═══════════════════════════════════

  it('BARNRAD: en ändrad post gör förutsättningen ogiltig', async () => {
    const { id, poster } = await nyBesiktning()
    const vy = await service.findOne(id, orgA)
    await service.updateItem(id, poster[1]!.id, { notes: 'Repa i lacken' } as never, orgA)
    await expect(
      service.update(id, { status: 'SIGNED', expectedContentHash: vy.contentHash } as never, orgA),
    ).rejects.toBeInstanceOf(ConflictException)
  })

  it('BARNRAD: en tillagd bild gör förutsättningen ogiltig', async () => {
    const { id } = await nyBesiktning()
    const vy = await service.findOne(id, orgA)
    await service.saveAnalysisImages(id, orgA, [
      {
        filename: 'kok.jpg',
        storageKey: `inspections/${orgA}/${randomUUID()}.jpg`,
        storageUrl: 'https://r2/x',
        caption: null,
        room: null,
        size: 10,
        contentSha256: 'd'.repeat(64),
      },
    ])
    await expect(
      service.update(id, { status: 'SIGNED', expectedContentHash: vy.contentHash } as never, orgA),
    ).rejects.toBeInstanceOf(ConflictException)
  })

  it('DEKLARERAD GRÄNS: en ändring utanför underlaget är INGEN konflikt', async () => {
    // `landlordSignature` ligger utanför `buildSignedContent` — den beskriver
    // radens livscykel, inte vad som besiktigades. Ändras bara den ska en
    // tidigare läst förutsättning fortfarande gälla.
    const { id } = await nyBesiktning()
    const vy = await service.findOne(id, orgA)
    await service.update(id, { landlordSignature: 'Bo Ek' } as never, orgA)

    await service.update(
      id,
      { status: 'SIGNED', expectedContentHash: vy.contentHash } as never,
      orgA,
    )
    const efter = await helRad(id)
    expect(efter.status).toBe('SIGNED')
    expect(efter.landlordSignature).toBe('Bo Ek')
  })

  it('EGEN ändring i samma anrop är ingen konflikt med sig själv', async () => {
    const { id } = await nyBesiktning()
    const vy = await service.findOne(id, orgA)
    await service.update(
      id,
      {
        overallCondition: 'Slitage i kök, i övrigt gott skick',
        status: 'SIGNED',
        expectedContentHash: vy.contentHash,
      } as never,
      orgA,
    )
    const efter = await helRad(id)
    expect(efter.status).toBe('SIGNED')
    expect(efter.overallCondition).toBe('Slitage i kök, i övrigt gott skick')
    // Hashen binder SLUTRESULTATET, alltså med den egna ändringen.
    expect(efter.signedContentHash).toBe(computeSignedContentHash(efter as never))
    expect(efter.signedContentHash).not.toBe(vy.contentHash)
  })

  // ══ SAMTIDIGHET ═══════════════════════════════════════════════════════════

  it('SAMTIDIGT: två signerare med samma vy — en vinner, den andra nekas', async () => {
    const { id } = await nyBesiktning()
    const vy = await service.findOne(id, orgA)

    const utfall = await Promise.all(
      [1, 2].map(() =>
        service
          .update(id, { status: 'SIGNED', expectedContentHash: vy.contentHash } as never, orgA)
          .then(
            () => 'signerade' as const,
            (e) => (e instanceof ConflictException ? ('nekad' as const) : Promise.reject(e)),
          ),
      ),
    )
    expect(utfall.filter((u) => u === 'signerade')).toHaveLength(1)
    expect(utfall.filter((u) => u === 'nekad')).toHaveLength(1)

    const efter = await helRad(id)
    expect(efter.status).toBe('SIGNED')
  })

  it('SAMTIDIGT: den andra signeraren nekas av FÖRUTSÄTTNINGEN, inte bara av spärren', async () => {
    // Utan den här assertionen mäter provet ovan ingenting om förutsättningen:
    // steg 1:s statusspärr nekar redan ett andra försök, och BÅDA kastar
    // ConflictException. Meddelandet är det enda som skiljer dem åt.
    const { id, poster } = await nyBesiktning()
    const vy = await service.findOne(id, orgA)
    await service.updateItem(id, poster[0]!.id, { condition: 'DAMAGED' } as never, orgA)

    const fel = await service
      .update(id, { status: 'SIGNED', expectedContentHash: vy.contentHash } as never, orgA)
      .catch((e: Error) => e)

    expect(fel).toBeInstanceOf(ConflictException)
    expect((fel as Error).message).toMatch(/ändrats sedan du läste det/i)
    expect((fel as Error).message).not.toBe(BESIKTNING_SIGNERAD_MEDDELANDE)
  })

  // ══ BILAGANS DIGEST NÅR FAKTISKT DATABASEN ════════════════════════════════

  it('en sparad bild bär sha256 över DE BYTES som laddades upp', async () => {
    // Källsvepet i `inspection-image-bytes.spec.ts` visar att controllern
    // RÄKNAR digesten ur `f.buffer`. Det här provet visar att värdet också
    // hamnar på raden — en källsökning kan inte se det.
    const { id } = await nyBesiktning()
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('KOKSGOLV')])
    const digest = createHash('sha256').update(bytes).digest('hex')

    await service.saveAnalysisImages(id, orgA, [
      {
        filename: 'kok.jpg',
        storageKey: `inspections/${orgA}/${randomUUID()}.jpg`,
        storageUrl: 'https://r2/x',
        caption: null,
        room: null,
        size: bytes.length,
        contentSha256: digest,
      },
    ])

    const bild = await prisma.inspectionImage.findFirstOrThrow({ where: { inspectionId: id } })
    expect(bild.contentSha256).toBe(digest)
  })

  it('digesten är med i det SIGNERADE underlaget — byts den ändras hashen', async () => {
    const { id } = await nyBesiktning()
    const bytes = Buffer.from('ORIGINALBILD')
    await service.saveAnalysisImages(id, orgA, [
      {
        filename: 'kok.jpg',
        storageKey: `inspections/${orgA}/${randomUUID()}.jpg`,
        storageUrl: 'https://r2/x',
        caption: null,
        room: null,
        size: bytes.length,
        contentSha256: createHash('sha256').update(bytes).digest('hex'),
      },
    ])
    const signerad = await signera(id)

    // Efterliknar att objektet bakom nyckeln bytts: samma rad, samma nyckel,
    // samma storlek — bara innehållet är ett annat. Mätningen mot syntetiskt
    // objektlager visar att lagringsporten tillåter exakt det.
    const bild = await prisma.inspectionImage.findFirstOrThrow({ where: { inspectionId: id } })
    await prisma.inspectionImage.update({
      where: { id: bild.id },
      data: { contentSha256: createHash('sha256').update('UTBYTTBILD').digest('hex') },
    })

    const nu = await helRad(id)
    expect(nu.images[0]!.storageKey).toBe(bild.storageKey)
    expect(nu.images[0]!.size).toBe(bild.size)
    // Signaturen matchar inte längre innehållet — det är hela poängen.
    expect(computeSignedContentHash(nu as never)).not.toBe(signerad.signedContentHash)
  })

  it('contentHash finns även i LISTAN — det är den vy webben signerar ifrån', async () => {
    const { id } = await nyBesiktning()
    const lista = await service.findAll(orgA)
    const rad = lista.find((i) => i.id === id)!
    expect(rad.contentHash).toMatch(/^[0-9a-f]{64}$/)
    await service.update(
      id,
      { status: 'SIGNED', expectedContentHash: rad.contentHash } as never,
      orgA,
    )
    expect((await helRad(id)).status).toBe('SIGNED')
  })
})
