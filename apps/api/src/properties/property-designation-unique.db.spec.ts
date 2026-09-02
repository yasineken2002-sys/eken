/**
 * FASTIGHETSBETECKNINGEN ÄR UNIK PER ORGANISATION — mot riktig Postgres.
 *
 * ── VARFÖR DEN HÄR NYCKELN INTE KAN BLI FÖR GROV ────────────────────────────
 *
 * Principen bakom hela nyckelarbetet är att en nämnare måste kunna skilja två
 * LEGITIMA upprepningar åt. Fastighetsbeteckningen klarar det utan hjälp:
 * den identifierar fastigheten i det offentliga registret, så det finns per
 * definition inte två legitima rader att skilja åt. Det är skillnaden mot
 * `name`, som är ett vardagsnamn ("Gården", "Hus B") och mycket väl kan
 * återkomma — och som därför hade varit exakt den för grova nämnaren.
 *
 * Före villkoret hade `Property` INGA unika villkor alls, och
 * `PropertiesService.create` skrev rakt igenom utan en enda kontroll.
 *
 * ── DE TVÅ KONTROLLERNA SOM ALLTID KÖRS ─────────────────────────────────────
 *
 *   samma anrop två gånger   → EN effekt
 *   två legitima anrop       → TVÅ effekter
 *
 * Den andra är den som fångar en för grov nämnare, och den finns här i två
 * former: en annan beteckning i samma organisation, och SAMMA beteckning i en
 * annan organisation. Utan den andra hade ett villkor utan `organizationId`
 * sett korrekt ut — och tyst blockerat en granne.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { randomUUID } from 'node:crypto'

import { ConflictException } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

import { PropertiesService } from './properties.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

const BETECKNING = 'Stockholm Eken 1:2'

medDb('create_property — beteckningen är nyckeln', () => {
  let prisma: PrismaClient
  let service: PropertiesService
  let orgA: string
  let orgB: string

  const nyOrg = async (märke: string) => {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `${märke}-${sfx}`,
        email: `${märke}-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
      select: { id: true },
    })
    return org.id
  }

  const skapa = (orgId: string, beteckning: string, namn = 'Gården') =>
    service.create(orgId, {
      name: namn,
      propertyDesignation: beteckning,
      type: 'RESIDENTIAL',
      address: { street: 'Storgatan 1', city: 'Stockholm', postalCode: '11122', country: 'SE' },
      totalArea: 100,
    } as never)

  beforeAll(async () => {
    prisma = new PrismaClient()
    service = new PropertiesService(prisma as never)
    orgA = await nyOrg('fast-a')
    orgB = await nyOrg('fast-b')
  }, 30_000)

  beforeEach(async () => {
    await prisma.property.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
  })

  afterAll(async () => {
    await prisma.property.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
    await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } })
    await prisma.$disconnect()
  })

  const antalIOrg = (orgId: string) => prisma.property.count({ where: { organizationId: orgId } })

  it('SAMMA anrop två gånger → EN fastighet, och det andra svaret säger varför', async () => {
    await skapa(orgA, BETECKNING)
    await expect(skapa(orgA, BETECKNING)).rejects.toBeInstanceOf(ConflictException)
    expect(await antalIOrg(orgA)).toBe(1)
  })

  it('felmeddelandet bär beteckningen — annars vet operatören inte vad som krockade', async () => {
    await skapa(orgA, BETECKNING)
    await expect(skapa(orgA, BETECKNING)).rejects.toThrow(new RegExp(BETECKNING))
  })

  it('TVÅ LEGITIMA anrop → TVÅ fastigheter (olika beteckning, samma organisation)', async () => {
    await skapa(orgA, BETECKNING)
    await skapa(orgA, 'Stockholm Eken 1:3')
    expect(await antalIOrg(orgA)).toBe(2)
  })

  it('TVÅ LEGITIMA anrop → TVÅ fastigheter (samma beteckning, OLIKA organisationer)', async () => {
    // Utan `organizationId` i villkoret hade det här provet fallit, och en
    // organisation hade kunnat blockera en annans registrering.
    await skapa(orgA, BETECKNING)
    await skapa(orgB, BETECKNING)
    expect(await antalIOrg(orgA)).toBe(1)
    expect(await antalIOrg(orgB)).toBe(1)
  })

  it('MOTPROV: samma NAMN men olika beteckning är två fastigheter', async () => {
    // `name` är ett vardagsnamn och duger inte som nyckel. Provet finns för att
    // en senare "förbättring" som lägger namnet i villkoret ska bli röd.
    await skapa(orgA, BETECKNING, 'Gården')
    await skapa(orgA, 'Stockholm Eken 1:4', 'Gården')
    expect(await antalIOrg(orgA)).toBe(2)
  })

  it('kantblanksteg kan inte dela på en beteckning', async () => {
    // Osynlig skillnad i UI:t. Trimmas den inte skyddar villkoret ingenting mot
    // en klippa-och-klistra-inmatning.
    await skapa(orgA, BETECKNING)
    await expect(skapa(orgA, `  ${BETECKNING}  `)).rejects.toBeInstanceOf(ConflictException)
    expect(await antalIOrg(orgA)).toBe(1)
  })

  it('UPPDATERING till en upptagen beteckning stoppas av samma grind', async () => {
    // Create och update får inte glida isär i vad de säger om samma villkor.
    await skapa(orgA, BETECKNING)
    const andra = await skapa(orgA, 'Stockholm Eken 1:5')
    await expect(
      service.update(andra.id, orgA, { propertyDesignation: BETECKNING } as never),
    ).rejects.toBeInstanceOf(ConflictException)
  })
})
