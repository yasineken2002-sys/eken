/**
 * UTRUSTNINGEN OCH DESS BYTEN (etapp 1b) — mot riktig Postgres.
 *
 * Tre egenskaper som ingen av dem går att pröva mot en attrapp:
 *
 *   1. HISTORIKEN SVARAR "vad byttes och när" — EQUIPMENT_REPLACED med rätt
 *      datum och rätt efterträdare, härlett tal.
 *   2. unitId/propertyId HÄNGER IHOP — en satt `unitId` måste peka på en enhet
 *      i SAMMA fastighet som `propertyId`. En FK kan inte uttrycka det, så
 *      invarianten prövas här, med negativ kontroll.
 *   3. BYTESFÖLJDEN ÄR ACYKLISK — `@unique` spärrar förgrening (databasen),
 *      `assertNoEquipmentCycle` spärrar cykler (koden). Båda prövas åt båda
 *      hållen.
 *
 * INGEN PERSONDATA i utdata — bara antal och nycklar.
 */
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { HistoryService } from './history.service'
import { createHistoryFixture, type HistoryFixtureIds } from './history-fixture'
import { assertNoEquipmentCycle } from './equipment-chain'
import type { PrismaService } from '../common/prisma/prisma.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('utrustning och byten', () => {
  let prisma: PrismaClient
  let history: HistoryService
  let ids: HistoryFixtureIds

  beforeAll(async () => {
    prisma = new PrismaClient()
    history = new HistoryService(prisma as unknown as PrismaService)
    const r = await createHistoryFixture(prisma)
    ids = r.ids
  }, 60_000)

  afterAll(async () => {
    const w = { organizationId: ids.organizationId }
    await prisma.unitEquipmentEvent.deleteMany({ where: { equipment: w } })
    await prisma.unitEquipment.deleteMany({ where: w })
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
   * FACIT för utrustningskällorna — räknat ur KÄLLTABELLERNA, inte genom att
   * anropa tjänsten. Ett facit ur koden som prövas bevisar bara att koden är
   * konsekvent med sig själv.
   */
  async function förväntatUtrustning(
    unitOnly: boolean,
  ): Promise<{ total: number; per: Record<string, number> }> {
    const org = ids.organizationId
    const scope = unitOnly
      ? { organizationId: org, unitId: ids.unitId }
      : { organizationId: org, propertyId: ids.propertyId }

    // equipment: 1 händelse per rad (INSTALLED) + 1 per removedAt
    // (REPLACED eller REMOVED — samma antal, olika typ).
    const equipment =
      (await prisma.unitEquipment.count({ where: scope })) +
      (await prisma.unitEquipment.count({ where: { ...scope, removedAt: { not: null } } }))
    const events = await prisma.unitEquipmentEvent.count({ where: { equipment: scope } })
    const per: Record<string, number> = { equipment, 'equipment-event': events }
    return { total: equipment + events, per }
  }

  it('ACCEPTANS: lägenhetens utrustningshändelser är exakt det källtabellerna säger', async () => {
    const facit = await förväntatUtrustning(true)
    const h = await history.forUnit(ids.organizationId, ids.unitId, 'OWNER')
    const utrustning = h.filter(
      (e) => e.source.table === 'UnitEquipment' || e.source.table === 'UnitEquipmentEvent',
    )
    console.warn(
      `[utrustning] UNIT förväntat=${facit.total} faktiskt=${utrustning.length} per källa=${JSON.stringify(facit.per)}`,
    )
    expect(utrustning.length).toBe(facit.total)
    // Härledning: 2 kylskåp (gamla + nya) → 2 INSTALLED + 1 för removedAt = 3.
    // Hissen har unitId=null och räknas INTE här. Händelser: reparationen av
    // det gamla kylskåpet = 1. Hissens service hör till fastigheten.
    expect(facit.per.equipment).toBe(3)
    expect(facit.per['equipment-event']).toBe(1)
  })

  it('ACCEPTANS: fastigheten ser ALLT, inklusive hissen som saknar enhet', async () => {
    const facit = await förväntatUtrustning(false)
    const h = await history.forProperty(ids.organizationId, ids.propertyId, 'OWNER')
    const utrustning = h.filter(
      (e) => e.source.table === 'UnitEquipment' || e.source.table === 'UnitEquipmentEvent',
    )
    console.warn(
      `[utrustning] PROPERTY förväntat=${facit.total} faktiskt=${utrustning.length} per källa=${JSON.stringify(facit.per)}`,
    )
    expect(utrustning.length).toBe(facit.total)
    // 3 objekt (2 kylskåp + hiss) → 3 INSTALLED + 1 removedAt = 4.
    // Händelser: hissens service + kylskåpets reparation = 2.
    expect(facit.per.equipment).toBe(4)
    expect(facit.per['equipment-event']).toBe(2)
  })

  it('KÄRNAN: historiken svarar EQUIPMENT_REPLACED med rätt datum och rätt efterträdare', async () => {
    const h = await history.forUnit(ids.organizationId, ids.unitId, 'OWNER')
    const byten = h.filter((e) => e.type === 'EQUIPMENT_REPLACED')

    // EXAKT ett byte — inte "fler än noll".
    expect(byten).toHaveLength(1)
    const bytet = byten[0]!

    // Rätt datum: bytet skedde när det gamla togs bort.
    const gammalt = await prisma.unitEquipment.findUniqueOrThrow({
      where: { id: ids.oldFridgeId },
      select: { removedAt: true, replacedById: true },
    })
    expect(bytet.at.toISOString()).toBe(gammalt.removedAt!.toISOString())

    // Rätt efterträdare: den raden pekar på, inte en gissning ur datum.
    expect(gammalt.replacedById).toBe(ids.newFridgeId)
    expect(bytet.source.id).toBe(ids.oldFridgeId)
    expect(bytet.description).toContain('byttes')

    console.warn(
      `[utrustning] byte: ${bytet.at.toISOString().slice(0, 10)}, källa=${bytet.source.id === ids.oldFridgeId ? 'gamla kylskåpet' : 'FEL'}`,
    )
  })

  it('en sak som togs bort UTAN efterträdare ger REMOVED, inte REPLACED', async () => {
    // Skillnaden är hela poängen med replacedById: utan den vet historiken
    // inte om ett borttaget objekt ersattes eller bara försvann.
    const tillfällig = await prisma.unitEquipment.create({
      data: {
        organizationId: ids.organizationId,
        propertyId: ids.propertyId,
        unitId: ids.unitId,
        kind: 'DISHWASHER',
        installedAt: new Date('2019-01-01T00:00:00Z'),
        removedAt: new Date('2024-01-01T00:00:00Z'),
      },
    })
    try {
      const h = await history.forUnit(ids.organizationId, ids.unitId, 'OWNER')
      const borttagna = h.filter((e) => e.type === 'EQUIPMENT_REMOVED')
      expect(borttagna).toHaveLength(1)
      expect(borttagna[0]?.source.id).toBe(tillfällig.id)
      // Och bytet är fortfarande exakt ett — de blandas inte ihop.
      expect(h.filter((e) => e.type === 'EQUIPMENT_REPLACED')).toHaveLength(1)
    } finally {
      await prisma.unitEquipment.delete({ where: { id: tillfällig.id } })
    }
  })

  // ── INVARIANTEN unitId ⊂ propertyId, med negativ kontroll ────────────────
  it('unitens fastighet är SAMMA som propertyId — för varje rad', async () => {
    const rader = await prisma.unitEquipment.findMany({
      where: { organizationId: ids.organizationId, unitId: { not: null } },
      select: { id: true, propertyId: true, unit: { select: { propertyId: true } } },
    })
    expect(rader.length).toBeGreaterThan(0) // annars prövar testet ingenting
    for (const r of rader) {
      expect(r.unit?.propertyId).toBe(r.propertyId)
    }
    console.warn(`[utrustning] invariant prövad på ${rader.length} rader med enhet`)
  })

  it('NEGATIV KONTROLL: invarianten FÄLLER när fastigheterna skiljer sig', async () => {
    // En andra fastighet med en egen enhet. Att peka utrustningens propertyId
    // på fastighet A men unitId på en enhet i fastighet B är exakt det en FK
    // INTE kan hindra — och exakt det invarianten ovan finns för.
    const annanProp = await prisma.property.create({
      data: {
        organizationId: ids.organizationId,
        name: 'Annan fastighet',
        propertyDesignation: `ANNAN ${randomUUID().slice(0, 6)}`,
        type: 'RESIDENTIAL',
        street: 'a',
        city: 'b',
        postalCode: '11111',
        totalArea: 100,
      },
    })
    const annanUnit = await prisma.unit.create({
      data: {
        propertyId: annanProp.id,
        name: 'U2',
        unitNumber: '2',
        type: 'APARTMENT',
        area: 40,
        monthlyRent: 7000,
      },
    })
    // Databasen SLÄPPER IGENOM detta — båda FK:erna är giltiga var för sig.
    const trasig = await prisma.unitEquipment.create({
      data: {
        organizationId: ids.organizationId,
        propertyId: ids.propertyId, // fastighet A
        unitId: annanUnit.id, // enhet i fastighet B
        kind: 'STOVE',
        installedAt: new Date('2020-01-01T00:00:00Z'),
      },
    })
    try {
      const r = await prisma.unitEquipment.findUniqueOrThrow({
        where: { id: trasig.id },
        select: { propertyId: true, unit: { select: { propertyId: true } } },
      })
      // Invarianten är BRUTEN — kontrollen ovan hade fällt på den här raden.
      expect(r.unit?.propertyId).not.toBe(r.propertyId)
    } finally {
      await prisma.unitEquipment.delete({ where: { id: trasig.id } })
      await prisma.unit.delete({ where: { id: annanUnit.id } })
      await prisma.property.delete({ where: { id: annanProp.id } })
    }
  })

  // ── CYKELSPÄRREN, båda hållen ────────────────────────────────────────────
  it('CYKEL: en länk som skulle sluta cirkeln AVVISAS', async () => {
    // Kedjan är gammalt → nytt. Att länka nytt → gammalt sluter cirkeln.
    await expect(assertNoEquipmentCycle(prisma, ids.newFridgeId, ids.oldFridgeId)).rejects.toThrow(
      /cirkulär/i,
    )
  })

  it('CYKEL: en sak kan inte ersätta sig själv', async () => {
    await expect(assertNoEquipmentCycle(prisma, ids.oldFridgeId, ids.oldFridgeId)).rejects.toThrow(
      /sig själv/i,
    )
  })

  it('CYKEL: en laglig länk släpps igenom — spärren fäller inte allt', async () => {
    // En regel som avvisar allt är lika värdelös som en som aldrig avvisar.
    // Hissen är inte i kedjan; att låta den ersättas av något nytt är lagligt.
    await expect(
      assertNoEquipmentCycle(prisma, ids.elevatorId, ids.newFridgeId),
    ).resolves.toBeUndefined()
  })

  it('FÖRGRENING: databasen avvisar två föregångare mot samma efterträdare', async () => {
    // @unique på replacedById. Den här spärren är databasens, inte kodens —
    // och den prövas mot en riktig databas eftersom en attrapp inte har index.
    await expect(
      prisma.unitEquipment.create({
        data: {
          organizationId: ids.organizationId,
          propertyId: ids.propertyId,
          unitId: ids.unitId,
          kind: 'REFRIGERATOR',
          installedAt: new Date('2017-01-01T00:00:00Z'),
          removedAt: new Date('2025-04-10T00:00:00Z'),
          replacedById: ids.newFridgeId, // redan taget av det gamla kylskåpet
        },
      }),
    ).rejects.toThrow()
  })

  it('APPEND-ONLY: händelsetabellen kan inte uppdateras', async () => {
    const e = await prisma.unitEquipmentEvent.findFirstOrThrow({
      where: { equipment: { organizationId: ids.organizationId } },
      select: { id: true },
    })
    // Databastriggern (#585-mekaniken), inte en vana i koden.
    await expect(
      prisma.unitEquipmentEvent.update({ where: { id: e.id }, data: { note: 'ändrad' } }),
    ).rejects.toThrow(/append-only/i)
  })
})
