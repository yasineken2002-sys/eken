/**
 * F025 MOT RIKTIG POSTGRES — spärren som HÅLLER, inte bara finns.
 *
 * ── VARFÖR DEN HÄR FILEN MÅSTE FINNAS ───────────────────────────────────────
 *
 * Enhetsprovet bredvid (`inspection-signature-lock.spec.ts`) mäter att varje
 * skrivväg frågar efter status. Det kan inte mäta det som gör frågan värd
 * någonting: att två samtidiga skrivare inte båda får ja. En stubbad prisma har
 * inga lås, ingen isoleringsnivå och ingen `FOR UPDATE` — mot den ser en ren
 * `if (status === 'SIGNED')` exakt lika trygg ut som ett radlås.
 *
 * Och invarianten ÄR samtidig. Fönstret är inte teoretiskt: analysvägen håller
 * det öppet under hela vision-modellens svarstid.
 *
 * ── DET RÖDA PROVET ─────────────────────────────────────────────────────────
 *
 * `manöverN ur fyndet` nedan är A055:s justerade formulering, ordagrant:
 * ingen endpoint SKAPAR en ny post via `updateItem` — manövern är att vända en
 * BEFINTLIG post GOOD → DAMAGED och sätta `repairCost`. Mot basrevisionen
 * lyckas den. Det är provet som ska falla när rättningen tas bort.
 *
 * ── VAD PROVEN INTE BEVISAR ─────────────────────────────────────────────────
 *
 *   • Ingenting om HTTP-lagret. Proven går på tjänsten; att `@Roles` sitter kvar
 *     på controllern ägs av authz-sviten, inte av den här filen.
 *   • Ingenting om vem som skrev under. `SIGNED` betyder fortfarande att
 *     hyresvärden tryckte på en knapp — `tenantSignature` fylls av ingen yta i
 *     produkten (F2b i A061). Spärren fryser det som signerades; den gör inte
 *     signeringen till hyresgästens.
 *   • Ingenting om protokoll som signerades FÖRE migrationen. De fryses från och
 *     med nu, men `signedContentHash` är NULL och kan inte räknas fram i
 *     efterhand, så en ändring som redan hunnit ske går inte att upptäcka.
 *   • Ingenting om en skrivare som går förbi tjänstelagret — rå SQL mot
 *     databasen stoppas inte av något här.
 */
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { randomUUID } from 'node:crypto'

import { ConflictException, NotFoundException } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

import { InspectionsService } from './inspections.service'
import { computeSignedContentHash } from './inspection-signature'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('F025 — frysning av signerat besiktningsprotokoll', () => {
  let prisma: PrismaClient
  let service: InspectionsService
  let orgA: string
  let orgB: string
  let propA: string
  let unitA: string
  let userA: string

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

  /** Ett protokoll med de 20 standardposterna, i valt läge. */
  const nyBesiktning = async (över: Record<string, unknown> = {}) => {
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
        ...över,
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

  /**
   * Signerar via tjänsten — samma väg produkten använder.
   *
   * Läser först ut `contentHash` precis som webben gör, och ekar tillbaka den
   * som `expectedContentHash`. Signering UTAN förutsättning är numera 400; att
   * den här hjälparen hämtar en färsk hash är alltså inte en genväg förbi
   * kontrollen utan exakt vad en klient med en aktuell vy gör.
   */
  const signera = async (id: string) => {
    const vy = await service.findOne(id, orgA)
    return service.update(
      id,
      { status: 'SIGNED', expectedContentHash: vy.contentHash } as never,
      orgA,
    )
  }

  beforeAll(async () => {
    prisma = new PrismaClient()
    await prisma.$connect()
    service = new InspectionsService(prisma as never, {} as never, {} as never)

    orgA = await nyOrg('f025-a')
    orgB = await nyOrg('f025-b')
    const f = await nyFastighet(orgA)
    propA = f.propertyId
    unitA = f.unitId
    const u = await prisma.user.create({
      data: {
        organizationId: orgA,
        email: `f025-${randomUUID().slice(0, 8)}@example.se`,
        firstName: 'Besiktnings',
        lastName: 'Ansvarig',
        role: 'ADMIN',
      },
      select: { id: true },
    })
    userA = u.id
  })

  afterAll(async () => {
    // Städar ENBART det den här filen skapade. Organisationen är roten och
    // `onDelete: Cascade` tar resten.
    for (const id of [orgA, orgB]) {
      await prisma.organization.delete({ where: { id } }).catch(() => undefined)
    }
    await prisma.$disconnect()
  })

  // ══ DET RÖDA PROVET ═══════════════════════════════════════════════════════

  it('MANÖVERN UR FYNDET: GOOD → DAMAGED med repairCost efter signering avvisas', async () => {
    const { id, poster } = await nyBesiktning()
    await signera(id)

    await expect(
      service.updateItem(
        id,
        poster[0]!.id,
        { condition: 'DAMAGED', repairCost: 18000 } as never,
        orgA,
      ),
    ).rejects.toBeInstanceOf(ConflictException)

    // Och raden är OFÖRÄNDRAD i databasen — inte bara "anropet kastade".
    const efter = await prisma.inspectionItem.findUniqueOrThrow({ where: { id: poster[0]!.id } })
    expect(efter.condition).toBe('GOOD')
    expect(efter.repairCost).toBeNull()
  })

  it('hela protokollet kan inte raderas när det är signerat — poster och bilder finns kvar', async () => {
    const { id, poster } = await nyBesiktning()
    await signera(id)

    await expect(service.delete(id, orgA)).rejects.toBeInstanceOf(ConflictException)

    expect(await prisma.inspection.findUnique({ where: { id } })).not.toBeNull()
    // `onDelete: Cascade` hade tagit barnraderna med sig.
    expect(await prisma.inspectionItem.count({ where: { inspectionId: id } })).toBe(poster.length)
  })

  it('update() på ett signerat protokoll ändrar ingenting', async () => {
    const { id } = await nyBesiktning()
    await signera(id)
    const före = await prisma.inspection.findUniqueOrThrow({ where: { id } })

    await expect(
      service.update(id, { overallCondition: 'Omskrivet i efterhand' } as never, orgA),
    ).rejects.toBeInstanceOf(ConflictException)

    const efter = await prisma.inspection.findUniqueOrThrow({ where: { id } })
    expect(efter.overallCondition).toBe(före.overallCondition)
    expect(efter.signedAt).toEqual(före.signedAt)
    expect(efter.signedContentHash).toBe(före.signedContentHash)
  })

  it('analysens skrivning avvisas och lämnar protokollet orört', async () => {
    const { id, poster } = await nyBesiktning()
    await signera(id)

    await expect(
      service.applyAnalysis(id, orgA, {
        overallCondition: 'AI: omfattande skador',
        notes: 'AI',
        items: [
          {
            room: 'Kök',
            item: 'Golv',
            condition: 'DAMAGED' as never,
            notes: 'AI',
            repairCost: 9000,
          },
          {
            room: 'Hall',
            item: 'Tak',
            condition: 'DAMAGED' as never,
            notes: 'AI',
            repairCost: 4000,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ConflictException)

    // Varken uppdatering av en befintlig post eller en NY post (analysvägen är
    // den enda väg som skapar poster efter `create`).
    expect(await prisma.inspectionItem.count({ where: { inspectionId: id } })).toBe(poster.length)
    const kök = await prisma.inspectionItem.findUniqueOrThrow({ where: { id: poster[1]!.id } })
    expect(kök.condition).toBe('GOOD')
  })

  it('analysens bilder avvisas — bilden är en del av beviset', async () => {
    const { id } = await nyBesiktning()
    await signera(id)

    await expect(
      service.saveAnalysisImages(id, orgA, [
        {
          filename: 'kok.jpg',
          storageKey: `inspections/${orgA}/${randomUUID()}.jpg`,
          storageUrl: 'https://r2/x',
          caption: 'Efterhandsbild',
          room: null,
          size: 4096,
          contentSha256: 'c'.repeat(64),
        },
      ]),
    ).rejects.toBeInstanceOf(ConflictException)

    expect(await prisma.inspectionImage.count({ where: { inspectionId: id } })).toBe(0)
  })

  it('DUBBEL SIGNERING: andra försöket avvisas och den första tidpunkten står kvar', async () => {
    const { id } = await nyBesiktning()
    const första = await signera(id)

    await expect(signera(id)).rejects.toBeInstanceOf(ConflictException)

    const efter = await prisma.inspection.findUniqueOrThrow({ where: { id } })
    expect(efter.signedAt).toEqual(första.signedAt)
  })

  // ══ SAMTIDIGHET — INVARIANTEN LIGGER I DATABASEN ══════════════════════════

  /**
   * ── VARFÖR DE HÄR TVÅ PROVEN SER UT SOM DE GÖR ────────────────────────────
   *
   * Ett prov som bara startar två anrop samtidigt och hoppas på en kollision
   * bevisar ingenting: schemaläggningen avgör utfallet, och provet är grönt
   * ÄVEN UTAN LÅS så snart det ena hinner committa först. Det är precis den
   * sortens prov som gjorde att F017 kunde stå grön medan buggen fanns.
   *
   * Proven nedan HÅLLER därför den ena transaktionen öppen med en spärr i
   * testkoden, och asserterar att den andra INTE HAR KOMMIT VIDARE medan låset
   * hålls. Den assertionen är omöjlig att uppfylla utan `FOR UPDATE` — utan
   * låset läser den andra transaktionen radens committade tillstånd direkt och
   * går klart. Det är alltså den assertionen som faller i negativkontrollen.
   */
  it('SIGNERING HÅLLER LÅSET → den samtidiga redigeringen BLOCKERAR och nekas sedan', async () => {
    const { id, poster } = await nyBesiktning()

    let släpp!: () => void
    const spärr = new Promise<void>((r) => {
      släpp = r
    })

    // Efterliknar signeringens transaktion: tar radlåset och HÅLLER det.
    const signeringsTx = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Inspection" WHERE id = ${id} AND "organizationId" = ${orgA} FOR UPDATE`
        await spärr
        await tx.inspection.update({
          where: { id },
          data: { status: 'SIGNED', signedAt: new Date() },
        })
      },
      { timeout: 20_000, maxWait: 10_000 },
    )

    await new Promise((r) => setTimeout(r, 250)) // låt låset hinna tas

    let avslutad = false
    const redigering = service
      .updateItem(id, poster[0]!.id, { condition: 'DAMAGED', repairCost: 12000 } as never, orgA)
      .then(
        () => {
          avslutad = true
          return 'skrev' as const
        },
        (e) => {
          avslutad = true
          if (e instanceof ConflictException) return 'nekad' as const
          throw e
        },
      )

    await new Promise((r) => setTimeout(r, 500))
    // BEVISET: redigeringen står still på `FOR UPDATE`. Utan låset hade den
    // läst COMPLETED (READ COMMITTED visar inte den andres ocommittade
    // skrivning) och redan hunnit skriva.
    expect(avslutad).toBe(false)

    släpp()
    await signeringsTx
    expect(await redigering).toBe('nekad')

    const efter = await prisma.inspectionItem.findUniqueOrThrow({ where: { id: poster[0]!.id } })
    expect(efter.condition).toBe('GOOD')
    expect(efter.repairCost).toBeNull()
  })

  it('REDIGERING HÅLLER LÅSET → signeringen BLOCKERAR, nekas sedan, och lyckas efter omläsning', async () => {
    // Den andra riktningen. Den mäter två saker på en gång:
    //   1. LÅSET — signeringen står still medan redigeringen håller raden.
    //   2. FÖRUTSÄTTNINGEN — signeraren läste FÖRE redigeringen, så när låset
    //      släpps får hen inte signera det ändrade innehållet. Före
    //      `expectedContentHash` gjorde hen precis det.
    const { id, poster } = await nyBesiktning()

    // Signerarens vy, hämtad INNAN redigeringen ens börjar.
    const gammalVy = await service.findOne(id, orgA)

    let släpp!: () => void
    const spärr = new Promise<void>((r) => {
      släpp = r
    })

    const redigeringsTx = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Inspection" WHERE id = ${id} AND "organizationId" = ${orgA} FOR UPDATE`
        await spärr
        await tx.inspectionItem.update({
          where: { id: poster[0]!.id },
          data: { condition: 'DAMAGED', repairCost: 7500 },
        })
      },
      { timeout: 20_000, maxWait: 10_000 },
    )

    await new Promise((r) => setTimeout(r, 250))

    let avslutad = false
    const signering = service
      .update(id, { status: 'SIGNED', expectedContentHash: gammalVy.contentHash } as never, orgA)
      .then(
        () => {
          avslutad = true
          return 'signerade' as const
        },
        (e) => {
          avslutad = true
          if (e instanceof ConflictException) return 'nekad' as const
          throw e
        },
      )

    await new Promise((r) => setTimeout(r, 500))
    expect(avslutad).toBe(false) // signeringen står still på låset

    släpp()
    await redigeringsTx
    expect(await signering).toBe('nekad')

    // Ingen signeringssidoeffekt: protokollet är fortfarande öppet.
    const efterNekandet = await prisma.inspection.findUniqueOrThrow({ where: { id } })
    expect(efterNekandet.status).toBe('COMPLETED')
    expect(efterNekandet.signedAt).toBeNull()
    expect(efterNekandet.signedContentHash).toBeNull()

    // OMLÄST VY LYCKAS — och binder det redigerade innehållet.
    const signerad = await signera(id)
    const fullständig = await prisma.inspection.findUniqueOrThrow({
      where: { id },
      include: { items: true, images: true },
    })
    const post = fullständig.items.find((i) => i.id === poster[0]!.id)!
    expect(post.condition).toBe('DAMAGED')
    expect(Number(post.repairCost)).toBe(7500)
    expect(signerad.signedContentHash).toBe(computeSignedContentHash(fullständig as never))
  })

  it('hashen skiljer två protokoll med olika innehåll åt', async () => {
    const { id, poster } = await nyBesiktning()
    await service.updateItem(id, poster[0]!.id, { condition: 'DAMAGED' } as never, orgA)
    const a = await signera(id)

    const orört = await nyBesiktning()
    const b = await signera(orört.id)

    expect(a.signedContentHash).not.toBe(b.signedContentHash)
  })

  // ══ FEL OCH ROLLBACK ══════════════════════════════════════════════════════

  it('ROLLBACK: faller analysen halvvägs skrivs ingenting alls', async () => {
    const { id, poster } = await nyBesiktning()

    await expect(
      service.applyAnalysis(id, orgA, {
        overallCondition: 'Delvis',
        notes: 'AI',
        items: [
          // Först en giltig uppdatering …
          {
            room: 'Kök',
            item: 'Golv',
            condition: 'DAMAGED' as never,
            notes: 'ok',
            repairCost: 500,
          },
          // … sedan ett belopp som spränger Decimal(10,2) och fäller satsen.
          {
            room: 'Badrum',
            item: 'Golv',
            condition: 'DAMAGED' as never,
            notes: 'spräng',
            repairCost: 99999999999,
          },
        ],
      }),
    ).rejects.toBeTruthy()

    // Den FÖRSTA uppdateringen får inte ha överlevt. Låg skrivningarna utanför
    // en transaktion hade protokollet stått halvskrivet.
    const kök = await prisma.inspectionItem.findUniqueOrThrow({ where: { id: poster[1]!.id } })
    expect(kök.condition).toBe('GOOD')
    expect(kök.repairCost).toBeNull()
    void poster
  })

  // ══ ORGANISATIONSGRÄNSEN ══════════════════════════════════════════════════

  it('ORGANISATIONSGRÄNSEN: orgB ser varken protokollet eller dess status', async () => {
    const { id, poster } = await nyBesiktning()
    await signera(id)

    // NotFound, inte Conflict: skillnaden hade varit ett existensorakel för en
    // annan kunds protokoll.
    await expect(service.delete(id, orgB)).rejects.toBeInstanceOf(NotFoundException)
    await expect(service.update(id, { notes: 'x' } as never, orgB)).rejects.toBeInstanceOf(
      NotFoundException,
    )
    await expect(
      service.updateItem(id, poster[0]!.id, { condition: 'DAMAGED' } as never, orgB),
    ).rejects.toBeInstanceOf(NotFoundException)

    expect(await prisma.inspection.findUnique({ where: { id } })).not.toBeNull()
  })

  // ══ ÖPPNA PROTOKOLL SKA FORTSÄTTA FUNGERA ═════════════════════════════════

  it.each(['SCHEDULED', 'IN_PROGRESS', 'COMPLETED'] as const)(
    'ett öppet protokoll (%s) går fortfarande att redigera och radera',
    async (status) => {
      const { id, poster } = await nyBesiktning({ status })

      await service.updateItem(
        id,
        poster[0]!.id,
        { condition: 'DAMAGED', repairCost: 4500 } as never,
        orgA,
      )
      const post = await prisma.inspectionItem.findUniqueOrThrow({ where: { id: poster[0]!.id } })
      expect(post.condition).toBe('DAMAGED')
      expect(Number(post.repairCost)).toBe(4500)

      await service.update(id, { overallCondition: 'Slitage i kök' } as never, orgA)
      await service.delete(id, orgA)
      expect(await prisma.inspection.findUnique({ where: { id } })).toBeNull()
    },
  )

  it('signeringen sätter tidpunkt och hash i samma transaktion som statusbytet', async () => {
    const { id } = await nyBesiktning()
    const före = Date.now()
    await signera(id)
    const efter = Date.now()

    const rad = await prisma.inspection.findUniqueOrThrow({ where: { id } })
    expect(rad.status).toBe('SIGNED')
    expect(rad.signedAt).not.toBeNull()
    expect(rad.signedAt!.getTime()).toBeGreaterThanOrEqual(före - 1000)
    expect(rad.signedAt!.getTime()).toBeLessThanOrEqual(efter + 1000)
    expect(rad.signedContentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  // ══ TIDSSTÄMPLARNA PÅ BARNRADEN ═══════════════════════════════════════════

  it('NYA poster får createdAt; en ändring sätter updatedAt', async () => {
    const { id, poster } = await nyBesiktning()

    const nyss = await prisma.inspectionItem.findUniqueOrThrow({ where: { id: poster[0]!.id } })
    expect(nyss.createdAt).not.toBeNull()
    // `@updatedAt` sätts av Prisma vid UPDATE, inte vid INSERT.
    const innan = nyss.updatedAt

    await service.updateItem(id, poster[0]!.id, { notes: 'Repa i lacken' } as never, orgA)

    const efter = await prisma.inspectionItem.findUniqueOrThrow({ where: { id: poster[0]!.id } })
    expect(efter.updatedAt).not.toBeNull()
    expect(efter.updatedAt).not.toEqual(innan)
    expect(efter.createdAt).toEqual(nyss.createdAt)
  })

  it('ÄLDRE rader har NULL — migrationen stämplade inte om dem', async () => {
    const { id } = await nyBesiktning()
    // Efterliknar en rad som fanns före migrationen: kolumnerna lades till utan
    // default, så gamla rader bär NULL. NULL BETYDER OKÄNT, inte "skapad nu".
    const gammal = await prisma.inspectionItem.create({
      data: { inspectionId: id, room: 'Hall', item: 'Golv' },
      select: { id: true },
    })
    await prisma.$executeRaw`UPDATE "InspectionItem" SET "createdAt" = NULL, "updatedAt" = NULL WHERE id = ${gammal.id}`

    const rad = await prisma.inspectionItem.findUniqueOrThrow({ where: { id: gammal.id } })
    expect(rad.createdAt).toBeNull()
    expect(rad.updatedAt).toBeNull()
  })
})
