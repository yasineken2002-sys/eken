/**
 * FÖRVÄNTANSFÄLTEN PÅ UTRUSTNING (etapp 1c) — mot riktig Postgres.
 *
 * ── DEN AVGÖRANDE REGELN ────────────────────────────────────────────────────
 *
 *   fältet SATT  → KONFIGURERAD, lucka beräknas
 *   fältet NULL  → ODEFINIERAD, med skälet utskrivet — ALDRIG "ingen lucka"
 *
 * Skillnaden mellan "inget saknas" och "vi vet inte vad som borde ha hänt" är
 * hela poängen med luckberäkningen. Ett null som tyst blir "allt är bra" är
 * exakt den defekt som byggts bort på fyra andra ställen i projektet, och den
 * kan inte tillåtas komma in igen genom en nullbar kolumn.
 *
 * De fyra negativa kontrollerna prövas mot SEEDENS data, inte mot fixturer
 * skapade i testet — värdena är valda i history-fixture.ts just för att bära
 * dem, och en kontroll som bygger sitt eget underlag prövar bara sig själv.
 *
 * INGEN PERSONDATA i utdata — bara antal och nycklar.
 */
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { GapsService } from './gaps.service'
import { HISTORY_EXPECTATIONS } from './history-expectations'
import { createHistoryFixture, type HistoryFixtureIds } from './history-fixture'
import type { PrismaService } from '../common/prisma/prisma.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('utrustningens förväntansfält', () => {
  let prisma: PrismaClient
  let gaps: GapsService
  let ids: HistoryFixtureIds
  /** Fast mätpunkt — annars mäts luckorna mot när provet råkade köras. */
  const NU = new Date('2026-01-15T00:00:00Z')

  beforeAll(async () => {
    prisma = new PrismaClient()
    gaps = new GapsService(prisma as unknown as PrismaService)
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

  const livslängd = (r: Awaited<ReturnType<GapsService['forProperty']>>) =>
    r.find((x) => x.key === 'equipment-lifespan')
  const service = (r: Awaited<ReturnType<GapsService['forProperty']>>) =>
    r.find((x) => x.key === 'equipment-service-interval')

  it('KANARIEFÅGEL: seeden gav underlag med och utan värden', async () => {
    // Härledda tal: 3 objekt, alla med livslängd, och EXAKT ett utan
    // serviceintervall (hissen). Utan den ojämnheten prövar kontroll 2 inget.
    const alla = await prisma.unitEquipment.count({ where: { organizationId: ids.organizationId } })
    const medLivslängd = await prisma.unitEquipment.count({
      where: { organizationId: ids.organizationId, expectedLifespanYears: { not: null } },
    })
    const utanService = await prisma.unitEquipment.count({
      where: { organizationId: ids.organizationId, serviceIntervalMonths: null },
    })
    expect(alla).toBe(3)
    expect(medLivslängd).toBe(3)
    expect(utanService).toBe(1)
  })

  it('förväntningarna är DEKLARERADE som konfigurerade, med bärarfältet utskrivet', async () => {
    const def = HISTORY_EXPECTATIONS.filter((e) => e.key.startsWith('equipment-'))
    expect(def).toHaveLength(2)
    for (const d of def) {
      expect(d.source.kind).toBe('KONFIGURERAD')
      if (d.source.kind === 'KONFIGURERAD') expect(d.source.field).toContain('UnitEquipment.')
    }
  })

  it('VARJE förväntan får ett utfall — även de nya', async () => {
    const r = await gaps.forProperty(ids.organizationId, ids.propertyId, NU)
    expect(r.map((x) => x.key).sort()).toEqual(HISTORY_EXPECTATIONS.map((x) => x.key).sort())
  })

  // ── KONTROLL 1: satt livslängd + gammal installedAt → LUCKA ──────────────
  it('KONTROLL 1: livslängd satt och passerad → LUCKA', async () => {
    const r = await gaps.forProperty(ids.organizationId, ids.propertyId, NU)
    const l = livslängd(r)
    // Hissen: installerad 2015-09-01, livslängd 8 år → förföll 2023, sitter kvar.
    expect(l?.status).toBe('LUCKA')
    expect(l?.missingCount).toBe(1)
    expect(l?.detail).toContain('ELEVATOR')
    expect(l?.source.kind).toBe('KONFIGURERAD')
    console.warn(`[1c] KONTROLL 1: ${l?.status}, försenade=${l?.missingCount}`)
  })

  // ── KONTROLL 2: samma sak med värdet NULL → ODEFINIERAD ──────────────────
  it('KONTROLL 2: värdet NULL → ODEFINIERAD med skäl, ALDRIG "ingen lucka"', async () => {
    const r = await gaps.forProperty(ids.organizationId, ids.propertyId, NU)
    const s = service(r)
    // Hissen saknar serviceIntervalMonths. De två kylskåpen har 24 mån och är
    // inte försenade — utan regeln hade svaret blivit UPPFYLLD, alltså "allt
    // är bra", trots att vi inte vet något om hissen.
    expect(s?.status).toBe('ODEFINIERAD')
    expect(s?.status).not.toBe('UPPFYLLD')
    expect(s?.source.kind).toBe('ODEFINIERAD')
    if (s?.source.kind === 'ODEFINIERAD') {
      expect(s.source.why).toContain('serviceIntervalMonths')
      expect(s.source.why.length).toBeGreaterThan(60)
    }
    // Skälet ska stå i SVARET, inte bara i koden.
    expect(s?.detail).toContain('Ingen förväntan är definierad')
    console.warn(`[1c] KONTROLL 2: ${s?.status}, källa=${s?.source.kind}`)
  })

  it('KONTROLL 2b: ett objekt UTAN värden alls ger ODEFINIERAD, inte UPPFYLLD', async () => {
    // Renodlat fall: en egen lägenhet där ingenting har värden. Utan det kan
    // kontroll 2 döljas av att andra objekt råkar vara mätbara.
    const unit = await prisma.unit.create({
      data: {
        propertyId: ids.propertyId,
        name: 'U-tom',
        unitNumber: `T${randomUUID().slice(0, 4)}`,
        type: 'APARTMENT',
        area: 30,
        monthlyRent: 5000,
      },
    })
    const utrustning = await prisma.unitEquipment.create({
      data: {
        organizationId: ids.organizationId,
        propertyId: ids.propertyId,
        unitId: unit.id,
        kind: 'STOVE',
        installedAt: new Date('2005-01-01T00:00:00Z'),
        // Båda fälten null: gammal sak, men INGEN uttalad förväntan.
      },
    })
    try {
      const r = await gaps.forUnit(ids.organizationId, unit.id, NU)
      const l = livslängd(r)
      // Spisen är 21 år gammal — men vi VET INTE om det är för gammalt.
      expect(l?.status).toBe('ODEFINIERAD')
      expect(l?.detail).toContain('Ingen förväntan är definierad')
      expect(service(r)?.status).toBe('ODEFINIERAD')
      console.warn(`[1c] KONTROLL 2b: 21 år gammal spis utan värde → ${l?.status}`)
    } finally {
      await prisma.unitEquipment.delete({ where: { id: utrustning.id } })
      await prisma.unit.delete({ where: { id: unit.id } })
    }
  })

  // ── KONTROLL 3: satt livslängd + nyligen installerad → INGEN lucka ───────
  it('KONTROLL 3: livslängd satt men inte passerad → objektet larmar INTE', async () => {
    const r = await gaps.forUnit(ids.organizationId, ids.unitId, NU)
    const l = livslängd(r)
    // Lägenheten har bara kylskåpen: nya (2025 + 10 = 2035, inte passerad) och
    // gamla (utbytt, kontroll 4). Ingen av dem ska larma.
    expect(l?.status).toBe('UPPFYLLD')
    expect(l?.missingCount).toBeUndefined()
    expect(l?.detail).toContain('inom sin gräns')
    console.warn(`[1c] KONTROLL 3: ${l?.status} — nytt kylskåp larmar inte`)
  })

  // ── KONTROLL 4: redan utbytt utrustning → INGEN lucka ────────────────────
  it('KONTROLL 4: utbytt utrustning larmar INTE, trots passerad livslängd', async () => {
    // Det gamla kylskåpet: installerat 2018, livslängd 5 → förföll 2023.
    // Det VORE försenat om det satt kvar. Men det byttes 2025-04-10, och
    // 1b:s bytesföljd gör att raden finns kvar för alltid.
    const gammalt = await prisma.unitEquipment.findUniqueOrThrow({
      where: { id: ids.oldFridgeId },
      select: {
        installedAt: true,
        removedAt: true,
        replacedById: true,
        expectedLifespanYears: true,
      },
    })
    expect(gammalt.expectedLifespanYears).toBe(5)
    expect(gammalt.removedAt).not.toBeNull()
    expect(gammalt.replacedById).toBe(ids.newFridgeId)

    // Härlett: 2018 + 5 = 2023 < 2026-01-15. Villkoret är alltså uppfyllt för
    // att larma — det enda som hindrar är att saken är borttagen.
    const skulleFörfalla = new Date(gammalt.installedAt)
    skulleFörfalla.setUTCFullYear(skulleFörfalla.getUTCFullYear() + 5)
    expect(skulleFörfalla.getTime()).toBeLessThan(NU.getTime())

    const r = await gaps.forUnit(ids.organizationId, ids.unitId, NU)
    const l = livslängd(r)
    expect(l?.status).toBe('UPPFYLLD')
    expect(l?.detail ?? '').not.toContain('2018')
    console.warn(
      `[1c] KONTROLL 4: gammalt kylskåp förföll ${skulleFörfalla.toISOString().slice(0, 10)} men är utbytt → ${l?.status}`,
    )
  })

  it('KONTROLL 4b: samma sak BORTTAGEN utan efterträdare larmar inte heller', async () => {
    // Villkoret är removedAt: null, inte replacedById: null — en sak som
    // skrotades utan ersättning är lika lite försenad som en som byttes.
    const skrotad = await prisma.unitEquipment.create({
      data: {
        organizationId: ids.organizationId,
        propertyId: ids.propertyId,
        unitId: ids.unitId,
        kind: 'DISHWASHER',
        installedAt: new Date('2010-01-01T00:00:00Z'),
        removedAt: new Date('2024-01-01T00:00:00Z'),
        expectedLifespanYears: 5, // förföll 2015 — skulle larmat om den satt kvar
      },
    })
    try {
      const l = livslängd(await gaps.forUnit(ids.organizationId, ids.unitId, NU))
      expect(l?.status).toBe('UPPFYLLD')
    } finally {
      await prisma.unitEquipment.delete({ where: { id: skrotad.id } })
    }
  })

  it('hyresgästdimensionen: utrustning GÄLLER_EJ — den hör till objektet', async () => {
    const r = await gaps.forTenant(ids.organizationId, ids.tenantId, NU)
    expect(livslängd(r)?.status).toBe('GÄLLER_EJ')
    expect(service(r)?.status).toBe('GÄLLER_EJ')
  })

  it('besiktning och avläsning är FORTFARANDE odefinierade — 1c gav dem ingen bärare', async () => {
    const r = await gaps.forUnit(ids.organizationId, ids.unitId, NU)
    const odef = r.filter((x) => x.status === 'ODEFINIERAD').map((x) => x.key)
    expect(odef).toContain('inspection-interval')
    expect(odef).toContain('meter-reading-interval')
    expect(odef).toContain('maintenance-ticket-response')
  })
})
