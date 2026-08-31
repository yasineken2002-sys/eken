/**
 * LUCKBERÄKNINGEN — mot den seedade hyresgästen i riktig Postgres.
 *
 * ── DE TVÅ NEGATIVA KONTROLLERNA ────────────────────────────────────────────
 *
 * En regel som aldrig larmar och en som larmar på allt är lika värdelösa, och
 * ser olika ut bara om båda prövas:
 *
 *   1. ta bort utförandet → luckan ska DYKA UPP
 *   2. ett objekt förväntan inte gäller → får INTE ge en lucka
 *
 * ── EN AVVIKELSE FRÅN UPPDRAGET, MED SKÄL ───────────────────────────────────
 *
 * Kontroll 1 var formulerad som "ta bort en BESIKTNING → luckan ska dyka upp".
 * Så kan den inte byggas, och skälet är mätt: det finns inget
 * besiktningsINTERVALL i systemet — inget fält i `schema.prisma`, ingen regel i
 * koden. Tar man bort en besiktning försvinner därför förväntan tillsammans med
 * den, och ingen lucka kan uppstå. Att införa ett intervall för att få provet
 * att gå igenom vore att hitta på förväntan, vilket uppdraget uttryckligen
 * förbjuder.
 *
 * Kontrollen prövar i stället samma sak på den förväntan som FAKTISKT finns:
 * `Inspection.scheduledDate` är satt av en människa, så en planerad besiktning
 * vars dag passerat utan att bli utförd ÄR en lucka. Att ta bort utförandet
 * (`completedAt`) får luckan att dyka upp — samma form, mot en förväntan som
 * går att belägga. Samma prov görs dessutom på `MaintenancePlan.lastDoneYear`,
 * som är ett riktigt konfigurerat intervall.
 *
 * INGEN PERSONDATA i utdata — bara antal och nycklar.
 */
import { PrismaClient } from '@prisma/client'
import { TenantGapsService } from './tenant-gaps.service'
import { HISTORY_EXPECTATIONS } from './history-expectations'
import { seedHistory } from '../../prisma/seed-history'
import type { PrismaService } from '../common/prisma/prisma.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

const SEED_ORG = '5eed0000-0000-4000-8000-000000000001'
const SEED_TENANT = '5eed0000-0000-4000-8000-000000000005'

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('luckberäkningen', () => {
  let prisma: PrismaClient
  let service: TenantGapsService
  /** Fast mätpunkt — annars mäts luckorna mot när provet råkade köras. */
  const NU = new Date('2026-01-15T00:00:00Z')

  beforeAll(async () => {
    prisma = new PrismaClient()
    // Provet skapar sitt EGET utgångsläge. CI kör ingen seed, och ett prov som
    // tyst hoppas över när underlaget saknas är grönt av fel skäl — samma
    // defekt som #565. Seeden är idempotent och scopad till SEED_ORG.
    await seedHistory(prisma)
    service = new TenantGapsService(prisma as unknown as PrismaService)
  }, 60_000)
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('KANARIEFÅGEL: seeden gav underlag (annars mäts luckor mot en tom databas)', async () => {
    // Härlett tal, inte "fler än noll": seeden skapar 23 avier och 2 besiktningar.
    expect(await prisma.tenant.count({ where: { id: SEED_TENANT } })).toBe(1)
    expect(await prisma.rentNotice.count({ where: { organizationId: SEED_ORG } })).toBe(23)
    expect(await prisma.inspection.count({ where: { organizationId: SEED_ORG } })).toBe(2)
  })

  it('VARJE deklarerad förväntan får ett utfall — inga tysta bortfall', async () => {
    const r = await service.forTenant(SEED_ORG, SEED_TENANT, NU)
    expect(r.map((x) => x.key).sort()).toEqual(HISTORY_EXPECTATIONS.map((x) => x.key).sort())
  })

  it('ODEFINIERAD redovisas som eget utfall, inte som frånvaro', async () => {
    const r = await service.forTenant(SEED_ORG, SEED_TENANT, NU)
    const odef = r.filter((x) => x.status === 'ODEFINIERAD')
    // De tre planen ger som exempel men systemet inte kan mäta.
    expect(odef.map((x) => x.key).sort()).toEqual([
      'inspection-interval',
      'maintenance-ticket-response',
      'meter-reading-interval',
    ])
    for (const o of odef) {
      expect(o.source.kind).toBe('ODEFINIERAD')
      // Skälet ska stå i svaret, inte bara i koden.
      expect(o.detail.length).toBeGreaterThan(60)
    }
    console.warn(`[luckor] ODEFINIERADE=${odef.length} nycklar=${odef.map((x) => x.key).join(',')}`)
  })

  it('varje utfall bär sin förväntans KÄLLA', async () => {
    const r = await service.forTenant(SEED_ORG, SEED_TENANT, NU)
    for (const x of r) {
      expect(['KONFIGURERAD', 'SYSTEMREGEL', 'ODEFINIERAD']).toContain(x.source.kind)
    }
  })

  it('den seedade luckan hittas: avin för 2024-06 saknas', async () => {
    const r = await service.forTenant(SEED_ORG, SEED_TENANT, NU)
    const avier = r.find((x) => x.key === 'rent-notice-per-month')
    expect(avier?.status).toBe('LUCKA')
    expect(avier?.detail).toContain('2024-06')
    // HÄRLETT TAL, inte "fler än noll": mätpunkten 2026-01-15 ger 24 förfallna
    // månader (2024-01…2025-12), seeden skapar 23 avier → exakt EN saknas.
    // Skulle seedhorisonten flyttas utan att det här talet följer med, faller
    // provet — vilket är rätt: talet är en mätning, inte en dekoration.
    expect(avier?.missingCount).toBe(1)
    console.warn(
      `[luckor] avier: ${avier?.status} saknade=${avier?.missingCount} (förväntat exakt 1)`,
    )
  })

  it('den seedade luckan hittas: OVK är förfallen mot sitt konfigurerade intervall', async () => {
    const r = await service.forTenant(SEED_ORG, SEED_TENANT, NU)
    const plan = r.find((x) => x.key === 'maintenance-plan-interval')
    expect(plan?.status).toBe('LUCKA')
    expect(plan?.source.kind).toBe('KONFIGURERAD')
  })

  // ── NEGATIV KONTROLL 1: ta bort utförandet → luckan dyker upp ────────────
  it('NEGATIV 1: en utförd besiktning som blir outförd ger en lucka — och tvärtom', async () => {
    const planerad = await prisma.inspection.findFirst({
      where: { organizationId: SEED_ORG, tenantId: SEED_TENANT, type: 'PERIODIC' },
      select: { id: true },
    })
    expect(planerad).not.toBeNull()

    // Utgångsläge: seeden har den PLANERAD men aldrig utförd → LUCKA.
    const före = await service.forTenant(SEED_ORG, SEED_TENANT, NU)
    expect(före.find((x) => x.key === 'scheduled-inspection-completed')?.status).toBe('LUCKA')

    // Markera den utförd → luckan ska FÖRSVINNA.
    await prisma.inspection.update({
      where: { id: planerad!.id },
      data: { completedAt: new Date('2025-03-02T00:00:00Z'), status: 'COMPLETED' },
    })
    const efter = await service.forTenant(SEED_ORG, SEED_TENANT, NU)
    expect(efter.find((x) => x.key === 'scheduled-inspection-completed')?.status).toBe('UPPFYLLD')

    // Ta bort utförandet igen → luckan ska DYKA UPP igen.
    await prisma.inspection.update({
      where: { id: planerad!.id },
      data: { completedAt: null, status: 'SCHEDULED' },
    })
    const åter = await service.forTenant(SEED_ORG, SEED_TENANT, NU)
    expect(åter.find((x) => x.key === 'scheduled-inspection-completed')?.status).toBe('LUCKA')

    console.warn('[luckor] NEGATIV 1: LUCKA → UPPFYLLD → LUCKA, båda riktningarna')
  })

  // ── NEGATIV KONTROLL 2: förväntan gäller inte → INGEN lucka ──────────────
  it('NEGATIV 2: ett avtal som började förra månaden ger INGEN avi-lucka', async () => {
    // En regel som larmar på allt är lika värdelös som en som aldrig larmar.
    // Det här avtalet kan omöjligt ha en avi för tiden innan det fanns.
    const org = await prisma.organization.create({
      data: {
        name: 'gap-neg-2',
        email: 'gap-neg-2@example.se',
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
    })
    const prop = await prisma.property.create({
      data: {
        organizationId: org.id,
        name: 'P',
        propertyDesignation: 'X 1:1',
        type: 'RESIDENTIAL',
        street: 'a',
        city: 'b',
        postalCode: '11111',
        totalArea: 100,
      },
    })
    const unit = await prisma.unit.create({
      data: {
        propertyId: prop.id,
        name: 'U',
        unitNumber: '1',
        type: 'APARTMENT',
        area: 50,
        monthlyRent: 8000,
      },
    })
    const t = await prisma.tenant.create({
      data: {
        organizationId: org.id,
        type: 'INDIVIDUAL',
        firstName: 'Ny',
        lastName: 'Inflyttad',
        email: 'gap-neg-2-t@example.se',
      },
    })
    // Tillträde 2025-12-01, mätpunkt 2026-01-15 → EN förfallen månad (dec).
    await prisma.lease.create({
      data: {
        organizationId: org.id,
        unitId: unit.id,
        tenantId: t.id,
        status: 'ACTIVE',
        startDate: new Date('2025-12-01T00:00:00Z'),
        tenancyStartDate: new Date('2025-12-01T00:00:00Z'),
        activatedAt: new Date('2025-12-01T00:00:00Z'),
        monthlyRent: 8000,
        depositAmount: 8000,
      },
    })

    try {
      // Utan avi för dec → EXAKT en lucka, inte tolv. Fönstret är beviset.
      const utan = await service.forTenant(org.id, t.id, NU)
      const a1 = utan.find((x) => x.key === 'rent-notice-per-month')
      expect(a1?.status).toBe('LUCKA')
      expect(a1?.missingCount).toBe(1)

      // Med avin på plats → INGEN lucka alls, trots att avtalet är nytt.
      const lease = await prisma.lease.findFirstOrThrow({ where: { tenantId: t.id } })
      await prisma.rentNotice.create({
        data: {
          organizationId: org.id,
          tenantId: t.id,
          leaseId: lease.id,
          noticeNumber: 'NEG2-2025-12-0001',
          ocrNumber: '9200001',
          month: 12,
          year: 2025,
          type: 'RENT',
          amount: 8000,
          vatAmount: 0,
          totalAmount: 8000,
          dueDate: new Date('2025-12-01T00:00:00Z'),
          status: 'PAID',
        },
      })
      const med = await service.forTenant(org.id, t.id, NU)
      const a2 = med.find((x) => x.key === 'rent-notice-per-month')
      expect(a2?.status).toBe('UPPFYLLD')

      // Och besiktningsförväntan GÄLLER_EJ — ingen är inplanerad.
      expect(med.find((x) => x.key === 'scheduled-inspection-completed')?.status).toBe('GÄLLER_EJ')

      console.warn(`[luckor] NEGATIV 2: nytt avtal → förväntade=1, ${a1?.status}→${a2?.status}`)
    } finally {
      await prisma.rentNotice.deleteMany({ where: { organizationId: org.id } })
      await prisma.lease.deleteMany({ where: { organizationId: org.id } })
      await prisma.tenant.deleteMany({ where: { organizationId: org.id } })
      await prisma.unit.deleteMany({ where: { propertyId: prop.id } })
      await prisma.property.deleteMany({ where: { organizationId: org.id } })
      await prisma.organization.delete({ where: { id: org.id } })
    }
  })

  it('MULTI-TENANT: en annan organisation ser ingenting', async () => {
    await expect(
      service.forTenant('00000000-0000-4000-8000-000000000000', SEED_TENANT, NU),
    ).rejects.toThrow()
  })
})
