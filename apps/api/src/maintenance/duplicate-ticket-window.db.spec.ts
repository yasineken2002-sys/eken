/**
 * DUBBLETTFÖNSTRET FÖR FELANMÄLNINGAR — mot riktig Postgres.
 *
 * ── ASYMMETRIN STYR VARJE PROV NEDAN ────────────────────────────────────────
 *
 * En spärr som äter en VERKLIG felanmälan betyder att ett fel aldrig blir
 * åtgärdat — ingen vet att det anmäldes. En dubblett betyder att någon läser
 * samma sak två gånger. De två felen är inte lika stora, och därför är
 * övervikten av prov här MOTPROV: fyra av sju kräver att fönstret INTE slår
 * till.
 *
 * ── VARFÖR INGEN NYCKEL ─────────────────────────────────────────────────────
 *
 * "Droppande kran" i köket och "Droppande kran" i badrummet är samma sträng och
 * två åtgärder. Innehållet kan alltså inte identifiera handlingen, och ett
 * unikt index hade tyst kastat den andra anmälan.
 *
 * ── VAD PROVET INTE KAN SE ──────────────────────────────────────────────────
 *
 * Om talet är RÄTT. Det är resonerat och inte mätt — produktionen har noll
 * felanmälningar — och det står i modulens docblock. Provet mäter att fönstret
 * gäller det det säger, inte att en minut är rätt minut.
 */
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import {
  DUPLICATE_TICKET_WINDOW_MS,
  hittaFärskDubblett,
  normaliseraRubrik,
} from './duplicate-ticket-window'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

const RUBRIK = 'Droppande kran'

medDb('felanmälningsfönstret', () => {
  let prisma: PrismaClient
  let orgId: string
  let userId: string
  let propertyId: string
  let unitA: string
  let unitB: string

  const skapa = (over: { unitId?: string | null; title?: string; createdAt?: Date } = {}) =>
    prisma.maintenanceTicket.create({
      data: {
        organizationId: orgId,
        propertyId,
        ...(over.unitId === undefined
          ? { unitId: unitA }
          : over.unitId
            ? { unitId: over.unitId }
            : {}),
        ticketNumber: `AR-${randomUUID().slice(0, 8)}`,
        title: over.title ?? RUBRIK,
        description: 'Det droppar.',
        reportedById: userId,
        ...(over.createdAt ? { createdAt: over.createdAt } : {}),
      },
      select: { id: true },
    })

  const leta = (over: { unitId?: string | undefined; title?: string } = {}) =>
    hittaFärskDubblett(prisma, {
      organizationId: orgId,
      propertyId,
      unitId: 'unitId' in over ? over.unitId : unitA,
      title: over.title ?? RUBRIK,
    })

  beforeAll(async () => {
    prisma = new PrismaClient()
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `fel-${sfx}`,
        email: `fel-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
      select: { id: true },
    })
    orgId = org.id
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `fel-${sfx}@example.se`,
        passwordHash: 'x',
        firstName: 'F',
        lastName: 'E',
        role: 'OWNER',
      },
      select: { id: true },
    })
    userId = user.id
    const property = await prisma.property.create({
      data: {
        organizationId: orgId,
        name: `Fastigheten ${sfx}`,
        propertyDesignation: `FEL ${sfx}`,
        type: 'RESIDENTIAL',
        street: 'a',
        city: 'b',
        postalCode: '11111',
        totalArea: 100,
      },
      select: { id: true },
    })
    propertyId = property.id
    for (const [i, namn] of ['Lgh 1', 'Lgh 2'].entries()) {
      const u = await prisma.unit.create({
        data: {
          propertyId,
          name: namn,
          unitNumber: `${10 + i}`,
          type: 'APARTMENT',
          area: 50,
          rooms: 2,
          monthlyRent: 9000,
        },
        select: { id: true },
      })
      if (i === 0) unitA = u.id
      else unitB = u.id
    }
  }, 30_000)

  beforeEach(async () => {
    await prisma.maintenanceTicket.deleteMany({ where: { organizationId: orgId } })
  })

  afterAll(async () => {
    await prisma.maintenanceTicket.deleteMany({ where: { organizationId: orgId } })
    await prisma.unit.deleteMany({ where: { propertyId } })
    await prisma.property.deleteMany({ where: { organizationId: orgId } })
    await prisma.user.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  it('SAMMA anrop två gånger inom fönstret → dubbletten hittas', async () => {
    await skapa()
    await expect(leta()).resolves.not.toBeNull()
  })

  it('rubriken jämförs normaliserad — ett omtag skickar nästan samma sträng', async () => {
    // Modellen kan byta versal eller lägga till ett mellanslag. Utan
    // normalisering missar fönstret just det fall det finns för.
    await skapa({ title: RUBRIK })
    await expect(leta({ title: '  droppande   KRAN ' })).resolves.not.toBeNull()
  })

  it('MOTPROV: en ANNAN rubrik är en annan anmälan', async () => {
    await skapa()
    await expect(leta({ title: 'Trasig spis' })).resolves.toBeNull()
  })

  it('MOTPROV: samma rubrik på en ANNAN enhet är ett annat objekt', async () => {
    // "Droppande kran" i två lägenheter är två fel. Skulle den här falla vore
    // spärren för grov på det dyraste sättet.
    await skapa({ unitId: unitA })
    await expect(leta({ unitId: unitB })).resolves.toBeNull()
  })

  it('MOTPROV: en anmälan på FASTIGHETEN krockar inte med en på en enhet', async () => {
    // `unitId: null` betyder "gäller huset". Det är ett annat objekt än en
    // lägenhet, i båda riktningarna.
    await skapa({ unitId: null })
    await expect(leta({ unitId: unitA })).resolves.toBeNull()
    await expect(leta({ unitId: undefined })).resolves.not.toBeNull()
  })

  it('MOTPROV: UTANFÖR fönstret är det två verkliga fel', async () => {
    // Det viktigaste motprovet. Faller det äter spärren en anmälan som kom
    // senare, och felet blir aldrig åtgärdat.
    await skapa({ createdAt: new Date(Date.now() - DUPLICATE_TICKET_WINDOW_MS - 30_000) })
    await expect(leta()).resolves.toBeNull()
  })

  it('SOND-STYRKA: fönstret är känt och sonderna ligger på rätt sida', () => {
    expect(DUPLICATE_TICKET_WINDOW_MS).toBe(60_000)
    // Lågt med flit: för grovt är värre än för fint här.
    expect(DUPLICATE_TICKET_WINDOW_MS).toBeLessThanOrEqual(120_000)
    expect(normaliseraRubrik('  Droppande   KRAN ')).toBe('droppande kran')
  })
})
