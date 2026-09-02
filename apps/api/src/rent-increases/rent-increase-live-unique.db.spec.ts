/**
 * EN LEVANDE HYRESHÖJNING PER AVTAL OCH IKRAFTTRÄDANDE — mot riktig Postgres.
 *
 * ── VARFÖR VILLKORET MÅSTE VARA PARTIELLT ───────────────────────────────────
 *
 * Hyran kan bara ändras en gång på ett givet datum, och hyresgästen ska bara få
 * ett meddelande om höjningen per ikraftträdande. Två REGISTRERADE höjningar för
 * samma avtal och datum är alltså inte två affärshändelser.
 *
 * Men ett rakt `UNIQUE (leaseId, effectiveDate)` hade varit FÖR GROVT. En
 * höjning som återkallats, nekats av hyresgästen eller annullerats vid en
 * avtalsförnyelse har inte trätt i kraft — en ny höjning för samma datum är då
 * en legitim andra handling, och ett rakt villkor hade tyst blockerat den.
 *
 * Det är den skillnaden proven nedan finns för, och den som gör den obligatoriska
 * andra kontrollen ("två legitima anrop → två effekter") vass här: den körs en
 * gång per icke-blockerande status.
 *
 * ── VARFÖR create() INTE KUNDE SE DET ───────────────────────────────────────
 *
 * `RentIncreasesService.create` validerar att avtalet är aktivt/utkast, att
 * fristen räcker och att ny hyra > nuvarande. Alla tre passerar vid en
 * omkörning, eftersom avtalets hyra inte skrivs om vid schemaläggningen.
 *
 * ── VAD PROVET INTE KAN SE ──────────────────────────────────────────────────
 *
 * Att meddelandet till hyresgästen faktiskt skickas en gång — det ägs av
 * `sendNotice()` och dess egna prov. Här mäts bara vilka rader som får finnas.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../mail/mail.service', () => ({ MailService: class {} }))

import { randomUUID } from 'node:crypto'

import { ConflictException } from '@nestjs/common'
import { Prisma, PrismaClient } from '@prisma/client'

import { RentIncreasesService } from './rent-increases.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

/** Fristen kräver minst 3 månader fram; 6 ger marginal mot månadsskiften. */
const IKRAFT = new Date(Date.now() + 1000 * 60 * 60 * 24 * 190).toISOString().slice(0, 10)
const HYRA = 10_000

medDb('apply_rent_increase — en levande höjning per avtal och datum', () => {
  let prisma: PrismaClient
  let service: RentIncreasesService
  let orgId: string
  let leaseA: string
  let leaseB: string

  const skapa = (leaseId: string, nyHyra = HYRA + 500, datum = IKRAFT) =>
    service.create(
      { leaseId, newRent: nyHyra, reason: 'Marknadsmässig justering', effectiveDate: datum },
      orgId,
    )

  beforeAll(async () => {
    prisma = new PrismaClient()
    service = new RentIncreasesService(
      prisma as never,
      { sendCustomEmail: async () => 'msg' } as never,
      { createForAllOrgUsers: async () => undefined } as never,
    )

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `hoj-${sfx}`,
        email: `hoj-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
      select: { id: true },
    })
    orgId = org.id
    const tenant = await prisma.tenant.create({
      data: { organizationId: orgId, type: 'INDIVIDUAL', email: `hoj-t-${sfx}@example.se` },
      select: { id: true },
    })
    const property = await prisma.property.create({
      data: {
        organizationId: orgId,
        name: `Fastigheten ${sfx}`,
        propertyDesignation: `HOJ ${sfx}`,
        type: 'RESIDENTIAL',
        street: 'a',
        city: 'b',
        postalCode: '11111',
        totalArea: 100,
      },
      select: { id: true },
    })
    const ids: string[] = []
    for (let i = 0; i < 2; i++) {
      const unit = await prisma.unit.create({
        data: {
          propertyId: property.id,
          name: `Lgh ${i}`,
          unitNumber: `${100 + i}`,
          type: 'APARTMENT',
          area: 50,
          rooms: 2,
          monthlyRent: HYRA,
        },
        select: { id: true },
      })
      const lease = await prisma.lease.create({
        data: {
          organizationId: orgId,
          tenantId: tenant.id,
          unitId: unit.id,
          contractNumber: `HK-${sfx}-${i}`,
          monthlyRent: HYRA,
          depositAmount: 0,
          startDate: new Date('2026-01-01'),
          tenancyStartDate: new Date('2026-01-01'),
          status: 'DRAFT',
        },
        select: { id: true },
      })
      ids.push(lease.id)
    }
    leaseA = ids[0]!
    leaseB = ids[1]!
  }, 30_000)

  beforeEach(async () => {
    await prisma.rentIncrease.deleteMany({ where: { organizationId: orgId } })
  })

  afterAll(async () => {
    await prisma.rentIncrease.deleteMany({ where: { organizationId: orgId } })
    await prisma.lease.deleteMany({ where: { organizationId: orgId } })
    await prisma.unit.deleteMany({ where: { property: { organizationId: orgId } } })
    await prisma.property.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  const antal = (leaseId: string) => prisma.rentIncrease.count({ where: { leaseId } })

  it('SAMMA anrop två gånger → EN höjning, och svaret säger varför', async () => {
    await skapa(leaseA)
    await expect(skapa(leaseA)).rejects.toBeInstanceOf(ConflictException)
    expect(await antal(leaseA)).toBe(1)
  })

  it('en omkörning med ANNAN hyra blockeras också — datumet är nyckeln, inte beloppet', async () => {
    // Det troliga omtaget: modellen avrundar annorlunda. Vore beloppet med i
    // nyckeln hade nämnaren blivit för fin och dedupat ingenting.
    await skapa(leaseA, HYRA + 500)
    await expect(skapa(leaseA, HYRA + 501)).rejects.toBeInstanceOf(ConflictException)
    expect(await antal(leaseA)).toBe(1)
  })

  it('TVÅ LEGITIMA anrop → TVÅ höjningar (olika avtal, samma datum)', async () => {
    await skapa(leaseA)
    await skapa(leaseB)
    expect(await antal(leaseA)).toBe(1)
    expect(await antal(leaseB)).toBe(1)
  })

  it('TVÅ LEGITIMA anrop → TVÅ höjningar (samma avtal, olika datum)', async () => {
    const senare = new Date(Date.now() + 1000 * 60 * 60 * 24 * 400).toISOString().slice(0, 10)
    await skapa(leaseA, HYRA + 500, IKRAFT)
    await skapa(leaseA, HYRA + 900, senare)
    expect(await antal(leaseA)).toBe(2)
  })

  describe('en höjning som inte längre gör anspråk på datumet blockerar inte', () => {
    // Kärnan i att villkoret är PARTIELLT. Ett rakt unikt index hade fällt
    // vartenda av de här fallen — och då hade en hyresvärd inte kunnat ersätta
    // en återkallad höjning utan att flytta datumet.
    for (const status of ['WITHDRAWN', 'REJECTED', 'VOIDED'] as const) {
      it(`${status} → en ny höjning för SAMMA datum går igenom`, async () => {
        const första = await skapa(leaseA)
        await prisma.rentIncrease.update({ where: { id: första.id }, data: { status } })

        await expect(skapa(leaseA)).resolves.toBeDefined()
        expect(await antal(leaseA)).toBe(2)
      })
    }

    for (const status of ['NOTICE_SENT', 'ACCEPTED', 'APPLIED'] as const) {
      it(`MOTPROV: ${status} gör fortfarande anspråk — en ny blockeras`, async () => {
        const första = await skapa(leaseA)
        await prisma.rentIncrease.update({ where: { id: första.id }, data: { status } })

        await expect(skapa(leaseA)).rejects.toBeInstanceOf(ConflictException)
        expect(await antal(leaseA)).toBe(1)
      })
    }
  })

  it('konfliktens FORM är den som disambigueringen läser', async () => {
    // MÄTT, INTE ANTAGET. Jag skrev först att Prisma rapporterar INDEXNAMNET
    // för ett partiellt index skapat i rå SQL — det gör den inte. Den ger
    // kolumnlistan som en array, precis som för ett index den känner ur
    // schemat. Provet står här för att ett formbyte ska bli rött i stället för
    // att tyst koppla bort igenkänningen.
    await skapa(leaseA)
    const fel = await prisma.rentIncrease
      .create({
        data: {
          organizationId: orgId,
          leaseId: leaseA,
          currentRent: HYRA,
          newRent: HYRA + 500,
          increasePercent: 5,
          reason: 'x',
          effectiveDate: new Date(IKRAFT),
          status: 'DRAFT',
        },
      })
      .then(
        () => null,
        (e: unknown) => e,
      )

    expect(fel).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
    const p2002 = fel as Prisma.PrismaClientKnownRequestError
    expect(p2002.code).toBe('P2002')
    const target = (p2002.meta as { target?: unknown }).target
    expect(Array.isArray(target)).toBe(true)
    expect(target as string[]).toEqual(expect.arrayContaining(['leaseId', 'effectiveDate']))
  })
})
