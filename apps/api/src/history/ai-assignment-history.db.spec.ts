/**
 * UPPDRAGET FRÅN 03:00 SYNS 09:00 — MOT RIKTIG POSTGRES.
 *
 * Etapp 4:s klart-kriterium i `docs/eveno-agentplan.md` är ordagrant *"uppdrag
 * från 03:00 finns 09:00 och syns i historiken"*. Den första halvan bevisades av
 * `ai-assignments.db.spec.ts`: raden överlever i databasen. Den ANDRA halvan —
 * att den syns — hade ingen mätning alls: noll av tjugo källor i registret läste
 * `AiAssignment`, och registervakten kunde inte se luckan därför att modellen
 * saknade de relationer vakten frågar om.
 *
 * ── VARFÖR RIKTIG POSTGRES OCH INTE EN ATTRAPP ──────────────────────────────
 *
 * Två av proven mäter en AVGRÄNSNING och inte ett flöde: att källan bara läser
 * den egna organisationens uppdrag, och att den bara läser dem som pekar på
 * just det subjekt som efterfrågas. En attrapp returnerar det den blivit
 * tillsagd oavsett `where`, så en tappad kolumn i avgränsningen hade lämnat båda
 * proven gröna — den mockade varianten kan inte pröva den FÖR GROVA riktningen.
 *
 * ── RIGGEN ÄGER SINA EGNA FÖRUTSÄTTNINGAR ───────────────────────────────────
 *
 * Den bygger två organisationer med var sin hyresgäst, lägenhet och fastighet,
 * och städar i FK-riktning. Ingenting läses ur omgivningen. Prövad mot en TOM
 * databas (`eken_tom`) och körd TVÅ gånger mot samma databas, så att en rigg som
 * bygger på sitt eget skräp faller.
 *
 * ── VAD PROVET INTE KAN SE ──────────────────────────────────────────────────
 *
 * Att ett godkänt uppdrag UTFÖRS. Det finns ingen utförare (etapp 8–9), och
 * `AiAssignmentStatus` har därför bara fyra värden. Källan har fyra
 * händelsetyper av exakt det skälet, och den dagen `EXECUTED`/`FAILED` finns är
 * det den PR:ens sak att lägga till både värdet, skrivaren och raden här.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { Logger } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

import { AiAssignmentsService } from '../ai/assignments/ai-assignments.service'
import { HistoryService } from './history.service'
import { HISTORY_SOURCES } from './history-sources.registry'

import type { SkapaUppdrag } from '../ai/assignments/ai-assignments.service'
import type { PrismaService } from '../common/prisma/prisma.service'
import type { HistoryEvent } from './history-event'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

/** Klockslagen ur planens klart-kriterium, samma dygn. */
const KL_03 = new Date('2026-09-05T03:00:00.000Z')
const KL_09 = new Date('2026-09-05T09:00:00.000Z')

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    // Utan den här raden är filen grön av att den hoppades över.
    expect(HAR_DB).toBe(true)
  })

  it('KANARIEFÅGEL: källan är registrerad i ALLA TRE dimensionerna', () => {
    // Omfångskanariefågeln. Faller registerposten bort ska DEN händelsen bli
    // röd — annars mäter proven nedan en tom mängd och är gröna för alltid.
    const post = HISTORY_SOURCES.find((s) => s.key === 'ai-assignment')
    expect(post).toBeDefined()
    expect(post?.relations).toEqual({
      tenant: 'aiAssignments',
      unit: 'aiAssignments',
      property: 'aiAssignments',
    })
  })
})

medDb('uppdragskön i historiken', () => {
  let prisma: PrismaClient
  let uppdrag: AiAssignmentsService
  let historik: HistoryService

  /** Organisation A — den som frågar. */
  let orgId: string
  let userId: string
  let tenantId: string
  let unitId: string
  let propertyId: string

  /** Organisation B — grannen som aldrig ska synas. */
  let orgBId: string
  let orgBUserId: string
  let orgBTenantId: string

  const om = (över: Partial<SkapaUppdrag> = {}): SkapaUppdrag => ({
    // `create_property`: IDEMPOTENT med DATABAS_INDEX — duglig som uppdrag.
    toolName: 'create_property',
    toolInput: { name: 'Storgatan 4' },
    title: 'Boka rörmokare till läckan',
    reasoning: 'Felanmälan från i natt beskriver rinnande vatten under diskbänken.',
    consequence: 'En bokning skapas. Inget skickas till någon utanför systemet.',
    undoHint: 'Bokningen kan avbokas fram till dagen före.',
    deadline: new Date(KL_09.getTime() + 6 * 60 * 60 * 1000),
    assignedToUserId: userId,
    ...över,
  })

  /**
   * Skapar ett uppdrag genom TJÄNSTEN — inte genom en direkt skrivning — och
   * backdaterar `createdAt` till 03:00 efteråt.
   *
   * Vägen in spelar roll: tjänsten bär duglighetsgrinden, omfångsprövningen mot
   * organisationen och kallelsen. En rigg som skrev raden direkt hade prövat
   * historiken mot en rad som skapandet kanske hade avvisat.
   */
  const skapaKl03 = async (org: string, över: Partial<SkapaUppdrag> = {}) => {
    const rad = await uppdrag.skapa(org, om(över))
    await prisma.aiAssignment.update({ where: { id: rad.id }, data: { createdAt: KL_03 } })
    return rad
  }

  const läs = async (
    kind: 'TENANT' | 'UNIT' | 'PROPERTY',
    id: string,
    roll: 'OWNER' | 'ADMIN' | 'MANAGER' | 'ACCOUNTANT' | 'VIEWER' = 'OWNER',
    org = orgId,
  ): Promise<HistoryEvent[]> => historik.forSubject(org, { kind, id }, roll)

  const uppdragsrader = (h: HistoryEvent[]) => h.filter((e) => e.source.table === 'AiAssignment')

  beforeAll(async () => {
    prisma = new PrismaClient()

    uppdrag = Object.create(AiAssignmentsService.prototype) as AiAssignmentsService
    Object.assign(uppdrag, {
      prisma,
      notifications: { create: async () => undefined },
      locks: { runIfUnlocked: async () => ({ ran: true }) },
      cronErrors: { report: async () => undefined },
      logger: new Logger('spec'),
    })
    historik = new HistoryService(prisma as unknown as PrismaService)

    const sfx = randomUUID().slice(0, 8)

    const skapaOrg = async (namn: string) => {
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
      const t = await prisma.tenant.create({
        data: {
          organizationId: o.id,
          type: 'INDIVIDUAL',
          firstName: 'H',
          lastName: 'G',
          email: `hg-${namn}-${sfx}@example.se`,
        },
        select: { id: true },
      })
      return { orgId: o.id, userId: u.id, tenantId: t.id }
    }

    const a = await skapaOrg('upphist')
    orgId = a.orgId
    userId = a.userId
    tenantId = a.tenantId

    const p = await prisma.property.create({
      data: {
        organizationId: orgId,
        name: 'Historikfastigheten',
        propertyDesignation: `TESTBY ${sfx}`,
        street: 'Storgatan 1',
        city: 'Testby',
        postalCode: '11111',
        type: 'RESIDENTIAL',
        totalArea: 500,
      },
      select: { id: true },
    })
    propertyId = p.id

    const u = await prisma.unit.create({
      data: {
        propertyId,
        name: 'Lgh 1001',
        unitNumber: `1001-${sfx}`,
        type: 'APARTMENT',
        rooms: 2,
        area: 55,
        monthlyRent: 8000,
      },
      select: { id: true },
    })
    unitId = u.id

    const b = await skapaOrg('upphistb')
    orgBId = b.orgId
    orgBUserId = b.userId
    orgBTenantId = b.tenantId
  }, 60_000)

  beforeEach(async () => {
    await prisma.aiAssignment.deleteMany({ where: { organizationId: { in: [orgId, orgBId] } } })
  })

  afterAll(async () => {
    // FK-riktning: barnen först. AiAssignment pekar på Organization, User,
    // Tenant, Unit och Property — den måste bort före alla fem.
    await prisma.aiAssignment.deleteMany({ where: { organizationId: { in: [orgId, orgBId] } } })
    await prisma.tenant.deleteMany({ where: { organizationId: { in: [orgId, orgBId] } } })
    await prisma.user.deleteMany({ where: { organizationId: { in: [orgId, orgBId] } } })
    await prisma.unit.deleteMany({ where: { propertyId } })
    await prisma.property.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, orgBId] } } })
    await prisma.$disconnect()
  })

  describe("planens klart-kriterium: 'uppdrag från 03:00 finns 09:00 och syns i historiken'", () => {
    it('ett uppdrag skapat 03:00 syns i hyresgästens historik 09:00 — med AGENT som aktör', async () => {
      const rad = await skapaKl03(orgId, { tenantId })

      // Raden FINNS 09:00 — den första halvan av kriteriet.
      const kvar = await prisma.aiAssignment.findFirst({
        where: { id: rad.id, createdAt: { lt: KL_09 } },
        select: { id: true, status: true },
      })
      expect(kvar).toMatchObject({ id: rad.id, status: 'AWAITING_APPROVAL' })

      // Och den SYNS — den andra halvan, som saknade mätning helt.
      const händelser = uppdragsrader(await läs('TENANT', tenantId))
      expect(händelser).toHaveLength(1)
      expect(händelser[0]).toMatchObject({
        type: 'AI_ASSIGNMENT_CREATED',
        severity: 'INFO',
        source: { table: 'AiAssignment', id: rad.id },
      })
      expect(händelser[0]?.at.toISOString()).toBe(KL_03.toISOString())
      // AKTÖREN. En agent som föreslår — aldrig en människa som låtsas.
      expect(händelser[0]?.actor).toEqual({ kind: 'AGENT', id: null, label: 'create_property' })
      expect(händelser[0]?.description).toContain('Boka rörmokare')
    })

    it('ett VÄNTANDE uppdrag ger EN rad, inte två — utfallet har inte inträffat', async () => {
      await skapaKl03(orgId, { tenantId })
      expect(uppdragsrader(await läs('TENANT', tenantId))).toHaveLength(1)
    })
  })

  describe('avgränsningen — mot riktig Postgres, där `where` utvärderas', () => {
    it('ett uppdrag i en ANNAN organisation syns inte', async () => {
      await skapaKl03(orgBId, { tenantId: orgBTenantId, assignedToUserId: orgBUserId })

      // Grannens hyresgäst, läst i grannens org: raden finns.
      expect(uppdragsrader(await läs('TENANT', orgBTenantId, 'OWNER', orgBId))).toHaveLength(1)
      // Samma hyresgäst, läst i VÅR org: 404 innan källan ens körs.
      await expect(läs('TENANT', orgBTenantId)).rejects.toThrow(/hittades inte/i)
      // Och vår egen hyresgäst har inget av grannens.
      expect(uppdragsrader(await läs('TENANT', tenantId))).toHaveLength(0)
    })

    it('ett uppdrag för en ANNAN hyresgäst i SAMMA organisation syns inte', async () => {
      // Den för grova riktningen: org-filtret ensamt hade släppt igenom den här.
      const annan = await prisma.tenant.create({
        data: {
          organizationId: orgId,
          type: 'INDIVIDUAL',
          firstName: 'A',
          lastName: 'N',
          email: `annan-${randomUUID().slice(0, 8)}@example.se`,
        },
        select: { id: true },
      })
      await skapaKl03(orgId, { tenantId: annan.id })
      expect(uppdragsrader(await läs('TENANT', tenantId))).toHaveLength(0)
      expect(uppdragsrader(await läs('TENANT', annan.id))).toHaveLength(1)
      await prisma.aiAssignment.deleteMany({ where: { tenantId: annan.id } })
      await prisma.tenant.delete({ where: { id: annan.id } })
    })

    it('omfånget prövas mot organisationen redan vid skapandet', async () => {
      await expect(uppdrag.skapa(orgId, om({ tenantId: orgBTenantId }))).rejects.toThrow(
        /Hyresgästen finns inte i organisationen/,
      )
    })
  })

  describe('de tre dimensionerna — en källa, tre ingångar', () => {
    it('ett uppdrag med lägenhet i omfånget syns i LÄGENHETENS historik', async () => {
      const rad = await skapaKl03(orgId, { unitId })
      const h = uppdragsrader(await läs('UNIT', unitId))
      expect(h).toHaveLength(1)
      expect(h[0]?.source.id).toBe(rad.id)
      expect(h[0]?.subject).toEqual({ kind: 'UNIT', id: unitId, label: null })
      // Och INTE i hyresgästens — omfånget är lägenheten, inte personen.
      expect(uppdragsrader(await läs('TENANT', tenantId))).toHaveLength(0)
    })

    it('ett uppdrag med fastighet i omfånget syns i FASTIGHETENS historik', async () => {
      const rad = await skapaKl03(orgId, { propertyId })
      const h = uppdragsrader(await läs('PROPERTY', propertyId))
      expect(h).toHaveLength(1)
      expect(h[0]?.source.id).toBe(rad.id)
    })

    it('ett uppdrag UTAN omfång syns i ingen objekthistorik — och det är rätt', async () => {
      // 17 av de 23 dugliga verktygen rör inget enskilt objekt. NULL betyder
      // "rör inget objekt", inte "vi vet inte" — uppdraget finns kvar i kön.
      const rad = await skapaKl03(orgId)
      expect(uppdragsrader(await läs('TENANT', tenantId))).toHaveLength(0)
      expect(uppdragsrader(await läs('UNIT', unitId))).toHaveLength(0)
      expect(uppdragsrader(await läs('PROPERTY', propertyId))).toHaveLength(0)
      expect(await prisma.aiAssignment.count({ where: { id: rad.id } })).toBe(1)
    })
  })

  describe('utfallen — aktören är den som faktiskt agerade', () => {
    it('ett GODKÄNT uppdrag ger en HUMAN-rad med beslutsfattaren', async () => {
      const rad = await skapaKl03(orgId, { tenantId })
      await uppdrag.besluta(orgId, rad.id, userId, 'APPROVED')

      const h = uppdragsrader(await läs('TENANT', tenantId))
      expect(h.map((e) => e.type).sort()).toEqual([
        'AI_ASSIGNMENT_APPROVED',
        'AI_ASSIGNMENT_CREATED',
      ])
      const godkänt = h.find((e) => e.type === 'AI_ASSIGNMENT_APPROVED')
      // HUMAN går att säga här därför att `besluta` bara nås från
      // `@Patch(':id/decision')` med `user.sub` — det finns ingen AI-väg dit.
      expect(godkänt?.actor).toEqual({ kind: 'HUMAN', id: userId, label: null })
      expect(godkänt?.severity).toBe('NOTICE')
      // Nyast först: beslutet ligger före skapandet i listan.
      expect(h[0]?.type).toBe('AI_ASSIGNMENT_APPROVED')
    })

    it('ett AVSLAGET uppdrag bär människans skäl — skälet är minnesmat', async () => {
      const rad = await skapaKl03(orgId, { tenantId })
      await uppdrag.besluta(orgId, rad.id, userId, 'REJECTED', 'Vi har redan en rörmokare bokad.')

      const avslag = uppdragsrader(await läs('TENANT', tenantId)).find(
        (e) => e.type === 'AI_ASSIGNMENT_REJECTED',
      )
      expect(avslag?.actor).toEqual({ kind: 'HUMAN', id: userId, label: null })
      expect(avslag?.description).toContain('Vi har redan en rörmokare bokad.')
    })

    it('ett FÖRFALLET uppdrag ger en SYSTEM-rad vid tidsgränsen', async () => {
      const rad = await skapaKl03(orgId, { tenantId })
      // Gränsen backas till 04:00 och passet körs mot en klocka strax efter.
      // Vägen in är den RIKTIGA cronmetoden, inte en direkt statusskrivning:
      // annars hade provet inte kunnat se att förfallet alls sätter statusen.
      const gräns = new Date('2026-09-05T04:00:00.000Z')
      await prisma.aiAssignment.update({ where: { id: rad.id }, data: { deadline: gräns } })
      await uppdrag.stängUtgångna(new Date('2026-09-05T04:00:30.000Z'))

      const h = uppdragsrader(await läs('TENANT', tenantId))
      const förfall = h.find((e) => e.type === 'AI_ASSIGNMENT_EXPIRED')
      expect(förfall?.actor).toEqual({ kind: 'SYSTEM', id: null, label: null })
      // Tidpunkten är GRÄNSEN, inte när passet råkade upptäcka det — modellen
      // bär ingen stängningstidpunkt, och `deadline` är faktumet.
      expect(förfall?.at.toISOString()).toBe(gräns.toISOString())
      expect(förfall?.severity).toBe('WARNING')
      // Ett tyst förfall är förbjudet: skälet står i raden.
      expect(förfall?.description).toContain('Tidsgränsen passerade')
    })

    it('varje uppdrag ger HÖGST två rader — skapat plus utfallet', async () => {
      const a = await skapaKl03(orgId, { tenantId })
      await uppdrag.besluta(orgId, a.id, userId, 'APPROVED')
      await skapaKl03(orgId, { tenantId })
      expect(uppdragsrader(await läs('TENANT', tenantId))).toHaveLength(3)
    })
  })

  describe('åtkomsten — ett aggregat får inte vidga den', () => {
    it.each(['ACCOUNTANT', 'VIEWER'] as const)(
      '%s ser inte uppdragskön i historiken — läsytan är OWNER/ADMIN/MANAGER',
      async (roll) => {
        await skapaKl03(orgId, { tenantId })
        expect(uppdragsrader(await läs('TENANT', tenantId, roll))).toHaveLength(0)
      },
    )

    it.each(['OWNER', 'ADMIN', 'MANAGER'] as const)('%s ser den', async (roll) => {
      await skapaKl03(orgId, { tenantId })
      expect(uppdragsrader(await läs('TENANT', tenantId, roll))).toHaveLength(1)
    })
  })
})
