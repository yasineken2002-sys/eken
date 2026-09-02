/**
 * G1 STEG 1 — VEM SOM UTFÖRDE, MOT RIKTIG POSTGRES.
 *
 * ── VAD PROVET MÄTER, OCH VARFÖR DET INTE GÅR ATT MÄTA MED ATTRAPP ──────────
 *
 * `humanOrUnknown` påstod `HUMAN` så snart en aktörskolumn var ifylld. AI:n
 * skriver UPPDRAGSGIVARENS userId i samma kolumn, så påståendet var osant för
 * varje AI-skriven rad. Rättelsen är två delar som bara betyder något
 * TILLSAMMANS:
 *
 *   1. `humanOrUnknown` säger aldrig mer `HUMAN` — den vet inte.
 *   2. `HistoryService` slår upp `AiToolEffect` på `(entityType, entityId)` och
 *      uppgraderar de rader en AI-körning bevisligen skrev till `AGENT`.
 *
 * Del 2 kan bara mätas mot en riktig databas: nyckeln är ett sammansatt index
 * över två tabeller som ingen attrapp kan hålla konsekvent. Ett prov med mockad
 * Prisma hade mätt att jag skrev rätt `where`, inte att uppslaget träffar.
 *
 * ── DE TVÅ RADERNA SKILJER SIG I EXAKT EN SAK ───────────────────────────────
 *
 * Båda felanmälningarna skapas likadant, av samma `reportedById`, i samma
 * organisation, i samma sekund. Den enda skillnaden är att den ena har en
 * `AiToolEffect` som pekar på sig. Faller provet vet man därför vilken
 * mekanism som gick sönder — det finns inget annat den kan bero på.
 *
 * ── DEN NEGATIVA KONTROLLEN ÄR EN AV RADERNA, INTE EN KOMMENTAR ─────────────
 *
 * Ett prov som bara visar AGENT-fallet skiljer inte en fungerande uppgradering
 * från en som säger AGENT om allt. Ett som bara visar UNKNOWN-fallet skiljer
 * inte ett fungerande uppslag från ett som aldrig träffar. Båda krävs, och de
 * står i samma `it` så att de inte kan glida isär.
 *
 * ── RIGGEN SKAPAR SINA EGNA FÖRUTSÄTTNINGAR ─────────────────────────────────
 *
 * Ingenting hämtas ur den omgivande databasen. Städningen går i FK-riktning:
 * `AiToolEffect` och `AiToolExecution` pekar på `Organization` med Restrict,
 * inte Cascade, så de måste bort före organisationen.
 *
 * INGEN PERSONDATA i utdata: bara antal och id:n som skapats i testet.
 */
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { HistoryService } from './history.service'
import { actorFromEventActorType, humanOrUnknown } from './history-event'
import type { PrismaService } from '../common/prisma/prisma.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    // Utan den här raden är filen grön av att den hoppades över.
    expect(HAR_DB).toBe(true)
  })
})

describe('humanOrUnknown säger aldrig HUMAN — invarianten, inte ett stickprov', () => {
  // ── VARFÖR DET HÄR INTE ÄR ETT SVEP ÖVER SVARET ───────────────────────────
  //
  // Första versionen skrev `expect(svaret.filter(kind === 'HUMAN')).toHaveLength(0)`
  // över enhetens historik. Den var grön — och kunde inte ha varit något annat:
  // fixturen skapar ingen faktura och ingen avi, och de två källor som ÖVER HUVUD
  // TAGET kan ge HUMAN (`InvoiceEvent`, `RentNoticeEvent`, båda via
  // `actorFromEventActorType`) fanns alltså inte i mängden. Sonden gav noll av
  // fel skäl. Se CLAUDE.md: en sond som ger NOLL måste bevisas kunna ge något
  // annat.
  //
  // Invarianten mäts därför där den bor — i funktionen — och de två källor som
  // fortfarande FÅR säga HUMAN rörs inte: de läser en riktig `actorType`-kolumn
  // som redan skiljer AI från användare, och deras påstående är belagt.

  it('varken ett ifyllt, tomt eller saknat userId ger HUMAN', () => {
    for (const indata of ['user-1', '', null, undefined]) {
      expect(humanOrUnknown(indata).kind).toBe('UNKNOWN')
    }
  })

  it('MOTPROV: funktionen KAN ge ett annat värde — annars mäter provet ovan inget', () => {
    // Utan den här raden är provet ovan lika grönt om `kind` vore en konstant
    // sträng. `actorFromEventActorType` är den andra vägen in i samma typ, och
    // den ger fortfarande HUMAN — så uppsättningen är inte tömd, bara den
    // obelagda vägen.
    expect(actorFromEventActorType('USER', 'user-1', null).kind).toBe('HUMAN')
    expect(actorFromEventActorType('AI', 'user-1', null).kind).toBe('AGENT')
  })

  it('ID:T BEHÅLLS — vi vet vilken användare raden hör till, inte vem som skrev', () => {
    expect(humanOrUnknown('user-1')).toEqual({ kind: 'UNKNOWN', id: 'user-1', label: null })
    expect(humanOrUnknown(null)).toEqual({ kind: 'UNKNOWN', id: null, label: null })
  })
})

medDb('historikens aktör: effektposten är enda belägget för AGENT', () => {
  let prisma: PrismaClient
  let service: HistoryService
  let orgId: string
  let userId: string
  let unitId: string
  let propertyId: string
  let tenantId: string
  /** Felanmälan MED effektpost — ska bli AGENT. */
  let ticketAi: string
  /** Felanmälan UTAN effektpost — ska bli UNKNOWN, aldrig HUMAN. */
  let ticketUtan: string
  let executionId: string

  beforeAll(async () => {
    prisma = new PrismaClient()
    service = new HistoryService(prisma as unknown as PrismaService)
    const sfx = randomUUID().slice(0, 8)

    const org = await prisma.organization.create({
      data: {
        name: `akt-${sfx}`,
        email: `akt-${sfx}@example.se`,
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
        email: `akt-u-${sfx}@example.se`,
        passwordHash: 'x',
        firstName: 'A',
        lastName: 'B',
        role: 'OWNER',
      },
      select: { id: true },
    })
    userId = user.id

    const property = await prisma.property.create({
      data: {
        organizationId: orgId,
        name: `Fastigheten ${sfx}`,
        propertyDesignation: `AKT ${sfx}`,
        type: 'RESIDENTIAL',
        street: 'a',
        city: 'b',
        postalCode: '11111',
        totalArea: 100,
      },
      select: { id: true },
    })
    propertyId = property.id

    const unit = await prisma.unit.create({
      data: {
        propertyId,
        name: 'Lgh 1',
        unitNumber: '1',
        type: 'APARTMENT',
        area: 50,
        rooms: 2,
        monthlyRent: 10000,
      },
      select: { id: true },
    })
    unitId = unit.id

    const tenant = await prisma.tenant.create({
      data: { organizationId: orgId, type: 'INDIVIDUAL', email: `akt-t-${sfx}@example.se` },
      select: { id: true },
    })
    tenantId = tenant.id

    // Två felanmälningar, identiska så när som på effektposten.
    const skapaTicket = async (nr: string) =>
      (
        await prisma.maintenanceTicket.create({
          data: {
            organizationId: orgId,
            propertyId,
            unitId,
            tenantId,
            ticketNumber: nr,
            title: 'Droppande kran',
            description: 'x',
            category: 'PLUMBING',
            priority: 'LOW',
            reportedById: userId,
          },
          select: { id: true },
        })
      ).id

    ticketAi = await skapaTicket(`FA-${sfx}-A`)
    ticketUtan = await skapaTicket(`FA-${sfx}-U`)

    const exec = await prisma.aiToolExecution.create({
      data: {
        organizationId: orgId,
        userId,
        toolName: 'create_maintenance_ticket',
        toolInput: {},
        success: true,
        durationMs: 1,
        completedAt: new Date(),
      },
      select: { id: true },
    })
    executionId = exec.id

    await prisma.aiToolEffect.create({
      data: {
        aiToolExecutionId: executionId,
        organizationId: orgId,
        entityType: 'MaintenanceTicket',
        entityId: ticketAi,
        operation: 'CREATE',
        rowCount: 1,
      },
    })
  }, 30_000)

  afterAll(async () => {
    // FK-riktning: Restrict mot Organization, alltså barnen först.
    await prisma.aiToolEffect.deleteMany({ where: { organizationId: orgId } })
    await prisma.aiToolExecution.deleteMany({ where: { organizationId: orgId } })
    await prisma.maintenanceTicket.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
    await prisma.unit.deleteMany({ where: { propertyId } })
    await prisma.property.deleteMany({ where: { organizationId: orgId } })
    await prisma.user.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  /** Anmälningshändelsen för en given felanmälan, ur enhetens historik. */
  const anmälan = async (ticketId: string) => {
    const rader = await service.forUnit(orgId, unitId, 'OWNER')
    const träff = rader.filter(
      (r) => r.source.table === 'MaintenanceTicket' && r.source.id === ticketId,
    )
    // Ticketen ger EN händelse så länge `completedAt` är null. Blir det två
    // ska provet falla här och inte tyst läsa fel rad.
    expect(träff).toHaveLength(1)
    return träff[0]!
  }

  it('EN EFFEKTPOST GER AGENT — och frånvaron ger UNKNOWN, aldrig HUMAN', async () => {
    const med = await anmälan(ticketAi)
    const utan = await anmälan(ticketUtan)

    // Den positiva halvan: uppslaget träffar och uppgraderar.
    expect(med.actor.kind).toBe('AGENT')
    // …och `id` byter betydelse med `kind`: körningen, inte uppdragsgivaren.
    expect(med.actor.id).toBe(executionId)

    // Den negativa halvan, som är hela ärendet: samma kolumn, samma värde,
    // ingen effektpost → inget påstående om en människa.
    expect(utan.actor.kind).toBe('UNKNOWN')
    expect(utan.actor.id).toBe(userId)
  })

  it('UPPGRADERINGEN ÄR ENVÄGS: en effektpost i en ANNAN organisation träffar inte', async () => {
    // Nyckeln är (organizationId, entityType, entityId). Tappas det första
    // ledet blir historiken en läcka mellan organisationer, inte bara fel.
    const främmande = await prisma.organization.create({
      data: {
        name: `akt-x-${randomUUID().slice(0, 8)}`,
        email: `akt-x-${randomUUID().slice(0, 8)}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
      select: { id: true },
    })
    const exec = await prisma.aiToolExecution.create({
      data: {
        organizationId: främmande.id,
        toolName: 'x',
        toolInput: {},
        success: true,
        durationMs: 1,
      },
      select: { id: true },
    })
    await prisma.aiToolEffect.create({
      data: {
        aiToolExecutionId: exec.id,
        organizationId: främmande.id,
        entityType: 'MaintenanceTicket',
        entityId: ticketUtan,
        operation: 'CREATE',
        rowCount: 1,
      },
    })

    try {
      expect((await anmälan(ticketUtan)).actor.kind).toBe('UNKNOWN')
    } finally {
      await prisma.aiToolEffect.deleteMany({ where: { organizationId: främmande.id } })
      await prisma.aiToolExecution.deleteMany({ where: { organizationId: främmande.id } })
      await prisma.organization.delete({ where: { id: främmande.id } })
    }
  })

  it('EN EFFEKTPOST UTAN entityId (updateMany) uppgraderar ingenting', async () => {
    // `entityId` är NULL för updateMany/deleteMany. Det är precis skälet till
    // att en utebliven träff inte får läsas som "en människa gjorde det" —
    // och skälet att uppslaget aldrig får matcha på bara `entityType`.
    const exec = await prisma.aiToolExecution.create({
      data: {
        organizationId: orgId,
        toolName: 'x',
        toolInput: {},
        success: true,
        durationMs: 1,
      },
      select: { id: true },
    })
    const effekt = await prisma.aiToolEffect.create({
      data: {
        aiToolExecutionId: exec.id,
        organizationId: orgId,
        entityType: 'MaintenanceTicket',
        entityId: null,
        operation: 'UPDATE',
        rowCount: 2,
      },
      select: { id: true },
    })

    try {
      expect((await anmälan(ticketUtan)).actor.kind).toBe('UNKNOWN')
    } finally {
      await prisma.aiToolEffect.delete({ where: { id: effekt.id } })
      await prisma.aiToolExecution.delete({ where: { id: exec.id } })
    }
  })
})
