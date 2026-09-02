/**
 * EFFEKTSPÅRET SKRIVS AV PRODUKTIONSVÄGEN — mot riktig Postgres.
 *
 * ── VARFÖR DEN HÄR SPECEN BEHÖVDES ──────────────────────────────────────────
 *
 * `ai-effect-extension.spec.ts` heter *"effekterna PERSISTERAS som rader"*, men
 * den anropar `prisma.aiToolExecution.create(...)` DIREKT i testet. Den prövar
 * alltså att Prismas nästlade skrivning fungerar — inte att produktionsvägen
 * använder den. Det är inte en svag vakt; det är fel fråga.
 *
 * Uppmätt 2026-09-01: med det ENDA persisteringsstället bortkopplat
 * (`effects: { create: … }` struken ur `AiAuditService.logToolExecution`) var
 * `check-ai-tool-effects.mjs` grön, 27 riktade tester gröna och HELA sviten grön
 * — 338/338 sviter, 3478/3478 tester. Spåret var obevakat.
 *
 * ── VAD DEN HÄR SPECEN GÖR I STÄLLET ────────────────────────────────────────
 *
 * Kör `ToolExecutorService.executeTool` — den RIKTIGA metoden, inte en kopia av
 * dess innehåll — för ett riktigt verktyg mot en riktig databas, och kräver att
 * `AiToolEffect`-raderna finns efteråt och pekar på det som faktiskt skapades.
 *
 * Tjänsten instansieras via `Object.create` med bara de kollaboratörer
 * `create_journal_entry` rör (`prisma`, `verifikationsnummer`, `audit`). Skälet
 * är inte bekvämlighet: konstruktorn tar 24 beroenden, och att räkna upp dem
 * positionellt hade gjort specen röd av fel skäl så fort någon la till ett
 * tjugofemte. Metodkroppen som körs är produktionens.
 *
 * ── VARFÖR DEN POLLAR ───────────────────────────────────────────────────────
 *
 * `void this.audit.logToolExecution(...)` — fyra anropare, alla `void`. Skrivningen
 * inväntas inte, så det finns ingen punkt att `await`:a. Pollningen är inte
 * slarv; den är själva egenskapen synliggjord. Skulle spåret en dag bli
 * `TRANSAKTIONELL` kan väntan tas bort, och att den behövs i dag är precis vad
 * `traceIntegrity: 'BÄST_MÖJLIGA'` deklarerar.
 *
 * ── ANSVARSDELNING (utskriven i BÅDA filerna) ───────────────────────────────
 *
 * Den här specen äger MEKANIKEN: att vägen faktiskt skriver raden.
 * `check-effect-trace.mjs` äger PÅKOPPLINGEN: att alla anropare av
 * `logToolExecution` finns i en HÄRLEDD mängd och skickar med sina effekter, och
 * att persisteringsstället har kvar sin nästlade skrivning.
 *
 * ── BÅDA EXEKVERARNA (steg 3a) ──────────────────────────────────────────────
 *
 * Det finns TVÅ exekverare, och hyresgästens är en egen klass. Täckte specen
 * bara ägarvägen hade hyresgästvägen ärvt precis den blindhet ägarvägen just
 * fick bort — vakten hade räknat dess anropare, men ingenting hade prövat att
 * de faktiskt skriver något. Filen kör därför båda.
 */
import { randomUUID } from 'node:crypto'

// StorageService drar in @aws-sdk (ESM) som ts-jest inte transformerar, och den
// når hit bara via importkedjan tool-executor → invoices.service → pdf.service.
// Stubbarna rör INTE vägen som mäts: `create_journal_entry` använder enbart
// `prisma` och `verifikationsnummer`. Samma mönster som collections-role-gate.spec.
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { PrismaService } from '../../common/prisma/prisma.service'
import { AiAuditService } from './ai-audit.service'
import { ToolExecutorService } from '../tools/tool-executor.service'
import { TenantToolExecutorService } from '../tools/tenant-tool-executor.service'
import { MaintenanceService } from '../../maintenance/maintenance.service'
import { VerifikationsnummerService } from '../../accounting/verifikationsnummer.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    // Utan den här raden är filen grön av att den hoppades över.
    expect(HAR_DB).toBe(true)
  })
})

/** Hur länge vi väntar på en skrivning som ingen inväntar. */
const SPAR_DEADLINE_MS = 8_000

medDb('effektspåret skrivs av produktionsvägen', () => {
  let prisma: PrismaService
  let executor: ToolExecutorService
  let orgId: string
  let userId: string
  let tenantId: string
  let leaseId: string

  beforeAll(async () => {
    prisma = new PrismaService()
    const audit = new AiAuditService(prisma)
    const verifikationsnummer = new VerifikationsnummerService(prisma)

    // Produktionens metodkropp, med produktionens kollaboratörer för just den
    // här vägen. Se docblocket för varför inte konstruktorn.
    executor = Object.create(ToolExecutorService.prototype) as ToolExecutorService
    Object.assign(executor, { prisma, audit, verifikationsnummer })

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `spar-${sfx}`,
        email: `spar-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
    })
    orgId = org.id
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `spar-${sfx}@example.se`,
        passwordHash: 'x',
        firstName: 'S',
        lastName: 'P',
        role: 'OWNER',
      },
    })
    userId = user.id
    await prisma.account.createMany({
      data: [
        { organizationId: orgId, number: 1930, name: 'Bank', type: 'ASSET' },
        { organizationId: orgId, number: 3911, name: 'Hyresintäkt', type: 'REVENUE' },
      ],
    })

    // Hyresgästvägens felanmälan kräver ett AKTIVT avtal — den slår upp
    // lease → unit → property för att veta var felet finns.
    const prop = await prisma.property.create({
      data: {
        organizationId: orgId,
        name: 'P',
        propertyDesignation: 'X 1:1',
        type: 'RESIDENTIAL',
        street: 'a',
        city: 'b',
        postalCode: '11111',
        totalArea: 100,
      },
    })
    const unit = await prisma.unit.create({
      data: {
        propertyId: prop.id,
        name: 'U',
        unitNumber: '1',
        type: 'APARTMENT',
        area: 50,
        monthlyRent: 8000,
      },
    })
    const tenant = await prisma.tenant.create({
      data: {
        organizationId: orgId,
        type: 'INDIVIDUAL',
        firstName: 'Hyres',
        lastName: 'Gäst',
        email: `spar-t-${sfx}@example.se`,
      },
    })
    tenantId = tenant.id
    const lease = await prisma.lease.create({
      data: {
        organizationId: orgId,
        unitId: unit.id,
        tenantId: tenant.id,
        status: 'ACTIVE',
        startDate: new Date('2026-01-01T00:00:00Z'),
        tenancyStartDate: new Date('2026-01-01T00:00:00Z'),
        activatedAt: new Date('2026-01-01T00:00:00Z'),
        monthlyRent: 8000,
        depositAmount: 8000,
      },
    })
    leaseId = lease.id
  })

  afterAll(async () => {
    await prisma.journalEntryLine.deleteMany({
      where: { journalEntry: { organizationId: orgId } },
    })
    await prisma.journalEntry.deleteMany({ where: { organizationId: orgId } })
    await prisma.journalEntrySequence.deleteMany({ where: { organizationId: orgId } })
    await prisma.account.deleteMany({ where: { organizationId: orgId } })
    await prisma.maintenanceComment.deleteMany({
      where: { ticket: { organizationId: orgId } },
    })
    await prisma.maintenanceTicket.deleteMany({ where: { organizationId: orgId } })
    await prisma.lease.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
    await prisma.unit.deleteMany({ where: { property: { organizationId: orgId } } })
    await prisma.property.deleteMany({ where: { organizationId: orgId } })
    await prisma.user.deleteMany({ where: { organizationId: orgId } })

    // STÄDNINGEN MÅSTE TÅLA EN SEN SKRIVNING — och det är egenskapen specen
    // mäter, sedd från andra hållet. `logToolExecution` anropas med `void`, så
    // den kan landa EFTER att testet tog slut. Raderas auditraden en gång kan
    // en försenad insert dyka upp efteråt, och `Organization`-raderingen faller
    // då på AiToolExecution_organizationId_fkey. Att i stället "sova en stund"
    // hade dolt precis det som är intressant.
    for (let försök = 1; ; försök++) {
      await prisma.aiToolExecution.deleteMany({ where: { organizationId: orgId } })
      try {
        await prisma.organization.delete({ where: { id: orgId } })
        break
      } catch (err) {
        if (försök >= 5) throw err
        await new Promise((r) => setTimeout(r, 200))
      }
    }
    await prisma.$disconnect()
  })

  /**
   * Väntar tills spåret dykt upp, eller ger upp.
   *
   * ⚠️ POLLNINGEN MÅSTE OMFATTA SJÄLVA UPPSLAGET, inte bara effekterna. Första
   * versionen slog upp körningen med en vanlig `findMany` och pollade sedan på
   * dess id — och blev flakig, 4 röda av 5. Skälet är egenskapen som mäts:
   * auditraden skrivs `void`, så den finns inte nödvändigtvis när testet
   * frågar. Specen hade alltså samma antagande som produktionskoden gör om sitt
   * eget spår, och blev flakig av precis det.
   */
  const väntaPåSpår = async (toolName: string) => {
    const deadline = Date.now() + SPAR_DEADLINE_MS
    for (;;) {
      const rad = await prisma.aiToolExecution.findFirst({
        where: { organizationId: orgId, toolName },
        select: {
          id: true,
          completedAt: true,
          effects: { select: { entityType: true, entityId: true } },
        },
      })
      // ⚠️ VÄNTA PÅ ATT RADEN STÄNGS, inte på att den finns. Sedan steg 3b
      // skrivs raden FÖRE körningen för FÖRE_EFFEKTEN-verktyg, så "raden finns"
      // betyder inte längre "spåret är komplett" — effekterna kommer med
      // stängningen. Att bara vänta på raden gav 0 effekter och en röd spec.
      if (rad?.completedAt) return rad
      if (Date.now() > deadline) return null
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  it('ett riktigt verktyg genom executeTool skriver BÅDE effekten och spåret', async () => {
    const beskrivning = `spårprov ${randomUUID().slice(0, 8)}`
    const resultat = await executor.executeTool(
      'create_journal_entry',
      {
        date: '2026-09-01',
        description: beskrivning,
        lines: [
          { accountNumber: 1930, debit: 100 },
          { accountNumber: 3911, credit: 100 },
        ],
      },
      orgId,
      userId,
      'OWNER',
      // Bindande verktyg kräver ett konsumerat anspråk (action-authorization.ts).
      { actionProof: { claimed: true } },
    )
    expect(resultat.success).toBe(true)

    // 1. EFFEKTEN skedde.
    const verifikat = await prisma.journalEntry.findFirst({
      where: { organizationId: orgId, description: beskrivning },
      select: { id: true },
    })
    expect(verifikat).not.toBeNull()

    // 2. SPÅRET finns — och det är det här som föll bort när persisteringen
    //    kopplades bort, utan att något annat i sviten märkte det.
    const spår = await väntaPåSpår('create_journal_entry')
    expect(spår).not.toBeNull()
    const körningar = await prisma.aiToolExecution.count({
      where: { organizationId: orgId, toolName: 'create_journal_entry' },
    })
    expect(körningar).toBe(1)

    // 3. Spåret pekar på det som FAKTISKT skapades, inte bara på "något".
    const träffar = spår!.effects.filter((e) => e.entityType === 'JournalEntry')
    expect(träffar.length).toBeGreaterThan(0)
    expect(träffar.map((e) => e.entityId)).toContain(verifikat!.id)
  })

  it('generate_lease_contract: TVÅ körningar ger EN lokal rad och ETT objekt', async () => {
    // KLASS B, DE NÄSTAN LÖSTA. R2-nyckeln är härledd ur (org, hyresgästnamn,
    // datum) och en PUT skriver över — den externa effekten var alltså redan
    // idempotent. Den LOKALA raden var det inte: varje omkörning gav ett nytt
    // `Document` mot samma objekt, och den äldre pekade på innehåll som inte
    // längre fanns.
    //
    // Provet kör verktyget TVÅ gånger med samma indata och kräver att paret
    // (extern effekt, lokal rad) är ETT. Det är den enda av de sju klass
    // B-verktygen där återupptagningsbarhet går att BEVISA i dag.
    const uppladdade: string[] = []
    const kontraktExecutor = Object.create(ToolExecutorService.prototype) as ToolExecutorService
    Object.assign(kontraktExecutor, {
      prisma,
      audit: new AiAuditService(prisma),
      // Stubbar för det som lämnar processen. De mäts inte här — poängen är
      // att RÄKNA uppladdningarna och se att nyckeln är densamma båda gångerna.
      pdfService: { generateFromHtml: async () => Buffer.from('%PDF-1.4 prov') },
      storage: {
        uploadFile: async (_b: Buffer, key: string) => {
          uppladdade.push(key)
          return `https://r2.example/${key}`
        },
        // Anspråket tas före uppladdningen, så raden signerar sin URL ur
        // nyckeln innan några bytes finns. Det som räknas här är fortfarande
        // `uppladdade` — och den andra körningen ska inte lägga något där.
        getPresignedUrl: async (key: string) => `https://r2.example/${key}`,
      },
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    })

    const indata = { leaseId, contractType: 'RESIDENTIAL' }
    const första = await kontraktExecutor.executeTool(
      'generate_lease_contract',
      { ...indata },
      orgId,
      userId,
      'OWNER',
      { actionProof: { claimed: true } },
    )
    const andra = await kontraktExecutor.executeTool(
      'generate_lease_contract',
      { ...indata },
      orgId,
      userId,
      'OWNER',
      { actionProof: { claimed: true } },
    )
    expect(första.success).toBe(true)
    expect(andra.success).toBe(true)

    // EN lokal rad — det som saknades.
    const dokument = await prisma.document.findMany({
      where: { organizationId: orgId, category: 'CONTRACT' },
      select: { id: true, storageKey: true },
    })
    expect(dokument).toHaveLength(1)

    // ── DEN HÄR ASSERTIONEN HADE SKRIVIT IN BUGGEN SOM FÖRVÄNTAT BETEENDE ──
    //
    // Den krävde tidigare TVÅ uppladdningar till samma nyckel och kallade det
    // "en överskrivning och inte ett nytt objekt". Överskrivningen var inte en
    // ofarlig biverkning av dedupen — den VAR skadan: uppladdningen låg före
    // `document.create`, så en andra körning skrev bytes innan den upptäckte
    // att nyckeln var upptagen. Med två avtal för samma hyresgäst samma dag
    // hamnade avtal B:s PDF under avtal A:s rad.
    //
    // Nu tas anspråket först, och bara den som vunnit rör lagringen. En
    // omkörning laddar därför upp INGENTING. Kravet är alltså skarpare än
    // förut, inte lösare: exakt en uppladdning, och den hör till den enda rad
    // som finns.
    expect(uppladdade).toHaveLength(1)
    expect(uppladdade[0]).toBe(dokument[0]!.storageKey)

    // Och svaret SÄGER att inget nytt skapades — annars ser en omkörning ut som
    // ett nytt kontrakt för den som läser. Texten namnger numera avtalet, så
    // att ett påstående om FEL avtal går att se.
    expect(andra.message).toMatch(/genererades redan i dag/)
  })

  it('HYRESGÄSTVÄGEN skriver också spåret — en egen exekverare, samma krav', async () => {
    // Före steg 3a fanns inget spår alls här: ingen kollektor, inget AI-ursprung,
    // ingen `effects` till auditraden. Två skrivande hyresgästverktyg var helt
    // ospårade — och det är den vägen en hyresgästagent kommer att köra på.
    const maintenance = Object.create(MaintenanceService.prototype) as MaintenanceService
    Object.assign(maintenance, {
      prisma,
      // createForAllOrgUsers anropas fire-and-forget och rör inte spåret.
      notificationsService: { createForAllOrgUsers: async () => undefined },
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    })
    const tenantExecutor = Object.create(
      TenantToolExecutorService.prototype,
    ) as TenantToolExecutorService
    Object.assign(tenantExecutor, {
      prisma,
      audit: new AiAuditService(prisma),
      maintenanceService: maintenance,
      notificationsService: { createForAllOrgUsers: async () => undefined },
    })

    const titel = `felanmälan ${randomUUID().slice(0, 8)}`
    const resultat = await tenantExecutor.executeTool(
      'create_maintenance_ticket',
      { title: titel, description: 'Kranen droppar.' },
      tenantId,
      orgId,
      { actionProof: { claimed: true } },
    )
    expect(resultat.success).toBe(true)

    const ärende = await prisma.maintenanceTicket.findFirst({
      where: { organizationId: orgId, title: titel },
      select: { id: true },
    })
    expect(ärende).not.toBeNull()

    const spår = await väntaPåSpår('create_maintenance_ticket')
    expect(spår).not.toBeNull()
    const träffar = spår!.effects.filter((e) => e.entityType === 'MaintenanceTicket')
    expect(träffar.length).toBeGreaterThan(0)
    expect(träffar.map((e) => e.entityId)).toContain(ärende!.id)
  })
})
