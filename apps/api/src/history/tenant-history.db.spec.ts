/**
 * ACCEPTANSTEST — HÄRLETT TAL, ALDRIG "FLER ÄN NOLL".
 *
 * ── VARFÖR EN BYGGD HYRESGÄST OCH INTE EN UR DEV-DATABASEN ──────────────────
 *
 * Uppdraget var att ta ett VERKLIGT objekt ur dev-databasen. Den är tom — mätt
 * 2026-08-31: `Tenant` 0 rader, `InvoiceEvent` 0, `RentNoticeEvent` 0, och
 * varken `db:seed` eller `db:seed:properties` skapar en enda hyresgäst (de
 * skapar organisation, användare, fastighet, enhet och kontoplan). Det fanns
 * alltså inget verkligt objekt att räkna på.
 *
 * Fixturen nedan byggs därför i RIKTIG Postgres — inte i en attrapp — och är
 * medvetet ojämn: ett avtal som både aktiverats och sagts upp, ett som bara
 * skapats, en nyckel som lämnats ut och en som också återlämnats. Det är den
 * ojämnheten som prövar att flerhändelsekällorna räknar rätt; en fixtur där
 * varje rad ger exakt en händelse hade inte kunnat skilja en korrekt mappning
 * från en som tappar grenar.
 *
 * ── VARFÖR FACIT RÄKNAS SEPARAT ─────────────────────────────────────────────
 *
 * Det förväntade talet härleds ur KÄLLTABELLERNA med egna frågor, inte genom
 * att anropa tjänsten. Ett facit som kommer ur koden som prövas bevisar bara
 * att koden är konsekvent med sig själv. Båda talen skrivs ut, så en avvikelse
 * går att läsa direkt i loggen.
 *
 * INGEN PERSONDATA i utdata: bara antal och id:n som skapats i testet.
 */
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { TenantHistoryService } from './tenant-history.service'
import { HISTORY_SOURCES } from './history-sources.registry'
import type { PrismaService } from '../common/prisma/prisma.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    // Utan den här raden är filen grön av att den hoppades över.
    expect(HAR_DB).toBe(true)
  })
})

medDb('hyresgästens historik — antalet härleds ur källtabellerna', () => {
  let prisma: PrismaClient
  let service: TenantHistoryService
  let orgId: string
  let tenantId: string
  let unitId: string
  let propertyId: string
  let leaseAId: string
  let leaseBId: string
  let userId: string

  beforeAll(async () => {
    prisma = new PrismaClient()
    const suffix = randomUUID().slice(0, 8)

    const org = await prisma.organization.create({
      data: {
        name: `hist-${suffix}`,
        email: `hist-${suffix}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
    })
    orgId = org.id

    const property = await prisma.property.create({
      data: {
        organizationId: orgId,
        name: 'Historikfastigheten',
        propertyDesignation: 'TESTBY 1:1',
        street: 'Storgatan 1',
        city: 'Testby',
        postalCode: '11111',
        type: 'RESIDENTIAL',
        totalArea: 500,
      },
    })
    propertyId = property.id

    const unit = await prisma.unit.create({
      data: {
        propertyId: property.id,
        name: 'Lgh 1001',
        unitNumber: '1001',
        type: 'APARTMENT',
        rooms: 2,
        area: 55,
        monthlyRent: 9000,
        status: 'OCCUPIED',
      },
    })
    unitId = unit.id

    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `hist-user-${suffix}@example.se`,
        passwordHash: 'x',
        firstName: 'Hand',
        lastName: 'Läggare',
        role: 'OWNER',
      },
    })
    userId = user.id

    const tenant = await prisma.tenant.create({
      data: {
        organizationId: orgId,
        type: 'INDIVIDUAL',
        firstName: 'Test',
        lastName: 'Historik',
        email: `hist-tenant-${suffix}@example.se`,
      },
    })
    tenantId = tenant.id

    // ── Avtal A: skapat + aktiverat + uppsagt  → 3 händelser ────────────────
    const leaseA = await prisma.lease.create({
      data: {
        organizationId: orgId,
        unitId,
        tenantId,
        startDate: new Date('2024-01-01'),
        tenancyStartDate: new Date('2024-01-01'),
        monthlyRent: 9000,
        depositAmount: 9000,
        activatedAt: new Date('2024-01-02'),
        terminatedAt: new Date('2025-06-30'),
        terminationReason: 'Egen uppsägning',
        status: 'TERMINATED',
      },
    })
    leaseAId = leaseA.id

    // ── Avtal B: bara skapat  → 1 händelse ──────────────────────────────────
    const leaseB = await prisma.lease.create({
      data: {
        organizationId: orgId,
        unitId,
        tenantId,
        startDate: new Date('2025-07-01'),
        tenancyStartDate: new Date('2025-07-01'),
        monthlyRent: 9500,
        depositAmount: 9500,
        status: 'DRAFT',
      },
    })
    leaseBId = leaseB.id

    // ── Nyckel 1: utlämnad + återlämnad → 2 · Nyckel 2: bara utlämnad → 1 ──
    await prisma.keyHandover.create({
      data: {
        organizationId: orgId,
        leaseId: leaseAId,
        unitId,
        tenantId,
        type: 'APARTMENT',
        issuedAt: new Date('2024-01-02'),
        returnedAt: new Date('2025-06-30'),
        status: 'RETURNED',
      },
    })
    await prisma.keyHandover.create({
      data: {
        organizationId: orgId,
        leaseId: leaseBId,
        unitId,
        tenantId,
        type: 'MAILBOX',
        issuedAt: new Date('2025-07-01'),
        status: 'ISSUED',
      },
    })

    // ── Felanmälan: en öppen (1) och en åtgärdad (2) ────────────────────────
    await prisma.maintenanceTicket.create({
      data: {
        organizationId: orgId,
        propertyId: property.id,
        unitId,
        tenantId,
        ticketNumber: `T-${suffix}-1`,
        title: 'Droppande kran',
        description: 'Kranen droppar',
        category: 'PLUMBING',
        priority: 'NORMAL',
        status: 'NEW',
      },
    })
    await prisma.maintenanceTicket.create({
      data: {
        organizationId: orgId,
        propertyId: property.id,
        unitId,
        tenantId,
        ticketNumber: `T-${suffix}-2`,
        title: 'Trasig lampa',
        description: 'Lampan i hallen',
        category: 'ELECTRICAL',
        priority: 'LOW',
        status: 'COMPLETED',
        completedAt: new Date('2024-03-01'),
      },
    })

    // ── Deposition: skapad + betald (ingen återbetalning) → 2 ───────────────
    await prisma.deposit.create({
      data: {
        organizationId: orgId,
        leaseId: leaseAId,
        tenantId,
        amount: 9000,
        status: 'PAID',
        paidAt: new Date('2024-01-03'),
      },
    })

    // ── Dokument → 1 ────────────────────────────────────────────────────────
    await prisma.document.create({
      data: {
        organizationId: orgId,
        tenantId,
        name: 'Kontrakt.pdf',
        storageKey: `k/${suffix}`,
        storageUrl: `https://example.invalid/${suffix}`,
        fileSize: 1024,
        mimeType: 'application/pdf',
        category: 'CONTRACT',
      },
    })

    // ── Meddelande → 1 ──────────────────────────────────────────────────────
    await prisma.sentMessage.create({
      data: {
        organizationId: orgId,
        tenantId,
        sentById: userId,
        subject: 'Information',
        content: 'Hej',
        status: 'SENT',
      },
    })

    // ── Uppsägning: begärd + behandlad → 2 ──────────────────────────────────
    await prisma.terminationRequest.create({
      data: {
        organizationId: orgId,
        tenantId,
        leaseId: leaseAId,
        requestedEndDate: new Date('2025-06-30'),
        status: 'APPROVED',
        reviewedAt: new Date('2025-04-01'),
        reviewedById: userId,
      },
    })

    // ── Besiktning: planerad + utförd → 2 ───────────────────────────────────
    await prisma.inspection.create({
      data: {
        organizationId: orgId,
        propertyId,
        unitId,
        tenantId,
        leaseId: leaseAId,
        inspectedById: userId,
        type: 'MOVE_OUT',
        status: 'COMPLETED',
        scheduledDate: new Date('2025-06-20'),
        completedAt: new Date('2025-06-21'),
        overallCondition: 'Gott skick',
      },
    })

    // ── AGENTSPÅRET: en AI-körning → 1 ──────────────────────────────────────
    await prisma.aiToolExecution.create({
      data: {
        organizationId: orgId,
        tenantId,
        toolName: 'create_maintenance_ticket',
        toolInput: {},
        success: true,
        durationMs: 12,
        requiredConfirmation: false,
      },
    })

    const prismaSomService = prisma as unknown as PrismaService
    service = new TenantHistoryService(prismaSomService)
  })

  afterAll(async () => {
    // Ordningen följer främmande nycklar: barn före förälder.
    await prisma.aiToolExecution.deleteMany({ where: { organizationId: orgId } })
    await prisma.inspection.deleteMany({ where: { organizationId: orgId } })
    await prisma.terminationRequest.deleteMany({ where: { organizationId: orgId } })
    await prisma.sentMessage.deleteMany({ where: { organizationId: orgId } })
    await prisma.document.deleteMany({ where: { organizationId: orgId } })
    await prisma.deposit.deleteMany({ where: { organizationId: orgId } })
    await prisma.maintenanceTicket.deleteMany({ where: { organizationId: orgId } })
    await prisma.keyHandover.deleteMany({ where: { organizationId: orgId } })
    await prisma.lease.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
    await prisma.user.deleteMany({ where: { organizationId: orgId } })
    await prisma.unit.deleteMany({ where: { propertyId: { in: [propertyId] } } })
    await prisma.property.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  /**
   * FACIT — räknat ur källtabellerna, inte ur tjänsten.
   *
   * Varje term speglar en dokumenterad regel i registret. Termerna summeras
   * var för sig så att ett fel går att lokalisera till en källa i stället för
   * att bara visa att totalen glappar.
   */
  async function förväntatAntal(): Promise<{ total: number; per: Record<string, number> }> {
    const per: Record<string, number> = {}

    // Lease: 1 per rad + 1 per activatedAt + 1 per terminatedAt
    const leases = await prisma.lease.count({ where: { organizationId: orgId, tenantId } })
    const leasesAkt = await prisma.lease.count({
      where: { organizationId: orgId, tenantId, activatedAt: { not: null } },
    })
    const leasesTerm = await prisma.lease.count({
      where: { organizationId: orgId, tenantId, terminatedAt: { not: null } },
    })
    per.lease = leases + leasesAkt + leasesTerm

    // KeyHandover: 1 per rad + 1 per returnedAt
    const keys = await prisma.keyHandover.count({ where: { organizationId: orgId, tenantId } })
    const keysRet = await prisma.keyHandover.count({
      where: { organizationId: orgId, tenantId, returnedAt: { not: null } },
    })
    per['key-handover'] = keys + keysRet

    // MaintenanceTicket: 1 per rad + 1 per completedAt
    const tickets = await prisma.maintenanceTicket.count({
      where: { organizationId: orgId, tenantId },
    })
    const ticketsDone = await prisma.maintenanceTicket.count({
      where: { organizationId: orgId, tenantId, completedAt: { not: null } },
    })
    per['maintenance-ticket'] = tickets + ticketsDone

    // Deposit: 1 per rad + 1 per paidAt + 1 per refundedAt
    const dep = await prisma.deposit.count({ where: { organizationId: orgId, tenantId } })
    const depPaid = await prisma.deposit.count({
      where: { organizationId: orgId, tenantId, paidAt: { not: null } },
    })
    const depRef = await prisma.deposit.count({
      where: { organizationId: orgId, tenantId, refundedAt: { not: null } },
    })
    per.deposit = dep + depPaid + depRef

    // AiToolExecution: 1 per rad
    per['ai-tool-execution'] = await prisma.aiToolExecution.count({
      where: { organizationId: orgId, tenantId },
    })

    // Källor utan rader i fixturen bidrar med noll — men räknas ändå, så att
    // en oavsiktlig rad i någon av dem syns i stället för att tyst passera.
    per['invoice-event'] = await prisma.invoiceEvent.count({
      where: { invoice: { organizationId: orgId, tenantId } },
    })
    per['rent-notice-event'] = await prisma.rentNoticeEvent.count({
      where: { rentNotice: { organizationId: orgId, tenantId } },
    })
    per.inspection =
      (await prisma.inspection.count({ where: { organizationId: orgId, tenantId } })) +
      (await prisma.inspection.count({
        where: { organizationId: orgId, tenantId, completedAt: { not: null } },
      }))
    per['termination-request'] =
      (await prisma.terminationRequest.count({ where: { organizationId: orgId, tenantId } })) +
      (await prisma.terminationRequest.count({
        where: { organizationId: orgId, tenantId, reviewedAt: { not: null } },
      }))
    per.document = await prisma.document.count({ where: { organizationId: orgId, tenantId } })
    per['document-signed'] = await prisma.document.count({
      where: { organizationId: orgId, signedByTenantId: tenantId, signedAt: { not: null } },
    })
    per['sent-message'] = await prisma.sentMessage.count({
      where: { organizationId: orgId, tenantId },
    })
    per['consumption-charge'] = await prisma.consumptionCharge.count({
      where: { organizationId: orgId, tenantId },
    })
    per['misc-charge'] = await prisma.miscCharge.count({
      where: { organizationId: orgId, tenantId },
    })
    per.anonymization = await prisma.tenantAnonymizationLog.count({
      where: { organizationId: orgId, tenantId },
    })

    const total = Object.values(per).reduce((a, b) => a + b, 0)
    return { total, per }
  }

  it('ACCEPTANS: antalet händelser är exakt det källtabellerna säger', async () => {
    const facit = await förväntatAntal()
    const historik = await service.forTenant(orgId, tenantId, 'OWNER')

    console.warn(
      `[historik] förväntat=${facit.total} faktiskt=${historik.length} ` +
        `per källa=${JSON.stringify(facit.per)}`,
    )

    expect(historik.length).toBe(facit.total)
  })

  it('facit är inte trivialt — fixturen har flerhändelsekällor', async () => {
    const facit = await förväntatAntal()
    // Avtal: 2 rader → 4 händelser. Nycklar: 2 rader → 3. Ärenden: 2 → 3.
    expect(facit.per.lease).toBe(4)
    expect(facit.per['key-handover']).toBe(3)
    expect(facit.per['maintenance-ticket']).toBe(3)
    expect(facit.per.deposit).toBe(2)
    expect(facit.total).toBeGreaterThan(10)
  })

  it('OMFÅNG: facit räknar VARJE registrerad källa — annars mäter testet mindre än det ser ut', async () => {
    // Utan den här kontrollen kan en 16:e källa registreras utan att
    // acceptanstestet börjar räkna den. Testet hade då fortsatt vara grönt
    // på ett facit som tyst blivit ofullständigt — samma defekt som vakten
    // finns för, fast i mätningen i stället för i koden.
    const facit = await förväntatAntal()
    expect(Object.keys(facit.per).sort()).toEqual(HISTORY_SOURCES.map((s) => s.key).sort())
  })

  it('sorterad nyast först', async () => {
    const h = await service.forTenant(orgId, tenantId, 'OWNER')
    const tider = h.map((e) => e.at.getTime())
    expect([...tider].sort((a, b) => b - a)).toEqual(tider)
  })

  it('varje rad bär hela den normaliserade formen', async () => {
    const h = await service.forTenant(orgId, tenantId, 'OWNER')
    for (const e of h) {
      expect(e.at).toBeInstanceOf(Date)
      expect(typeof e.type).toBe('string')
      expect(['HUMAN', 'AGENT', 'SYSTEM', 'UNKNOWN']).toContain(e.actor.kind)
      expect(typeof e.description).toBe('string')
      expect(['INFO', 'NOTICE', 'WARNING', 'CRITICAL']).toContain(e.severity)
      // Källan ska gå att klicka vidare på: både tabell och id.
      expect(e.source.table).toBeTruthy()
      expect(e.source.id).toBeTruthy()
    }
  })

  it('AGENTAKTÖREN finns i flödet redan innan någon agent gör det', async () => {
    const h = await service.forTenant(orgId, tenantId, 'OWNER')
    const agent = h.filter((e) => e.actor.kind === 'AGENT')
    expect(agent).toHaveLength(1)
    expect(agent[0]?.source.table).toBe('AiToolExecution')
  })

  it('AGGREGATET VIDGAR INGEN ÅTKOMST: VIEWER ser varken AI-körningar eller GDPR-radering', async () => {
    // /ai-usage är ACCOUNTANT+, POST /tenants/:id/anonymize är OWNER-only.
    // Utan filtreringen hade historiken gett en VIEWER båda — en gräns flyttad
    // av misstag. Talen härleds, inte gissas: OWNER ser allt, VIEWER ser allt
    // utom de två begränsade källorna.
    const somOwner = await service.forTenant(orgId, tenantId, 'OWNER')
    const somViewer = await service.forTenant(orgId, tenantId, 'VIEWER')

    const aiHosOwner = somOwner.filter((e) => e.source.table === 'AiToolExecution').length
    const aiHosViewer = somViewer.filter((e) => e.source.table === 'AiToolExecution').length

    console.warn(
      `[historik] OWNER=${somOwner.length} VIEWER=${somViewer.length} (AI: ${aiHosOwner} vs ${aiHosViewer})`,
    )

    expect(aiHosOwner).toBe(1)
    expect(aiHosViewer).toBe(0)
    expect(somViewer.length).toBe(somOwner.length - aiHosOwner)
  })

  it('ACCOUNTANT ser AI-körningar men inte GDPR-raderingar', async () => {
    const somAccountant = await service.forTenant(orgId, tenantId, 'ACCOUNTANT')
    expect(somAccountant.filter((e) => e.source.table === 'AiToolExecution')).toHaveLength(1)
    expect(somAccountant.filter((e) => e.source.table === 'TenantAnonymizationLog')).toHaveLength(0)
  })

  it('MULTI-TENANT: en annan organisation ser ingenting', async () => {
    await expect(service.forTenant(randomUUID(), tenantId, 'OWNER')).rejects.toThrow()
  })
})
