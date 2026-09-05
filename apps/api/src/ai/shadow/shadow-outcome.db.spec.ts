/**
 * FACIT OCH TRÄFFGRAD MOT RIKTIG POSTGRES.
 *
 * Två ärenden, ett rätt och ett fel förslag → 50 %. Talet är hela etapp 6:s
 * produkt, och det beräknas — aldrig lagras.
 *
 * ── VAD SOM INTE GÅR ATT MOCKA ──────────────────────────────────────────────
 *
 * Att `updateMany` bara träffar rätt rad: avgränsningen är (org, källa, källid),
 * och en attrapp hade returnerat samma count oavsett `where`. Och att en andra
 * skrivning ger SAMMA rad — idempotensen är en egenskap hos skrivningen, inte
 * hos en räknare.
 *
 * ── RIGGEN ÄGER SINA EGNA FÖRUTSÄTTNINGAR ───────────────────────────────────
 *
 * Egen organisation, fastighet och användare. Städning i FK-riktning. Prövad mot
 * en TOM databas och körd TVÅ gånger mot samma databas.
 */
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { Logger } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

import { AiAssignmentsService } from '../assignments/ai-assignments.service'
import { ShadowOutcomeService } from './shadow-outcome.service'
import { SKUGGKALLA_FELANMALAN } from './shadow-fields'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('skuggfacit', () => {
  let prisma: PrismaClient
  let facit: ShadowOutcomeService
  let uppdrag: AiAssignmentsService
  let orgId: string
  let propertyId: string
  let userId: string

  const arende = async (category: string, priority: string) => {
    const t = await prisma.maintenanceTicket.create({
      data: {
        organizationId: orgId,
        propertyId,
        ticketNumber: `T-${randomUUID().slice(0, 8)}`,
        title: 'Ärende',
        description: 'Beskrivning som är tillräckligt lång.',
        category: category as never,
        priority: priority as never,
      },
      select: { id: true, category: true, priority: true, assignedToId: true },
    })
    return t
  }

  const forslag = async (ticketId: string, prediction: Record<string, string>) =>
    prisma.aiAssignment.create({
      data: {
        organizationId: orgId,
        shadow: true,
        sourceKind: SKUGGKALLA_FELANMALAN,
        sourceId: ticketId,
        toolName: 'update_maintenance_status',
        toolInput: {},
        title: 'Förslag',
        reasoning: 'Därför.',
        consequence: 'SKUGGLÄGE: ingenting utförs.',
        undoHint: 'Inget att ångra.',
        prediction,
        deadline: new Date(Date.now() + 6 * 60 * 60 * 1000),
        assignedToUserId: userId,
      },
      select: { id: true },
    })

  beforeAll(async () => {
    prisma = new PrismaClient()
    facit = new ShadowOutcomeService(prisma as never)
    uppdrag = Object.create(AiAssignmentsService.prototype) as AiAssignmentsService
    Object.assign(uppdrag, {
      prisma,
      notifications: { create: async () => undefined },
      locks: { runIfUnlocked: async () => ({ ran: true }) },
      cronErrors: { report: async () => undefined },
      logger: new Logger('spec'),
    })

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `facit-${sfx}`,
        email: `facit-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
      select: { id: true },
    })
    orgId = org.id
    const p = await prisma.property.create({
      data: {
        organizationId: orgId,
        name: 'Facitfastigheten',
        propertyDesignation: `FACIT ${sfx}`,
        street: 'Storgatan 1',
        city: 'Testby',
        postalCode: '11111',
        type: 'RESIDENTIAL',
        totalArea: 500,
      },
      select: { id: true },
    })
    propertyId = p.id
    const u = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `facit-${sfx}@example.se`,
        passwordHash: 'x',
        firstName: 'A',
        lastName: 'B',
        role: 'OWNER',
      },
      select: { id: true },
    })
    userId = u.id
  }, 60_000)

  beforeEach(async () => {
    await prisma.aiAssignment.deleteMany({ where: { organizationId: orgId } })
    await prisma.maintenanceTicket.deleteMany({ where: { organizationId: orgId } })
  })

  afterAll(async () => {
    await prisma.aiAssignment.deleteMany({ where: { organizationId: orgId } })
    await prisma.maintenanceTicket.deleteMany({ where: { organizationId: orgId } })
    await prisma.user.deleteMany({ where: { organizationId: orgId } })
    await prisma.property.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  it('ETT RÄTT och ETT FEL förslag ger 50 % träffgrad', async () => {
    // Rätt: agenten sa PLUMBING, ärendet avslutades som PLUMBING.
    const t1 = await arende('PLUMBING', 'HIGH')
    await forslag(t1.id, { category: 'PLUMBING', priority: 'HIGH' })
    // Fel: agenten sa PLUMBING, ärendet avslutades som ELECTRICAL.
    const t2 = await arende('ELECTRICAL', 'HIGH')
    await forslag(t2.id, { category: 'PLUMBING', priority: 'HIGH' })

    expect(await facit.skrivFacitForArende(orgId, t1)).toBe(1)
    expect(await facit.skrivFacitForArende(orgId, t2)).toBe(1)

    const s = await uppdrag.sammanfattning(orgId, true)
    expect(s.traffgrad['category']).toEqual({ besvarade: 2, traffar: 1, andel: 0.5 })
    // Prioriteten var rätt i BÅDA — träffgraden är per fält, inte per rad.
    expect(s.traffgrad['priority']).toEqual({ besvarade: 2, traffar: 2, andel: 1 })
  })

  it('IDEMPOTENT: ett ärende som avslutas TVÅ gånger ger samma facit', async () => {
    const t = await arende('PLUMBING', 'HIGH')
    const f = await forslag(t.id, { category: 'PLUMBING', priority: 'HIGH' })

    await facit.skrivFacitForArende(orgId, t)
    const forst = await prisma.aiAssignment.findUniqueOrThrow({ where: { id: f.id } })
    await facit.skrivFacitForArende(orgId, t)
    const andra = await prisma.aiAssignment.findUniqueOrThrow({ where: { id: f.id } })

    expect(andra.outcome).toEqual(forst.outcome)
    // Träffgraden rörs inte av omkörningen — nämnaren är rader, inte skrivningar.
    const s = await uppdrag.sammanfattning(orgId, true)
    expect(s.traffgrad['category']).toEqual({ besvarade: 1, traffar: 1, andel: 1 })
  })

  it('ett ärende UTAN förslag skriver ingenting — och det är inte ett fel', async () => {
    const t = await arende('PLUMBING', 'HIGH')
    // Normalfallet så länge skuggläget är av för organisationen.
    expect(await facit.skrivFacitForArende(orgId, t)).toBe(0)
  })

  it('facit träffar BARA sitt eget ärende — avgränsningen är inte för grov', async () => {
    const t1 = await arende('PLUMBING', 'HIGH')
    const t2 = await arende('ELECTRICAL', 'LOW')
    const f1 = await forslag(t1.id, { category: 'PLUMBING' })
    const f2 = await forslag(t2.id, { category: 'PLUMBING' })

    expect(await facit.skrivFacitForArende(orgId, t1)).toBe(1)
    expect((await prisma.aiAssignment.findUniqueOrThrow({ where: { id: f1.id } })).outcome).toEqual(
      {
        category: 'PLUMBING',
        priority: 'HIGH',
      },
    )
    // Grannens rad är orörd.
    expect(
      (await prisma.aiAssignment.findUniqueOrThrow({ where: { id: f2.id } })).outcome,
    ).toBeNull()
  })

  it('ett fält som saknas i facit räknas varken som träff eller miss', async () => {
    // `assignedToId` är null på ärendet — facit säger inget om tilldelning, och
    // agentens gissning ska då varken belönas eller straffas.
    const t = await arende('PLUMBING', 'HIGH')
    await forslag(t.id, { category: 'PLUMBING', assignedToId: 'nagon' })
    await facit.skrivFacitForArende(orgId, t)

    const s = await uppdrag.sammanfattning(orgId, true)
    expect(s.traffgrad['category']?.andel).toBe(1)
    expect(s.traffgrad['assignedToId']).toEqual({ besvarade: 0, traffar: 0, andel: null })
  })

  it('utan facit är träffgraden NULL — inte noll procent', async () => {
    const t = await arende('PLUMBING', 'HIGH')
    await forslag(t.id, { category: 'PLUMBING' })
    const s = await uppdrag.sammanfattning(orgId, true)
    expect(s.traffgrad['category']).toEqual({ besvarade: 0, traffar: 0, andel: null })
  })
})
