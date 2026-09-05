/**
 * "GÖR ALLTID DETTA" MOT RIKTIG POSTGRES.
 *
 * ── VAD SOM INTE GÅR ATT MOCKA ──────────────────────────────────────────────
 *
 * Mönsterkravet — att det krävs ETT TIDIGARE godkännande av samma verktyg och
 * samma typ — är en FRÅGA mot databasen, med tre villkor i `where` (org, verktyg,
 * status) och en filtrering på `prediction`. En attrapp hade svarat detsamma
 * oavsett, och en tappad org-kolumn hade lämnat provet grönt medan grannens
 * godkännanden räknades.
 *
 * ── RIGGEN ÄGER SINA EGNA FÖRUTSÄTTNINGAR ───────────────────────────────────
 *
 * Två organisationer med var sin ägare och fastighet. Städning i FK-riktning.
 * Prövad mot en TOM databas och körd TVÅ gånger mot samma databas.
 */
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

import { DelegationService } from './delegation.service'
import { TYPFÄLT } from './delegation-birth'
import { SKUGGKALLA_FELANMALAN } from '../shadow/shadow-fields'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

/** IDEMPOTENT, EGEN_ORG, ingen sänka, VÄG — delegerbar utan frekvenskrav. */
const VERKTYG = 'create_property'
/** DEDUPLICERBAR — kräver frekvensvillkor. */
const DEDUP = 'create_invoice'

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('delegationen föds ur ett godkänt förslag', () => {
  let prisma: PrismaClient
  let tjanst: DelegationService
  let orgA: string
  let orgB: string
  let agareA: string
  let agareB: string
  let propA: string

  const agare = (id: string) => ({ userId: id, roll: 'OWNER' as const })

  /** Ett förslag. `godkant` sätter status och beslutsfattare. */
  const forslag = async (opts: {
    org: string
    user: string
    toolName?: string
    typ?: string | null
    godkant?: boolean
    propertyId?: string | null
  }) => {
    const prediction =
      opts.typ === null ? {} : { [TYPFÄLT]: opts.typ ?? 'PLUMBING', priority: 'HIGH' }
    return prisma.aiAssignment.create({
      data: {
        organizationId: opts.org,
        shadow: true,
        sourceKind: SKUGGKALLA_FELANMALAN,
        sourceId: randomUUID(),
        toolName: opts.toolName ?? VERKTYG,
        toolInput: {},
        title: 'Förslag',
        reasoning: 'Därför.',
        consequence: 'SKUGGLÄGE: ingenting utförs.',
        undoHint: 'Inget att ångra.',
        prediction,
        deadline: new Date(Date.now() + 6 * 60 * 60 * 1000),
        assignedToUserId: opts.user,
        ...(opts.propertyId === undefined ? {} : { propertyId: opts.propertyId }),
        ...(opts.godkant === false
          ? {}
          : { status: 'APPROVED' as const, decidedAt: new Date(), decidedByUserId: opts.user }),
      },
      select: { id: true },
    })
  }

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
          firstName: 'A',
          lastName: 'B',
          role: 'OWNER',
        },
        select: { id: true },
      })
      const p = await prisma.property.create({
        data: {
          organizationId: o.id,
          name: 'F',
          propertyDesignation: `${namn.toUpperCase()} ${sfx}`,
          street: 'a',
          city: 'b',
          postalCode: '11111',
          type: 'RESIDENTIAL',
          totalArea: 100,
        },
        select: { id: true },
      })
      return { org: o.id, user: u.id, prop: p.id }
    }
    const a = await bygg('fodA')
    const b = await bygg('fodB')
    orgA = a.org
    agareA = a.user
    propA = a.prop
    orgB = b.org
    agareB = b.user
  }, 60_000)

  beforeEach(async () => {
    await prisma.aiDelegation.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
    await prisma.aiAssignment.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
  })

  afterAll(async () => {
    await prisma.aiDelegation.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
    await prisma.aiAssignment.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
    await prisma.property.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
    await prisma.user.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
    await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } })
    await prisma.$disconnect()
  })

  describe('mönstret: det ANDRA godkännandet', () => {
    it('FÖRSTA godkännandet → 409 med vad som saknas', async () => {
      const a = await forslag({ org: orgA, user: agareA })
      await expect(tjanst.skapaUrFörslag(orgA, a.id, agare(agareA))).rejects.toBeInstanceOf(
        ConflictException,
      )
      await expect(tjanst.skapaUrFörslag(orgA, a.id, agare(agareA))).rejects.toThrow(/en gång till/)
      expect(await prisma.aiDelegation.count({ where: { organizationId: orgA } })).toBe(0)
    })

    it('ANDRA godkännandet av samma verktyg OCH typ → skapad', async () => {
      await forslag({ org: orgA, user: agareA })
      const a2 = await forslag({ org: orgA, user: agareA })
      const d = await tjanst.skapaUrFörslag(orgA, a2.id, agare(agareA))
      expect(d.bornFromAssignmentId).toBe(a2.id)
      expect(d.toolName).toBe(VERKTYG)
      // CREATED-händelsen bär en MÄNNISKA.
      const h = await prisma.aiDelegationEvent.findFirstOrThrow({
        where: { delegationId: d.id, type: 'CREATED' },
      })
      expect(h.handlingAv).toBe('HUMAN')
      expect(h.actorUserId).toBe(agareA)
      // 90 dagar.
      expect(Math.round((d.expiresAt.getTime() - Date.now()) / 86_400_000)).toBe(90)
    })

    it('ett tidigare godkännande av ANNAN TYP räknas inte', async () => {
      await forslag({ org: orgA, user: agareA, typ: 'ELECTRICAL' })
      const a2 = await forslag({ org: orgA, user: agareA, typ: 'PLUMBING' })
      await expect(tjanst.skapaUrFörslag(orgA, a2.id, agare(agareA))).rejects.toThrow(
        /en gång till/,
      )
    })

    it('ett tidigare godkännande av ANNAT VERKTYG räknas inte', async () => {
      await forslag({ org: orgA, user: agareA, toolName: 'create_unit' })
      const a2 = await forslag({ org: orgA, user: agareA, toolName: VERKTYG })
      await expect(tjanst.skapaUrFörslag(orgA, a2.id, agare(agareA))).rejects.toThrow(
        /en gång till/,
      )
    })

    it('en ANNAN ORGANISATIONS godkännanden räknas inte', async () => {
      // Avgränsningen, mot riktig Postgres: grannens vana är inte din.
      await forslag({ org: orgB, user: agareB })
      await forslag({ org: orgB, user: agareB })
      const a = await forslag({ org: orgA, user: agareA })
      await expect(tjanst.skapaUrFörslag(orgA, a.id, agare(agareA))).rejects.toThrow(/en gång till/)
    })

    it('ett EJ GODKÄNT tidigare förslag räknas inte', async () => {
      await forslag({ org: orgA, user: agareA, godkant: false })
      const a2 = await forslag({ org: orgA, user: agareA })
      await expect(tjanst.skapaUrFörslag(orgA, a2.id, agare(agareA))).rejects.toThrow(
        /en gång till/,
      )
    })
  })

  describe('idempotens', () => {
    it('SAMMA förslag två gånger → EN delegation, andra gången 409', async () => {
      await forslag({ org: orgA, user: agareA })
      const a2 = await forslag({ org: orgA, user: agareA })
      await tjanst.skapaUrFörslag(orgA, a2.id, agare(agareA))
      await expect(tjanst.skapaUrFörslag(orgA, a2.id, agare(agareA))).rejects.toThrow(
        /redan blivit en delegation/,
      )
      expect(await prisma.aiDelegation.count({ where: { organizationId: orgA } })).toBe(1)
    })
  })

  describe('villkoret får bara SNÄVAS', () => {
    it('förifylls ur förslaget: typ och fastighet', async () => {
      await forslag({ org: orgA, user: agareA, propertyId: propA })
      const a2 = await forslag({ org: orgA, user: agareA, propertyId: propA })
      const d = await tjanst.skapaUrFörslag(orgA, a2.id, agare(agareA))
      expect(d.villkor).toEqual({ [TYPFÄLT]: 'PLUMBING', propertyId: propA })
    })

    it('ett BREDARE villkor avvisas — fastigheten borttagen', async () => {
      await forslag({ org: orgA, user: agareA, propertyId: propA })
      const a2 = await forslag({ org: orgA, user: agareA, propertyId: propA })
      await expect(
        tjanst.skapaUrFörslag(orgA, a2.id, agare(agareA), {
          villkor: { [TYPFÄLT]: 'PLUMBING' },
        }),
      ).rejects.toBeInstanceOf(BadRequestException)
    })

    it('ett BREDARE villkor avvisas — typen ändrad', async () => {
      await forslag({ org: orgA, user: agareA })
      const a2 = await forslag({ org: orgA, user: agareA })
      await expect(
        tjanst.skapaUrFörslag(orgA, a2.id, agare(agareA), {
          villkor: { [TYPFÄLT]: 'ELECTRICAL' },
        }),
      ).rejects.toThrow(/kan inte ändras/)
    })

    it('ett SNÄVARE villkor går igenom — ett fält tillagt', async () => {
      await forslag({ org: orgA, user: agareA })
      const a2 = await forslag({ org: orgA, user: agareA })
      const d = await tjanst.skapaUrFörslag(orgA, a2.id, agare(agareA), {
        villkor: { [TYPFÄLT]: 'PLUMBING', propertyId: propA },
      })
      expect(d.villkor).toEqual({ [TYPFÄLT]: 'PLUMBING', propertyId: propA })
    })
  })

  describe('övriga förutsättningar', () => {
    it('ett EJ GODKÄNT förslag → 409', async () => {
      await forslag({ org: orgA, user: agareA })
      const a = await forslag({ org: orgA, user: agareA, godkant: false })
      await expect(tjanst.skapaUrFörslag(orgA, a.id, agare(agareA))).rejects.toThrow(
        /GODKÄNT förslag/,
      )
    })

    it('ett förslag UTAN typ → 409', async () => {
      await forslag({ org: orgA, user: agareA })
      const a = await forslag({ org: orgA, user: agareA, typ: null })
      await expect(tjanst.skapaUrFörslag(orgA, a.id, agare(agareA))).rejects.toThrow(
        new RegExp(TYPFÄLT),
      )
    })

    it('ett DEDUPLICERBART verktyg kräver frekvensvillkor', async () => {
      await forslag({ org: orgA, user: agareA, toolName: DEDUP })
      const a2 = await forslag({ org: orgA, user: agareA, toolName: DEDUP })
      await expect(tjanst.skapaUrFörslag(orgA, a2.id, agare(agareA))).rejects.toThrow(
        /frekvensvillkor/,
      )
      const d = await tjanst.skapaUrFörslag(orgA, a2.id, agare(agareA), {
        frekvensvillkor: { maxAntal: 3, periodDagar: 7 },
      })
      expect(d.frekvensvillkor).toEqual({ maxAntal: 3, periodDagar: 7 })
    })

    it.each(['ADMIN', 'MANAGER', 'ACCOUNTANT', 'VIEWER'] as const)('%s → 403', async (roll) => {
      await forslag({ org: orgA, user: agareA })
      const a2 = await forslag({ org: orgA, user: agareA })
      await expect(
        tjanst.skapaUrFörslag(orgA, a2.id, { userId: agareA, roll }),
      ).rejects.toBeInstanceOf(ForbiddenException)
      expect(await prisma.aiDelegation.count({ where: { organizationId: orgA } })).toBe(0)
    })

    it('en ANNAN organisations förslag → 404, inte 403', async () => {
      // Ett id i en annan org ska inte gå att skilja från ett påhittat.
      const a = await forslag({ org: orgB, user: agareB })
      await expect(tjanst.skapaUrFörslag(orgA, a.id, agare(agareA))).rejects.toBeInstanceOf(
        NotFoundException,
      )
    })
  })

  describe('kanBliDelegation — läsytans fråga', () => {
    it('nej efter första godkännandet, med hjälptexten', async () => {
      const a = await forslag({ org: orgA, user: agareA })
      const r = await tjanst.kanBliDelegation(orgA, a.id)
      expect(r.kan).toBe(false)
      expect(r.skäl).toMatch(/en gång till/)
    })

    it('ja efter det andra, med det förifyllda villkoret', async () => {
      await forslag({ org: orgA, user: agareA, propertyId: propA })
      const a2 = await forslag({ org: orgA, user: agareA, propertyId: propA })
      const r = await tjanst.kanBliDelegation(orgA, a2.id)
      expect(r.kan).toBe(true)
      expect(r.förifylltVillkor).toEqual({ [TYPFÄLT]: 'PLUMBING', propertyId: propA })
    })

    it('nej när delegationen redan finns', async () => {
      await forslag({ org: orgA, user: agareA })
      const a2 = await forslag({ org: orgA, user: agareA })
      await tjanst.skapaUrFörslag(orgA, a2.id, agare(agareA))
      expect((await tjanst.kanBliDelegation(orgA, a2.id)).kan).toBe(false)
    })

    it('FAIL-CLOSED: ett okänt id är inte ett ja', async () => {
      expect((await tjanst.kanBliDelegation(orgA, randomUUID())).kan).toBe(false)
    })
  })
})
