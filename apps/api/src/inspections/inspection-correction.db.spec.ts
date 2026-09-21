/**
 * RÄTTELSEVERSIONER MOT RIKTIG POSTGRES.
 *
 * ── VARFÖR DEN HÄR FILEN MÅSTE GÅ MOT EN RIKTIG DATABAS ─────────────────────
 *
 * Tre av invarianterna nedan går inte att mäta mot en stubb, och det är precis
 * de tre som bär:
 *
 *   1. ATT ORIGINALET ÄR ORÖRT. En stubb svarar vad den blivit tillsagd. Bara
 *      en riktig rad kan läsas tillbaka och jämföras fält för fält med vad den
 *      var före rättelsen.
 *   2. ATT TVÅ SAMTIDIGA RÄTTELSER GER EN VINNARE. En stubbad prisma har inga
 *      lås, ingen isoleringsnivå och inga unika villkor. Mot den ser en naiv
 *      läs-sedan-skriv-kontroll exakt lika trygg ut som ett radlås plus ett
 *      unikt index.
 *   3. ATT DEPOSITIONEN INTE RÖRS. Avdragen är bokförd räkenskapsinformation.
 *      Ett prov som frågar en mock om den blev anropad mäter anropet; det här
 *      provet läser raden.
 *
 * ── VAD PROVEN INTE BEVISAR ─────────────────────────────────────────────────
 *
 *   • Ingenting om HTTP-lagret. `@Roles` på controllern ägs av authz-sviten.
 *   • Ingenting om lagringen. Bildraderna kopieras med samma `storageKey`;
 *     att objektet bakom nyckeln finns kvar prövas av bildkontrollen, inte här.
 *   • Ingenting om vem som skrev under. `SIGNED` betyder fortfarande att
 *     hyresvärden tryckte på en knapp.
 *   • Ingenting om en skrivare som går förbi tjänstelagret.
 */
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { randomUUID } from 'node:crypto'

import { ConflictException, NotFoundException } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

import { InspectionsService } from './inspections.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('rättelseversioner av ett slutfört protokoll', () => {
  let prisma: PrismaClient
  let service: InspectionsService
  let orgA: string
  let orgB: string
  let propA: string
  let unitA: string
  let userA: string
  let userA2: string
  let tenantA: string
  let leaseA: string

  const bildkontrollStub = {
    kontrolleraBilder: async () => [],
    sammanfatta: () => 'INGA_BILDER' as const,
  }

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

  /** Protokoll med två poster och två bilagor — bilagorna är hela poängen. */
  const nyBesiktning = async (över: Record<string, unknown> = {}) => {
    const insp = await prisma.inspection.create({
      data: {
        organizationId: orgA,
        propertyId: propA,
        unitId: unitA,
        leaseId: leaseA,
        tenantId: tenantA,
        inspectedById: userA,
        type: 'MOVE_OUT',
        status: 'COMPLETED',
        scheduledDate: new Date('2026-03-02T09:00:00Z'),
        completedAt: new Date('2026-03-02T10:30:00Z'),
        overallCondition: 'Godtagbart skick',
        notes: 'Originalets anteckning',
        ...över,
      },
      select: { id: true },
    })
    await prisma.inspectionItem.createMany({
      data: [
        { inspectionId: insp.id, room: 'Kök', item: 'Golv', condition: 'GOOD' },
        {
          inspectionId: insp.id,
          room: 'Badrum',
          item: 'Golv',
          condition: 'DAMAGED',
          repairCost: 4500,
          notes: 'Spricka i klinker',
        },
      ],
    })
    await prisma.inspectionImage.createMany({
      data: [
        {
          inspectionId: insp.id,
          filename: 'kok.jpg',
          storageKey: `inspections/${orgA}/${randomUUID()}.jpg`,
          storageUrl: 'https://exempel/kok.jpg',
          size: 1234,
          contentSha256: 'a'.repeat(64),
        },
        {
          // Utan digest — en bilaga från tiden före kolumnen fanns.
          inspectionId: insp.id,
          filename: 'badrum.jpg',
          storageKey: `inspections/${orgA}/${randomUUID()}.jpg`,
          storageUrl: 'https://exempel/badrum.jpg',
          size: 2345,
          contentSha256: null,
        },
      ],
    })
    return insp.id
  }

  const signera = async (id: string) => {
    const vy = await service.findOne(id, orgA)
    return service.update(
      id,
      { status: 'SIGNED', expectedContentHash: vy.contentHash } as never,
      orgA,
    )
  }

  const rattelse = async (id: string, orsak = 'Fel rum angavs i badrumsposten') => {
    const vy = await service.findOne(id, orgA)
    return service.skapaRattelse(id, { orsak, expectedContentHash: vy.contentHash }, orgA, userA2)
  }

  beforeAll(async () => {
    prisma = new PrismaClient()
    await prisma.$connect()
    service = new InspectionsService(
      prisma as never,
      {} as never,
      {} as never,
      bildkontrollStub as never,
    )

    orgA = await nyOrg('rattelse-a')
    orgB = await nyOrg('rattelse-b')
    const f = await nyFastighet(orgA)
    propA = f.propertyId
    unitA = f.unitId

    const användare = await prisma.user.createManyAndReturn({
      data: [
        {
          organizationId: orgA,
          email: `rattelse-${randomUUID().slice(0, 8)}@example.se`,
          firstName: 'Besiktnings',
          lastName: 'Ansvarig',
          role: 'ADMIN',
        },
        {
          organizationId: orgA,
          email: `rattelse-${randomUUID().slice(0, 8)}@example.se`,
          firstName: 'Rättande',
          lastName: 'Förvaltare',
          role: 'MANAGER',
        },
      ],
      select: { id: true },
    })
    userA = användare[0]!.id
    userA2 = användare[1]!.id

    const t = await prisma.tenant.create({
      data: {
        organizationId: orgA,
        type: 'INDIVIDUAL',
        firstName: 'Hyres',
        lastName: 'Gäst',
        email: `hg-${randomUUID().slice(0, 8)}@example.se`,
      },
      select: { id: true },
    })
    tenantA = t.id

    const l = await prisma.lease.create({
      data: {
        organizationId: orgA,
        unitId: unitA,
        tenantId: tenantA,
        startDate: new Date('2025-01-01T00:00:00Z'),
        tenancyStartDate: new Date('2025-01-01T00:00:00Z'),
        monthlyRent: 9500,
        depositAmount: 19000,
        status: 'TERMINATED',
      },
      select: { id: true },
    })
    leaseA = l.id
  })

  afterAll(async () => {
    for (const id of [orgA, orgB]) {
      // Depositionen har `onDelete: Restrict` mot organisationen (BFL) och
      // måste därför bort först. Filen städar ENBART det den själv skapade.
      await prisma.deposit.deleteMany({ where: { organizationId: id } }).catch(() => undefined)
      await prisma.organization.delete({ where: { id } }).catch(() => undefined)
    }
    await prisma.$disconnect()
  })

  // ══ ORIGINALET BEVARAS ════════════════════════════════════════════════════

  it('ORIGINALET ÄR BYTE-IDENTISKT EFTERÅT — poster, bilagor, signatur och hash', async () => {
    const id = await nyBesiktning()
    await signera(id)

    const före = await prisma.inspection.findUniqueOrThrow({
      where: { id },
      include: { items: { orderBy: { id: 'asc' } }, images: { orderBy: { id: 'asc' } } },
    })

    await rattelse(id)

    const efter = await prisma.inspection.findUniqueOrThrow({
      where: { id },
      include: { items: { orderBy: { id: 'asc' } }, images: { orderBy: { id: 'asc' } } },
    })

    // ALLT utom `correction`-relationen, som inte är ett fält på raden.
    expect(efter.status).toBe(före.status)
    expect(efter.signedAt).toEqual(före.signedAt)
    expect(efter.signedContentHash).toBe(före.signedContentHash)
    expect(efter.notes).toBe(före.notes)
    expect(efter.overallCondition).toBe(före.overallCondition)
    expect(efter.completedAt).toEqual(före.completedAt)
    expect(efter.version).toBe(1)
    expect(efter.correctionOfId).toBeNull()
    expect(efter.correctionReason).toBeNull()
    expect(efter.updatedAt).toEqual(före.updatedAt)

    expect(efter.items).toEqual(före.items)
    expect(efter.images).toEqual(före.images)
  })

  it('bilagorna KOPIERAS med samma lagringsnyckel och samma digest — ingen fil rörs', async () => {
    const id = await nyBesiktning()
    await signera(id)
    const ny = await rattelse(id)

    const original = await prisma.inspectionImage.findMany({
      where: { inspectionId: id },
      orderBy: { filename: 'asc' },
    })
    const kopia = await prisma.inspectionImage.findMany({
      where: { inspectionId: ny.id },
      orderBy: { filename: 'asc' },
    })

    expect(kopia).toHaveLength(original.length)
    for (let i = 0; i < original.length; i++) {
      // Egna rader (eget id, egen förälder) men SAMMA objekt och SAMMA digest.
      expect(kopia[i]!.id).not.toBe(original[i]!.id)
      expect(kopia[i]!.inspectionId).toBe(ny.id)
      expect(kopia[i]!.storageKey).toBe(original[i]!.storageKey)
      expect(kopia[i]!.contentSha256).toBe(original[i]!.contentSha256)
      expect(kopia[i]!.size).toBe(original[i]!.size)
    }
    // Bilagan UTAN digest får inte tilldelas en i kopian — okänt förblir okänt.
    expect(kopia.some((b) => b.contentSha256 === null)).toBe(true)
  })

  // ══ DEN NYA VERSIONEN ═════════════════════════════════════════════════════

  it('den nya versionen är ett UTKAST med orsak, aktör och SERVERNS datum', async () => {
    const id = await nyBesiktning()
    await signera(id)

    const före = Date.now()
    const ny = await rattelse(id, 'Reparationskostnaden avsåg fel lägenhet')
    const efter = Date.now()

    expect(ny.status).toBe('IN_PROGRESS')
    expect(ny.version).toBe(2)
    expect(ny.correctionOfId).toBe(id)
    expect(ny.correctionReason).toBe('Reparationskostnaden avsåg fel lägenhet')
    expect(ny.correctedById).toBe(userA2)
    expect(ny.correctedAt!.getTime()).toBeGreaterThanOrEqual(före)
    expect(ny.correctedAt!.getTime()).toBeLessThanOrEqual(efter)

    // Utkastet får INTE se ut som slutfört.
    expect(ny.signedAt).toBeNull()
    expect(ny.signedContentHash).toBeNull()
    expect(ny.completedAt).toBeNull()
  })

  it('DET GAMLA PROTOKOLLET GÄLLER TILLS ERSÄTTAREN SLUTFÖRTS', async () => {
    const id = await nyBesiktning()
    await signera(id)
    const ny = await rattelse(id)

    const underArbete = await service.hamtaVersioner(id, orgA)
    expect(underArbete.map((v) => [v.version, v.arGallande, v.arUtkast])).toEqual([
      [1, true, false],
      [2, false, true],
    ])

    // Slutför ersättaren genom den BEFINTLIGA signeringsvägen.
    const vy = await service.findOne(ny.id, orgA)
    await service.update(
      ny.id,
      { status: 'SIGNED', expectedContentHash: vy.contentHash } as never,
      orgA,
    )

    const efteråt = await service.hamtaVersioner(id, orgA)
    expect(efteråt.map((v) => [v.version, v.arGallande, v.arUtkast])).toEqual([
      [1, false, false],
      [2, true, false],
    ])
  })

  it('en rättelse kan i sin tur rättas — kedjan håller i tre led', async () => {
    const id = await nyBesiktning()
    await signera(id)
    const v2 = await rattelse(id)
    const vy2 = await service.findOne(v2.id, orgA)
    await service.update(
      v2.id,
      { status: 'SIGNED', expectedContentHash: vy2.contentHash } as never,
      orgA,
    )
    const v3 = await service.skapaRattelse(
      v2.id,
      { orsak: 'Även bildtexten var fel i version 2', expectedContentHash: vy2.contentHash },
      orgA,
      userA2,
    )

    expect(v3.version).toBe(3)
    // Kedjan är densamma oavsett vilken länk man frågar ifrån.
    for (const start of [id, v2.id, v3.id]) {
      const kedja = await service.hamtaVersioner(start, orgA)
      expect(kedja.map((v) => v.version)).toEqual([1, 2, 3])
      expect(kedja.filter((v) => v.arGallande).map((v) => v.version)).toEqual([2])
    }
  })

  // ══ SPÄRRARNA ═════════════════════════════════════════════════════════════

  it('ett PÅGÅENDE protokoll kan inte rättas — det ändras på plats', async () => {
    const id = await nyBesiktning({ status: 'IN_PROGRESS', completedAt: null })
    const vy = await service.findOne(id, orgA)
    await expect(
      service.skapaRattelse(
        id,
        { orsak: 'Vill rätta ett utkast', expectedContentHash: vy.contentHash },
        orgA,
        userA2,
      ),
    ).rejects.toBeInstanceOf(ConflictException)
  })

  it('GAMMAL KLIENTVY: en inaktuell expectedContentHash fälls, och INGET skapas', async () => {
    const id = await nyBesiktning()
    const gammalVy = await service.findOne(id, orgA)
    // Någon annan hinner ändra protokollet innan rättelsen skickas.
    await service.update(id, { notes: 'Ändrad av någon annan' } as never, orgA)
    await signera(id)

    await expect(
      service.skapaRattelse(
        id,
        {
          orsak: 'Utgår från en vy jag inte längre har',
          expectedContentHash: gammalVy.contentHash,
        },
        orgA,
        userA2,
      ),
    ).rejects.toBeInstanceOf(ConflictException)

    expect(await prisma.inspection.count({ where: { correctionOfId: id } })).toBe(0)
  })

  it('SAMTIDIGHET: två parallella rättelser av samma version ger EXAKT en vinnare', async () => {
    const id = await nyBesiktning()
    await signera(id)
    const vy = await service.findOne(id, orgA)

    const utfall = await Promise.allSettled([
      service.skapaRattelse(
        id,
        { orsak: 'Förvaltare A rättar badrumsposten', expectedContentHash: vy.contentHash },
        orgA,
        userA,
      ),
      service.skapaRattelse(
        id,
        { orsak: 'Förvaltare B rättar köksposten', expectedContentHash: vy.contentHash },
        orgA,
        userA2,
      ),
    ])

    const lyckade = utfall.filter((u) => u.status === 'fulfilled')
    const misslyckade = utfall.filter((u) => u.status === 'rejected')
    expect(lyckade).toHaveLength(1)
    expect(misslyckade).toHaveLength(1)
    expect((misslyckade[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException)

    // Och databasen har EN rättelse, inte två.
    expect(await prisma.inspection.count({ where: { correctionOfId: id } })).toBe(1)
  })

  it('en version som redan rättats kan inte rättas igen', async () => {
    const id = await nyBesiktning()
    await signera(id)
    const vy = await service.findOne(id, orgA)
    await service.skapaRattelse(
      id,
      { orsak: 'Första rättelsen av den här versionen', expectedContentHash: vy.contentHash },
      orgA,
      userA2,
    )
    await expect(
      service.skapaRattelse(
        id,
        { orsak: 'Andra rättelsen av samma version', expectedContentHash: vy.contentHash },
        orgA,
        userA2,
      ),
    ).rejects.toBeInstanceOf(ConflictException)
  })

  it('ORG-ISOLERING: en främmande org kan varken rätta eller läsa kedjan', async () => {
    const id = await nyBesiktning()
    await signera(id)
    const vy = await service.findOne(id, orgA)

    await expect(
      service.skapaRattelse(
        id,
        { orsak: 'Rättelse från fel organisation', expectedContentHash: vy.contentHash },
        orgB,
        userA2,
      ),
    ).rejects.toBeInstanceOf(NotFoundException)

    await expect(service.hamtaVersioner(id, orgB)).rejects.toBeInstanceOf(NotFoundException)
    expect(await prisma.inspection.count({ where: { correctionOfId: id } })).toBe(0)
  })

  it('en version med rättelse går inte att radera', async () => {
    const id = await nyBesiktning({ status: 'COMPLETED' })
    await rattelse(id)
    await expect(service.delete(id, orgA)).rejects.toBeInstanceOf(ConflictException)
    expect(await prisma.inspection.count({ where: { id } })).toBe(1)
  })

  // ══ DEPOSITIONEN ══════════════════════════════════════════════════════════

  it('EN RÄTTELSE RÖR ALDRIG ETT BOKFÖRT DEPOSITIONSAVDRAG', async () => {
    const id = await nyBesiktning()
    await signera(id)

    const deposition = await prisma.deposit.create({
      data: {
        organizationId: orgA,
        leaseId: leaseA,
        tenantId: tenantA,
        amount: 19000,
        status: 'PARTIALLY_REFUNDED',
        paidAt: new Date('2025-01-05T00:00:00Z'),
        refundedAt: new Date('2026-03-10T00:00:00Z'),
        refundAmount: 14500,
        deductions: [{ reason: 'Skada badrumsgolv', amount: 4500 }],
      },
    })

    await rattelse(id, 'Badrumsposten avsåg fel lägenhet och ska strykas')

    const efter = await prisma.deposit.findUniqueOrThrow({ where: { id: deposition.id } })
    expect(efter.status).toBe(deposition.status)
    expect(efter.amount.toFixed(2)).toBe(deposition.amount.toFixed(2))
    expect(efter.refundAmount!.toFixed(2)).toBe(deposition.refundAmount!.toFixed(2))
    expect(efter.refundedAt).toEqual(deposition.refundedAt)
    expect(efter.deductions).toEqual(deposition.deductions)
    expect(efter.updatedAt).toEqual(deposition.updatedAt)

    await prisma.deposit.delete({ where: { id: deposition.id } })
  })

  it('rättelsen UPPLYSER om ett redan beslutat avdrag i stället för att ändra det', async () => {
    const id = await nyBesiktning()
    await signera(id)
    const deposition = await prisma.deposit.create({
      data: {
        organizationId: orgA,
        leaseId: leaseA,
        tenantId: tenantA,
        amount: 19000,
        status: 'PARTIALLY_REFUNDED',
        refundedAt: new Date('2026-03-10T00:00:00Z'),
        refundAmount: 14500,
        deductions: [{ reason: 'Skada badrumsgolv', amount: 4500 }],
      },
    })

    const ny = await rattelse(id)
    expect(ny.depositionsvarning).toMatchObject({
      depositId: deposition.id,
      status: 'PARTIALLY_REFUNDED',
      avdragAntal: 1,
      refundAmount: '14500.00',
    })

    await prisma.deposit.delete({ where: { id: deposition.id } })
  })

  it('ingen varning när depositionen saknar avdrag och inte är reglerad', async () => {
    const id = await nyBesiktning()
    await signera(id)
    const deposition = await prisma.deposit.create({
      data: {
        organizationId: orgA,
        leaseId: leaseA,
        tenantId: tenantA,
        amount: 19000,
        status: 'PAID',
        paidAt: new Date('2025-01-05T00:00:00Z'),
      },
    })

    const ny = await rattelse(id)
    expect(ny.depositionsvarning).toBeNull()

    await prisma.deposit.delete({ where: { id: deposition.id } })
  })
})
