/**
 * DELEGATIONSFÖRSLAGET — mot riktig Postgres.
 *
 * ── DEN KRITISKA GRÄNSEN ────────────────────────────────────────────────────
 *
 * Planens Del 6: *"Eveno får observera … Det får ALDRIG automatiskt bli 'agenten
 * får boka rörmokare upp till 2 000 kr'."* Proven mäter att tjänsten skriver ett
 * FÖRSLAG och aldrig en delegation — `AiDelegation` räknas före och efter varje
 * scenario och ska vara oförändrad.
 *
 * ── VAD SOM INTE GÅR ATT MOCKA ──────────────────────────────────────────────
 *
 * Idempotensen ligger i ett PARTIELLT unikt index. En attrapp hade returnerat
 * det provet matade in och aldrig avvisat en andra rad — och en tappad
 * `organizationId` i någon `where` hade lämnat provet grönt medan grannens
 * beslut födde förslag i din organisation.
 *
 * ── VAD DEN INTE MÄTER ──────────────────────────────────────────────────────
 *
 * Att sveparen ANROPAR tjänsten. Det ägs av `shadow-sweep.service.ts`, och den
 * kopplingen har inget prov här — ett grönt prov på tjänsten bevisar inte att
 * någon kör den.
 *
 * ── RIGGEN ÄGER SINA EGNA FÖRUTSÄTTNINGAR ───────────────────────────────────
 *
 * Två organisationer med var sin ägare. Städning i FK-riktning, prövad mot en
 * TOM databas och körd TVÅ gånger mot samma databas.
 */
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import {
  DELEGATIONSFORSLAG_TROSKEL,
  DELEGATIONSKALLA_MONSTER,
  DelegationProposalService,
} from './delegation-proposal.service'
import { ObservationService } from './observation.service'
import { DelegationService } from '../delegation/delegation.service'
import { SKUGGKALLA_FELANMALAN } from '../shadow/shadow-fields'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

/** Delegerbart och skuggdugligt. */
const VERKTYG = 'update_maintenance_status'
/** UTÅTRIKTAT — aldrig delegerbart, planens Del 6. */
const UTATRIKTAT = 'send_document_to_tenant'
const KATEGORI = 'PLUMBING'

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
  it('KANARIEFÅGEL: tröskeln är tre — talet står i provet, inte bara i prosan', () => {
    // Ändras konstanten ska scenarierna nedan bli röda tills de följt med.
    expect(DELEGATIONSFORSLAG_TROSKEL).toBe(3)
  })
})

medDb('delegationsförslaget', () => {
  let prisma: PrismaClient
  let tjanst: DelegationProposalService
  let delegation: DelegationService
  let orgA: string
  let orgB: string
  let userA: string
  let userB: string

  const beslut = (
    org: string,
    user: string,
    status: 'APPROVED' | 'REJECTED',
    verktyg = VERKTYG,
    typ = KATEGORI,
    när = new Date(),
  ) =>
    prisma.aiAssignment.create({
      data: {
        organizationId: org,
        kind: 'TOOL_PROPOSAL',
        shadow: true,
        sourceKind: SKUGGKALLA_FELANMALAN,
        sourceId: randomUUID(),
        toolName: verktyg,
        toolInput: {},
        title: 'F',
        reasoning: 'R',
        consequence: 'C',
        undoHint: 'U',
        prediction: { category: typ },
        deadline: new Date(Date.now() + 6e6),
        status,
        decidedAt: när,
        decidedByUserId: user,
      },
      select: { id: true },
    })

  const förslagen = (org: string) =>
    prisma.aiAssignment.findMany({
      where: { organizationId: org, kind: 'DELEGATION_PROPOSAL' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, sourceId: true, status: true, reasoning: true, shadow: true },
    })

  beforeAll(async () => {
    prisma = new PrismaClient()
    const obs = new ObservationService(prisma as never)
    tjanst = new DelegationProposalService(prisma as never, obs)
    delegation = new DelegationService(prisma as never, obs)

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
    const a = await bygg('fsA')
    const b = await bygg('fsB')
    orgA = a.org
    userA = a.user
    orgB = b.org
    userB = b.user
  }, 60_000)

  beforeEach(async () => {
    await prisma.aiAssignment.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
    await prisma.aiDelegation.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
  })

  afterAll(async () => {
    await prisma.aiAssignment.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
    await prisma.aiDelegation.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
    await prisma.user.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } })
    await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } })
    await prisma.$disconnect()
  })

  describe('SYSTEMET FÖRESLÅR, DET TAR SIG ALDRIG RÄTT', () => {
    it('inget scenario skapar en delegation', async () => {
      for (let i = 0; i < 5; i++) await beslut(orgA, userA, 'APPROVED')
      const före = await prisma.aiDelegation.count()
      await tjanst.prövaMönster(orgA, VERKTYG, KATEGORI)
      expect(await prisma.aiDelegation.count()).toBe(före)
      // …men ett FÖRSLAG skrevs, annars mäter provet att koden inte kördes.
      expect((await förslagen(orgA)).length).toBe(1)
    })

    it('förslaget är INTE `shadow` — ett ja på det skapar en rättighet', async () => {
      for (let i = 0; i < 3; i++) await beslut(orgA, userA, 'APPROVED')
      await tjanst.prövaMönster(orgA, VERKTYG, KATEGORI)
      expect((await förslagen(orgA))[0]?.shadow).toBe(false)
    })
  })

  describe('tröskeln', () => {
    it('TVÅ godkännanden → inget förslag', async () => {
      await beslut(orgA, userA, 'APPROVED')
      await beslut(orgA, userA, 'APPROVED')
      const r = await tjanst.prövaMönster(orgA, VERKTYG, KATEGORI)
      expect(r).toEqual({ utfall: 'FOR_FA', svit: 2 })
      expect(await förslagen(orgA)).toEqual([])
    })

    it('TRE → ETT förslag, med talet i texten', async () => {
      for (let i = 0; i < 3; i++) await beslut(orgA, userA, 'APPROVED')
      const r = await tjanst.prövaMönster(orgA, VERKTYG, KATEGORI)
      expect(r.utfall).toBe('SKAPAT')
      const f = await förslagen(orgA)
      expect(f).toHaveLength(1)
      expect(f[0]?.sourceId).toBe(`${VERKTYG}|${KATEGORI}|3`)
      expect(f[0]?.reasoning).toContain('3 gånger i rad')
    })

    it('SVEP IGEN → fortfarande ETT', async () => {
      for (let i = 0; i < 3; i++) await beslut(orgA, userA, 'APPROVED')
      await tjanst.prövaMönster(orgA, VERKTYG, KATEGORI)
      const r = await tjanst.prövaMönster(orgA, VERKTYG, KATEGORI)
      expect(r).toEqual({ utfall: 'REDAN_FINNS' })
      expect(await förslagen(orgA)).toHaveLength(1)
    })

    it('ETT AVSLAG BRYTER SVITEN — tre godkännanden med ett nej i mitten räcker inte', async () => {
      const t = Date.now()
      await beslut(orgA, userA, 'APPROVED', VERKTYG, KATEGORI, new Date(t - 4000))
      await beslut(orgA, userA, 'APPROVED', VERKTYG, KATEGORI, new Date(t - 3000))
      await beslut(orgA, userA, 'REJECTED', VERKTYG, KATEGORI, new Date(t - 2000))
      await beslut(orgA, userA, 'APPROVED', VERKTYG, KATEGORI, new Date(t - 1000))
      const r = await tjanst.prövaMönster(orgA, VERKTYG, KATEGORI)
      expect(r).toEqual({ utfall: 'FOR_FA', svit: 1 })
    })
  })

  describe('ett AVVISAT förslag återkommer först när mönstret vuxit', () => {
    it('avvisa + 3 nya godkännanden → ETT NYTT förslag, på nästa nivå', async () => {
      for (let i = 0; i < 3; i++) await beslut(orgA, userA, 'APPROVED')
      await tjanst.prövaMönster(orgA, VERKTYG, KATEGORI)
      const första = (await förslagen(orgA))[0]!
      await prisma.aiAssignment.update({
        where: { id: första.id },
        data: { status: 'REJECTED', decidedAt: new Date(), decidedByUserId: userA },
      })

      // INGET NYTT direkt efteråt: sviten är fortfarande 3, alltså samma nivå.
      expect((await tjanst.prövaMönster(orgA, VERKTYG, KATEGORI)).utfall).toBe('REDAN_FINNS')

      for (let i = 0; i < 3; i++) await beslut(orgA, userA, 'APPROVED')
      const r = await tjanst.prövaMönster(orgA, VERKTYG, KATEGORI)
      expect(r.utfall).toBe('SKAPAT')
      const alla = await förslagen(orgA)
      expect(alla).toHaveLength(2)
      expect(alla[1]?.sourceId).toBe(`${VERKTYG}|${KATEGORI}|6`)
    })

    it('och EN TILL räcker inte — nivån flyttas var tredje, inte varje', async () => {
      for (let i = 0; i < 3; i++) await beslut(orgA, userA, 'APPROVED')
      await tjanst.prövaMönster(orgA, VERKTYG, KATEGORI)
      const första = (await förslagen(orgA))[0]!
      await prisma.aiAssignment.update({
        where: { id: första.id },
        data: { status: 'REJECTED', decidedAt: new Date(), decidedByUserId: userA },
      })
      await beslut(orgA, userA, 'APPROVED')
      expect((await tjanst.prövaMönster(orgA, VERKTYG, KATEGORI)).utfall).toBe('REDAN_FINNS')
      expect(await förslagen(orgA)).toHaveLength(1)
    })
  })

  describe('ett ÖPPET förslag stoppar ett nytt — även på en HÖGRE nivå', () => {
    it('sviten växer till 6 medan förslaget på nivå 3 fortfarande väntar → inget nytt', async () => {
      // ── VARFÖR DEN HÄR GRENEN BEHÖVER ETT EGET PROV ────────────────────
      //
      // Det unika indexet fångar bara SAMMA nyckel. Växer sviten från 3 till 6
      // blir nyckeln en annan (`…|6`), och indexet släpper igenom — så utan
      // öppet-spärren hade hyresvärden fått ett andra kort om exakt samma sak
      // medan det första låg obesvarat.
      //
      // Uppmätt: med spärren urkopplad var hela sviten fortfarande grön. Den
      // var alltså djupförsvar utan bevis, vilket är samma sak som en vakt med
      // tom mängd. Det här provet är skillnaden.
      for (let i = 0; i < 3; i++) await beslut(orgA, userA, 'APPROVED')
      expect((await tjanst.prövaMönster(orgA, VERKTYG, KATEGORI)).utfall).toBe('SKAPAT')

      // Förslaget lämnas ÖPPET (AWAITING_APPROVAL) och sviten växer.
      for (let i = 0; i < 3; i++) await beslut(orgA, userA, 'APPROVED')
      const r = await tjanst.prövaMönster(orgA, VERKTYG, KATEGORI)
      expect(r).toEqual({ utfall: 'REDAN_FINNS' })
      expect(await förslagen(orgA)).toHaveLength(1)
    })
  })

  describe('spärrarna', () => {
    it('ett UTÅTRIKTAT verktyg med tio godkännanden → inget förslag', async () => {
      for (let i = 0; i < 10; i++) await beslut(orgA, userA, 'APPROVED', UTATRIKTAT)
      const r = await tjanst.prövaMönster(orgA, UTATRIKTAT, KATEGORI)
      expect(r.utfall).toBe('EJ_DELEGERBART')
      expect(await förslagen(orgA)).toEqual([])
    })

    it('en AKTIV delegation för verktyget → frågan är besvarad', async () => {
      for (let i = 0; i < 3; i++) await beslut(orgA, userA, 'APPROVED')
      await delegation.skapa(orgA, { toolName: VERKTYG }, { userId: userA, roll: 'OWNER' })
      const r = await tjanst.prövaMönster(orgA, VERKTYG, KATEGORI)
      expect(r).toEqual({ utfall: 'REDAN_DELEGERAT' })
      expect(await förslagen(orgA)).toEqual([])
    })

    it('EN ANNAN ORGANISATIONS godkännanden räknas inte', async () => {
      for (let i = 0; i < 5; i++) await beslut(orgB, userB, 'APPROVED')
      const r = await tjanst.prövaMönster(orgA, VERKTYG, KATEGORI)
      expect(r).toEqual({ utfall: 'FOR_FA', svit: 0 })
      expect(await förslagen(orgA)).toEqual([])
    })

    it('en ANNAN TYP räknas inte in i mönstret', async () => {
      for (let i = 0; i < 2; i++) await beslut(orgA, userA, 'APPROVED')
      await beslut(orgA, userA, 'APPROVED', VERKTYG, 'ELECTRICAL')
      expect((await tjanst.prövaMönster(orgA, VERKTYG, KATEGORI)).utfall).toBe('FOR_FA')
    })

    it('källmärkningen skiljer ett mönsterfött förslag från ett ärendefött', async () => {
      for (let i = 0; i < 3; i++) await beslut(orgA, userA, 'APPROVED')
      await tjanst.prövaMönster(orgA, VERKTYG, KATEGORI)
      const rad = await prisma.aiAssignment.findFirstOrThrow({
        where: { organizationId: orgA, kind: 'DELEGATION_PROPOSAL' },
        select: { sourceKind: true },
      })
      expect(rad.sourceKind).toBe(DELEGATIONSKALLA_MONSTER)
    })
  })
})
