/**
 * SKUGGPRODUCENTEN MOT RIKTIG POSTGRES.
 *
 * ── TRE PÅSTÅENDEN, OCH BARA DET FÖRSTA GÅR ATT MOCKA ───────────────────────
 *
 *   1. INGENTING UTFÖRS. `AiToolExecution` räknas före och efter — noll.
 *   2. SAMMA ÄRENDE GER ETT FÖRSLAG. Två körningar, en rad.
 *   3. TVÅ SAMTIDIGA JOBB GER ETT FÖRSLAG. Det är det partiella unika indexet
 *      som håller, inte `findFirst`-kontrollen — och en attrapp hade inte kunnat
 *      säga emot, eftersom den returnerar det den blivit tillsagd oavsett
 *      `where`. Mot riktig Postgres utvärderas villkoret på riktigt.
 *
 * ── MODELLEN ÄR EN ATTRAPP, DATABASEN ÄR DET INTE ───────────────────────────
 *
 * Anthropic-klienten byts ut mot ett fast svar. Skälet är inte kostnad utan
 * MÄTBARHET: ett prov vars facit kommer ur en modell mäter modellen, inte koden.
 * Att prompten och tolkningen är rätt ägs av `shadow-parse.spec.ts` (ren
 * funktion); det här provet äger skrivvägen.
 *
 * ── RIGGEN ÄGER SINA EGNA FÖRUTSÄTTNINGAR ───────────────────────────────────
 *
 * Egen organisation, fastighet, lägenhet, hyresgäst och användare. Städning i
 * FK-riktning. Prövad mot en TOM databas och körd TVÅ gånger mot samma databas.
 */
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import { MaintenanceShadowService } from './maintenance-shadow.service'
import { SKUGGKALLA_FELANMALAN } from './shadow-fields'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

/**
 * Modellens svar — som ett VERKTYGSANROP, inte som JSON i text.
 *
 * Formen speglar `tool_choice: { type: 'tool' }`, som API:t garanterar. Att
 * attrappen svarar i den formen är därför inte en förenkling: det är den enda
 * form produktionskoden kan få.
 */
const SVAR = {
  toolName: 'update_maintenance_status',
  toolInput: { ticketId: 'x', status: 'IN_PROGRESS' },
  reasoning: 'Beskrivningen pekar på en läcka som redan anmälts en gång i höstas.',
  confidence: 0.72,
  prediction: { category: 'PLUMBING', priority: 'HIGH' },
}

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('skuggproducenten', () => {
  let prisma: PrismaClient
  let tjanst: MaintenanceShadowService
  let anrop: number
  let orgId: string
  let propertyId: string
  let unitId: string
  let tenantId: string

  const skapaArende = async () =>
    prisma.maintenanceTicket.create({
      data: {
        organizationId: orgId,
        propertyId,
        unitId,
        tenantId,
        ticketNumber: `T-${randomUUID().slice(0, 8)}`,
        title: 'Det droppar under diskbänken',
        description: 'Vatten på golvet varje morgon sedan i tisdags.',
        category: 'OTHER',
        priority: 'NORMAL',
      },
      select: { id: true },
    })

  beforeAll(async () => {
    prisma = new PrismaClient()
    anrop = 0

    tjanst = Object.create(MaintenanceShadowService.prototype) as MaintenanceShadowService
    Object.assign(tjanst, {
      prisma,
      history: {
        // Historikmodulen är riggad, inte mockad bort: den returnerar en
        // händelse så att `evidence` faktiskt får innehåll att prövas.
        forSubject: async () => [
          {
            at: new Date('2026-01-02T00:00:00.000Z'),
            type: 'MAINTENANCE_REPORTED',
            description: 'Läckage under diskbänk',
            actor: { kind: 'UNKNOWN', id: null, label: null },
            subject: { kind: 'UNIT', id: null, label: null },
            amount: null,
            severity: 'INFO',
            source: { table: 'MaintenanceTicket', id: 'x' },
          },
        ],
      },
      quota: { checkOrgDailyCostCap: async () => undefined },
      usage: { logUsage: async () => undefined },
      anthropic: {
        messages: {
          create: async () => {
            anrop++
            return {
              stop_reason: 'tool_use',
              content: [{ type: 'tool_use', name: 'lamna_forslag', input: SVAR }],
              usage: { input_tokens: 1, output_tokens: 1 },
            }
          },
        },
      },
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    })

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `skugg-${sfx}`,
        email: `skugg-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
        shadowAgentEnabled: true,
      },
      select: { id: true },
    })
    orgId = org.id
    const p = await prisma.property.create({
      data: {
        organizationId: orgId,
        name: 'Skuggfastigheten',
        propertyDesignation: `SKUGG ${sfx}`,
        street: 'Storgatan 1',
        city: 'Testby',
        postalCode: '11111',
        type: 'RESIDENTIAL',
        totalArea: 500,
      },
      select: { id: true },
    })
    propertyId = p.id
    const u = await prisma.unit.create({
      data: {
        propertyId,
        name: 'Lgh 1001',
        unitNumber: `1001-${sfx}`,
        type: 'APARTMENT',
        rooms: 2,
        area: 55,
        monthlyRent: 8000,
      },
      select: { id: true },
    })
    unitId = u.id
    const t = await prisma.tenant.create({
      data: {
        organizationId: orgId,
        type: 'INDIVIDUAL',
        firstName: 'H',
        lastName: 'G',
        email: `hg-${sfx}@example.se`,
      },
      select: { id: true },
    })
    tenantId = t.id
  }, 60_000)

  beforeEach(async () => {
    anrop = 0
    await prisma.aiAssignment.deleteMany({ where: { organizationId: orgId } })
    await prisma.maintenanceTicket.deleteMany({ where: { organizationId: orgId } })
  })

  afterAll(async () => {
    // FK-riktning: barnen först.
    await prisma.aiAssignment.deleteMany({ where: { organizationId: orgId } })
    await prisma.maintenanceTicket.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
    await prisma.unit.deleteMany({ where: { propertyId } })
    await prisma.property.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  it('skapar ETT förslag med agentens fem fält — och UTFÖR ingenting', async () => {
    const forut = await prisma.aiToolExecution.count({ where: { organizationId: orgId } })
    const ticket = await skapaArende()

    const r = await tjanst.korForArende(orgId, ticket.id)
    expect(r.utfall).toBe('SKAPAD')

    // ── PÅSTÅENDE 1: INGENTING UTFÖRDES ────────────────────────────────────
    const efter = await prisma.aiToolExecution.count({ where: { organizationId: orgId } })
    expect(efter).toBe(forut)
    expect(efter).toBe(0)

    const rad = await prisma.aiAssignment.findFirstOrThrow({ where: { organizationId: orgId } })
    expect(rad.shadow).toBe(true)
    expect(rad.status).toBe('AWAITING_APPROVAL')
    expect(rad.sourceKind).toBe(SKUGGKALLA_FELANMALAN)
    expect(rad.sourceId).toBe(ticket.id)
    // Planens fem: vad · varför · vilken information · hur säker · vad som krävt godkännande.
    expect(rad.toolName).toBe('update_maintenance_status')
    expect(rad.reasoning).toContain('läcka')
    // Hyresgästens text går INTE in i rubriken — den hade annars kommit tillbaka
    // som "AI föreslog: <hyresgästtext>" i nästa körnings historik.
    expect(rad.title).not.toContain('diskbänken')
    expect(rad.evidence).not.toEqual([])
    expect(rad.confidence).toBeCloseTo(0.72)
    expect(rad.consequence).toMatch(/SKUGGLÄGE/)
    // Omfånget ärvs av ärendet, så förslaget syns i objektens historik.
    expect(rad.propertyId).toBe(propertyId)
    expect(rad.unitId).toBe(unitId)
    expect(rad.tenantId).toBe(tenantId)
  })

  it('SAMMA ärende två gånger ger ETT förslag — och bara ETT modellanrop', async () => {
    const ticket = await skapaArende()
    const a = await tjanst.korForArende(orgId, ticket.id)
    const b = await tjanst.korForArende(orgId, ticket.id)
    expect(a.utfall).toBe('SKAPAD')
    expect(b.utfall).toBe('REDAN_FINNS')
    expect(await prisma.aiAssignment.count({ where: { organizationId: orgId } })).toBe(1)
    // Dubbletten stoppas FÖRE modellanropet — annars kostar varje omkörning pengar.
    expect(anrop).toBe(1)
  })

  it('TVÅ SAMTIDIGA körningar ger ETT förslag — det partiella indexet håller', async () => {
    const ticket = await skapaArende()
    const [a, b] = await Promise.all([
      tjanst.korForArende(orgId, ticket.id),
      tjanst.korForArende(orgId, ticket.id),
    ])
    expect(await prisma.aiAssignment.count({ where: { organizationId: orgId } })).toBe(1)
    // Exakt en vann; den andra fick REDAN_FINNS, inte ett kast.
    expect([a.utfall, b.utfall].filter((u) => u === 'SKAPAD')).toHaveLength(1)
    expect([a.utfall, b.utfall].filter((u) => u === 'REDAN_FINNS')).toHaveLength(1)
  })

  it('TVÅ OLIKA ärenden ger TVÅ förslag — avgränsningen är inte för grov', async () => {
    const t1 = await skapaArende()
    const t2 = await skapaArende()
    await tjanst.korForArende(orgId, t1.id)
    await tjanst.korForArende(orgId, t2.id)
    expect(await prisma.aiAssignment.count({ where: { organizationId: orgId } })).toBe(2)
  })

  it('AVSTÄNGD organisation kostar INTE ett enda modellanrop', async () => {
    const ticket = await skapaArende()
    await prisma.organization.update({
      where: { id: orgId },
      data: { shadowAgentEnabled: false },
    })
    try {
      const r = await tjanst.korForArende(orgId, ticket.id)
      expect(r.utfall).toBe('AVSTANGD')
      expect(anrop).toBe(0)
      expect(await prisma.aiAssignment.count({ where: { organizationId: orgId } })).toBe(0)
    } finally {
      await prisma.organization.update({
        where: { id: orgId },
        data: { shadowAgentEnabled: true },
      })
    }
  })

  it('ett ärende i en ANNAN organisation rörs inte', async () => {
    const r = await tjanst.korForArende(orgId, randomUUID())
    expect(r.utfall).toBe('SAKNAS')
    expect(anrop).toBe(0)
  })
})
