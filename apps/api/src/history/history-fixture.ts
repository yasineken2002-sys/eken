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
  /**
   * TIDIGARE hyresgäst på samma lägenhet (avtal 2023, avslutat). Finns för att
   * lägenhetens historik ska spänna över FLERA hyresgäster — det är den
   * egenskapen objektdimensionen finns för, och den som gör anonymiserings-
   * provet meningsfullt: en anonymiserad tidigare hyresgäst får inte dyka upp
   * igen via objektet.
   */
  formerTenantId: string
  formerLeaseId: string
  /** Kylskåpet som SATT DÄR FÖRST och byttes 2025. */
  oldFridgeId: string
  /** Efterträdaren — den som sitter där nu. */
  newFridgeId: string
  /** Fastighetens hiss (unitId = null) — prövar att objektet kan sakna enhet. */
  elevatorId: string
}

export interface HistoryFixtureCounts {
  rentNotices: number
  tickets: number
  inspections: number
  readings: number
  plans: number
  equipment: number
  equipmentEvents: number
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
    formerTenantId: ids.formerTenantId ?? randomUUID(),
    formerLeaseId: ids.formerLeaseId ?? randomUUID(),
    oldFridgeId: ids.oldFridgeId ?? randomUUID(),
    newFridgeId: ids.newFridgeId ?? randomUUID(),
    elevatorId: ids.elevatorId ?? randomUUID(),
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
    formerEmail: `seed-former-${kort}@example.se`,
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

  // ── TIDIGARE HYRESGÄST: avtal 2023, komplett och avslutat ────────────────
  //
  // Namnet är syntetiskt men DISTINKT ('Seedgästen') med flit: anonymiserings-
  // provet i object-history.db.spec.ts kör den riktiga anonymiseringen och
  // kräver sedan att strängen inte förekommer någonstans i lägenhetens
  // historik. Ett vanligt ord hade kunnat matcha av en slump åt båda hållen.
  //
  // Perioden är KOMPLETT (12 av 12 avier, utflyttsbesiktning utförd, nyckel
  // återlämnad) så att den inte tillför några nya luckor — de avsiktliga
  // luckorna ska förbli den nuvarande hyresgästens, annars går de inte att
  // räkna för hand.
  await prisma.tenant.create({
    data: {
      id: ids.formerTenantId,
      organizationId: ids.organizationId,
      type: 'INDIVIDUAL',
      firstName: 'Tidigare',
      lastName: 'Seedgästen',
      email: unik.formerEmail,
    },
  })
  await prisma.lease.create({
    data: {
      id: ids.formerLeaseId,
      organizationId: ids.organizationId,
      unitId: ids.unitId,
      tenantId: ids.formerTenantId,
      status: 'TERMINATED',
      startDate: new Date('2023-01-01T00:00:00Z'),
      tenancyStartDate: new Date('2023-01-01T00:00:00Z'),
      activatedAt: new Date('2023-01-01T09:00:00Z'),
      terminatedAt: new Date('2023-12-20T00:00:00Z'),
      endDate: new Date('2023-12-31T00:00:00Z'),
      // Fritext utan namn: fältet skrubbas INTE av anonymiseringen, så ett
      // namn här hade läckt förbi provet — och förbi anonymiseringen själv.
      terminationReason: 'Avflyttad',
      monthlyRent: 9200,
      depositAmount: 9200,
    },
  })
  for (let månad = 1; månad <= 12; månad++) {
    const mm = String(månad).padStart(2, '0')
    await prisma.rentNotice.create({
      data: {
        organizationId: ids.organizationId,
        tenantId: ids.formerTenantId,
        leaseId: ids.formerLeaseId,
        noticeNumber: `AVI-2023-${mm}-9${String(månad).padStart(3, '0')}`,
        ocrNumber: `9${String(200000 + månad)}`,
        month: månad,
        year: 2023,
        type: 'RENT',
        amount: 9200,
        vatAmount: 0,
        totalAmount: 9200,
        dueDate: new Date(Date.UTC(2023, månad - 1, 1)),
        status: 'PAID',
        paidAt: new Date(Date.UTC(2023, månad - 1, 3)),
        paidAmount: 9200,
      },
    })
  }
  await prisma.inspection.create({
    data: {
      organizationId: ids.organizationId,
      propertyId: ids.propertyId,
      unitId: ids.unitId,
      leaseId: ids.formerLeaseId,
      tenantId: ids.formerTenantId,
      inspectedById: ids.userId,
      type: 'MOVE_OUT',
      status: 'COMPLETED',
      scheduledDate: new Date('2023-12-27T09:00:00Z'),
      completedAt: new Date('2023-12-28T10:00:00Z'),
      overallCondition: 'Normalt slitage',
    },
  })
  await prisma.keyHandover.create({
    data: {
      organizationId: ids.organizationId,
      leaseId: ids.formerLeaseId,
      unitId: ids.unitId,
      tenantId: ids.formerTenantId,
      type: 'APARTMENT',
      status: 'RETURNED',
      issuedAt: new Date('2023-01-01T10:00:00Z'),
      issuedById: ids.userId,
      returnedAt: new Date('2023-12-28T10:30:00Z'),
      receivedById: ids.userId,
    },
  })

  // ── UTRUSTNING: EN RIKTIG BYTESKEDJA ─────────────────────────────────────
  //
  // Gamla kylskåpet satt 2018–2025 och BYTTES; det nya sitter kvar. Kedjan är
  // riktad med `replacedById` — det är den som gör att historiken kan säga
  // EQUIPMENT_REPLACED i stället för att gissa ur sammanfallande datum.
  //
  // Efterträdaren skapas FÖRST: `replacedById` är en FK, så raden den pekar på
  // måste finnas.
  await prisma.unitEquipment.create({
    data: {
      id: ids.newFridgeId,
      organizationId: ids.organizationId,
      propertyId: ids.propertyId,
      unitId: ids.unitId,
      kind: 'REFRIGERATOR',
      label: 'Kök',
      installedAt: new Date('2025-04-10T00:00:00Z'),
    },
  })
  await prisma.unitEquipment.create({
    data: {
      id: ids.oldFridgeId,
      organizationId: ids.organizationId,
      propertyId: ids.propertyId,
      unitId: ids.unitId,
      kind: 'REFRIGERATOR',
      label: 'Kök',
      installedAt: new Date('2018-06-01T00:00:00Z'),
      removedAt: new Date('2025-04-10T00:00:00Z'),
      replacedById: ids.newFridgeId,
    },
  })

  // FASTIGHETENS hiss: unitId = null. Sitter kvar, aldrig bytt — prövar att
  // ett objekt utan enhet fungerar och att en sak utan removedAt bara ger en
  // händelse.
  await prisma.unitEquipment.create({
    data: {
      id: ids.elevatorId,
      organizationId: ids.organizationId,
      propertyId: ids.propertyId,
      kind: 'ELEVATOR',
      installedAt: new Date('2015-09-01T00:00:00Z'),
    },
  })

  // Händelser: en service på hissen, en reparation av det GAMLA kylskåpet
  // kopplad till felanmälan. Append-only — de skrivs en gång och ändras aldrig.
  await prisma.unitEquipmentEvent.create({
    data: {
      equipmentId: ids.elevatorId,
      type: 'SERVICED',
      occurredAt: new Date('2024-09-15T00:00:00Z'),
      note: 'Årlig service',
    },
  })
  await prisma.unitEquipmentEvent.create({
    data: {
      equipmentId: ids.oldFridgeId,
      type: 'REPAIRED',
      occurredAt: new Date('2024-11-02T00:00:00Z'),
      note: 'Termostat bytt',
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
    equipment: await prisma.unitEquipment.count({ where: { organizationId: ids.organizationId } }),
    equipmentEvents: await prisma.unitEquipmentEvent.count({
      where: { equipment: { organizationId: ids.organizationId } },
    }),
  }
  return { ids, counts }
}
