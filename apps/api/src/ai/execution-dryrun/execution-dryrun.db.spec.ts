/**
 * UTFÖRAREN I TORRLÄGE — mot riktig Postgres.
 *
 * ── TVÅ FRÅGOR, OCH DEN ANDRA ÄR DEN VIKTIGA ────────────────────────────────
 *
 * 1. Blir domen RÄTT? Fem grenar: matchande delegation, ingen delegation,
 *    utgången, pausad, och en annan organisations delegation.
 * 2. Uppstår någon EFFEKT? `AiToolExecution` och de domäntabeller ett
 *    delegerbart verktyg hade rört räknas före och efter varje pass, och kravet
 *    är noll.
 *
 * Fråga 2 ensam kan inte skiljas från "koden kördes aldrig" — därför kräver
 * samma prov att en DOM faktiskt skrevs. Noll effekter OCH en skriven dom är
 * tillsammans ett belägg; var för sig är de två olika sorters tystnad.
 *
 * ── VAD SOM INTE GÅR ATT MOCKA ──────────────────────────────────────────────
 *
 * Domen läses ur `assertDelegated`, som beräknar delegationens status ur dess
 * händelser och räknar förbrukning över ett tidsfönster. En attrapp hade
 * returnerat det svar provet matade in, och en tappad `organizationId` i någon
 * `where` hade lämnat provet grönt medan grannens delegationer fällde domar i
 * din organisation.
 *
 * ── VAD DEN INTE MÄTER ──────────────────────────────────────────────────────
 *
 * Att sveparcronen och kön kopplar in tjänsten. Det ägs av `dryrun.module.ts`
 * (som per konstruktion inte importerar exekveraren) och av
 * `check-cron-classification`/`cron-heartbeat.spec.ts`. Ett grönt prov här
 * bevisar inte att någon anropar det som prövas.
 *
 * ── RIGGEN ÄGER SINA EGNA FÖRUTSÄTTNINGAR ───────────────────────────────────
 *
 * Två organisationer med var sin ägare, egna fastigheter och egna lägenheter.
 * Städning i FK-riktning, prövad mot en TOM databas och körd TVÅ gånger mot
 * samma databas.
 */
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import { DelegationService } from '../delegation/delegation.service'
import { SKUGGKALLA_FELANMALAN } from '../shadow/shadow-fields'
import { AiExecutionDryRunService } from './execution-dryrun.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

/** Ett delegerbart verktyg UTAN krav på frekvensvillkor — se `delegation-scope`. */
const VERKTYG = 'update_maintenance_status'
const KATEGORI = 'PLUMBING'
const DAG = 24 * 60 * 60 * 1000

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('utföraren i torrläge', () => {
  let prisma: PrismaClient
  let delegation: DelegationService
  let dryrun: AiExecutionDryRunService
  let orgA: string
  let orgB: string
  let agareA: string
  let agareB: string
  let propA: string
  let unitA: string

  const agare = (id: string) => ({ userId: id, roll: 'OWNER' as const })

  /** Ett skuggförslag med omfång — det som gör villkorsmatchningen prövbar. */
  const forslag = async (
    org: string,
    over: { unitId?: string | null; propertyId?: string | null } = {},
  ) =>
    prisma.aiAssignment.create({
      data: {
        organizationId: org,
        shadow: true,
        sourceKind: SKUGGKALLA_FELANMALAN,
        sourceId: randomUUID(),
        toolName: VERKTYG,
        toolInput: {},
        title: 'Förslag',
        reasoning: 'Därför.',
        consequence: 'SKUGGLÄGE: ingenting utförs.',
        undoHint: 'Inget att ångra.',
        prediction: { category: KATEGORI },
        deadline: new Date(Date.now() + 7 * DAG),
        propertyId: over.propertyId === undefined ? (org === orgA ? propA : null) : over.propertyId,
        unitId: over.unitId === undefined ? (org === orgA ? unitA : null) : over.unitId,
      },
      select: { id: true },
    })

  /**
   * EFFEKTRÄKNINGEN. Tabellerna är de ett delegerbart verktyg hade rört, plus
   * spårtabellerna. Listan är skriven och inte härledd — och det står här att
   * den är det: en härledning ur schemat hade räknat 84 modeller och gjort
   * provet långsamt utan att göra det skarpare.
   */
  const effekter = async () => ({
    körningar: await prisma.aiToolExecution.count(),
    effekter: await prisma.aiToolEffect.count(),
    ärenden: await prisma.maintenanceTicket.count(),
    fastigheter: await prisma.property.count(),
    lägenheter: await prisma.unit.count(),
    verifikat: await prisma.journalEntry.count(),
    fakturor: await prisma.invoice.count(),
  })

  beforeAll(async () => {
    prisma = new PrismaClient()
    delegation = new DelegationService(prisma as never)
    dryrun = new AiExecutionDryRunService(prisma as never, delegation)

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
    const a = await bygg('torrA')
    const b = await bygg('torrB')
    orgA = a.org
    agareA = a.user
    orgB = b.org
    agareB = b.user

    const p = await prisma.property.create({
      data: {
        organizationId: orgA,
        name: 'Storgatan 4',
        propertyDesignation: `TORR ${randomUUID().slice(0, 8)}`,
        street: 'Storgatan 4',
        city: 'Ort',
        postalCode: '11111',
        type: 'RESIDENTIAL',
        totalArea: 100,
      },
      select: { id: true },
    })
    propA = p.id
    const u = await prisma.unit.create({
      data: {
        propertyId: propA,
        name: 'Lgh 1',
        unitNumber: '1001',
        type: 'APARTMENT',
        area: 50,
        rooms: 2,
        monthlyRent: 8500,
      },
      select: { id: true },
    })
    unitA = u.id
  }, 60_000)

  beforeEach(async () => {
    await prisma.aiAssignment.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
    await prisma.aiDelegation.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
  })

  afterAll(async () => {
    // FK-RIKTNING: uppdragen pekar på delegationerna (verdictDelegationId), så
    // de måste bort först trots SetNull — ordningen gör provet oberoende av att
    // just den regeln inte ändras.
    await prisma.aiAssignment.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
    await prisma.aiDelegation.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
    await prisma.unit.deleteMany({ where: { propertyId: propA } })
    await prisma.property.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
    await prisma.user.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
    await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } })
    await prisma.$disconnect()
  })

  describe('INGEN EFFEKT — hela PR:ens bärande påstående', () => {
    it('ett pass skriver EN dom och NOLL effekter', async () => {
      await delegation.skapa(orgA, { toolName: VERKTYG }, agare(agareA))
      const a = await forslag(orgA)

      const före = await effekter()
      const r = await dryrun.bedöm(orgA, a.id)
      const efter = await effekter()

      // BÅDA HALVORNA. Noll effekter ensamt är oskiljbart från "koden kördes
      // aldrig"; en skriven dom ensam säger inget om effekter.
      expect(r).toEqual({ utfall: 'DOM', dom: 'WOULD_EXECUTE', delegationId: expect.any(String) })
      expect(efter).toEqual(före)
    })

    it('inte heller när domen är ett NEJ', async () => {
      const a = await forslag(orgA)
      const före = await effekter()
      await dryrun.bedöm(orgA, a.id)
      expect(await effekter()).toEqual(före)
    })
  })

  describe('de fem grenarna', () => {
    it('matchande delegation → WOULD_EXECUTE, med delegationen utpekad', async () => {
      const d = await delegation.skapa(orgA, { toolName: VERKTYG }, agare(agareA))
      const a = await forslag(orgA)
      await dryrun.bedöm(orgA, a.id)
      const rad = await prisma.aiAssignment.findUniqueOrThrow({ where: { id: a.id } })
      expect(rad.executionVerdict).toBe('WOULD_EXECUTE')
      expect(rad.verdictDelegationId).toBe(d.id)
      expect(rad.verdictAt).toBeInstanceOf(Date)
      // SKÄLET NOLLSTÄLLS i den här grenen — annars hade en omdömd rad kunnat
      // bära ett gammalt BLOCKED-skäl bredvid ett nytt ja.
      expect(rad.verdictReason).toBeNull()
    })

    it('ingen delegation → NO_DELEGATION', async () => {
      const a = await forslag(orgA)
      await dryrun.bedöm(orgA, a.id)
      const rad = await prisma.aiAssignment.findUniqueOrThrow({ where: { id: a.id } })
      expect(rad.executionVerdict).toBe('NO_DELEGATION')
      expect(rad.verdictDelegationId).toBeNull()
    })

    it('UTGÅNGEN delegation → BLOCKED med skäl', async () => {
      // Delegationen SKAPAS giltig — `skapa` vägrar en tidsgräns i det förflutna,
      // och att skriva en olaglig rad förbi tjänsten hade prövat en form som
      // koden inte kan producera. Klockan flyttas i stället fram förbi gränsen,
      // vilket är exakt vad som händer i verkligheten.
      await delegation.skapa(orgA, { toolName: VERKTYG }, agare(agareA))
      const a = await forslag(orgA)
      await dryrun.bedöm(orgA, a.id, false, new Date(Date.now() + 200 * DAG))
      const rad = await prisma.aiAssignment.findUniqueOrThrow({ where: { id: a.id } })
      expect(rad.executionVerdict).toBe('BLOCKED')
      expect(rad.verdictReason).toContain('pausad, återkallad eller utgången')
      expect(rad.verdictDelegationId).toBeNull()
    })

    it('PAUSAD delegation → BLOCKED', async () => {
      const d = await delegation.skapa(orgA, { toolName: VERKTYG }, agare(agareA))
      await delegation.pausa(orgA, d.id, agare(agareA))
      const a = await forslag(orgA)
      await dryrun.bedöm(orgA, a.id)
      const rad = await prisma.aiAssignment.findUniqueOrThrow({ where: { id: a.id } })
      expect(rad.executionVerdict).toBe('BLOCKED')
    })

    it('EN ANNAN ORGANISATIONS delegation → NO_DELEGATION, inte WOULD_EXECUTE', async () => {
      // Grannens rätt är inte din. Den här grenen är den enda som kan skilja en
      // korrekt org-avgränsning från en tappad `where`.
      await delegation.skapa(orgB, { toolName: VERKTYG }, agare(agareB))
      const a = await forslag(orgA)
      await dryrun.bedöm(orgA, a.id)
      const rad = await prisma.aiAssignment.findUniqueOrThrow({ where: { id: a.id } })
      expect(rad.executionVerdict).toBe('NO_DELEGATION')
    })
  })

  describe('villkoret prövas mot FALLET, inte mot en förenkling', () => {
    it('en delegation avgränsad till FASTIGHETEN täcker ett förslag på en LÄGENHET i den', async () => {
      // Regressionen: en kontext byggd med `förifylltVillkor` hade utelämnat
      // `propertyId` när `unitId` finns, och den här delegationen hade då blivit
      // en icke-träff — alltså NO_DELEGATION om en rätt som faktiskt täcker.
      await delegation.skapa(
        orgA,
        { toolName: VERKTYG, villkor: { propertyId: propA } },
        agare(agareA),
      )
      const a = await forslag(orgA)
      await dryrun.bedöm(orgA, a.id)
      const rad = await prisma.aiAssignment.findUniqueOrThrow({ where: { id: a.id } })
      expect(rad.executionVerdict).toBe('WOULD_EXECUTE')
    })

    it('en delegation för en ANNAN kategori täcker inte fallet', async () => {
      await delegation.skapa(
        orgA,
        { toolName: VERKTYG, villkor: { kategori: 'ELECTRICAL' } },
        agare(agareA),
      )
      const a = await forslag(orgA)
      await dryrun.bedöm(orgA, a.id)
      const rad = await prisma.aiAssignment.findUniqueOrThrow({ where: { id: a.id } })
      expect(rad.executionVerdict).toBe('NO_DELEGATION')
    })
  })

  describe('domen skrivs EN gång', () => {
    it('ett andra pass rör inte en redan bedömd rad', async () => {
      await delegation.skapa(orgA, { toolName: VERKTYG }, agare(agareA))
      const a = await forslag(orgA)
      await dryrun.bedöm(orgA, a.id)
      const första = await prisma.aiAssignment.findUniqueOrThrow({ where: { id: a.id } })

      const r = await dryrun.bedöm(orgA, a.id)
      expect(r).toEqual({ utfall: 'REDAN_BEDÖMD' })
      const andra = await prisma.aiAssignment.findUniqueOrThrow({ where: { id: a.id } })
      expect(andra.verdictAt).toEqual(första.verdictAt)
    })

    it('EN ANNAN ORGANISATIONS uppdrag är osynligt, inte förbjudet', async () => {
      const a = await forslag(orgB, { unitId: null, propertyId: null })
      expect(await dryrun.bedöm(orgA, a.id)).toEqual({ utfall: 'SAKNAS' })
      const rad = await prisma.aiAssignment.findUniqueOrThrow({ where: { id: a.id } })
      expect(rad.executionVerdict).toBeNull()
    })
  })

  describe('frekvensvillkoret räknar torrläget som om det utförts', () => {
    it('taket biter på DOMAR, inte bara på verkliga körningar', async () => {
      // Utan det här är facit obrukbart: en delegation med tak 2 hade sagt
      // "hade utförts" om det tionde fallet, och hyresvärden hade fattat sitt
      // beslut på en siffra som inte gäller i skarpt läge.
      await delegation.skapa(
        orgA,
        { toolName: VERKTYG, frekvensvillkor: { maxAntal: 2, periodDagar: 30 } },
        agare(agareA),
      )
      const domar: Array<string | null> = []
      for (let i = 0; i < 3; i++) {
        const a = await forslag(orgA)
        await dryrun.bedöm(orgA, a.id)
        const rad = await prisma.aiAssignment.findUniqueOrThrow({ where: { id: a.id } })
        domar.push(rad.executionVerdict)
      }
      expect(domar).toEqual(['WOULD_EXECUTE', 'WOULD_EXECUTE', 'BLOCKED'])
    })

    it('och en dom UTANFÖR fönstret förbrukar ingenting', async () => {
      const d = await delegation.skapa(
        orgA,
        { toolName: VERKTYG, frekvensvillkor: { maxAntal: 1, periodDagar: 7 } },
        agare(agareA),
      )
      const gammal = await forslag(orgA)
      // En dom fälld för 30 dagar sedan ligger utanför ett sjudagarsfönster.
      await dryrun.bedöm(orgA, gammal.id, false, new Date(Date.now() - 30 * DAG))
      expect(
        (await prisma.aiAssignment.findUniqueOrThrow({ where: { id: gammal.id } }))
          .verdictDelegationId,
      ).toBe(d.id)

      const ny = await forslag(orgA)
      await dryrun.bedöm(orgA, ny.id)
      const rad = await prisma.aiAssignment.findUniqueOrThrow({ where: { id: ny.id } })
      expect(rad.executionVerdict).toBe('WOULD_EXECUTE')
    })
  })

  describe('"Skulle ha utlöst" räknar EXAKT de domar som är ja', () => {
    it('nej-domar pekar inte på delegationen och räknas därför inte', async () => {
      const d = await delegation.skapa(
        orgA,
        { toolName: VERKTYG, frekvensvillkor: { maxAntal: 1, periodDagar: 30 } },
        agare(agareA),
      )
      const a1 = await forslag(orgA)
      await dryrun.bedöm(orgA, a1.id)
      const a2 = await forslag(orgA)
      await dryrun.bedöm(orgA, a2.id) // BLOCKED — taket är förbrukat

      // Invarianten listan vilar på: `verdictDelegationId` sätts BARA vid ja.
      const pekare = await prisma.aiAssignment.count({ where: { verdictDelegationId: d.id } })
      expect(pekare).toBe(1)

      const lista = await delegation.lista(orgA)
      expect(lista[0]?.skulleHaUtlöst).toBe(1)
    })
  })
})
