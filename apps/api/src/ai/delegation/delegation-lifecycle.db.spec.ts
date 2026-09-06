/**
 * DELEGATIONERNAS LIVSCYKEL MOT RIKTIG POSTGRES.
 *
 * ── VAD SOM INTE GÅR ATT MOCKA ──────────────────────────────────────────────
 *
 * Statusen är BERÄKNAD ur händelserna. Varje operation läser alltså rader den
 * själv skrev i ett tidigare steg, och ordningen mellan dem avgör svaret. En
 * attrapp hade returnerat den händelselista provet matade in, oavsett vad
 * tjänsten skrev — och en tappad `organizationId` i `where` hade lämnat provet
 * grönt medan grannens delegationer gick att pausa.
 *
 * `lista()` hämtar dessutom `bornFromAssignment` och `createdByUser` via
 * relationer. Att KÄLLAN följer med är hela poängen med sidan; att den följer med
 * går inte att bevisa utan en databas som har relationerna.
 *
 * ── VAD DEN INTE MÄTER ──────────────────────────────────────────────────────
 *
 * Rollgrinden på HTTP-vägen (`@Roles('OWNER')` på controllern). Den ägs av
 * behörighetsytans golden-fil. Här prövas tjänstens EGEN grind, som gäller varje
 * anropare — även de som aldrig går genom controllern.
 *
 * ── RIGGEN ÄGER SINA EGNA FÖRUTSÄTTNINGAR ───────────────────────────────────
 *
 * Två organisationer med var sin ägare. Städning i FK-riktning, prövad mot en TOM
 * databas och körd TVÅ gånger mot samma databas.
 */
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

import { DelegationService, FÖRLÄNGNING_KARENS_DAGAR } from './delegation.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

const VERKTYG = 'create_property'
const DAG = 24 * 60 * 60 * 1000

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('delegationens livscykel', () => {
  let prisma: PrismaClient
  let tjanst: DelegationService
  let orgA: string
  let orgB: string
  let agareA: string
  let agareB: string

  const agare = (id: string) => ({ userId: id, roll: 'OWNER' as const })

  const skapa = (org: string, user: string) => tjanst.skapa(org, { toolName: VERKTYG }, agare(user))

  beforeAll(async () => {
    prisma = new PrismaClient()
    tjanst = new DelegationService(prisma as never)
    const bygg = async (namn: string) => {
      const sfx = randomUUID().slice(0, 8)
      const o = await prisma.organization.create({
        data: {
          name: `${namn}-${sfx}`,
          email: `${namn}-${sfx}@example.se`,
          street: 'a',
          city: 'b',
          postalCode: '11111',
        },
        select: { id: true },
      })
      const u = await prisma.user.create({
        data: {
          organizationId: o.id,
          email: `${namn}-${sfx}@example.se`,
          passwordHash: 'x',
          firstName: 'Ada',
          lastName: 'Ek',
          role: 'OWNER',
        },
        select: { id: true },
      })
      return { org: o.id, user: u.id }
    }
    const a = await bygg('livA')
    const b = await bygg('livB')
    orgA = a.org
    agareA = a.user
    orgB = b.org
    agareB = b.user
  }, 60_000)

  beforeEach(async () => {
    await prisma.aiDelegation.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
  })

  afterAll(async () => {
    await prisma.aiDelegation.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
    await prisma.user.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
    await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } })
    await prisma.$disconnect()
  })

  describe('lista', () => {
    it('bara den egna organisationens rader', async () => {
      const a = await skapa(orgA, agareA)
      await skapa(orgB, agareB)
      const rader = await tjanst.lista(orgA)
      expect(rader.map((r) => r.id)).toEqual([a.id])
    })

    it('bär KÄLLAN: vem som tryckte, och vilket ärende', async () => {
      const d = await skapa(orgA, agareA)
      const [r] = await tjanst.lista(orgA)
      expect(r?.createdByUserId).toBe(agareA)
      expect(r?.createdByUser?.firstName).toBe('Ada')
      // Skapad direkt (inte ur ett ärende) → ingen härkomst, och det syns.
      expect(r?.bornFromAssignmentId).toBeNull()
      expect(d.id).toBe(r?.id)
    })

    it('statusen är BERÄKNAD ur händelserna, inte läst ur en kolumn', async () => {
      const d = await skapa(orgA, agareA)
      expect((await tjanst.lista(orgA))[0]?.status).toBe('AKTIV')
      await tjanst.pausa(orgA, d.id, agare(agareA))
      expect((await tjanst.lista(orgA))[0]?.status).toBe('PAUSAD')
      await tjanst.återuppta(orgA, d.id, agare(agareA))
      expect((await tjanst.lista(orgA))[0]?.status).toBe('AKTIV')
      await tjanst.återkalla(orgA, d.id, agare(agareA))
      expect((await tjanst.lista(orgA))[0]?.status).toBe('ÅTERKALLAD')
      // Raden är ORÖRD: varje övergång är en HÄNDELSE, aldrig en UPDATE.
      const rå = await prisma.aiDelegation.findUniqueOrThrow({ where: { id: d.id } })
      expect(rå.createdAt.getTime()).toBe(d.createdAt.getTime())
      expect(rå.expiresAt.getTime()).toBe(d.expiresAt.getTime())
      const typer = await prisma.aiDelegationEvent.findMany({
        where: { delegationId: d.id },
        orderBy: { createdAt: 'asc' },
        select: { type: true, handlingAv: true },
      })
      expect(typer.map((t) => t.type)).toEqual(['CREATED', 'PAUSED', 'RESUMED', 'REVOKED'])
      expect(typer.every((t) => t.handlingAv === 'HUMAN')).toBe(true)
    })

    it('UTGÅNGEN härleds ur klockan, utan att någon skrivit en händelse', async () => {
      const d = await tjanst.skapa(
        orgA,
        { toolName: VERKTYG, expiresAt: new Date(Date.now() + 60_000) },
        agare(agareA),
      )
      const rader = await tjanst.lista(orgA, new Date(Date.now() + 120_000))
      expect(rader[0]?.status).toBe('UTGÅNGEN')
      expect(
        await prisma.aiDelegationEvent.count({ where: { delegationId: d.id, type: 'EXPIRED' } }),
      ).toBe(0)
    })

    it('löperUtInomDagar räknas i tjänsten, inte i webben', async () => {
      await tjanst.skapa(
        orgA,
        { toolName: VERKTYG, expiresAt: new Date(Date.now() + 10 * DAG) },
        agare(agareA),
      )
      expect((await tjanst.lista(orgA))[0]?.löperUtInomDagar).toBe(10)
    })
  })

  describe('pausa och återuppta', () => {
    it('pausa två gånger avvisas — historiken ska inte visa ett val som inte gjordes', async () => {
      const d = await skapa(orgA, agareA)
      await tjanst.pausa(orgA, d.id, agare(agareA))
      await expect(tjanst.pausa(orgA, d.id, agare(agareA))).rejects.toBeInstanceOf(
        ConflictException,
      )
      expect(
        await prisma.aiDelegationEvent.count({ where: { delegationId: d.id, type: 'PAUSED' } }),
      ).toBe(1)
    })

    it('återuppta något som inte är pausat avvisas', async () => {
      const d = await skapa(orgA, agareA)
      await expect(tjanst.återuppta(orgA, d.id, agare(agareA))).rejects.toBeInstanceOf(
        ConflictException,
      )
    })

    it('en ÅTERKALLAD delegation går inte att pausa eller återuppta', async () => {
      const d = await skapa(orgA, agareA)
      await tjanst.återkalla(orgA, d.id, agare(agareA))
      await expect(tjanst.pausa(orgA, d.id, agare(agareA))).rejects.toThrow(/återkallad/)
      await expect(tjanst.återuppta(orgA, d.id, agare(agareA))).rejects.toThrow(/återkallad/)
    })

    it('EN ANNAN ORGANISATIONS delegation är osynlig, inte förbjuden', async () => {
      const d = await skapa(orgB, agareB)
      await expect(tjanst.pausa(orgA, d.id, agare(agareA))).rejects.toBeInstanceOf(
        NotFoundException,
      )
      expect(
        await prisma.aiDelegationEvent.count({ where: { delegationId: d.id, type: 'PAUSED' } }),
      ).toBe(0)
    })

    it('bara ÄGAREN får pausa — tjänstens egen grind, inte ruttens', async () => {
      const d = await skapa(orgA, agareA)
      await expect(
        tjanst.pausa(orgA, d.id, { userId: agareA, roll: 'ADMIN' }),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })
  })

  describe('återkalla', () => {
    it('två återkallanden av samma delegation är inte två beslut', async () => {
      const d = await skapa(orgA, agareA)
      await tjanst.återkalla(orgA, d.id, agare(agareA), 'Fel scope.')
      await expect(tjanst.återkalla(orgA, d.id, agare(agareA))).rejects.toBeInstanceOf(
        ConflictException,
      )
      const h = await prisma.aiDelegationEvent.findMany({
        where: { delegationId: d.id, type: 'REVOKED' },
      })
      expect(h).toHaveLength(1)
      expect(h[0]?.note).toBe('Fel scope.')
    })
  })

  describe('förläng', () => {
    it('+90 dagar räknat FRÅN NU, och en händelse', async () => {
      const d = await tjanst.skapa(
        orgA,
        { toolName: VERKTYG, expiresAt: new Date(Date.now() + 3 * DAG) },
        agare(agareA),
      )
      const nytt = await tjanst.förläng(orgA, d.id, agare(agareA))
      expect(Math.round((nytt.getTime() - Date.now()) / DAG)).toBe(90)
      const rå = await prisma.aiDelegation.findUniqueOrThrow({ where: { id: d.id } })
      expect(rå.expiresAt.getTime()).toBe(nytt.getTime())
      expect(
        await prisma.aiDelegationEvent.count({ where: { delegationId: d.id, type: 'EXTENDED' } }),
      ).toBe(1)
    })

    it('en UTGÅNGEN delegation får 90 NYA dagar, inte 90 från ett passerat datum', async () => {
      const d = await tjanst.skapa(
        orgA,
        { toolName: VERKTYG, expiresAt: new Date(Date.now() + 60_000) },
        agare(agareA),
      )
      const nu = new Date(Date.now() + 5 * DAG)
      const nytt = await tjanst.förläng(orgA, d.id, agare(agareA), nu)
      expect(Math.round((nytt.getTime() - nu.getTime()) / DAG)).toBe(90)
    })

    it('TAKET: en andra förlängning inom karensen avvisas', async () => {
      const d = await skapa(orgA, agareA)
      await tjanst.förläng(orgA, d.id, agare(agareA))
      await expect(tjanst.förläng(orgA, d.id, agare(agareA))).rejects.toBeInstanceOf(
        ConflictException,
      )
      await expect(tjanst.förläng(orgA, d.id, agare(agareA))).rejects.toThrow(
        new RegExp(`${FÖRLÄNGNING_KARENS_DAGAR} dagar`),
      )
      expect(
        await prisma.aiDelegationEvent.count({ where: { delegationId: d.id, type: 'EXTENDED' } }),
      ).toBe(1)
    })

    it('OMVÄNDA RIKTNINGEN: efter karensen går det igen', async () => {
      const d = await skapa(orgA, agareA)
      await tjanst.förläng(orgA, d.id, agare(agareA))
      const efter = new Date(Date.now() + (FÖRLÄNGNING_KARENS_DAGAR + 1) * DAG)
      await expect(tjanst.förläng(orgA, d.id, agare(agareA), efter)).resolves.toBeInstanceOf(Date)
      expect(
        await prisma.aiDelegationEvent.count({ where: { delegationId: d.id, type: 'EXTENDED' } }),
      ).toBe(2)
    })

    it('en ÅTERKALLAD delegation går inte att förlänga', async () => {
      const d = await skapa(orgA, agareA)
      await tjanst.återkalla(orgA, d.id, agare(agareA))
      await expect(tjanst.förläng(orgA, d.id, agare(agareA))).rejects.toThrow(/återkallad/)
    })

    it('en PAUSAD delegation går att förlänga — pausen är inte ett avslut', async () => {
      const d = await skapa(orgA, agareA)
      await tjanst.pausa(orgA, d.id, agare(agareA))
      await expect(tjanst.förläng(orgA, d.id, agare(agareA))).resolves.toBeInstanceOf(Date)
      expect((await tjanst.lista(orgA))[0]?.status).toBe('PAUSAD')
    })

    it('bara ÄGAREN får förlänga', async () => {
      const d = await skapa(orgA, agareA)
      await expect(
        tjanst.förläng(orgA, d.id, { userId: agareA, roll: 'MANAGER' }),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })

    it('EN ANNAN ORGANISATIONS delegation går inte att förlänga', async () => {
      const d = await skapa(orgB, agareB)
      await expect(tjanst.förläng(orgA, d.id, agare(agareA))).rejects.toBeInstanceOf(
        NotFoundException,
      )
    })
  })
})
