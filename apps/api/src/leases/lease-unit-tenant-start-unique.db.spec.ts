/**
 * ETT AVTAL PER ENHET, HYRESGÄST OCH TILLTRÄDESDAG — mot riktig Postgres.
 *
 * ── VARFÖR NYCKELN ÄR DE TRE FÄLTEN ─────────────────────────────────────────
 *
 * Samma part, samma lägenhet, samma tillträdesdag två gånger är inte två
 * hyresförhållanden — det är ett registrerat två gånger. `contractNumber`
 * kommer ur en sekvens och är motsatsen till en idempotensnyckel.
 *
 * Nämnaren blir inte för grov, och proven nedan håller fast vid det i tre
 * former: en hyresgäst som flyttar tillbaka in får ett annat startdatum, samma
 * hyresgäst kan ha lägenhet OCH p-plats från samma dag, och två utkast för
 * olika hyresgäster på samma enhet är ett normalt jämförelseläge.
 *
 * ── LUCKAN DEN FYLLER ───────────────────────────────────────────────────────
 *
 * `lease_unit_active_unique` är PARTIELLT på `status = 'ACTIVE'`. Båda
 * AI-verktygen skapar avtalet som DRAFT — `create_lease` stannar där,
 * `create_tenant_and_lease` övergår sedan till ACTIVE. En omkörning gav alltså
 * två utkast på samma enhet utan att något villkor kunde se det.
 *
 * ── DET FARLIGASTE PROVET ÄR DISAMBIGUERINGEN ───────────────────────────────
 *
 * De två villkoren delar kolumnen `unitId`. `isActiveUnitConflict` matchade
 * tidigare på `target.includes('unitId')`, vilket blev tvetydigt i samma stund
 * som det nya villkoret fanns: en dubblettkonflikt hade svarat "Lägenheten har
 * redan ett aktivt kontrakt" om ett avtal som inte ens är aktivt. En felaktig
 * men trovärdig text är värre än ett rått fel — operatören letar på fel ställe.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../mail/mail.service', () => ({ MailService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { ConflictException } from '@nestjs/common'
import { Prisma, PrismaClient } from '@prisma/client'

import { LeasesService } from './leases.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

const START = '2026-10-01'
const HYRA = 9_000

medDb('create_lease — ett avtal per enhet, hyresgäst och tillträdesdag', () => {
  let prisma: PrismaClient
  let service: LeasesService
  let orgId: string
  let tenantA: string
  let tenantB: string
  let unitA: string
  let unitB: string
  let propertyId: string

  const skapa = (unitId: string, tenantId: string, startDate = START) =>
    service.create(
      { unitId, tenantId, monthlyRent: HYRA, depositAmount: 0, startDate } as never,
      orgId,
    )

  beforeAll(async () => {
    prisma = new PrismaClient()
    // Bara `prisma` och `contractNumbers` används av create(); resten är
    // beroenden på andra vägar och matas som tomma attrapper.
    service = Object.create(LeasesService.prototype) as LeasesService
    Object.assign(service, {
      prisma,
      contractNumbers: { next: async () => `HK-${randomUUID().slice(0, 8)}` },
    })

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `avt-${sfx}`,
        email: `avt-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
      select: { id: true },
    })
    orgId = org.id
    const t = await Promise.all(
      [0, 1].map((i) =>
        prisma.tenant.create({
          data: {
            organizationId: orgId,
            type: 'INDIVIDUAL',
            email: `avt-t${i}-${sfx}@example.se`,
          },
          select: { id: true },
        }),
      ),
    )
    tenantA = t[0]!.id
    tenantB = t[1]!.id
    const property = await prisma.property.create({
      data: {
        organizationId: orgId,
        name: `Fastigheten ${sfx}`,
        propertyDesignation: `AVT ${sfx}`,
        type: 'RESIDENTIAL',
        street: 'a',
        city: 'b',
        postalCode: '11111',
        totalArea: 100,
      },
      select: { id: true },
    })
    propertyId = property.id
    const u = await Promise.all(
      ['Lägenhet 1101', 'P-plats 12'].map((namn, i) =>
        prisma.unit.create({
          data: {
            propertyId,
            name: namn,
            unitNumber: `${1101 + i}`,
            type: i === 0 ? 'APARTMENT' : 'PARKING',
            area: 60 - i * 50,
            rooms: 2,
            monthlyRent: HYRA,
          },
          select: { id: true },
        }),
      ),
    )
    unitA = u[0]!.id
    unitB = u[1]!.id
  }, 30_000)

  beforeEach(async () => {
    await prisma.lease.deleteMany({ where: { organizationId: orgId } })
  })

  afterAll(async () => {
    await prisma.lease.deleteMany({ where: { organizationId: orgId } })
    await prisma.unit.deleteMany({ where: { propertyId } })
    await prisma.property.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  const antal = () => prisma.lease.count({ where: { organizationId: orgId } })

  it('SAMMA anrop två gånger → ETT avtal', async () => {
    await skapa(unitA, tenantA)
    await expect(skapa(unitA, tenantA)).rejects.toBeInstanceOf(ConflictException)
    expect(await antal()).toBe(1)
  })

  it('TVÅ LEGITIMA anrop → TVÅ avtal (samma part och enhet, ANNAT tillträdesdatum)', async () => {
    // En hyresgäst som flyttar ut och tillbaka in, eller en förnyelse: den ger
    // efterföljaren `endDate + 1 dag` och alltså aldrig samma startdatum.
    await skapa(unitA, tenantA, START)
    await skapa(unitA, tenantA, '2027-10-01')
    expect(await antal()).toBe(2)
  })

  it('TVÅ LEGITIMA anrop → TVÅ avtal (samma part och datum, ANNAN enhet)', async () => {
    // Lägenhet och p-plats från samma dag — precis fallet som gav #641 dess
    // förväxlade kontrakt.
    await skapa(unitA, tenantA)
    await skapa(unitB, tenantA)
    expect(await antal()).toBe(2)
  })

  it('TVÅ LEGITIMA anrop → TVÅ avtal (samma enhet och datum, ANNAN hyresgäst)', async () => {
    // Två utkast för olika kandidater på samma lägenhet är ett normalt
    // jämförelseläge. Dubbeluthyrning stoppas av `lease_unit_active_unique` när
    // det ena aktiveras — inte av det här villkoret, och det är rätt fördelning.
    await skapa(unitA, tenantA)
    await skapa(unitA, tenantB)
    expect(await antal()).toBe(2)
  })

  it('DISAMBIGUERINGEN: en dubblett rapporteras INTE som "aktivt kontrakt"', async () => {
    // De två villkoren delar `unitId`. Matchar igenkänningen löst på det fältet
    // får operatören en felaktig men trovärdig text om ett avtal som inte ens
    // är aktivt.
    await skapa(unitA, tenantA)
    const fel = await skapa(unitA, tenantA).then(
      () => null,
      (e: unknown) => e,
    )
    expect(fel).toBeInstanceOf(ConflictException)
    expect((fel as Error).message).not.toMatch(/aktivt kontrakt/i)
    expect((fel as Error).message).toMatch(/tillträdesdag/i)
  })

  it('konfliktens FORM är den som disambigueringen läser', async () => {
    await skapa(unitA, tenantA)
    const fel = await prisma.lease
      .create({
        data: {
          organizationId: orgId,
          unitId: unitA,
          tenantId: tenantA,
          contractNumber: `HK-${randomUUID().slice(0, 8)}`,
          monthlyRent: HYRA,
          depositAmount: 0,
          startDate: new Date(START),
          tenancyStartDate: new Date(START),
          status: 'DRAFT',
        },
      })
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(fel).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
    const target = ((fel as Prisma.PrismaClientKnownRequestError).meta as { target?: unknown })
      .target
    expect(target as string[]).toEqual(expect.arrayContaining(['unitId', 'tenantId', 'startDate']))
    // Tre fält, inte ett: den lösa `includes('unitId')`-formen kan inte skilja
    // det här från `lease_unit_active_unique`.
    expect((target as string[]).length).toBe(3)
  })
})
