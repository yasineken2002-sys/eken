/**
 * DELEGATIONEN MOT RIKTIG POSTGRES.
 *
 * ── VAD SOM INTE GÅR ATT MOCKA ──────────────────────────────────────────────
 *
 * Statusen BERÄKNAS ur händelserna plus klockan — det finns ingen kolumn att
 * läsa. Att den blir rätt i varje steg (skapad → pausad → återupptagen →
 * återkallad, och utgången) kräver att raderna faktiskt finns i den ordningen.
 * Och `assertDelegated` mäter en AVGRÄNSNING: en attrapp hade svarat detsamma
 * oavsett `where`, så en tappad org-kolumn hade lämnat provet grönt.
 *
 * ── EN NEGATIVKONTROLL PER REGEL I GRINDEN ──────────────────────────────────
 *
 * Fem vägar till nej, prövade var för sig: ingen delegation, inte aktiv,
 * villkoret matchar inte, frekvensen överskriden, verktyget inte delegerbart.
 * Ett prov som bara visar ja-fallet skiljer inte en grind från en `return true`.
 *
 * ── RIGGEN ÄGER SINA EGNA FÖRUTSÄTTNINGAR ───────────────────────────────────
 *
 * Två organisationer med var sin ägare. Städning i FK-riktning. Prövad mot en
 * TOM databas och körd TVÅ gånger mot samma databas.
 */
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { ForbiddenException } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

import { DelegationService } from './delegation.service'
import { beräknaStatus } from './delegation-status'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

/** `create_property` — IDEMPOTENT, EGEN_ORG, ingen sänka, VÄG. Delegerbar. */
const IDEMPOTENT_VERKTYG = 'create_property'
/** `create_invoice` — DEDUPLICERBAR: kräver frekvensvillkor. */
const DEDUP_VERKTYG = 'create_invoice'
/** `send_overdue_reminders` — MOT_HYRESGAST med MAIL-sänka. Aldrig delegerbar. */
const EJ_DELEGERBART = 'send_overdue_reminders'

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('delegationen', () => {
  let prisma: PrismaClient
  let tjanst: DelegationService
  let orgA: string
  let orgB: string
  let agareA: string
  let agareB: string

  const agare = (id: string) => ({ userId: id, roll: 'OWNER' as const })

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
      return { org: o.id, user: u.id }
    }
    const a = await bygg('delA')
    const b = await bygg('delB')
    orgA = a.org
    agareA = a.user
    orgB = b.org
    agareB = b.user
  }, 60_000)

  beforeEach(async () => {
    await prisma.aiDelegation.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
  })

  afterAll(async () => {
    // FK-riktning: händelserna faller via Cascade från delegationen.
    await prisma.aiDelegation.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
    await prisma.user.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
    await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } })
    await prisma.$disconnect()
  })

  const status = async (id: string) => {
    const d = await prisma.aiDelegation.findUniqueOrThrow({
      where: { id },
      select: { expiresAt: true, events: { select: { type: true, createdAt: true } } },
    })
    return beräknaStatus(d.events, d.expiresAt)
  }

  describe('livscykeln — status BERÄKNAS i varje steg', () => {
    it('skapad → AKTIV, med en CREATED-händelse av en MÄNNISKA', async () => {
      const d = await tjanst.skapa(orgA, { toolName: IDEMPOTENT_VERKTYG }, agare(agareA))
      expect(await status(d.id)).toBe('AKTIV')
      const h = await prisma.aiDelegationEvent.findMany({ where: { delegationId: d.id } })
      expect(h).toHaveLength(1)
      expect(h[0]).toMatchObject({ type: 'CREATED', actorKind: 'HUMAN', actorUserId: agareA })
      // Scopet är KOPIERAT vid skapandet, inte uppslaget vid läsning.
      expect(d.authorityScope).toBe('EGEN_ORG')
      // 90 dagar som default — ett beslut, inte en härledning.
      const dagar = Math.round((d.expiresAt.getTime() - Date.now()) / 86_400_000)
      expect(dagar).toBe(90)
    })

    it('pausad → PAUSAD, av SYSTEM — växeln är inte en människa', async () => {
      const d = await tjanst.skapa(orgA, { toolName: IDEMPOTENT_VERKTYG }, agare(agareA))
      expect(await tjanst.pausaAlla(orgA)).toBe(1)
      expect(await status(d.id)).toBe('PAUSAD')
      const h = await prisma.aiDelegationEvent.findMany({
        where: { delegationId: d.id, type: 'PAUSED' },
      })
      expect(h[0]?.actorKind).toBe('SYSTEM')
    })

    it('återupptagen → AKTIV igen', async () => {
      const d = await tjanst.skapa(orgA, { toolName: IDEMPOTENT_VERKTYG }, agare(agareA))
      await tjanst.pausaAlla(orgA)
      expect(await tjanst.återupptaAlla(orgA)).toBe(1)
      expect(await status(d.id)).toBe('AKTIV')
    })

    it('en OMKÖRNING av pausen skriver INGEN andra händelse', async () => {
      // Utan det hade historiken fått händelser som inte motsvarar något som hände.
      const d = await tjanst.skapa(orgA, { toolName: IDEMPOTENT_VERKTYG }, agare(agareA))
      await tjanst.pausaAlla(orgA)
      expect(await tjanst.pausaAlla(orgA)).toBe(0)
      const h = await prisma.aiDelegationEvent.findMany({
        where: { delegationId: d.id, type: 'PAUSED' },
      })
      expect(h).toHaveLength(1)
    })

    it('återkallad → ÅTERKALLAD, och den går INTE att återuppta', async () => {
      const d = await tjanst.skapa(orgA, { toolName: IDEMPOTENT_VERKTYG }, agare(agareA))
      await tjanst.återkalla(orgA, d.id, agare(agareA), 'Vi sköter det själva.')
      expect(await status(d.id)).toBe('ÅTERKALLAD')
      // Återupptagning rör den inte — slutgiltigt betyder slutgiltigt.
      expect(await tjanst.återupptaAlla(orgA)).toBe(0)
      expect(await status(d.id)).toBe('ÅTERKALLAD')
      const h = await prisma.aiDelegationEvent.findFirst({
        where: { delegationId: d.id, type: 'REVOKED' },
      })
      expect(h?.note).toBe('Vi sköter det själva.')
    })

    it('utgången → UTGÅNGEN, utan att någon skrivit en EXPIRED-händelse', async () => {
      // Beräkningen är sanningen; händelsen är kvittot på att systemet SÅG det.
      // Utan den här raden hade en delegation vars pass inte hunnit köra räknats
      // som aktiv, och grinden hade släppt igenom den.
      const d = await tjanst.skapa(orgA, { toolName: IDEMPOTENT_VERKTYG }, agare(agareA))
      await prisma.aiDelegation.update({
        where: { id: d.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      })
      expect(await status(d.id)).toBe('UTGÅNGEN')
    })

    it('händelserna är APPEND-ONLY — en UPDATE avvisas av databasen', async () => {
      const d = await tjanst.skapa(orgA, { toolName: IDEMPOTENT_VERKTYG }, agare(agareA))
      const h = await prisma.aiDelegationEvent.findFirstOrThrow({ where: { delegationId: d.id } })
      // Återkallelse är en händelse, inte en radering — och en historik som går
      // att skriva om kan inte bevisa att delegationen existerade.
      await expect(
        prisma.aiDelegationEvent.update({ where: { id: h.id }, data: { note: 'omskriven' } }),
      ).rejects.toThrow()
    })
  })

  describe('vem som får delegera', () => {
    it.each(['ADMIN', 'MANAGER', 'ACCOUNTANT', 'VIEWER'] as const)('%s får INTE', async (roll) => {
      await expect(
        tjanst.skapa(orgA, { toolName: IDEMPOTENT_VERKTYG }, { userId: agareA, roll }),
      ).rejects.toBeInstanceOf(ForbiddenException)
      expect(await prisma.aiDelegation.count({ where: { organizationId: orgA } })).toBe(0)
    })

    it('en icke-ägare får inte heller återkalla', async () => {
      const d = await tjanst.skapa(orgA, { toolName: IDEMPOTENT_VERKTYG }, agare(agareA))
      await expect(
        tjanst.återkalla(orgA, d.id, { userId: agareA, roll: 'ADMIN' }),
      ).rejects.toBeInstanceOf(ForbiddenException)
      expect(await status(d.id)).toBe('AKTIV')
    })
  })

  describe('skapandet är fail-closed', () => {
    it('ett EJ DELEGERBART verktyg kan inte delegeras', async () => {
      await expect(tjanst.skapa(orgA, { toolName: EJ_DELEGERBART }, agare(agareA))).rejects.toThrow(
        /EGNA register|utåtriktat|allowlist/i,
      )
    })

    it('ett DEDUPLICERBART verktyg kräver ett frekvensvillkor', async () => {
      await expect(tjanst.skapa(orgA, { toolName: DEDUP_VERKTYG }, agare(agareA))).rejects.toThrow(
        /frekvensvillkor/,
      )
    })

    it('…och går igenom MED ett', async () => {
      const d = await tjanst.skapa(
        orgA,
        { toolName: DEDUP_VERKTYG, frekvensvillkor: { maxAntal: 3, periodDagar: 7 } },
        agare(agareA),
      )
      expect(await status(d.id)).toBe('AKTIV')
    })

    it('en tidsgräns som redan passerat avvisas', async () => {
      await expect(
        tjanst.skapa(
          orgA,
          { toolName: IDEMPOTENT_VERKTYG, expiresAt: new Date(Date.now() - 1000) },
          agare(agareA),
        ),
      ).rejects.toThrow(/framtiden/)
    })
  })

  describe('assertDelegated — en negativkontroll per regel', () => {
    it('JA när en aktiv delegation utan villkor finns', async () => {
      const d = await tjanst.skapa(orgA, { toolName: IDEMPOTENT_VERKTYG }, agare(agareA))
      const r = await tjanst.assertDelegated(orgA, IDEMPOTENT_VERKTYG)
      expect(r).toEqual({ delegerad: true, delegationId: d.id })
    })

    it('NEJ: ingen delegation', async () => {
      const r = await tjanst.assertDelegated(orgA, IDEMPOTENT_VERKTYG)
      expect(r).toMatchObject({ delegerad: false, skäl: 'INGEN_DELEGATION' })
    })

    it('NEJ: en ANNAN organisations delegation räknas inte', async () => {
      await tjanst.skapa(orgB, { toolName: IDEMPOTENT_VERKTYG }, agare(agareB))
      const r = await tjanst.assertDelegated(orgA, IDEMPOTENT_VERKTYG)
      expect(r).toMatchObject({ delegerad: false, skäl: 'INGEN_DELEGATION' })
      // …och grannen får ja, så provet mäter avgränsningen och inte tomhet.
      expect(await tjanst.assertDelegated(orgB, IDEMPOTENT_VERKTYG)).toMatchObject({
        delegerad: true,
      })
    })

    it.each(['PAUSAD', 'ÅTERKALLAD'] as const)('NEJ: delegationen är %s', async (läge) => {
      await tjanst.skapa(orgA, { toolName: IDEMPOTENT_VERKTYG }, agare(agareA))
      if (läge === 'PAUSAD') await tjanst.pausaAlla(orgA)
      else {
        const d = await prisma.aiDelegation.findFirstOrThrow({ where: { organizationId: orgA } })
        await tjanst.återkalla(orgA, d.id, agare(agareA))
      }
      const r = await tjanst.assertDelegated(orgA, IDEMPOTENT_VERKTYG)
      expect(r).toMatchObject({ delegerad: false, skäl: 'EJ_AKTIV' })
    })

    it('NEJ: delegationen är utgången', async () => {
      const d = await tjanst.skapa(orgA, { toolName: IDEMPOTENT_VERKTYG }, agare(agareA))
      await prisma.aiDelegation.update({
        where: { id: d.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      })
      expect(await tjanst.assertDelegated(orgA, IDEMPOTENT_VERKTYG)).toMatchObject({
        delegerad: false,
        skäl: 'EJ_AKTIV',
      })
    })

    it('NEJ: villkoret matchar inte kontexten', async () => {
      await tjanst.skapa(
        orgA,
        { toolName: IDEMPOTENT_VERKTYG, villkor: { propertyId: 'p1' } },
        agare(agareA),
      )
      expect(
        await tjanst.assertDelegated(orgA, IDEMPOTENT_VERKTYG, { propertyId: 'p2' }),
      ).toMatchObject({ delegerad: false, skäl: 'VILLKORET_MATCHAR_INTE' })
      // …och JA för rätt fastighet.
      expect(
        await tjanst.assertDelegated(orgA, IDEMPOTENT_VERKTYG, { propertyId: 'p1' }),
      ).toMatchObject({ delegerad: true })
    })

    it('NEJ: en kontext UTAN fältet passerar inte en avgränsning på det', async () => {
      // Fail-closed. Annars hade en avgränsning gått att kringgå genom att
      // utelämna fältet den avgränsar på.
      await tjanst.skapa(
        orgA,
        { toolName: IDEMPOTENT_VERKTYG, villkor: { propertyId: 'p1' } },
        agare(agareA),
      )
      expect(await tjanst.assertDelegated(orgA, IDEMPOTENT_VERKTYG, {})).toMatchObject({
        delegerad: false,
        skäl: 'VILLKORET_MATCHAR_INTE',
      })
    })

    it('NEJ: verktyget är inte delegerbart — prövas FÖRE uppslaget', async () => {
      // Ordningen bär mening: en delegation som blivit ogiltig av en
      // katalogändring nekas även om raden finns kvar.
      const r = await tjanst.assertDelegated(orgA, EJ_DELEGERBART)
      expect(r).toMatchObject({ delegerad: false, skäl: 'EJ_DELEGERBART' })
    })

    it('NEJ: frekvensen är överskriden — och räknas på UTFÖRANDEN', async () => {
      const d = await tjanst.skapa(
        orgA,
        { toolName: DEDUP_VERKTYG, frekvensvillkor: { maxAntal: 2, periodDagar: 7 } },
        agare(agareA),
      )
      expect(await tjanst.assertDelegated(orgA, DEDUP_VERKTYG)).toMatchObject({ delegerad: true })

      for (let i = 0; i < 2; i++) {
        await prisma.aiToolExecution.create({
          data: {
            organizationId: orgA,
            toolName: DEDUP_VERKTYG,
            toolInput: {},
            success: true,
            durationMs: 1,
            authorityKind: 'DELEGATION',
            delegationId: d.id,
          },
        })
      }
      expect(await tjanst.assertDelegated(orgA, DEDUP_VERKTYG)).toMatchObject({
        delegerad: false,
        skäl: 'FREKVENSEN_ÖVERSKRIDEN',
      })
      await prisma.aiToolExecution.deleteMany({ where: { organizationId: orgA } })
    })

    it('ett NEKAT anrop förbrukar INTE kvoten', async () => {
      // Annars kunde en trasig anropare tysta en giltig delegation.
      const d = await tjanst.skapa(
        orgA,
        { toolName: DEDUP_VERKTYG, frekvensvillkor: { maxAntal: 1, periodDagar: 7 } },
        agare(agareA),
      )
      for (let i = 0; i < 5; i++) await tjanst.assertDelegated(orgA, DEDUP_VERKTYG)
      expect(await tjanst.assertDelegated(orgA, DEDUP_VERKTYG)).toMatchObject({ delegerad: true })
      expect(await prisma.aiToolExecution.count({ where: { delegationId: d.id } })).toBe(0)
    })
  })

  describe('grunden på skrivningen', () => {
    it('en körning kan peka på delegationen, och authorityKind säger vilken rätt', async () => {
      const d = await tjanst.skapa(orgA, { toolName: IDEMPOTENT_VERKTYG }, agare(agareA))
      const e = await prisma.aiToolExecution.create({
        data: {
          organizationId: orgA,
          toolName: IDEMPOTENT_VERKTYG,
          toolInput: {},
          success: true,
          durationMs: 1,
          authorityKind: 'DELEGATION',
          delegationId: d.id,
        },
        select: { id: true, authorityKind: true, delegationId: true },
      })
      expect(e).toMatchObject({ authorityKind: 'DELEGATION', delegationId: d.id })
      await prisma.aiToolExecution.deleteMany({ where: { organizationId: orgA } })
    })

    it('en körning UTAN delegation är APPROVAL — inte null', async () => {
      // Defaulten är ett FAKTUM och inte en gissning: en skrivning utan
      // delegation skedde med en människas ja.
      const e = await prisma.aiToolExecution.create({
        data: {
          organizationId: orgA,
          toolName: IDEMPOTENT_VERKTYG,
          toolInput: {},
          success: true,
          durationMs: 1,
        },
        select: { authorityKind: true, delegationId: true },
      })
      expect(e).toEqual({ authorityKind: 'APPROVAL', delegationId: null })
      await prisma.aiToolExecution.deleteMany({ where: { organizationId: orgA } })
    })
  })
})
