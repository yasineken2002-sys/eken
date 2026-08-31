/**
 * SEED: EN HYRESGÄST MED VERKLIG HISTORIK ÖVER TID.
 *
 * ── VARFÖR DEN FINNS ────────────────────────────────────────────────────────
 *
 * Dev-databasen hade 0 hyresgäster (mätt 2026-08-31), och varken `db:seed`
 * eller `db:seed:properties` skapar en. Historiken och luckberäkningen mättes
 * därför mot ingenting — och en luckberäkning som körs mot en tom databas
 * hittar aldrig en lucka, vilket ser ut precis som att allt är i sin ordning.
 *
 * ── DETERMINISTISK OCH OMKÖRBAR ─────────────────────────────────────────────
 *
 * Alla id:n är fasta (`SEED_*` nedan), alla datum är absoluta, och inget
 * beräknas ur `new Date()`. Två körningar ger därför exakt samma databasläge,
 * och ett testfall som räknar rader kan lita på talet.
 *
 * Omkörbarheten är implementerad som RADERA-DÄREFTER-SKAPA inom den seedade
 * organisationen, inte som upsert per rad. Skälet: en upsert lämnar kvar rader
 * som en tidigare version av seeden skapade men den nya inte längre skapar, och
 * då driver databasen tyst ifrån seedens innehåll. Raderingen är avgränsad till
 * `SEED_ORG_ID` och rör ingenting annat.
 *
 * ── VILKA LUCKOR DEN SKAPAR MED FLIT ────────────────────────────────────────
 *
 * Seeden är INTE felfri, för en felfri historik går inte att mäta luckor mot:
 *
 *   • avin för 2024-06 saknas          → lucka mot avisering-regeln
 *   • besiktningen 2025-03 är planerad men aldrig utförd → lucka
 *   • underhållsplanen är 5 år försenad → lucka mot MaintenancePlan.interval
 *   • EN mätaravläsning, sedan tyst    → INGEN lucka, för ingen
 *                                        avläsningsfrekvens är konfigurerad
 *                                        någonstans i systemet
 *
 * Den sista är själva poängen. Skillnaden mellan "inget saknas" och "vi vet
 * inte vad som borde ha hänt" måste synas i utdata, inte döljas.
 *
 * Körs med:  cd apps/api && pnpm db:seed:history
 */
import { PrismaClient } from '@prisma/client'

const modulPrisma = new PrismaClient()

// Fasta id:n — determinismen vilar på dem.
const SEED_ORG_ID = '5eed0000-0000-4000-8000-000000000001'
const SEED_USER_ID = '5eed0000-0000-4000-8000-000000000002'
const SEED_PROPERTY_ID = '5eed0000-0000-4000-8000-000000000003'
const SEED_UNIT_ID = '5eed0000-0000-4000-8000-000000000004'
const SEED_TENANT_ID = '5eed0000-0000-4000-8000-000000000005'
const SEED_LEASE_ID = '5eed0000-0000-4000-8000-000000000006'
const SEED_METER_ID = '5eed0000-0000-4000-8000-000000000007'
const SEED_PLAN_ID = '5eed0000-0000-4000-8000-000000000008'

/** Hyresförhållandet: inflytt 2024-01-01, fortfarande pågående. */
const TILLTRÄDE = new Date('2024-01-01T00:00:00Z')

/**
 * Månader som ska ha en hyresavi: från tillträdet till SEED_HORISONT, med
 * 2024-06 utelämnad med flit.
 *
 * ── VARFÖR EN HORISONT, OCH VAD DEN KOSTAR ──────────────────────────────────
 *
 * Avtalet är ACTIVE och har inget slutdatum, så förväntan "en avi per månad"
 * löper vidare med kalendern. Seeden kan inte skapa avier i framtiden, och
 * därför växer antalet luckor efter `SEED_HORISONT` med tiden — det är inte ett
 * fel i seeden utan i vad en horisont ÄR.
 *
 * INOM den seedade perioden saknas exakt EN avi (2024-06), och det är den
 * luckan som är avsiktlig. Ett test som vill ha ett stabilt tal måste därför
 * mäta mot en fast tidpunkt, inte mot `new Date()` — se tenant-gaps.db.spec.ts.
 */
const SEED_HORISONT: readonly [number, number] = [2025, 12]
const AVI_LUCKA: readonly [number, number] = [2024, 6]

function aviMånader(): Array<[number, number]> {
  const ut: Array<[number, number]> = []
  let år = TILLTRÄDE.getUTCFullYear()
  let månad = TILLTRÄDE.getUTCMonth() + 1
  const [slutÅr, slutMånad] = SEED_HORISONT
  while (år < slutÅr || (år === slutÅr && månad <= slutMånad)) {
    if (!(år === AVI_LUCKA[0] && månad === AVI_LUCKA[1])) ut.push([år, månad])
    månad++
    if (månad > 12) {
      månad = 1
      år++
    }
  }
  return ut
}

const AVI_MÅNADER: ReadonlyArray<[number, number]> = aviMånader()

/** Radera allt seedat, i främmande-nyckel-ordning. Rör bara SEED_ORG_ID. */
async function rensa(prisma: PrismaClient): Promise<void> {
  const org = await prisma.organization.findUnique({ where: { id: SEED_ORG_ID } })
  if (!org) return
  const w = { organizationId: SEED_ORG_ID }
  await prisma.rentNoticeEvent.deleteMany({ where: { rentNotice: w } })
  await prisma.rentNoticeLine.deleteMany({ where: { rentNotice: w } })
  await prisma.rentNotice.deleteMany({ where: w })
  await prisma.consumptionCharge.deleteMany({ where: w })
  await prisma.meterReading.deleteMany({ where: w })
  await prisma.meter.deleteMany({ where: w })
  await prisma.inspectionItem.deleteMany({ where: { inspection: w } })
  await prisma.inspection.deleteMany({ where: w })
  await prisma.maintenanceTicket.deleteMany({ where: w })
  await prisma.maintenancePlan.deleteMany({ where: w })
  await prisma.keyHandover.deleteMany({ where: w })
  await prisma.deposit.deleteMany({ where: w })
  await prisma.lease.deleteMany({ where: w })
  await prisma.tenant.deleteMany({ where: w })
  await prisma.unit.deleteMany({ where: { propertyId: SEED_PROPERTY_ID } })
  await prisma.property.deleteMany({ where: w })
  await prisma.user.deleteMany({ where: w })
  await prisma.organization.delete({ where: { id: SEED_ORG_ID } })
}

/**
 * Seedar historiken. Exporterad så att tester kan garantera sitt eget
 * utgångsläge i stället för att förutsätta att någon körde skriptet — CI kör
 * ingen seed, och ett prov som TYST hoppas över när underlaget saknas är grönt
 * av fel skäl.
 */
export async function seedHistory(prisma: PrismaClient = modulPrisma): Promise<void> {
  await rensa(prisma)

  await prisma.organization.create({
    data: {
      id: SEED_ORG_ID,
      name: 'Historik-seed AB',
      orgNumber: '556000-0009',
      email: 'seed-historik@example.se',
      street: 'Seedgatan 1',
      city: 'Testby',
      postalCode: '11111',
    },
  })

  await prisma.user.create({
    data: {
      id: SEED_USER_ID,
      organizationId: SEED_ORG_ID,
      email: 'seed-handlaggare@example.se',
      // Inget riktigt lösenord: kontot är en AKTÖR i historiken, inte en
      // inloggning. En seedad bcrypt-hash hade sett ut som en fungerande
      // credential och är onödig här.
      passwordHash: 'seed-not-a-real-hash',
      firstName: 'Seed',
      lastName: 'Handläggare',
      role: 'OWNER',
    },
  })

  await prisma.property.create({
    data: {
      id: SEED_PROPERTY_ID,
      organizationId: SEED_ORG_ID,
      name: 'Seedfastigheten',
      propertyDesignation: 'TESTBY 1:9',
      type: 'RESIDENTIAL',
      street: 'Seedgatan 1',
      city: 'Testby',
      postalCode: '11111',
      totalArea: 420,
    },
  })

  await prisma.unit.create({
    data: {
      id: SEED_UNIT_ID,
      propertyId: SEED_PROPERTY_ID,
      name: 'Lgh 1201',
      unitNumber: '1201',
      type: 'APARTMENT',
      status: 'OCCUPIED',
      area: 62,
      rooms: 2,
      monthlyRent: 9500,
    },
  })

  await prisma.tenant.create({
    data: {
      id: SEED_TENANT_ID,
      organizationId: SEED_ORG_ID,
      type: 'INDIVIDUAL',
      firstName: 'Seed',
      lastName: 'Hyresgäst',
      email: 'seed-hyresgast@example.se',
    },
  })

  // ── Avtalet: inflytt 2024-01-01, aktiverat, fortfarande pågående ──────────
  await prisma.lease.create({
    data: {
      id: SEED_LEASE_ID,
      organizationId: SEED_ORG_ID,
      unitId: SEED_UNIT_ID,
      tenantId: SEED_TENANT_ID,
      status: 'ACTIVE',
      startDate: TILLTRÄDE,
      tenancyStartDate: TILLTRÄDE,
      activatedAt: new Date('2024-01-01T09:00:00Z'),
      monthlyRent: 9500,
      depositAmount: 9500,
    },
  })

  // ── Nyckelkvittens vid inflytt ───────────────────────────────────────────
  await prisma.keyHandover.create({
    data: {
      organizationId: SEED_ORG_ID,
      leaseId: SEED_LEASE_ID,
      unitId: SEED_UNIT_ID,
      tenantId: SEED_TENANT_ID,
      type: 'APARTMENT',
      status: 'ISSUED',
      issuedAt: new Date('2024-01-01T10:00:00Z'),
      issuedById: SEED_USER_ID,
    },
  })

  // ── Deposition ───────────────────────────────────────────────────────────
  await prisma.deposit.create({
    data: {
      organizationId: SEED_ORG_ID,
      leaseId: SEED_LEASE_ID,
      tenantId: SEED_TENANT_ID,
      amount: 9500,
      status: 'PAID',
      paidAt: new Date('2024-01-05T00:00:00Z'),
    },
  })

  // ── Hyresavier, en per månad UTOM 2024-06 ────────────────────────────────
  let löpnummer = 0
  for (const [år, månad] of AVI_MÅNADER) {
    löpnummer += 1
    const mm = String(månad).padStart(2, '0')
    await prisma.rentNotice.create({
      data: {
        organizationId: SEED_ORG_ID,
        tenantId: SEED_TENANT_ID,
        leaseId: SEED_LEASE_ID,
        noticeNumber: `AVI-${år}-${mm}-${String(löpnummer).padStart(4, '0')}`,
        ocrNumber: `9${String(100000 + löpnummer)}`,
        month: månad,
        year: år,
        type: 'RENT',
        amount: 9500,
        vatAmount: 0,
        totalAmount: 9500,
        dueDate: new Date(Date.UTC(år, månad - 1, 1)),
        status: 'PAID',
        paidAt: new Date(Date.UTC(år, månad - 1, 3)),
        paidAmount: 9500,
      },
    })
  }

  // ── Två felanmälningar: en åtgärdad, en fortfarande öppen ────────────────
  await prisma.maintenanceTicket.create({
    data: {
      organizationId: SEED_ORG_ID,
      propertyId: SEED_PROPERTY_ID,
      unitId: SEED_UNIT_ID,
      tenantId: SEED_TENANT_ID,
      ticketNumber: 'SEED-T-0001',
      title: 'Droppande kran i köket',
      description: 'Kranen droppar jämnt sedan en vecka.',
      category: 'PLUMBING',
      priority: 'NORMAL',
      status: 'COMPLETED',
      createdAt: new Date('2024-04-10T08:00:00Z'),
      completedAt: new Date('2024-04-12T14:00:00Z'),
      actualCost: 1200,
    },
  })
  await prisma.maintenanceTicket.create({
    data: {
      organizationId: SEED_ORG_ID,
      propertyId: SEED_PROPERTY_ID,
      unitId: SEED_UNIT_ID,
      tenantId: SEED_TENANT_ID,
      ticketNumber: 'SEED-T-0002',
      title: 'Drag från balkongdörren',
      description: 'Tätningslisten släpper.',
      category: 'WINDOWS_DOORS',
      priority: 'LOW',
      status: 'NEW',
      createdAt: new Date('2025-01-15T08:00:00Z'),
    },
  })

  // ── Besiktningar: inflytt utförd; en periodisk PLANERAD men aldrig utförd ─
  await prisma.inspection.create({
    data: {
      organizationId: SEED_ORG_ID,
      propertyId: SEED_PROPERTY_ID,
      unitId: SEED_UNIT_ID,
      leaseId: SEED_LEASE_ID,
      tenantId: SEED_TENANT_ID,
      inspectedById: SEED_USER_ID,
      type: 'MOVE_IN',
      status: 'COMPLETED',
      scheduledDate: new Date('2024-01-01T11:00:00Z'),
      completedAt: new Date('2024-01-01T11:30:00Z'),
      overallCondition: 'Gott skick',
    },
  })
  await prisma.inspection.create({
    data: {
      organizationId: SEED_ORG_ID,
      propertyId: SEED_PROPERTY_ID,
      unitId: SEED_UNIT_ID,
      leaseId: SEED_LEASE_ID,
      tenantId: SEED_TENANT_ID,
      inspectedById: SEED_USER_ID,
      type: 'PERIODIC',
      // PLANERAD, aldrig utförd — datumet är förväntan, satt av en människa.
      status: 'SCHEDULED',
      scheduledDate: new Date('2025-03-01T09:00:00Z'),
    },
  })

  // ── Mätare med EN avläsning, sedan tyst ──────────────────────────────────
  // Ingen avläsningsfrekvens är konfigurerad någonstans i systemet, så det här
  // ger INGEN lucka — det ger ett "förväntan saknas". Se docblocket överst.
  await prisma.meter.create({
    data: {
      id: SEED_METER_ID,
      organizationId: SEED_ORG_ID,
      unitId: SEED_UNIT_ID,
      type: 'ELECTRICITY',
      unitOfMeasure: 'kWh',
      status: 'ACTIVE',
      installedAt: TILLTRÄDE,
    },
  })
  await prisma.meterReading.create({
    data: {
      organizationId: SEED_ORG_ID,
      meterId: SEED_METER_ID,
      unitId: SEED_UNIT_ID,
      leaseId: SEED_LEASE_ID,
      value: 1240.5,
      readingType: 'CUMULATIVE',
      readingDate: new Date('2024-02-01T00:00:00Z'),
      periodStart: new Date('2024-01-01T00:00:00Z'),
      periodEnd: new Date('2024-01-31T00:00:00Z'),
      source: 'MANUAL',
      registeredById: SEED_USER_ID,
    },
  })

  // ── Underhållsplan med KONFIGURERAT intervall, sedan länge förfallen ─────
  await prisma.maintenancePlan.create({
    data: {
      id: SEED_PLAN_ID,
      organizationId: SEED_ORG_ID,
      propertyId: SEED_PROPERTY_ID,
      title: 'OVK — obligatorisk ventilationskontroll',
      category: 'HEATING',
      status: 'PLANNED',
      plannedYear: 2020,
      estimatedCost: 25000,
      interval: 3,
      lastDoneYear: 2017,
    },
  })

  const antal = {
    rentNotices: await prisma.rentNotice.count({ where: { organizationId: SEED_ORG_ID } }),
    tickets: await prisma.maintenanceTicket.count({ where: { organizationId: SEED_ORG_ID } }),
    inspections: await prisma.inspection.count({ where: { organizationId: SEED_ORG_ID } }),
    readings: await prisma.meterReading.count({ where: { organizationId: SEED_ORG_ID } }),
    plans: await prisma.maintenancePlan.count({ where: { organizationId: SEED_ORG_ID } }),
  }
  // Antal, inga personuppgifter.
  console.warn(`Historik-seed klar. Org ${SEED_ORG_ID}, hyresgäst ${SEED_TENANT_ID}`)
  console.warn(`  ${JSON.stringify(antal)}`)
  console.warn(
    `  Avsiktliga luckor: avi ${AVI_LUCKA[0]}-${String(AVI_LUCKA[1]).padStart(2, '0')} saknas ` +
      `(inom seedhorisonten ${SEED_HORISONT[0]}-${SEED_HORISONT[1]}), besiktning 2025-03 ej utförd, OVK förfallen.`,
  )
  console.warn(
    '  Månader efter horisonten räknas också som luckor — det talet växer med kalendern.',
  )
}

// Kör bara när filen körs SOM SKRIPT. Importeras den från ett test ska den
// inte starta en seed som bieffekt av importen.
if (require.main === module) {
  seedHistory()
    .catch((e) => {
      console.error(e)
      process.exit(1)
    })
    .finally(() => modulPrisma.$disconnect())
}

export { SEED_ORG_ID, SEED_TENANT_ID, SEED_LEASE_ID, SEED_UNIT_ID, SEED_PROPERTY_ID }
