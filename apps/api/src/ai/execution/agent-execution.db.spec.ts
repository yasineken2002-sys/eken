/**
 * SKARPT LÄGE MOT EN RIKTIG DATABAS.
 *
 * Det här är första gången en maskin skriver i kundens data utan att en människa
 * säger ja just då. Provet mäter de sex fallen som avgör om det är säkert, och
 * VARJE gren har en negativkontroll: en mätning som bara visar det önskade
 * utfallet skiljer inte "grinden höll" från "ingenting kördes".
 *
 * ── VARFÖR INGET AV DET HÄR GÅR ATT MOCKA ───────────────────────────────────
 *
 * Tre av mekanismerna finns bara i databasen:
 *
 *   ANSPRÅKET      `updateMany ... where executionStartedAt: null` — vem som
 *                  vinner en kapplöpning avgörs av Postgres. En attrapp
 *                  returnerar det den blev tillsagd, oavsett `where`, och hade
 *                  varit grön även om villkoret tappats.
 *   STÄMPLINGEN    `actorKind = AGENT` sätts av Prisma-extensionen inne i
 *                  `runAsAi`. En attrapp har ingen extension.
 *   EFFEKTRÄKNINGEN  "noll effekter" mäts genom att räkna RADER i domäntabellen
 *                  före och efter. Utan en riktig tabell finns inget att räkna.
 *
 * ── RIGGEN ÄGER SINA EGNA FÖRUTSÄTTNINGAR ───────────────────────────────────
 *
 * Egen organisation, egen ägare, egna delegationer, och en ANDRA organisation
 * för isoleringsprovet. Städning i FK-riktning. Prövad mot en TOM databas och
 * körd TVÅ gånger mot samma databas.
 */
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { Prisma } from '@prisma/client'

import { PrismaService } from '../../common/prisma/prisma.service'
import { PropertiesService } from '../../properties/properties.service'
import { AiAuditService } from '../audit/ai-audit.service'
import { ObservationService } from '../observation/observation.service'
import { DelegationService } from '../delegation/delegation.service'
import { ToolExecutorService } from '../tools/tool-executor.service'
import { AiAgentExecutionService, DOTT_ANSPRAK_MS } from './agent-execution.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

/** Ett av de FEM: delegerbart OCH uppdragsdugligt, och rör ingen människa. */
const VERKTYG = 'create_property'

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('skarpt läge', () => {
  let prisma: PrismaService
  let execution: AiAgentExecutionService
  let delegation: DelegationService
  let orgId: string
  let annanOrgId: string
  let userId: string
  let annanUserId: string

  const indata = () => ({
    name: `Torget ${randomUUID().slice(0, 8)}`,
    propertyDesignation: `T ${randomUUID().slice(0, 8)}`,
    type: 'RESIDENTIAL',
    street: 'Storgatan 1',
    city: 'Ort',
    postalCode: '11111',
  })

  /** Ett skuggförslag med domen WOULD_EXECUTE — utgångsläget för varje prov. */
  const skapaUppdrag = async (opts: {
    organizationId: string
    delegationId: string
    toolName?: string
    toolInput?: Prisma.InputJsonObject
  }) =>
    prisma.aiAssignment.create({
      data: {
        organizationId: opts.organizationId,
        toolName: opts.toolName ?? VERKTYG,
        toolInput: opts.toolInput ?? indata(),
        title: 'Lägg upp fastigheten',
        reasoning: 'Den saknas i registret.',
        consequence: 'En ny fastighet skapas.',
        undoHint: 'Går att ta bort.',
        deadline: new Date(Date.now() + 3 * 24 * 3600_000),
        shadow: true,
        executionVerdict: 'WOULD_EXECUTE',
        verdictAt: new Date(),
        verdictDelegationId: opts.delegationId,
      },
      select: { id: true },
    })

  const antalFastigheter = (org: string) =>
    prisma.property.count({ where: { organizationId: org } })
  const antalSpår = (org: string) =>
    prisma.aiToolExecution.count({ where: { organizationId: org } })

  const sättVäxel = (org: string, skugga: boolean, skarpt: boolean) =>
    prisma.organization.update({
      where: { id: org },
      data: { shadowAgentEnabled: skugga, agentExecutionEnabled: skarpt },
    })

  beforeAll(async () => {
    prisma = new PrismaService()
    const audit = new AiAuditService(prisma)
    const propertiesService = new PropertiesService(prisma)
    const executor = Object.create(ToolExecutorService.prototype) as ToolExecutorService
    Object.assign(executor, { prisma, audit, propertiesService })
    delegation = new DelegationService(prisma as never, new ObservationService(prisma as never))
    execution = new AiAgentExecutionService(prisma, delegation, executor)

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `exec-${sfx}`,
        email: `exec-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
      select: { id: true },
    })
    orgId = org.id
    const annan = await prisma.organization.create({
      data: {
        name: `annan-${sfx}`,
        email: `annan-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
      select: { id: true },
    })
    annanOrgId = annan.id
    const annanUser = await prisma.user.create({
      data: {
        organizationId: annanOrgId,
        email: `annan-${sfx}@example.se`,
        passwordHash: 'x',
        firstName: 'Bo',
        lastName: 'Ek',
        role: 'OWNER',
      },
      select: { id: true },
    })
    annanUserId = annanUser.id
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `exec-${sfx}@example.se`,
        passwordHash: 'x',
        firstName: 'Ada',
        lastName: 'Ek',
        role: 'OWNER',
      },
      select: { id: true },
    })
    userId = user.id
  }, 60_000)

  afterAll(async () => {
    // FK-RIKTNING. `AiAssignmentEvent` → `AiAssignment` → `AiDelegation`.
    for (const org of [orgId, annanOrgId]) {
      await prisma.aiAssignmentEvent.deleteMany({ where: { assignment: { organizationId: org } } })
      await prisma.aiToolEffect.deleteMany({ where: { execution: { organizationId: org } } })
      await prisma.aiToolExecution.deleteMany({ where: { organizationId: org } })
      await prisma.aiAssignment.deleteMany({ where: { organizationId: org } })
      await prisma.aiDelegationEvent.deleteMany({
        where: { delegation: { organizationId: org } },
      })
      await prisma.aiDelegation.deleteMany({ where: { organizationId: org } })
      await prisma.property.deleteMany({ where: { organizationId: org } })
      await prisma.user.deleteMany({ where: { organizationId: org } })
      await prisma.organization.deleteMany({ where: { id: org } })
    }
    await prisma.$disconnect()
  })

  /**
   * Delegationen skapas via PRODUKTIONSVÄGEN (`delegation.skapa`), inte med ett
   * handbyggt `create`. En handbyggd rad hade behövt `authorityScope` och
   * `expiresAt` satta av provet — alltså två fält som tjänsten härleder, och som
   * provet då hade mätt sin egen gissning av.
   */
  /**
   * ── EXAKT EN AKTIV DELEGATION FÖR VERKTYGET ───────────────────────────────
   *
   * `assertDelegated` svarar med den FÖRSTA aktiva delegation som matchar, och
   * vilken det blir när flera finns är inte definierat. Varje prov i sviten
   * skapar en egen, så efter ett par prov har organisationen flera aktiva — och
   * ett prov som påstår "spåret pekar på DEN HÄR delegationen" mäter då
   * turordningen, inte tjänsten.
   *
   * Uppmätt: provet nedan föll med ett delegations-id från ett tidigare prov,
   * och båda raderna var i sig korrekta. Det var provets antagande som var fel.
   *
   * De gamla återkallas därför först. Att de måste återkallas — och inte bara
   * ignoreras — är också ett belägg: hade tjänsten valt "den nyaste" hade det
   * här steget inte behövts, och det gör den inte.
   */
  const enbartEnDelegation = async (org: string) => {
    // BARA de som inte redan är återkallade — `återkalla` kastar `Conflict` på
    // en som är det, och en try/catch här hade dolt riktiga fel lika tyst.
    const gamla = await prisma.aiDelegation.findMany({
      where: { organizationId: org, toolName: VERKTYG, events: { none: { type: 'REVOKED' } } },
      select: { id: true },
    })
    for (const g of gamla) {
      await delegation.återkalla(
        org,
        g.id,
        { userId: org === orgId ? userId : annanUserId, roll: 'OWNER' },
        'Rensar inför provet',
      )
    }
    return nyDelegation(org)
  }

  const nyDelegation = async (
    org: string,
    toolName: string = VERKTYG,
    frekvensvillkor?: { maxAntal: number; periodDagar: number },
  ) =>
    (
      await delegation.skapa(
        org,
        { toolName, ...(frekvensvillkor ? { frekvensvillkor } : {}) },
        { userId: org === orgId ? userId : annanUserId, roll: 'OWNER' },
      )
    ).id

  // ── 1. VÄXELN AV ────────────────────────────────────────────────────────
  it('växel AV: domen står kvar och INGENTING utförs', async () => {
    const d = await nyDelegation(orgId)
    await sättVäxel(orgId, true, false)
    const u = await skapaUppdrag({ organizationId: orgId, delegationId: d })

    const fastigheterFöre = await antalFastigheter(orgId)
    const spårFöre = await antalSpår(orgId)
    const r = await execution.utför(orgId, u.id)

    expect(r.utfall).toBe('VÄXEL_AV')
    expect(await antalFastigheter(orgId)).toBe(fastigheterFöre)
    expect(await antalSpår(orgId)).toBe(spårFöre)
    const efter = await prisma.aiAssignment.findUniqueOrThrow({ where: { id: u.id } })
    // DOMEN ÄR ORÖRD: en avstängd växel är inte ett nej till delegationen.
    expect(efter.executionVerdict).toBe('WOULD_EXECUTE')
    expect(efter.status).toBe('AWAITING_APPROVAL')
    // ANSPRÅKET TOGS INTE. Grinden ligger FÖRE, så en avstängd organisation
    // lämnar inga spår alls — inte ens ett halvtaget uppdrag.
    expect(efter.executionStartedAt).toBeNull()
  })

  // NEGATIVKONTROLL till provet ovan: samma uppdrag, växeln PÅ, ska utföras.
  // Utan den kan "ingenting hände" inte skiljas från "riggen kan inte utföra".
  it('NEGATIVKONTROLL: samma uppdrag med växeln PÅ utförs', async () => {
    const d = await nyDelegation(orgId)
    await sättVäxel(orgId, true, false)
    const u = await skapaUppdrag({ organizationId: orgId, delegationId: d })
    expect((await execution.utför(orgId, u.id)).utfall).toBe('VÄXEL_AV')

    await sättVäxel(orgId, true, true)
    const före = await antalFastigheter(orgId)
    const r = await execution.utför(orgId, u.id)
    expect(r.utfall).toBe('UTFÖRD')
    expect(await antalFastigheter(orgId)).toBe(före + 1)
  }, 30_000)

  // ── 1b. SKUGGAN AV RÄCKER OCKSÅ ────────────────────────────────────────
  it('skuggan AV men skarpt PÅ: ingenting utförs — båda krävs', async () => {
    const d = await nyDelegation(orgId)
    await sättVäxel(orgId, false, true)
    const u = await skapaUppdrag({ organizationId: orgId, delegationId: d })
    const före = await antalFastigheter(orgId)
    expect((await execution.utför(orgId, u.id)).utfall).toBe('VÄXEL_AV')
    expect(await antalFastigheter(orgId)).toBe(före)
    await sättVäxel(orgId, true, true)
  })

  // ── 2. EN EFFEKT, ETT SPÅR, RÄTT RÄTT ──────────────────────────────────
  it('växel PÅ + giltig delegation: EN effekt, ETT spår med DELEGATION', async () => {
    const d = await enbartEnDelegation(orgId)
    await sättVäxel(orgId, true, true)
    const data = indata()
    const u = await skapaUppdrag({ organizationId: orgId, delegationId: d, toolInput: data })

    const fastigheterFöre = await antalFastigheter(orgId)
    const r = await execution.utför(orgId, u.id)
    expect(r.utfall).toBe('UTFÖRD')

    // EXAKT EN ny fastighet.
    expect(await antalFastigheter(orgId)).toBe(fastigheterFöre + 1)

    // SPÅRET: ingen människa, rätten utpekad.
    // AVGRÄNSAT PÅ DELEGATIONEN. Utan det plockar frågan upp spåret från ett
    // TIDIGARE prov i samma organisation — vilket den gjorde, och som avslöjade
    // att tjänsten hade samma fel. Se `slåUppSpår`.
    const spår = await prisma.aiToolExecution.findFirst({
      where: { organizationId: orgId, toolName: VERKTYG, delegationId: d },
      orderBy: { createdAt: 'desc' },
    })
    expect(spår).not.toBeNull()
    // …och uppdraget pekar på SAMMA rad. Ett spår som finns men inte är det
    // uppdraget pekar på är precis den defekt provet en gång fällde.
    expect(r.utfall === 'UTFÖRD' && r.aiToolExecutionId).toBe(spår!.id)
    expect(spår!.userId).toBeNull()
    expect(spår!.authorityKind).toBe('DELEGATION')
    expect(spår!.delegationId).toBe(d)

    // STÄMPELN sätts av extensionen, inte av provet.
    const skapad = await prisma.property.findFirstOrThrow({
      where: { organizationId: orgId, name: data.name },
      select: { actorKind: true },
    })
    expect(skapad.actorKind).toBe('AGENT')

    const efter = await prisma.aiAssignment.findUniqueOrThrow({ where: { id: u.id } })
    expect(efter.status).toBe('EXECUTED')
    expect(efter.authorityKind).toBe('DELEGATION')
    expect(efter.delegationId).toBe(d)
    expect(efter.executionStartedAt).not.toBeNull()
  }, 30_000)

  // ── 3. G0: SAMMA UPPDRAG TVÅ GÅNGER ────────────────────────────────────
  it('samma uppdrag två gånger ger EN effekt', async () => {
    const d = await nyDelegation(orgId)
    await sättVäxel(orgId, true, true)
    const u = await skapaUppdrag({ organizationId: orgId, delegationId: d })

    const före = await antalFastigheter(orgId)
    const a = await execution.utför(orgId, u.id)
    const b = await execution.utför(orgId, u.id)

    expect(a.utfall).toBe('UTFÖRD')
    expect(b.utfall).toBe('REDAN_HANTERAD')
    expect(await antalFastigheter(orgId)).toBe(före + 1)
  }, 30_000)

  it('SAMTIDIGT: två parallella körningar ger EN effekt', async () => {
    // ANSPRÅKET, inte statusen, är det som bär det här. Två sekventiella anrop
    // stoppas av terminalstatusen; två SAMTIDIGA hinner läsa samma status, och
    // då är `updateMany ... executionStartedAt: null` det enda som skiljer dem.
    const d = await nyDelegation(orgId)
    await sättVäxel(orgId, true, true)
    const u = await skapaUppdrag({ organizationId: orgId, delegationId: d })

    const före = await antalFastigheter(orgId)
    const [a, b] = await Promise.all([execution.utför(orgId, u.id), execution.utför(orgId, u.id)])
    const utfall = [a.utfall, b.utfall].sort()
    expect(utfall).toEqual(['REDAN_HANTERAD', 'UTFÖRD'])
    expect(await antalFastigheter(orgId)).toBe(före + 1)
  }, 30_000)

  // NEGATIVKONTROLL: TVÅ OLIKA uppdrag ger TVÅ effekter. Utan den kan "en
  // effekt" inte skiljas från "utföraren kör aldrig mer än en gång alls".
  it('NEGATIVKONTROLL: två OLIKA uppdrag ger TVÅ effekter', async () => {
    const d = await nyDelegation(orgId)
    await sättVäxel(orgId, true, true)
    const u1 = await skapaUppdrag({ organizationId: orgId, delegationId: d })
    const u2 = await skapaUppdrag({ organizationId: orgId, delegationId: d })

    const före = await antalFastigheter(orgId)
    expect((await execution.utför(orgId, u1.id)).utfall).toBe('UTFÖRD')
    expect((await execution.utför(orgId, u2.id)).utfall).toBe('UTFÖRD')
    expect(await antalFastigheter(orgId)).toBe(före + 2)
  }, 30_000)

  // ── 4. ÅTERKALLAD MELLAN DOM OCH UTFÖRANDE ─────────────────────────────
  it('delegation återkallad efter domen: LAPSED och NOLL effekt', async () => {
    const d = await nyDelegation(orgId)
    await sättVäxel(orgId, true, true)
    const u = await skapaUppdrag({ organizationId: orgId, delegationId: d })

    // DOMEN ÄR FÄLLD, och FÖRST därefter försvinner rätten. Det är hela poängen
    // med omprövningen: en dom från i går är inte en rätt i dag.
    //
    // ALLA delegationer för verktyget återkallas, inte bara `d`. Varje prov i
    // sviten skapar en egen, och `assertDelegated` frågar efter NÅGON aktiv —
    // att bara återkalla en hade lämnat de övriga kvar och gjort provet grönt
    // av fel skäl. (Det var precis vad som hände i första körningen.)
    const alla = await prisma.aiDelegation.findMany({
      where: { organizationId: orgId, toolName: VERKTYG, events: { none: { type: 'REVOKED' } } },
      select: { id: true },
    })
    for (const x of alla) {
      await delegation.återkalla(orgId, x.id, { userId, roll: 'OWNER' }, 'Ändrade mig')
    }

    const före = await antalFastigheter(orgId)
    const r = await execution.utför(orgId, u.id)
    expect(r.utfall).toBe('FÖRFALLEN')
    expect(await antalFastigheter(orgId)).toBe(före)

    const efter = await prisma.aiAssignment.findUniqueOrThrow({ where: { id: u.id } })
    expect(efter.status).toBe('LAPSED')
    // PLANENS DEL 12: säg vad du SKULLE ha gjort. En tom `statusReason` hade
    // varit ett tyst förfall.
    expect(efter.statusReason).toContain('Skulle ha utfört')
    expect(efter.statusReason).toContain(VERKTYG)
  }, 30_000)

  // NEGATIVKONTROLL: en delegation som INTE återkallats ger UTFÖRD på exakt
  // samma väg. Utan den kan LAPSED bero på riggen och inte på återkallelsen.
  it('NEGATIVKONTROLL: utan återkallelse blir samma uppställning UTFÖRD', async () => {
    const d = await nyDelegation(orgId)
    await sättVäxel(orgId, true, true)
    const u = await skapaUppdrag({ organizationId: orgId, delegationId: d })
    const före = await antalFastigheter(orgId)
    expect((await execution.utför(orgId, u.id)).utfall).toBe('UTFÖRD')
    expect(await antalFastigheter(orgId)).toBe(före + 1)
  }, 30_000)

  // ── 5. VERKTYGSFEL ─────────────────────────────────────────────────────
  it('verktygsfel: FAILED med felets text, och delegationen är ORÖRD', async () => {
    const d = await nyDelegation(orgId)
    await sättVäxel(orgId, true, true)
    // TOM INDATA fäller verktygets egen validering. Felet kommer alltså ur
    // produktionsvägen och inte ur en injicerad kastare — en stubb hade prövat
    // stubben.
    const u = await skapaUppdrag({ organizationId: orgId, delegationId: d, toolInput: {} })

    const före = await antalFastigheter(orgId)
    const r = await execution.utför(orgId, u.id)
    expect(r.utfall).toBe('MISSLYCKADES')
    expect(await antalFastigheter(orgId)).toBe(före)

    const efter = await prisma.aiAssignment.findUniqueOrThrow({ where: { id: u.id } })
    expect(efter.status).toBe('FAILED')
    expect(efter.statusReason).toBeTruthy()

    // DELEGATIONEN ÄR ORÖRD: ett verktygsfel säger något om körningen, inte om
    // rätten. Att pausa den hade straffat hyresvärden för ett buggigt verktyg.
    const svar = await delegation.assertDelegated(orgId, VERKTYG)
    expect(svar.delegerad).toBe(true)
  }, 30_000)

  // ── 6. ANNAN ORGANISATION ──────────────────────────────────────────────
  it('ett uppdrag i en ANNAN organisation rörs inte', async () => {
    // EGEN ÄGARE i den andra organisationen — ingen människa lånas över
    // gränsen, vilket hade varit precis den läcka provet ska mäta frånvaron av.
    const d = await nyDelegation(annanOrgId)
    await sättVäxel(annanOrgId, true, true)
    await sättVäxel(orgId, true, true)
    const u = await skapaUppdrag({ organizationId: annanOrgId, delegationId: d })

    const före = await antalFastigheter(annanOrgId)
    // FRÅGAN STÄLLS MED FEL ORG — precis det en läcka mellan kunder ser ut som.
    const r = await execution.utför(orgId, u.id)
    expect(r.utfall).toBe('SAKNAS')
    expect(await antalFastigheter(annanOrgId)).toBe(före)
    const efter = await prisma.aiAssignment.findUniqueOrThrow({ where: { id: u.id } })
    expect(efter.status).toBe('AWAITING_APPROVAL')
    expect(efter.executionStartedAt).toBeNull()
  }, 30_000)

  // NEGATIVKONTROLL: med RÄTT organisation utförs samma uppdrag. Annars mäter
  // provet ovan bara att riggen inte kan utföra i den andra organisationen.
  it('NEGATIVKONTROLL: med RÄTT organisation utförs det', async () => {
    const d = await nyDelegation(annanOrgId)
    await sättVäxel(annanOrgId, true, true)
    const u = await skapaUppdrag({ organizationId: annanOrgId, delegationId: d })
    const före = await antalFastigheter(annanOrgId)
    expect((await execution.utför(annanOrgId, u.id)).utfall).toBe('UTFÖRD')
    expect(await antalFastigheter(annanOrgId)).toBe(före + 1)
  }, 30_000)

  // ── REAPERN: ETT ANSPRÅK UTAN UTFALL ───────────────────────────────────
  //
  // Den här grenen fanns inte förrän en säkerhetsgranskning påpekade att en
  // körning som dör mellan anspråket och terminalstatusen fastnar för alltid:
  // sveparpasset frågar efter `executionStartedAt: null` och hittar den aldrig
  // igen, "Gjort" visar den inte, och inget larmar. Provet är beviset för att
  // luckan är stängd.
  describe('reapern', () => {
    it('stänger ett anspråk utan utfall som är ÄLDRE än gränsen', async () => {
      const d = await nyDelegation(orgId)
      await sättVäxel(orgId, true, true)
      const u = await skapaUppdrag({ organizationId: orgId, delegationId: d })
      // SIMULERAR EN DÖD KÖRNING: anspråket taget, ingen terminalstatus.
      // Tidsstämpeln sätts BAKÅT i stället för att provet väntar fem minuter.
      await prisma.aiAssignment.update({
        where: { id: u.id },
        data: { executionStartedAt: new Date(Date.now() - DOTT_ANSPRAK_MS - 60_000) },
      })

      const stängda = await execution.stängDöda(new Date())
      expect(stängda).toBeGreaterThanOrEqual(1)

      const efter = await prisma.aiAssignment.findUniqueOrThrow({ where: { id: u.id } })
      // FAILED och inte LAPSED: vi VET inte att ingenting utfördes — körningen
      // kan ha hunnit orsaka effekten innan processen dog. Texten säger det.
      expect(efter.status).toBe('FAILED')
      expect(efter.statusReason).toContain('avbröts oväntat')
      expect(efter.statusReason).toContain('kontrollera')
    }, 30_000)

    // NEGATIVKONTROLL 1: ett FÄRSKT anspråk får INTE stängas. Utan den kan
    // reapern vara "stänger allt den ser", vilket hade dödat levande körningar.
    it('NEGATIVKONTROLL: ett FÄRSKT anspråk rörs inte', async () => {
      const d = await nyDelegation(orgId)
      await sättVäxel(orgId, true, true)
      const u = await skapaUppdrag({ organizationId: orgId, delegationId: d })
      await prisma.aiAssignment.update({
        where: { id: u.id },
        data: { executionStartedAt: new Date() },
      })

      await execution.stängDöda(new Date())
      const efter = await prisma.aiAssignment.findUniqueOrThrow({ where: { id: u.id } })
      expect(efter.status).toBe('AWAITING_APPROVAL')
      expect(efter.statusReason).toBeNull()
    }, 30_000)

    // NEGATIVKONTROLL 2: en rad som redan NÅTT en terminalstatus skrivs inte
    // om. En reaper som skrev över ett EXECUTED hade raderat beviset för att
    // åtgärden faktiskt utfördes.
    it('NEGATIVKONTROLL: en redan UTFÖRD rad skrivs inte om', async () => {
      const d = await enbartEnDelegation(orgId)
      await sättVäxel(orgId, true, true)
      const u = await skapaUppdrag({ organizationId: orgId, delegationId: d })
      expect((await execution.utför(orgId, u.id)).utfall).toBe('UTFÖRD')
      // Åldra anspråket så bara terminalstatusen kan skydda raden.
      await prisma.aiAssignment.update({
        where: { id: u.id },
        data: { executionStartedAt: new Date(Date.now() - DOTT_ANSPRAK_MS - 60_000) },
      })

      await execution.stängDöda(new Date())
      const efter = await prisma.aiAssignment.findUniqueOrThrow({ where: { id: u.id } })
      expect(efter.status).toBe('EXECUTED')
    }, 30_000)
  })

  // ── DE TRE SOM INTE FÅR KÖRAS OBEVAKAT ─────────────────────────────────
  it('ett DEDUPLICERBART verktyg får en dom men ingen körning', async () => {
    // FREKVENSVILLKOR KRÄVS för ett DEDUPLICERBART verktyg — `DelegationService`
    // avvisar annars. Att provet måste ange det är i sig ett belägg för att den
    // grinden lever.
    const d = await nyDelegation(orgId, 'create_invoice', { maxAntal: 5, periodDagar: 30 })
    await sättVäxel(orgId, true, true)
    const u = await skapaUppdrag({
      organizationId: orgId,
      delegationId: d,
      toolName: 'create_invoice',
      toolInput: {},
    })
    const r = await execution.utför(orgId, u.id)
    expect(r.utfall).toBe('EJ_UPPDRAGSDUGLIG')

    const efter = await prisma.aiAssignment.findUniqueOrThrow({ where: { id: u.id } })
    // UPPDRAGET ÄR ORÖRT. Varken FAILED (inget gick sönder) eller LAPSED (ingen
    // förutsättning föll bort) — verktyget tål bara inte att köras obevakat.
    expect(efter.status).toBe('AWAITING_APPROVAL')
    expect(efter.executionStartedAt).toBeNull()
    expect(efter.executionVerdict).toBe('WOULD_EXECUTE')
  }, 30_000)
})
