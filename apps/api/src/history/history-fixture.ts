/**
 * HISTORIKFIXTUREN — den som SKAPAR data. Inget destruktivt här.
 *
 * ── VARFÖR DEN LIGGER UNDER src/ OCH INTE I prisma/ ─────────────────────────
 *
 * Den låg i `prisma/seed-history.ts`, och specen importerade den DÄRIFRÅN. Den
 * importen sänkte prod.
 *
 * `apps/api/tsconfig.json` har `include: ["src"]` men hade ingen `rootDir`, så
 * TypeScript härledde roten ur den gemensamma katalogen för alla indatafiler.
 * En enda import från `src/` ut till `prisma/` flyttade den roten från `src/`
 * till `apps/api/` — och därmed HELA byggutdatan ett steg ner:
 *
 *     nest build       → exit 0   (grönt!)
 *     dist/main.js     → SAKNAS
 *     dist/src/main.js → FINNS
 *     → migrate-and-start.sh: Cannot find module '/app/apps/api/dist/main.js'
 *
 * Bygget var grönt, CI var grön (33/33), och prod startade inte. Se #591.
 *
 * ── DÄRFÖR PEKAR PILEN NU ÅT ANDRA HÅLLET ───────────────────────────────────
 *
 * `prisma/seed-history.ts` importerar HÄRIFRÅN. Ingenting under `src/` rör
 * `prisma/`, så `prisma/` dras aldrig in i programmet och roten kan inte
 * förskjutas igen. `rootDir: "./src"` är dessutom satt explicit, så ett
 * återfall blir ett högljutt TS6059 i stället för en tyst förskjutning.
 *
 * ── OCH DÄRFÖR ÄR DET DESTRUKTIVA KVAR I prisma/ ────────────────────────────
 *
 * Den här filen ligger under `src/` och följer alltså med i prod-bundlen. Den
 * får därför bara KUNNA SKAPA rader i en organisation anroparen namnger — den
 * kan inte radera något, och den kan inte råka träffa en befintlig
 * organisation, eftersom id:n som standard slumpas. Radera-därefter-skapa och
 * de fasta id:na bor i CLI-skalet, utanför bundlen och bakom en miljögrind.
 */
import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'

/** Hyresförhållandet: inflytt 2024-01-01, fortfarande pågående. */
export const FIXTURE_TILLTRÄDE = new Date('2024-01-01T00:00:00Z')

/** Sista månaden fixturen skapar en avi för. Se `fixtureAviMånader`. */
export const FIXTURE_HORISONT: readonly [number, number] = [2025, 12]

/** Månaden som med flit SAKNAR avi — luckan luckberäkningen prövas mot. */
export const FIXTURE_AVI_LUCKA: readonly [number, number] = [2024, 6]

export interface HistoryFixtureIds {
  organizationId: string
  userId: string
  propertyId: string
  unitId: string
  tenantId: string
  leaseId: string
  meterId: string
  planId: string
}

export interface HistoryFixtureCounts {
  rentNotices: number
  tickets: number
  inspections: number
  readings: number
  plans: number
}

/**
 * Månader som ska ha en hyresavi: från tillträdet till `FIXTURE_HORISONT`, med
 * `FIXTURE_AVI_LUCKA` utelämnad med flit.
 *
 * Avtalet är ACTIVE och har inget slutdatum, så förväntan "en avi per månad"
 * löper vidare med kalendern. Fixturen kan inte skapa avier i framtiden, och
 * antalet luckor efter horisonten växer därför med tiden — det är inte ett fel
 * utan vad en horisont ÄR. Ett prov som vill ha ett stabilt tal måste mäta mot
 * en fast tidpunkt, inte mot `new Date()`.
 */
export function fixtureAviMånader(): Array<[number, number]> {
  const ut: Array<[number, number]> = []
  let år = FIXTURE_TILLTRÄDE.getUTCFullYear()
  let månad = FIXTURE_TILLTRÄDE.getUTCMonth() + 1
  const [slutÅr, slutMånad] = FIXTURE_HORISONT
  while (år < slutÅr || (år === slutÅr && månad <= slutMånad)) {
    if (!(år === FIXTURE_AVI_LUCKA[0] && månad === FIXTURE_AVI_LUCKA[1])) ut.push([år, månad])
    månad++
    if (månad > 12) {
      månad = 1
      år++
    }
  }
  return ut
}

const AVI_MÅNADER: ReadonlyArray<[number, number]> = fixtureAviMånader()

/**
 * Skapar hyresgästen med historik. SKAPAR BARA — raderar aldrig.
 *
 * `ids` kan anges för att få determinism (CLI-skalet gör det). Utelämnas de
 * slumpas varje id, så två samtidiga anrop inte kan kollidera och inget
 * befintligt kan träffas.
 *
 * Fixturen är med flit INTE felfri — en felfri historik går inte att mäta
 * luckor mot:
 *
 *   • avin för FIXTURE_AVI_LUCKA saknas       → lucka mot avisering-regeln
 *   • besiktningen 2025-03 är planerad men aldrig utförd → lucka
 *   • underhållsplanen är förfallen           → lucka mot MaintenancePlan.interval
 *   • EN mätaravläsning, sedan tyst           → INGEN lucka: ingen
 *                                               avläsningsfrekvens är konfigurerad
 */
export async function createHistoryFixture(
  prisma: PrismaClient,
  ids: Partial<HistoryFixtureIds> = {},
): Promise<{ ids: HistoryFixtureIds; counts: HistoryFixtureCounts }> {
  const full: HistoryFixtureIds = {
    organizationId: ids.organizationId ?? randomUUID(),
    userId: ids.userId ?? randomUUID(),
    propertyId: ids.propertyId ?? randomUUID(),
    unitId: ids.unitId ?? randomUUID(),
    tenantId: ids.tenantId ?? randomUUID(),
    leaseId: ids.leaseId ?? randomUUID(),
    meterId: ids.meterId ?? randomUUID(),
    planId: ids.planId ?? randomUUID(),
  }
  return skapa(prisma, full)
}

async function skapa(
  prisma: PrismaClient,
  ids: HistoryFixtureIds,
): Promise<{ ids: HistoryFixtureIds; counts: HistoryFixtureCounts }> {
  // Unikhetsbärande fält härleds ur organisationens id, så två fixturer med
  // olika id:n aldrig krockar på e-post, orgnummer eller ärendenummer.
  const kort = ids.organizationId.replace(/-/g, '').slice(0, 10)
  const unik = {
    prefix: `SEED-${kort.toUpperCase()}`,
    orgNumber: `55${kort.replace(/\D/g, '0').slice(0, 4)}-${kort.replace(/\D/g, '0').slice(4, 8)}`,
    orgEmail: `seed-org-${kort}@example.se`,
    userEmail: `seed-user-${kort}@example.se`,
    tenantEmail: `seed-tenant-${kort}@example.se`,
  }

  await prisma.organization.create({
    data: {
      id: ids.organizationId,
      name: 'Historik-seed AB',
      orgNumber: unik.orgNumber,
      email: unik.orgEmail,
      street: 'Seedgatan 1',
      city: 'Testby',
      postalCode: '11111',
    },
  })

  await prisma.user.create({
    data: {
      id: ids.userId,
      organizationId: ids.organizationId,
      email: unik.userEmail,
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
      id: ids.propertyId,
      organizationId: ids.organizationId,
      name: 'Seedfastigheten',
      propertyDesignation: `${unik.prefix} 1:9`,
      type: 'RESIDENTIAL',
      street: 'Seedgatan 1',
      city: 'Testby',
      postalCode: '11111',
      totalArea: 420,
    },
  })

  await prisma.unit.create({
    data: {
      id: ids.unitId,
      propertyId: ids.propertyId,
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
      id: ids.tenantId,
      organizationId: ids.organizationId,
      type: 'INDIVIDUAL',
      firstName: 'Seed',
      lastName: 'Hyresgäst',
      email: unik.tenantEmail,
    },
  })

  // ── Avtalet: inflytt 2024-01-01, aktiverat, fortfarande pågående ──────────
  await prisma.lease.create({
    data: {
      id: ids.leaseId,
      organizationId: ids.organizationId,
      unitId: ids.unitId,
      tenantId: ids.tenantId,
      status: 'ACTIVE',
      startDate: FIXTURE_TILLTRÄDE,
      tenancyStartDate: FIXTURE_TILLTRÄDE,
      activatedAt: new Date('2024-01-01T09:00:00Z'),
      monthlyRent: 9500,
      depositAmount: 9500,
    },
  })

  // ── Nyckelkvittens vid inflytt ───────────────────────────────────────────
  await prisma.keyHandover.create({
    data: {
      organizationId: ids.organizationId,
      leaseId: ids.leaseId,
      unitId: ids.unitId,
      tenantId: ids.tenantId,
      type: 'APARTMENT',
      status: 'ISSUED',
      issuedAt: new Date('2024-01-01T10:00:00Z'),
      issuedById: ids.userId,
    },
  })

  // ── Deposition ───────────────────────────────────────────────────────────
  await prisma.deposit.create({
    data: {
      organizationId: ids.organizationId,
      leaseId: ids.leaseId,
      tenantId: ids.tenantId,
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
        organizationId: ids.organizationId,
        tenantId: ids.tenantId,
        leaseId: ids.leaseId,
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
      organizationId: ids.organizationId,
      propertyId: ids.propertyId,
      unitId: ids.unitId,
      tenantId: ids.tenantId,
      ticketNumber: `${unik.prefix}-T-0001`,
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
      organizationId: ids.organizationId,
      propertyId: ids.propertyId,
      unitId: ids.unitId,
      tenantId: ids.tenantId,
      ticketNumber: `${unik.prefix}-T-0002`,
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
      organizationId: ids.organizationId,
      propertyId: ids.propertyId,
      unitId: ids.unitId,
      leaseId: ids.leaseId,
      tenantId: ids.tenantId,
      inspectedById: ids.userId,
      type: 'MOVE_IN',
      status: 'COMPLETED',
      scheduledDate: new Date('2024-01-01T11:00:00Z'),
      completedAt: new Date('2024-01-01T11:30:00Z'),
      overallCondition: 'Gott skick',
    },
  })
  await prisma.inspection.create({
    data: {
      organizationId: ids.organizationId,
      propertyId: ids.propertyId,
      unitId: ids.unitId,
      leaseId: ids.leaseId,
      tenantId: ids.tenantId,
      inspectedById: ids.userId,
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
      id: ids.meterId,
      organizationId: ids.organizationId,
      unitId: ids.unitId,
      type: 'ELECTRICITY',
      unitOfMeasure: 'kWh',
      status: 'ACTIVE',
      installedAt: FIXTURE_TILLTRÄDE,
    },
  })
  await prisma.meterReading.create({
    data: {
      organizationId: ids.organizationId,
      meterId: ids.meterId,
      unitId: ids.unitId,
      leaseId: ids.leaseId,
      value: 1240.5,
      readingType: 'CUMULATIVE',
      readingDate: new Date('2024-02-01T00:00:00Z'),
      periodStart: new Date('2024-01-01T00:00:00Z'),
      periodEnd: new Date('2024-01-31T00:00:00Z'),
      source: 'MANUAL',
      registeredById: ids.userId,
    },
  })

  // ── Underhållsplan med KONFIGURERAT intervall, sedan länge förfallen ─────
  await prisma.maintenancePlan.create({
    data: {
      id: ids.planId,
      organizationId: ids.organizationId,
      propertyId: ids.propertyId,
      title: 'OVK — obligatorisk ventilationskontroll',
      category: 'HEATING',
      status: 'PLANNED',
      plannedYear: 2020,
      estimatedCost: 25000,
      interval: 3,
      lastDoneYear: 2017,
    },
  })

  const counts: HistoryFixtureCounts = {
    rentNotices: await prisma.rentNotice.count({ where: { organizationId: ids.organizationId } }),
    tickets: await prisma.maintenanceTicket.count({
      where: { organizationId: ids.organizationId },
    }),
    inspections: await prisma.inspection.count({ where: { organizationId: ids.organizationId } }),
    readings: await prisma.meterReading.count({ where: { organizationId: ids.organizationId } }),
    plans: await prisma.maintenancePlan.count({ where: { organizationId: ids.organizationId } }),
  }
  return { ids, counts }
}
