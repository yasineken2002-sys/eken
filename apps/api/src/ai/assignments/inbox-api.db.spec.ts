/**
 * INKORGENS LÄSYTA MOT RIKTIG POSTGRES.
 *
 * ── VAD SOM INTE GÅR ATT MOCKA ──────────────────────────────────────────────
 *
 * Tre av proven mäter en AVGRÄNSNING, inte ett flöde: att `hamta` svarar 404 på
 * en annan organisations id, att pagineringen räknar `total` över HELA mängden
 * och inte över sidan, och att träffgradens nämnare bara är rader med facit. En
 * attrapp returnerar det den blivit tillsagd oavsett `where`, så en tappad
 * kolumn i avgränsningen hade lämnat alla tre gröna.
 *
 * ── RIGGEN ÄGER SINA EGNA FÖRUTSÄTTNINGAR ───────────────────────────────────
 *
 * Två organisationer, egen användare i var. Städning i FK-riktning. Prövad mot
 * en TOM databas och körd TVÅ gånger mot samma databas.
 */
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { Logger } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

import { AiAssignmentsService } from './ai-assignments.service'
import { SKUGGKALLA_FELANMALAN } from '../shadow/shadow-fields'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('inkorgens läsyta', () => {
  let prisma: PrismaClient
  let tjanst: AiAssignmentsService
  let orgA: string
  let orgB: string
  let userA: string
  let userB: string

  /** Ett skuggförslag. `prediction`/`outcome` sätts av den som behöver dem. */
  const forslag = async (
    org: string,
    user: string,
    over: Record<string, unknown> = {},
  ): Promise<string> => {
    const r = await prisma.aiAssignment.create({
      data: {
        organizationId: org,
        shadow: true,
        sourceKind: SKUGGKALLA_FELANMALAN,
        sourceId: randomUUID(),
        toolName: 'update_maintenance_status',
        toolInput: {},
        title: 'Förslag',
        reasoning: 'Därför.',
        consequence: 'SKUGGLÄGE: ingenting utförs.',
        undoHint: 'Inget att ångra.',
        deadline: new Date(Date.now() + 6 * 60 * 60 * 1000),
        assignedToUserId: user,
        ...over,
      },
      select: { id: true },
    })
    return r.id
  }

  beforeAll(async () => {
    prisma = new PrismaClient()
    tjanst = Object.create(AiAssignmentsService.prototype) as AiAssignmentsService
    Object.assign(tjanst, {
      prisma,
      notifications: { create: async () => undefined },
      locks: { runIfUnlocked: async () => ({ ran: true }) },
      cronErrors: { report: async () => undefined },
      logger: new Logger('spec'),
    })

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
      return { org: o.id, user: u.id }
    }
    const a = await bygg('inkorga')
    const b = await bygg('inkorgb')
    orgA = a.org
    userA = a.user
    orgB = b.org
    userB = b.user
  }, 60_000)

  beforeEach(async () => {
    await prisma.aiAssignment.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
  })

  afterAll(async () => {
    await prisma.aiAssignment.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
    await prisma.user.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
    await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } })
    await prisma.$disconnect()
  })

  describe('org-scoping', () => {
    it('en ANNAN organisations uppdrag ger 404 — inte ett tomt svar', async () => {
      const id = await forslag(orgB, userB)
      // 404 och inte 403: ett id i en annan org ska inte gå att skilja från ett
      // påhittat. Ett 403 hade bekräftat att raden finns.
      await expect(tjanst.hamta(orgA, id)).rejects.toThrow(/hittades inte/i)
      await expect(tjanst.hamta(orgB, id)).resolves.toMatchObject({ id })
    })

    it('listan bär bara den egna organisationens rader', async () => {
      await forslag(orgA, userA)
      await forslag(orgB, userB)
      await forslag(orgB, userB)
      const a = await tjanst.lista(orgA)
      const b = await tjanst.lista(orgB)
      expect(a.total).toBe(1)
      expect(b.total).toBe(2)
    })

    it('sammanfattningen korsar inte org-gränsen', async () => {
      await forslag(orgA, userA)
      await forslag(orgB, userB)
      const s = await tjanst.sammanfattning(orgA)
      expect(s.status.AWAITING_APPROVAL).toBe(1)
    })
  })

  describe('pagineringen — taket SYNS', () => {
    it('`total` räknar HELA mängden, inte sidan', async () => {
      for (let i = 0; i < 7; i++) await forslag(orgA, userA)
      const sida = await tjanst.lista(orgA, { limit: 3 })
      expect(sida.rader).toHaveLength(3)
      // Det här är hela poängen: en inkorg med sju ser ut att ha tre om svaret
      // bara bär raderna.
      expect(sida.total).toBe(7)
      expect(sida.limit).toBe(3)
    })

    it('offset flyttar fönstret utan att ändra total', async () => {
      for (let i = 0; i < 5; i++) await forslag(orgA, userA)
      const s1 = await tjanst.lista(orgA, { limit: 2, offset: 0 })
      const s2 = await tjanst.lista(orgA, { limit: 2, offset: 2 })
      expect(s1.total).toBe(5)
      expect(s2.total).toBe(5)
      const idn = new Set([...s1.rader, ...s2.rader].map((r) => r.id))
      expect(idn.size).toBe(4)
    })

    it('limit klamps till taket — ett för stort tal blir inte en full tabell', async () => {
      const s = await tjanst.lista(orgA, { limit: 9999 })
      expect(s.limit).toBe(100)
    })
  })

  describe('träffgraden — nämnaren är BESVARADE fall', () => {
    it('ett förslag UTAN facit räknas varken som träff eller miss', async () => {
      await forslag(orgA, userA, { prediction: { category: 'PLUMBING' } })
      const s = await tjanst.sammanfattning(orgA)
      expect(s.traffgrad['category']).toEqual({ besvarade: 0, traffar: 0, andel: null })
    })

    it('ETT RÄTT och ETT FEL ger 50 %', async () => {
      await forslag(orgA, userA, {
        prediction: { category: 'PLUMBING', priority: 'HIGH' },
        outcome: { category: 'PLUMBING', priority: 'HIGH' },
        outcomeAt: new Date(),
      })
      await forslag(orgA, userA, {
        prediction: { category: 'PLUMBING', priority: 'HIGH' },
        outcome: { category: 'ELECTRICAL', priority: 'HIGH' },
        outcomeAt: new Date(),
      })
      const s = await tjanst.sammanfattning(orgA)
      expect(s.traffgrad['category']).toEqual({ besvarade: 2, traffar: 1, andel: 0.5 })
      // Prioritet var rätt i BÅDA — träffgraden är per fält, inte per rad.
      expect(s.traffgrad['priority']).toEqual({ besvarade: 2, traffar: 2, andel: 1 })
    })

    it('ett fält som saknas i facit sänker inte träffgraden', async () => {
      await forslag(orgA, userA, {
        prediction: { category: 'PLUMBING', assignedToId: 'x' },
        outcome: { category: 'PLUMBING' },
        outcomeAt: new Date(),
      })
      const s = await tjanst.sammanfattning(orgA)
      expect(s.traffgrad['category']?.andel).toBe(1)
      // Facit sa inget om tilldelning → varken träff eller miss.
      expect(s.traffgrad['assignedToId']).toEqual({ besvarade: 0, traffar: 0, andel: null })
    })
  })

  describe('filtret', () => {
    it('status och shadow filtrerar var för sig', async () => {
      await forslag(orgA, userA)
      await forslag(orgA, userA, { shadow: false, sourceKind: null, sourceId: null })
      expect((await tjanst.lista(orgA, { shadow: true })).total).toBe(1)
      expect((await tjanst.lista(orgA, { shadow: false })).total).toBe(1)
      expect((await tjanst.lista(orgA)).total).toBe(2)
      expect((await tjanst.lista(orgA, { status: 'APPROVED' })).total).toBe(0)
    })
  })
})
