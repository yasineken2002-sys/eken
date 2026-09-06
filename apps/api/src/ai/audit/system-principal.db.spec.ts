/**
 * AKTÖRSMODELLEN — EN AGENT SKRIVER UTAN ATT LÅTSAS VARA EN MÄNNISKA.
 *
 * Planens Del 5, ordagrant: *"En skrivning ska inte kunna representeras som
 * gjord av en agent utan att det samtidigt går att uttrycka varför agenten hade
 * rätt att göra den."* Den här specen mäter båda halvorna på en riktig databas:
 *
 *   VEM        `userId` är NULL, och `actorKind` är AGENT — stämplad av
 *              Prisma-extensionen, inte satt för hand i provet.
 *   MED VILKEN RÄTT  `authorityKind = DELEGATION` och `delegationId` pekar på
 *              den rätt hyresvärden gav.
 *
 * ── VAD SOM INTE GÅR ATT MOCKA ──────────────────────────────────────────────
 *
 * `actorKind` sätts av `ai-effect-extension` när skrivningen sker inne i
 * `runAsAi`. En attrapp hade returnerat det provet matade in, och stämplingen
 * hade varit oprövad — vilket är hela skillnaden mellan "vi skickar rätt värde"
 * och "vägen sätter det".
 *
 * ── VAD DEN INTE MÄTER ──────────────────────────────────────────────────────
 *
 * Att någon i SKARPT LÄGE anropar den här vägen. Det finns ingen sådan anropare
 * — utföraren är etapp 9 — och `check-assignment-status-writers.mjs` bevisar
 * åt andra hållet att de tre utförandestatusarna inte kan uppstå i drift ännu.
 * Provet mäter att modellen HÅLLER, inte att den används.
 *
 * ── RIGGEN ÄGER SINA EGNA FÖRUTSÄTTNINGAR ───────────────────────────────────
 *
 * Egen organisation, egen ägare, egen delegation. Städning i FK-riktning,
 * prövad mot en TOM databas och körd TVÅ gånger mot samma databas.
 */
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { ForbiddenException } from '@nestjs/common'

import { PrismaService } from '../../common/prisma/prisma.service'
import { PropertiesService } from '../../properties/properties.service'
import { AiAuditService } from './ai-audit.service'
import { DelegationService } from '../delegation/delegation.service'
import { ToolExecutorService } from '../tools/tool-executor.service'

import type { AiPrincipal } from '../../common/ai-origin/ai-origin.context'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

/** Ett av de FEM: delegerbart OCH uppdragsdugligt, och rör ingen människa. */
const VERKTYG = 'create_property'
/** Delegerbart men DEDUPLICERBAR — får inte köras obevakat. Se de fem/åtta. */
const EJ_OBEVAKAT = 'create_invoice'

const SPAR_DEADLINE_MS = 8_000

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('en SYSTEM-principal på en delegation', () => {
  let prisma: PrismaService
  let executor: ToolExecutorService
  let delegation: DelegationService
  let orgId: string
  let userId: string
  let delegationId: string

  const indata = () => ({
    name: `Torget ${randomUUID().slice(0, 6)}`,
    propertyDesignation: `T ${randomUUID().slice(0, 6)}`,
    type: 'RESIDENTIAL',
    street: 'Storgatan 1',
    city: 'Ort',
    postalCode: '11111',
  })

  /** Spåret skrivs `void`:at — se effect-trace-production-path.db.spec.ts. */
  const väntaPåSpår = async (före: number) => {
    const slut = Date.now() + SPAR_DEADLINE_MS
    for (;;) {
      const rader = await prisma.aiToolExecution.findMany({
        where: { organizationId: orgId },
        orderBy: { createdAt: 'desc' },
      })
      if (rader.length > före) return rader[0]!
      if (Date.now() > slut) throw new Error('spåret skrevs aldrig')
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  beforeAll(async () => {
    prisma = new PrismaService()
    const audit = new AiAuditService(prisma)
    const propertiesService = new PropertiesService(prisma)
    executor = Object.create(ToolExecutorService.prototype) as ToolExecutorService
    Object.assign(executor, { prisma, audit, propertiesService })
    delegation = new DelegationService(prisma as never)

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `sys-${sfx}`,
        email: `sys-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
      select: { id: true },
    })
    orgId = org.id
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `sys-${sfx}@example.se`,
        passwordHash: 'x',
        firstName: 'Ada',
        lastName: 'Ek',
        role: 'OWNER',
      },
      select: { id: true },
    })
    userId = user.id
    const d = await delegation.skapa(orgId, { toolName: VERKTYG }, { userId, roll: 'OWNER' })
    delegationId = d.id
  }, 60_000)

  afterAll(async () => {
    await prisma.aiToolEffect.deleteMany({
      where: { execution: { organizationId: orgId } },
    })
    await prisma.aiToolExecution.deleteMany({ where: { organizationId: orgId } })
    await prisma.unit.deleteMany({ where: { property: { organizationId: orgId } } })
    await prisma.property.deleteMany({ where: { organizationId: orgId } })
    await prisma.aiDelegation.deleteMany({ where: { organizationId: orgId } })
    await prisma.user.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  const systemPrincipal = (): AiPrincipal => ({
    kind: 'SYSTEM',
    organizationId: orgId,
    origin: 'delegation',
    delegationId,
  })

  it('utför ett av de fem och skriver ett spår UTAN människa', async () => {
    const svar = await delegation.assertDelegated(orgId, VERKTYG)
    expect(svar.delegerad).toBe(true)

    const före = await prisma.aiToolExecution.count({ where: { organizationId: orgId } })
    const r = await executor.executeTool(VERKTYG, indata(), orgId, systemPrincipal(), 'OWNER', {
      actionProof: { delegated: true, delegationId },
    })
    expect(r.success).toBe(true)

    const spår = await väntaPåSpår(före)
    // VEM: ingen människa. Att `userId` är NULL är inte en lucka — det är
    // påståendet. En agent som skriver med ägarens id säger att ägaren gjorde
    // något hen inte gjorde.
    expect(spår.userId).toBeNull()
    // MED VILKEN RÄTT: delegationen, utpekad.
    expect(spår.authorityKind).toBe('DELEGATION')
    expect(spår.delegationId).toBe(delegationId)
  })

  it('EFFEKTEN stämplas AGENT av extensionen, inte av provet', async () => {
    const före = await prisma.aiToolExecution.count({ where: { organizationId: orgId } })
    const data = indata()
    await executor.executeTool(VERKTYG, data, orgId, systemPrincipal(), 'OWNER', {
      actionProof: { delegated: true, delegationId },
    })
    await väntaPåSpår(före)

    const skapad = await prisma.property.findFirstOrThrow({
      where: { organizationId: orgId, name: data.name },
      select: { actorKind: true },
    })
    // Extensionen ser skrivningen inne i `runAsAi` och sätter AGENT. Provet rör
    // aldrig fältet — hade det gjort det mätte det sig självt.
    expect(skapad.actorKind).toBe('AGENT')
    // `Property` bär BARA `actorKind`, inte något `actorUserId` — modellen har
    // inget fält där en människa kan tillskrivas, och det är rätt: raden säger
    // VEM SORTS aktör som skrev, och spårets `userId` säger vilken människa
    // (här: ingen). Att kolla ett fält som inte finns hade varit ett prov på
    // schemat, inte på stämplingen.
  })

  it('MÄNNISKANS väg är oförändrad: APPROVAL och ett userId', async () => {
    const före = await prisma.aiToolExecution.count({ where: { organizationId: orgId } })
    await executor.executeTool(VERKTYG, indata(), orgId, { kind: 'USER', id: userId }, 'OWNER', {
      actionProof: { claimed: true },
    })
    const spår = await väntaPåSpår(före)
    expect(spår.userId).toBe(userId)
    expect(spår.authorityKind).toBe('APPROVAL')
    expect(spår.delegationId).toBeNull()
  })

  describe('grinderna', () => {
    it('UTAN bevis avvisas den bindande åtgärden — som förut', async () => {
      await expect(
        executor.executeTool(VERKTYG, indata(), orgId, systemPrincipal(), 'OWNER'),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })

    it('ett delegationsbevis räcker INTE för ett DEDUPLICERBART verktyg', async () => {
      // Mängden är FEM, inte åtta: delegationen ger rätten, men ett verktyg vars
      // omkörning kan ge en andra effekt får inte köras utan att en människa ser
      // varje gång. Skillnaden är avsiktlig — se action-authorization.ts.
      await expect(
        executor.executeTool(
          EJ_OBEVAKAT,
          {},
          orgId,
          { kind: 'SYSTEM', organizationId: orgId, origin: 'delegation', delegationId },
          'OWNER',
          { actionProof: { delegated: true, delegationId } },
        ),
      ).rejects.toThrow(/kan inte utföras på en delegation/)
    })

    it('UTAN delegation svarar grinden nej, med skäl', async () => {
      const svar = await delegation.assertDelegated(orgId, 'create_unit')
      expect(svar.delegerad).toBe(false)
      if (!svar.delegerad) expect(svar.skäl).toBe('INGEN_DELEGATION')
    })

    it('en SYSTEM-principal UTAN delegationId kan inte ens starta en körning', async () => {
      await expect(
        executor.executeTool(
          VERKTYG,
          indata(),
          orgId,
          { kind: 'SYSTEM', organizationId: orgId, origin: 'delegation', delegationId: '' },
          'OWNER',
          { actionProof: { delegated: true, delegationId } },
        ),
      ).rejects.toThrow(/utan delegationId/)
    })

    it('en SYSTEM-principal UTAN organizationId avvisas också', async () => {
      await expect(
        executor.executeTool(
          VERKTYG,
          indata(),
          orgId,
          { kind: 'SYSTEM', organizationId: '', origin: 'delegation', delegationId },
          'OWNER',
          { actionProof: { delegated: true, delegationId } },
        ),
      ).rejects.toThrow(/utan organizationId/)
    })
  })
})
