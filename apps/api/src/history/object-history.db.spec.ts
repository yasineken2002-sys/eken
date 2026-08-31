/**
 * LÄGENHETENS OCH FASTIGHETENS HISTORIK — mot riktig Postgres.
 *
 * ── VAD SOM ÄR FARLIGARE HÄR ÄN I HYRESGÄSTDIMENSIONEN ─────────────────────
 *
 * 1. AGGREGATREGELN: en lägenhet spänner över flera hyresgäster, en fastighet
 *    över flera lägenheter — spridningen i källornas behörighet är större.
 *    Regeln (planens Del 8, uppmätt i #589) är att ytan tar den SNÄVASTE
 *    grinden. Uppmätt för de här dimensionerna: ingen käll-GET är rollgrindad,
 *    så VIEWER och OWNER ska se EXAKT samma svar — och det prövas, inte antas.
 *
 * 2. PERSONDATA FRÅN FLERA PERSONER: en lägenhets historik visar tidigare
 *    hyresgäster. Två invarianter prövas mot den RIKTIGA anonymiserings-
 *    funktionen (`anonymizeTenantWithin` — samma som operatörs- och
 *    portalvägen kör), inte en efterlikning:
 *
 *      a) Ingen källa läser personfält ur `Tenant` — namnet och e-posten på
 *         den tidigare hyresgästen förekommer INTE i svaret ens FÖRE
 *         anonymisering. Det är den starkare egenskapen: det finns inget att
 *         skrubba för att inget någonsin hämtas.
 *      b) Efter anonymisering består händelserna (domänfakta — avtalet fanns,
 *         nyckeln lämnades) men personen är borta. Sammanställning vid läsning
 *         har ingen andra kopia, så det anonymiseringen nollar är borta i
 *         samma ögonblick.
 *
 * INGEN PERSONDATA i utdata — bara antal och nycklar. De syntetiska strängarna
 * ('Seedgästen', seed-former-…) skrivs aldrig till konsolen; de används bara i
 * negativa contains-assertioner.
 */
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { HistoryService } from './history.service'
import { GapsService } from './gaps.service'
import { HISTORY_SOURCES } from './history-sources.registry'
import { createHistoryFixture, type HistoryFixtureIds } from './history-fixture'
import { anonymizeTenantWithin } from '../common/gdpr/anonymize-tenant'
import type { PrismaService } from '../common/prisma/prisma.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('objekthistoriken', () => {
  let prisma: PrismaClient
  let history: HistoryService
  let gaps: GapsService
  let ids: HistoryFixtureIds
  /** Fast mätpunkt — annars mäts luckorna mot när provet råkade köras. */
  const NU = new Date('2026-01-15T00:00:00Z')

  beforeAll(async () => {
    prisma = new PrismaClient()
    const prismaSomService = prisma as unknown as PrismaService
    history = new HistoryService(prismaSomService)
    gaps = new GapsService(prismaSomService)

    // Provet skapar sitt EGET utgångsläge (CI kör ingen seed; #565).
    // Slumpat orgId — rör aldrig CLI-seedens organisation.
    const resultat = await createHistoryFixture(prisma)
    ids = resultat.ids

    // Fastighetskällor som fixturen inte fyller: en PUBLICERAD nyhet, ett
    // UTKAST (som INTE ska räknas — filtret är deklarerat i källan och prövas
    // här), och ett fastighetsdokument. Utan rader hade de källorna varit
    // gröna av "0 == 0", vilket inte skiljer en fungerande mappning från en
    // som aldrig körs.
    await prisma.newsPost.create({
      data: {
        organizationId: ids.organizationId,
        propertyId: ids.propertyId,
        createdById: ids.userId,
        title: 'Vattnet avstängt torsdag',
        content: 'Underhåll.',
        targetAll: false,
        publishedAt: new Date('2025-05-01T08:00:00Z'),
      },
    })
    await prisma.newsPost.create({
      data: {
        organizationId: ids.organizationId,
        propertyId: ids.propertyId,
        createdById: ids.userId,
        title: 'UTKAST — ej publicerad',
        content: 'Ska inte synas.',
        targetAll: false,
      },
    })
    await prisma.document.create({
      data: {
        organizationId: ids.organizationId,
        propertyId: ids.propertyId,
        name: 'Energideklaration.pdf',
        storageKey: `p/${randomUUID().slice(0, 8)}`,
        storageUrl: 'https://example.invalid/e',
        fileSize: 2048,
        mimeType: 'application/pdf',
        category: 'OTHER',
      },
    })
  }, 60_000)

  afterAll(async () => {
    const w = { organizationId: ids.organizationId }
    // Utrustningens händelser FÖRE ärendena (Restrict på maintenanceTicketId),
    // och utrustningen före fastigheten (FK på propertyId).
    await prisma.unitEquipmentEvent.deleteMany({ where: { equipment: w } })
    await prisma.unitEquipment.deleteMany({ where: w })
    await prisma.tenantAnonymizationLog.deleteMany({ where: w })
    await prisma.newsPost.deleteMany({ where: w })
    await prisma.rentNotice.deleteMany({ where: w })
    await prisma.meterReading.deleteMany({ where: w })
    await prisma.meter.deleteMany({ where: w })
    await prisma.inspection.deleteMany({ where: w })
    await prisma.maintenanceTicket.deleteMany({ where: w })
    await prisma.maintenancePlan.deleteMany({ where: w })
    await prisma.keyHandover.deleteMany({ where: w })
    await prisma.deposit.deleteMany({ where: w })
    await prisma.document.deleteMany({ where: w })
    await prisma.lease.deleteMany({ where: w })
    await prisma.tenant.deleteMany({ where: w })
    await prisma.unit.deleteMany({ where: { property: w } })
    await prisma.property.deleteMany({ where: w })
    await prisma.user.deleteMany({ where: w })
    await prisma.organization.deleteMany({ where: { id: ids.organizationId } })
    await prisma.$disconnect()
  }, 60_000)

  /**
   * FACIT för lägenheten — räknat ur KÄLLTABELLERNA med egna frågor, inte
   * genom att anropa tjänsten. Varje term speglar källans dokumenterade regel.
   */
  async function förväntatFörUnit(): Promise<{ total: number; per: Record<string, number> }> {
    const org = ids.organizationId
    const unitId = ids.unitId
    const per: Record<string, number> = {}

    per.lease =
      (await prisma.lease.count({ where: { organizationId: org, unitId } })) +
      (await prisma.lease.count({
        where: { organizationId: org, unitId, activatedAt: { not: null } },
      })) +
      (await prisma.lease.count({
        where: { organizationId: org, unitId, terminatedAt: { not: null } },
      }))
    per['maintenance-ticket'] =
      (await prisma.maintenanceTicket.count({ where: { organizationId: org, unitId } })) +
      (await prisma.maintenanceTicket.count({
        where: { organizationId: org, unitId, completedAt: { not: null } },
      }))
    per.inspection =
      (await prisma.inspection.count({ where: { organizationId: org, unitId } })) +
      (await prisma.inspection.count({
        where: { organizationId: org, unitId, completedAt: { not: null } },
      }))
    per['key-handover'] =
      (await prisma.keyHandover.count({ where: { organizationId: org, unitId } })) +
      (await prisma.keyHandover.count({
        where: { organizationId: org, unitId, returnedAt: { not: null } },
      }))
    per.document = await prisma.document.count({ where: { organizationId: org, unitId } })
    per.meter =
      (await prisma.meter.count({ where: { organizationId: org, unitId } })) +
      (await prisma.meter.count({
        where: { organizationId: org, unitId, removedAt: { not: null } },
      })) +
      (await prisma.meterReading.count({ where: { organizationId: org, unitId } }))
    // Utrustning (1b): 1 INSTALLED per rad + 1 per removedAt (REPLACED eller
    // REMOVED — samma antal, olika typ beroende på om efterträdare finns).
    per.equipment =
      (await prisma.unitEquipment.count({ where: { organizationId: org, unitId } })) +
      (await prisma.unitEquipment.count({
        where: { organizationId: org, unitId, removedAt: { not: null } },
      }))
    per['equipment-event'] = await prisma.unitEquipmentEvent.count({
      where: { equipment: { organizationId: org, unitId } },
    })

    return { total: Object.values(per).reduce((a, b) => a + b, 0), per }
  }

  /** FACIT för fastigheten. Nyhetstermen speglar källans publicerings-filter. */
  async function förväntatFörProperty(): Promise<{ total: number; per: Record<string, number> }> {
    const org = ids.organizationId
    const propertyId = ids.propertyId
    const per: Record<string, number> = {}

    per['maintenance-ticket'] =
      (await prisma.maintenanceTicket.count({ where: { organizationId: org, propertyId } })) +
      (await prisma.maintenanceTicket.count({
        where: { organizationId: org, propertyId, completedAt: { not: null } },
      }))
    per.inspection =
      (await prisma.inspection.count({ where: { organizationId: org, propertyId } })) +
      (await prisma.inspection.count({
        where: { organizationId: org, propertyId, completedAt: { not: null } },
      }))
    per.document = await prisma.document.count({ where: { organizationId: org, propertyId } })
    per['maintenance-plan'] =
      (await prisma.maintenancePlan.count({ where: { organizationId: org, propertyId } })) +
      (await prisma.maintenancePlan.count({
        where: { organizationId: org, propertyId, completedAt: { not: null } },
      }))
    per['news-post'] = await prisma.newsPost.count({
      where: { organizationId: org, propertyId, publishedAt: { not: null } },
    })
    // Fastigheten ser ALL utrustning, inklusive den som sitter i en lägenhet
    // och den som saknar enhet (hiss). Se källans docblock.
    per.equipment =
      (await prisma.unitEquipment.count({ where: { organizationId: org, propertyId } })) +
      (await prisma.unitEquipment.count({
        where: { organizationId: org, propertyId, removedAt: { not: null } },
      }))
    per['equipment-event'] = await prisma.unitEquipmentEvent.count({
      where: { equipment: { organizationId: org, propertyId } },
    })

    return { total: Object.values(per).reduce((a, b) => a + b, 0), per }
  }

  it('ACCEPTANS lägenhet: antalet händelser är exakt det källtabellerna säger', async () => {
    const facit = await förväntatFörUnit()
    const h = await history.forUnit(ids.organizationId, ids.unitId, 'OWNER')
    console.warn(
      `[objekt] UNIT förväntat=${facit.total} faktiskt=${h.length} per källa=${JSON.stringify(facit.per)}`,
    )
    expect(h.length).toBe(facit.total)
  })

  it('facit för lägenheten är inte trivialt — det spänner över TVÅ hyresgäster', async () => {
    const facit = await förväntatFörUnit()
    // Härledning: nuvarande avtal (skapat+aktiverat=2) + tidigare (skapat+
    // aktiverat+avslutat=3) = 5. Nycklar: nuvarande utlämnad (1) + tidigare
    // utlämnad+återlämnad (2) = 3. Besiktningar: MOVE_IN utförd (2) + PERIODIC
    // planerad (1) + MOVE_OUT utförd (2) = 5. Mätare: 1 installerad + 1
    // avläsning = 2. Ärenden: 2 varav 1 åtgärdat = 3.
    expect(facit.per.lease).toBe(5)
    expect(facit.per['key-handover']).toBe(3)
    expect(facit.per.inspection).toBe(5)
    expect(facit.per.meter).toBe(2)
    expect(facit.per['maintenance-ticket']).toBe(3)
    // + utrustning: 2 kylskåp → 2 INSTALLED + 1 REPLACED = 3, och 1 reparation.
    expect(facit.per.equipment).toBe(3)
    expect(facit.per['equipment-event']).toBe(1)
    expect(facit.total).toBe(22)
  })

  it('ACCEPTANS fastighet: antalet händelser är exakt det källtabellerna säger', async () => {
    const facit = await förväntatFörProperty()
    const h = await history.forProperty(ids.organizationId, ids.propertyId, 'OWNER')
    console.warn(
      `[objekt] PROPERTY förväntat=${facit.total} faktiskt=${h.length} per källa=${JSON.stringify(facit.per)}`,
    )
    expect(h.length).toBe(facit.total)
    // Härledning: ärenden 3 + besiktningar 5 + dokument 1 + plan (upprättad,
    // ej utförd) 1 + publicerad nyhet 1 = 11. Utkastet räknas INTE.
    expect(facit.per['news-post']).toBe(1)
    // + utrustning: 3 objekt (2 kylskåp + hiss) → 3 INSTALLED + 1 REPLACED = 4,
    // och 2 händelser (hissens service + kylskåpets reparation).
    expect(facit.per.equipment).toBe(4)
    expect(facit.per['equipment-event']).toBe(2)
    expect(facit.total).toBe(17)
  })

  it('utkast till nyhet syns INTE — källans deklarerade filter håller', async () => {
    const h = await history.forProperty(ids.organizationId, ids.propertyId, 'OWNER')
    const nyheter = h.filter((e) => e.source.table === 'NewsPost')
    expect(nyheter).toHaveLength(1)
    expect(nyheter[0]?.description).toContain('Vattnet avstängt')
  })

  it('OMFÅNG: facit räknar VARJE källa som deklarerar dimensionen', async () => {
    // Utan detta kan en ny källa få dimensionen utan att acceptanstestet
    // börjar räkna den — testet hade förblivit grönt på ett tyst ofullständigt
    // facit. Samma kontroll som hyresgästspecen har.
    const unitFacit = await förväntatFörUnit()
    const unitKällor = HISTORY_SOURCES.filter((s) => s.relations.unit).map((s) => s.key)
    expect(Object.keys(unitFacit.per).sort()).toEqual(unitKällor.sort())

    const propFacit = await förväntatFörProperty()
    const propKällor = HISTORY_SOURCES.filter((s) => s.relations.property).map((s) => s.key)
    expect(Object.keys(propFacit.per).sort()).toEqual(propKällor.sort())
  })

  it('AGGREGATREGELN: VIEWER ser exakt samma objekthistorik som OWNER', async () => {
    // Ingen källa i objektdimensionerna bär `restrictedToRoles` — uppmätt mot
    // authz-surface-golden: alla käll-GET:ar ligger i hinken "öppen för VARJE
    // roll". Då ska rollerna se SAMMA svar; en skillnad hade betytt att en
    // begränsad källa smugit sig in utan att golden-mätningen gjorts om.
    const [ownerU, viewerU] = await Promise.all([
      history.forUnit(ids.organizationId, ids.unitId, 'OWNER'),
      history.forUnit(ids.organizationId, ids.unitId, 'VIEWER'),
    ])
    expect(viewerU.length).toBe(ownerU.length)

    const [ownerP, viewerP] = await Promise.all([
      history.forProperty(ids.organizationId, ids.propertyId, 'OWNER'),
      history.forProperty(ids.organizationId, ids.propertyId, 'VIEWER'),
    ])
    expect(viewerP.length).toBe(ownerP.length)
  })

  it('PERSONDATA a: den tidigare hyresgästens namn/e-post finns inte i svaret ens FÖRE anonymisering', async () => {
    const kort = ids.organizationId.replace(/-/g, '').slice(0, 10)
    const formerEmail = `seed-former-${kort}@example.se`
    const h = await history.forUnit(ids.organizationId, ids.unitId, 'OWNER')
    const json = JSON.stringify(h)
    // Ingen källa läser personfält ur Tenant. Det är invarianten som gör att
    // anonymiseringen inte HAR något att missa här.
    expect(json).not.toContain('Seedgästen')
    expect(json).not.toContain(formerEmail)
    // …men händelserna finns: den tidigare hyresgästens avtal syns som avslutat.
    expect(h.some((e) => e.type === 'LEASE_TERMINATED')).toBe(true)
  })

  it('PERSONDATA b: RIKTIG anonymisering — händelserna består, personen är borta', async () => {
    const före = await history.forUnit(ids.organizationId, ids.unitId, 'OWNER')

    // Den riktiga funktionen — samma som operatörsvägen (tenants.service) och
    // portalvägen kör. Ingen efterlikning: en stubbe hade kunnat glida isär
    // från vad anonymiseringen faktiskt gör.
    await prisma.$transaction(async (tx) => {
      await anonymizeTenantWithin(tx, ids.formerTenantId, ids.organizationId, {
        performedById: ids.userId,
        reason: 'GDPR-begäran (testfixtur)',
      })
    })

    const efter = await history.forUnit(ids.organizationId, ids.unitId, 'OWNER')
    // Domänfakta består: avtalet fanns, nyckeln lämnades, besiktningen gjordes.
    // Sammanställning vid läsning = ingen andra kopia att skrubba, ingen rad
    // att tappa.
    expect(efter.length).toBe(före.length)

    const kort = ids.organizationId.replace(/-/g, '').slice(0, 10)
    const json = JSON.stringify(efter)
    expect(json).not.toContain('Seedgästen')
    expect(json).not.toContain(`seed-former-${kort}@example.se`)

    // Och i HYRESGÄSTdimensionen syns själva anonymiseringen som händelse
    // (OWNER-källa) — spåret av att raderingen skedde är också historik.
    const tenantH = await history.forTenant(ids.organizationId, ids.formerTenantId, 'OWNER')
    expect(tenantH.some((e) => e.type === 'TENANT_ANONYMIZED')).toBe(true)
  })

  it('LUCKOR lägenhet: härledda tal över BÅDA hyresgästernas avtal', async () => {
    const r = await gaps.forUnit(ids.organizationId, ids.unitId, NU)

    const avier = r.find((x) => x.key === 'rent-notice-per-month')
    // Härledning vid NU=2026-01-15: nuvarande avtal 2024-01…2025-12 = 24
    // förväntade varav 23 finns; tidigare avtal 2023-01…2023-12 = 12/12.
    // Totalt 36 förväntade, EXAKT 1 saknas (2024-06).
    expect(avier?.status).toBe('LUCKA')
    expect(avier?.missingCount).toBe(1)
    expect(avier?.detail).toContain('av 36')
    expect(avier?.detail).toContain('2024-06')

    // PERIODIC 2025-03 planerad, aldrig utförd → 1. MOVE_IN/MOVE_OUT är utförda.
    expect(r.find((x) => x.key === 'scheduled-inspection-completed')?.missingCount).toBe(1)
    expect(r.find((x) => x.key === 'maintenance-plan-interval')?.status).toBe('LUCKA')
    expect(r.filter((x) => x.status === 'ODEFINIERAD')).toHaveLength(3)
    console.warn(`[objekt] UNIT-luckor: avier saknade=${avier?.missingCount} av 36 förväntade`)
  })

  it('LUCKOR fastighet: samma förväntningar, fastighetens hela avtalsmängd', async () => {
    const r = await gaps.forProperty(ids.organizationId, ids.propertyId, NU)
    const avier = r.find((x) => x.key === 'rent-notice-per-month')
    // Fastigheten har en lägenhet, så mängden är densamma som lägenhetens.
    expect(avier?.status).toBe('LUCKA')
    expect(avier?.missingCount).toBe(1)
    expect(r.find((x) => x.key === 'maintenance-plan-interval')?.status).toBe('LUCKA')
    expect(r.filter((x) => x.status === 'ODEFINIERAD')).toHaveLength(3)
  })

  it('MULTI-TENANT: en annan organisation ser ingenting', async () => {
    await expect(history.forUnit(randomUUID(), ids.unitId, 'OWNER')).rejects.toThrow()
    await expect(history.forProperty(randomUUID(), ids.propertyId, 'OWNER')).rejects.toThrow()
    await expect(gaps.forUnit(randomUUID(), ids.unitId, NU)).rejects.toThrow()
  })
})
