/**
 * ETAPP 1b: SKRIVVÄGEN — mot riktig Postgres.
 *
 * ── VAD SOM SAKNADES, MÄTT FÖRE BYGGET ──────────────────────────────────────
 *
 * Planens rad 1b sa "läsvägen finns, skrivvägen inte", och mätningen bekräftade
 * det exakt: modellerna fanns (`UnitEquipment`, `UnitEquipmentEvent`),
 * historiken svarade redan `EQUIPMENT_REPLACED`, men
 *
 *     moduler/kataloger med "equip"                     0
 *     *.controller.ts som nämner equipment              0
 *     unitEquipment.create i produktionskod             0
 *     apps/web/src med utrustnings-feature              0
 *     assertNoEquipmentCycle-anropare i produktionskod  0
 *
 * Frågan gick alltså att STÄLLA, men svaret kunde bara bli tomt i prod.
 *
 * ── VARFÖR MOT RIKTIG POSTGRES ──────────────────────────────────────────────
 *
 * Tre av egenskaperna nedan ÄR databasens och kan inte visas mot en attrapp:
 * append-only-triggern (#585) som avvisar UPDATE, `@unique` på `correctsId` som
 * spärrar en förgrenad rättelsekedja, och org-scopningen som går via
 * `unit → property → organizationId` i en `where`. En attrapp returnerar det den
 * blev tillsagd oavsett `where`.
 *
 * ── VAD DEN HÄR FILEN INTE KAN SE ───────────────────────────────────────────
 *
 * Att rutten är monterad och att `@Roles` sitter på den. Den anropar tjänsten
 * direkt. Rollgrinden ägs av `authz-surface.golden.spec.ts`; monteringen av att
 * `EquipmentModule` står i `app.module.ts`.
 */
import { randomUUID } from 'node:crypto'
import { BadRequestException, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { EquipmentService } from './equipment.service'
import { HISTORY_SOURCES } from '../history/history-sources.registry'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

// Utanför det hoppbara blocket — annars är den grön av att den hoppades över.
describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

const POOL = 8
const urlMedPool = (bas: string) => {
  const u = new URL(bas)
  u.searchParams.set('connection_limit', String(POOL))
  return u.toString()
}

medDb('etapp 1b · utrustningens skrivväg', () => {
  let prisma: PrismaService
  let service: EquipmentService
  let orgId: string
  let annanOrgId: string
  let userId: string
  let montörId: string
  let unitId: string
  let annanUnitId: string

  /** Riggen skapar sina EGNA förutsättningar — den lånar ingenting ur miljön. */
  const nyOrg = async (märke: string) => {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `utr-${märke}-${sfx}`,
        email: `utr-${märke}-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
    })
    const prop = await prisma.property.create({
      data: {
        organizationId: org.id,
        name: `P-${märke}`,
        propertyDesignation: `X ${märke}:1`,
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
        name: `U-${märke}`,
        unitNumber: '1',
        type: 'APARTMENT',
        area: 50,
        monthlyRent: 8000,
      },
    })
    return { orgId: org.id, unitId: unit.id }
  }

  beforeAll(async () => {
    const bas = process.env.DATABASE_URL as string
    process.env.DATABASE_URL = urlMedPool(bas)
    prisma = new PrismaService()
    process.env.DATABASE_URL = bas
    service = new EquipmentService(prisma)

    const a = await nyOrg('a')
    orgId = a.orgId
    unitId = a.unitId
    const b = await nyOrg('b')
    annanOrgId = b.orgId
    annanUnitId = b.unitId

    const sfx = randomUUID().slice(0, 8)
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `utr-u-${sfx}@example.se`,
        passwordHash: 'x',
        firstName: 'Ida',
        lastName: 'Förvaltare',
        role: 'OWNER',
      },
    })
    userId = user.id
    const montör = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `utr-m-${sfx}@example.se`,
        passwordHash: 'x',
        firstName: 'Mo',
        lastName: 'Montör',
        role: 'MANAGER',
      },
    })
    montörId = montör.id
  }, 60_000)

  afterAll(async () => {
    // FK-ORDNING. Händelsen pekar på User med Restrict (aldrig SetNull — en
    // kaskad-UPDATE avvisas av append-only-triggern), så den måste bort först.
    for (const id of [orgId, annanOrgId]) {
      if (!id) continue
      await prisma.unitEquipmentEvent.deleteMany({
        where: { equipment: { organizationId: id } },
      })
      await prisma.unitEquipment.updateMany({
        where: { organizationId: id },
        data: { replacedById: null },
      })
      await prisma.unitEquipment.deleteMany({ where: { organizationId: id } })
      await prisma.unit.deleteMany({ where: { property: { organizationId: id } } })
      await prisma.property.deleteMany({ where: { organizationId: id } })
      await prisma.user.deleteMany({ where: { organizationId: id } })
      await prisma.organization.delete({ where: { id } })
    }
    await prisma.$disconnect()
  }, 60_000)

  const nyKyl = (installedAt: string) =>
    service.create(
      { unitId, kind: 'REFRIGERATOR', label: `Kyl ${randomUUID().slice(0, 6)}`, installedAt },
      orgId,
    )

  it('skapar utrustning MED sin första händelse i samma transaktion', async () => {
    const kyl = await nyKyl('2020-01-15T00:00:00Z')
    const händelser = await prisma.unitEquipmentEvent.findMany({
      where: { equipmentId: kyl.id },
      select: { type: true, occurredAt: true },
    })
    // En sak utan INSTALLED hade varit synlig i listan och osynlig i strömmen.
    expect(händelser).toHaveLength(1)
    expect(händelser[0]!.type).toBe('INSTALLED')
  }, 60_000)

  it('TVÅ BYTEN → historiken svarar "vad byttes och när", i rätt ordning', async () => {
    const kyl1 = await nyKyl('2015-03-01T00:00:00Z')

    const byte1 = await service.registerReplacement(
      kyl1.id,
      {
        occurredAt: '2019-06-10T00:00:00Z',
        label: 'Kyl gen 2',
        performedById: montörId,
        cost: 8500,
        note: 'Kompressorn dog',
      },
      orgId,
    )
    const byte2 = await service.registerReplacement(
      byte1.replacement.id,
      {
        occurredAt: '2026-02-20T00:00:00Z',
        label: 'Kyl gen 3',
        performedById: userId,
        cost: 12000,
        note: 'Uppgradering',
      },
      orgId,
    )

    // ── FRÅGAN STÄLLS GENOM PRODUKTIONSKOD ──────────────────────────────────
    //
    // Registrets EGEN `load`, inte en fråga riggen hittat på. Skulle källan
    // kopplas bort blir det här rött — en rigg som ställer sin egen fråga hade
    // varit grön om samma bortkoppling.
    const källa = HISTORY_SOURCES.find((k) => k.table === 'UnitEquipmentEvent')
    expect(källa).toBeDefined()
    const rader = await källa!.load({
      prisma,
      organizationId: orgId,
      subject: { kind: 'UNIT', id: unitId },
    } as never)

    const byten = (rader as Array<{ at: Date; type: string; actor: { id: string | null } }>)
      .filter((r) => r.type === 'EQUIPMENT_REPLACED')
      .sort((a, b) => a.at.getTime() - b.at.getTime())

    expect(byten).toHaveLength(2)
    // RÄTT ORDNING — äldst först.
    expect(byten[0]!.at.toISOString()).toBe('2019-06-10T00:00:00.000Z')
    expect(byten[1]!.at.toISOString()).toBe('2026-02-20T00:00:00.000Z')
    // RÄTT AKTÖR — var sitt byte, var sin människa.
    expect(byten[0]!.actor.id).toBe(montörId)
    expect(byten[1]!.actor.id).toBe(userId)

    // Och kedjan är en följd, inte en förgrening.
    const gammal = await prisma.unitEquipment.findUnique({
      where: { id: kyl1.id },
      select: { removedAt: true, replacedById: true },
    })
    expect(gammal!.replacedById).toBe(byte1.replacement.id)
    expect(gammal!.removedAt).not.toBeNull()
    expect(byte2.replacement.id).not.toBe(byte1.replacement.id)
  }, 60_000)

  it('KOSTNADEN följer med som belopp — okänd kostnad blir null, inte noll', async () => {
    const kyl = await nyKyl('2018-01-01T00:00:00Z')
    await service.registerReplacement(
      kyl.id,
      { occurredAt: '2026-03-01T00:00:00Z', cost: 4500, note: 'med kostnad' },
      orgId,
    )
    const utan = await nyKyl('2018-02-01T00:00:00Z')
    await service.registerReplacement(
      utan.id,
      { occurredAt: '2026-03-02T00:00:00Z', note: 'utan kostnad' },
      orgId,
    )

    const källa = HISTORY_SOURCES.find((k) => k.table === 'UnitEquipmentEvent')!
    const rader = (await källa.load({
      prisma,
      organizationId: orgId,
      subject: { kind: 'UNIT', id: unitId },
    } as never)) as Array<{ description: string; amount: number | null }>

    const med = rader.find((r) => r.description.includes('med kostnad'))
    const utanRad = rader.find((r) => r.description.includes('utan kostnad'))
    expect(med!.amount).toBe(4500)
    // OKÄNT, inte noll. Skillnaden mellan "gratis" och "vi vet inte".
    expect(utanRad!.amount).toBeNull()
  }, 60_000)

  it('ett REGISTRERAT byte går inte att ändra — databasen avvisar UPDATE', async () => {
    const kyl = await nyKyl('2017-01-01T00:00:00Z')
    await service.registerReplacement(
      kyl.id,
      { occurredAt: '2026-04-01T00:00:00Z', note: 'original' },
      orgId,
    )
    const händelse = await prisma.unitEquipmentEvent.findFirst({
      where: { equipmentId: kyl.id, type: 'REPLACED' },
      select: { id: true },
    })
    // APPEND-ONLY ÄR EN TRIGGER, INTE EN VANA (#585). Provet går förbi tjänsten
    // med flit: det är databasen som ska säga nej, inte en kodgren.
    await expect(
      prisma.unitEquipmentEvent.update({
        where: { id: händelse!.id },
        data: { note: 'omskriven historia' },
      }),
    ).rejects.toThrow()
  }, 60_000)

  it('RÄTTELSE är en ny händelse som pekar tillbaka — och bara EN per original', async () => {
    const kyl = await nyKyl('2016-01-01T00:00:00Z')
    await service.registerReplacement(
      kyl.id,
      { occurredAt: '2026-05-01T00:00:00Z', cost: 1000, note: 'fel belopp' },
      orgId,
    )
    const original = await prisma.unitEquipmentEvent.findFirst({
      where: { equipmentId: kyl.id, type: 'REPLACED' },
      select: { id: true },
    })

    const rättelse = await service.correctEvent(
      kyl.id,
      {
        correctsId: original!.id,
        occurredAt: '2026-05-01T00:00:00Z',
        cost: 10000,
        note: 'Rätt belopp var 10 000 kr',
      },
      orgId,
    )
    expect(rättelse.correctsId).toBe(original!.id)
    // Originalet står KVAR — en rättelse raderar inte, den lägger till.
    expect(await prisma.unitEquipmentEvent.count({ where: { id: original!.id } })).toBe(1)

    // EN förgrenad rättelsekedja är ingen rättelse.
    await expect(
      service.correctEvent(
        kyl.id,
        { correctsId: original!.id, occurredAt: '2026-05-02T00:00:00Z', note: 'en till' },
        orgId,
      ),
    ).rejects.toThrow(BadRequestException)

    // Och historiken märker ut den, så två rader med olika belopp inte blir en gåta.
    const källa = HISTORY_SOURCES.find((k) => k.table === 'UnitEquipmentEvent')!
    const rader = (await källa.load({
      prisma,
      organizationId: orgId,
      subject: { kind: 'UNIT', id: unitId },
    } as never)) as Array<{ description: string }>
    expect(rader.some((r) => r.description.includes('RÄTTELSE'))).toBe(true)
  }, 60_000)

  it('ORG-SCOPNING: en annan orgs lägenhet ger 404, inte en tom lista', async () => {
    // Tom lista hade varit ett svar. 404 säger att frågan inte var din att ställa.
    await expect(service.findByUnit(annanUnitId, orgId)).rejects.toThrow(NotFoundException)
    await expect(
      service.create(
        { unitId: annanUnitId, kind: 'STOVE', installedAt: '2026-01-01T00:00:00Z' },
        orgId,
      ),
    ).rejects.toThrow(NotFoundException)

    // NEGATIVKONTROLLENS SYSTER: samma lägenhet ur SIN EGEN org fungerar. Utan
    // den raden vore 404 ovan förenligt med "metoden kastar alltid".
    await expect(service.findByUnit(annanUnitId, annanOrgId)).resolves.toBeDefined()
  }, 60_000)

  it('ORG-SCOPNING: ett byte på en annan orgs utrustning ger 404', async () => {
    const främmande = await service.create(
      { unitId: annanUnitId, kind: 'DISHWASHER', installedAt: '2020-01-01T00:00:00Z' },
      annanOrgId,
    )
    await expect(
      service.registerReplacement(främmande.id, { occurredAt: '2026-06-01T00:00:00Z' }, orgId),
    ).rejects.toThrow(NotFoundException)
  }, 60_000)

  it('en redan utbytt sak byts inte igen — och felet SÄGER varför', async () => {
    const kyl = await nyKyl('2014-01-01T00:00:00Z')
    await service.registerReplacement(kyl.id, { occurredAt: '2026-07-01T00:00:00Z' }, orgId)
    // Utan grinden hade `replacedById`:s @unique gett ett P2002 som säger
    // "unique constraint" i stället för vad som faktiskt är fel.
    await expect(
      service.registerReplacement(kyl.id, { occurredAt: '2026-07-02T00:00:00Z' }, orgId),
    ).rejects.toThrow(BadRequestException)
  }, 60_000)
})
