/**
 * UPPDRAGSKÖN MOT RIKTIG POSTGRES.
 *
 * ── VARFÖR INTE MOT EN ATTRAPP ──────────────────────────────────────────────
 *
 * Två av proven nedan mäter en AVGRÄNSNING, inte ett flöde: att `besluta` bara
 * vinner på en rad i `AWAITING_APPROVAL`, och att utgångspasset bara plockar
 * rader vars deadline PASSERAT. En attrapp returnerar det den blivit tillsagd
 * oavsett `where`, så en tappad kolumn i avgränsningen hade lämnat båda proven
 * gröna. Mot riktig Postgres utvärderas villkoret på riktigt.
 *
 * ── RIGGEN ÄGER SINA EGNA FÖRUTSÄTTNINGAR ───────────────────────────────────
 *
 * Den skapar sin organisation och sin användare, och städar dem efteråt i
 * FK-riktning. Ingenting läses ur omgivningen — provad mot en TOM databas, och
 * körd två gånger mot samma databas för att fånga en rigg som bygger på sitt
 * eget skräp.
 *
 * ── VAD PROVEN INTE KAN SE ──────────────────────────────────────────────────
 *
 * Att grinden vid skapandet har RÄTT omdöme — det ägs av
 * `assignment-eligibility.spec.ts`. Här mäts bara att den är PÅKOPPLAD.
 * Och att ett godkänt uppdrag utförs: det finns ingen utförare (etapp 8–9).
 */
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { Logger } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

import { AiAssignmentsService } from './ai-assignments.service'

import type { SkapaUppdrag } from './ai-assignments.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('uppdragskön', () => {
  let prisma: PrismaClient
  let tjänst: AiAssignmentsService
  let notiser: Array<{ userId: string; type: string; entityId: string | undefined }>
  let orgId: string
  let userId: string

  const om = (över: Partial<SkapaUppdrag> = {}): SkapaUppdrag => ({
    // `create_property`: IDEMPOTENT med DATABAS_INDEX — duglig.
    toolName: 'create_property',
    toolInput: { name: 'Storgatan 4' },
    title: 'Lägg upp fastigheten Storgatan 4',
    reasoning: 'Kontraktet som skannades i natt pekar på en fastighet som saknas.',
    consequence: 'En fastighet skapas. Inget skickas till någon utanför systemet.',
    undoHint: 'Fastigheten kan tas bort så länge inga objekt lagts upp under den.',
    deadline: new Date(Date.now() + 6 * 60 * 60 * 1000),
    assignedToUserId: userId,
    ...över,
  })

  beforeAll(async () => {
    prisma = new PrismaClient()
    notiser = []
    tjänst = Object.create(AiAssignmentsService.prototype) as AiAssignmentsService
    Object.assign(tjänst, {
      prisma,
      notifications: {
        create: async (
          _org: string,
          uid: string,
          type: string,
          _t: string,
          _m: string,
          target?: { relatedEntityId?: string },
        ) => {
          notiser.push({ userId: uid, type, entityId: target?.relatedEntityId })
        },
      },
      locks: { runIfUnlocked: async () => ({ ran: true }) },
      cronErrors: { report: async () => undefined },
      logger: new Logger('spec'),
    })

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `upp-${sfx}`,
        email: `upp-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
      select: { id: true },
    })
    orgId = org.id
    const u = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `upp-${sfx}@example.se`,
        passwordHash: 'x',
        firstName: 'A',
        lastName: 'B',
        role: 'OWNER',
      },
      select: { id: true },
    })
    userId = u.id
  }, 30_000)

  beforeEach(async () => {
    notiser = []
    await prisma.aiAssignment.deleteMany({ where: { organizationId: orgId } })
  })

  afterAll(async () => {
    // FK-riktning: barnen först. AiAssignment pekar på både User och Organization.
    await prisma.aiAssignment.deleteMany({ where: { organizationId: orgId } })
    await prisma.user.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  describe('skapandet', () => {
    it('skapar uppdraget OCH kallelsen — kön är aldrig utan läsare', async () => {
      const u = await tjänst.skapa(orgId, om())
      expect(u.status).toBe('AWAITING_APPROVAL')
      expect(u.toolInput).toEqual({ name: 'Storgatan 4' })
      expect(notiser).toEqual([{ userId, type: 'AI_ASSIGNMENT_AWAITING', entityId: u.id }])
    })

    it('GRINDEN ÄR PÅKOPPLAD: ett DEDUPLICERBART verktyg kan inte bli ett uppdrag', async () => {
      // `create_invoice` är DEDUPLICERBAR — en andra effekt kan uppstå.
      await expect(tjänst.skapa(orgId, om({ toolName: 'create_invoice' }))).rejects.toThrow(
        /DEDUPLICERBAR/,
      )
      expect(await prisma.aiAssignment.count({ where: { organizationId: orgId } })).toBe(0)
      // Och ingen kallelse gick ut om något som inte finns.
      expect(notiser).toEqual([])
    })

    it('avvisar en tidsgräns som redan passerat — ett uppdrag föds inte förfallet', async () => {
      await expect(
        tjänst.skapa(orgId, om({ deadline: new Date(Date.now() - 1000) })),
      ).rejects.toThrow(/framtiden/)
    })

    it('avvisar en mottagare utanför organisationen', async () => {
      const sfx = randomUUID().slice(0, 8)
      const annan = await prisma.organization.create({
        data: {
          name: `x-${sfx}`,
          email: `x-${sfx}@example.se`,
          street: 'a',
          city: 'b',
          postalCode: '11111',
        },
        select: { id: true },
      })
      const främling = await prisma.user.create({
        data: {
          organizationId: annan.id,
          email: `x-${sfx}@example.se`,
          passwordHash: 'x',
          firstName: 'A',
          lastName: 'B',
          role: 'OWNER',
        },
        select: { id: true },
      })
      await expect(tjänst.skapa(orgId, om({ assignedToUserId: främling.id }))).rejects.toThrow(
        /organisationen/,
      )
      await prisma.user.delete({ where: { id: främling.id } })
      await prisma.organization.delete({ where: { id: annan.id } })
    })
  })

  describe('beslutet', () => {
    it('godkänner, och skriver vem som beslutade', async () => {
      const u = await tjänst.skapa(orgId, om())
      const efter = await tjänst.besluta(orgId, u.id, userId, 'APPROVED')
      expect(efter.status).toBe('APPROVED')
      expect(efter.decidedByUserId).toBe(userId)
      expect(efter.decidedAt).not.toBeNull()
    })

    it('kräver ett skäl vid avslag — skälet är minnesmat', async () => {
      const u = await tjänst.skapa(orgId, om())
      await expect(tjänst.besluta(orgId, u.id, userId, 'REJECTED')).rejects.toThrow(/skäl/)
    })

    it('SAMMA uppdrag två gånger ger EN effekt — anspråket är atomiskt', async () => {
      const u = await tjänst.skapa(orgId, om())
      await tjänst.besluta(orgId, u.id, userId, 'APPROVED')
      await expect(tjänst.besluta(orgId, u.id, userId, 'APPROVED')).rejects.toThrow(/redan godkänt/)
    })

    // DEN OMVÄNDA RIKTNINGEN, och den går inte att köra mot en attrapp: två
    // OLIKA uppdrag måste ge TVÅ beslut. Tappar `id` ur avgränsningen blir det
    // här provet rött, medan provet ovan förblir grönt.
    it('TVÅ olika uppdrag ger TVÅ beslut — avgränsningen är inte för grov', async () => {
      const a = await tjänst.skapa(orgId, om({ title: 'A' }))
      const b = await tjänst.skapa(orgId, om({ title: 'B' }))
      expect((await tjänst.besluta(orgId, a.id, userId, 'APPROVED')).status).toBe('APPROVED')
      expect(
        (await tjänst.besluta(orgId, b.id, userId, 'REJECTED', 'Hann göra det själv')).status,
      ).toBe('REJECTED')
      const kvar = await prisma.aiAssignment.findMany({
        where: { organizationId: orgId },
        select: { title: true, status: true, statusReason: true },
        orderBy: { title: 'asc' },
      })
      expect(kvar).toEqual([
        { title: 'A', status: 'APPROVED', statusReason: null },
        { title: 'B', status: 'REJECTED', statusReason: 'Hann göra det själv' },
      ])
    })
  })

  describe('det synliga förfallet', () => {
    /** Skriver deadline direkt i databasen — skapandet vägrar en passerad gräns. */
    const förfallet = async (title: string) => {
      const u = await tjänst.skapa(orgId, om({ title }))
      await prisma.aiAssignment.update({
        where: { id: u.id },
        data: { deadline: new Date(Date.now() - 60_000) },
      })
      return u.id
    }

    it('stänger utgångna uppdrag OCH notifierar — ett tyst förfall är förbjudet', async () => {
      const id = await förfallet('Förfaller')
      notiser = []

      const utfall = await tjänst.stängUtgångna()
      expect(utfall.stängda).toBeGreaterThanOrEqual(1)

      const rad = await prisma.aiAssignment.findUniqueOrThrow({ where: { id } })
      expect(rad.status).toBe('EXPIRED')
      expect(rad.statusReason).toMatch(/ingenting utfördes/)
      expect(notiser).toContainEqual({
        userId,
        type: 'AI_ASSIGNMENT_EXPIRED',
        entityId: id,
      })
    })

    // Avgränsningens andra riktning: ett uppdrag vars gräns INTE passerat får
    // inte röras. Utan det här provet vore "stäng allt" också grönt.
    it('rör INTE ett uppdrag vars tidsgräns ligger kvar i framtiden', async () => {
      const kvar = await tjänst.skapa(orgId, om({ title: 'Lever' }))
      await förfallet('Dör')

      await tjänst.stängUtgångna()

      const efter = await prisma.aiAssignment.findUniqueOrThrow({ where: { id: kvar.id } })
      expect(efter.status).toBe('AWAITING_APPROVAL')
      expect(efter.statusReason).toBeNull()
    })

    it('ett REDAN BESLUTAT uppdrag förfaller inte i efterhand', async () => {
      const id = await förfallet('Beslutat men gammalt')
      await prisma.aiAssignment.update({ where: { id }, data: { status: 'APPROVED' } })

      await tjänst.stängUtgångna()

      const efter = await prisma.aiAssignment.findUniqueOrThrow({ where: { id } })
      expect(efter.status).toBe('APPROVED')
    })
  })
})
