/**
 * G0 EXECUTION TRUTH — KRASCH, OMTAG, UPPSPELNING mot riktig Postgres.
 *
 * Planens Del 3 rad 2 (`docs/eveno-agentplan.md`) hade prov 4 och 6 som DELVIS
 * och prov 5 som SAKNAS. Skälet stod utskrivet: de två DELVIS-proven vilar på
 * en ATTRAPP. `ai-confirm-crash-honesty.spec.ts` hårdkodar
 * `aiPendingAction.findFirst` till en redan konsumerad rad och
 * `aiToolExecution.findFirst` till en körning eller null — den mäter alltså
 * vilket SVAR som ges i ett läge den själv har hittat på, aldrig att noll rader
 * faktiskt skrevs. Det är den halva frågan CLAUDE.md varnar för.
 *
 * ── SÖMMEN: TOOLEXECUTOR, INTE PRISMA ───────────────────────────────────────
 *
 * Kraschfönstret ligger mellan två rader i `confirmActionInner`:
 *
 *   anspråket   `ai-assistant.service.ts:1251`
 *               aiPendingAction.updateMany({ where: { id, consumedAt: null } })
 *               — atomärt, committat på egen connection
 *   utförandet  `ai-assistant.service.ts:1045`
 *               this.toolExecutor.executeTool(...) — ett SEPARAT anrop på en
 *               INJICERAD kollaboratör
 *
 * Mellan dem körs bara rena funktioner. Ingen delad transaktion. Produktions-
 * koden namnger själv fönstret (`:959`–`:967`).
 *
 * Sömmen är därför `ToolExecutorService`-injektionen. Prisma är RIKTIG hela
 * vägen, och det är hela poängen: allt de tre proven påstår går genom Prisma —
 * det atomära anspråket (`:1251`), treutfallsuppslaget (`:1240`) och
 * `aiToolExecution.findFirst` (`:976`) som avgör om svaret blir "redan utförd"
 * eller den ärliga formuleringen.
 *
 * ── VAD DEN HÄR FILEN INTE KAN SE ───────────────────────────────────────────
 *
 * Ett KASTAT FEL är inte processdöd. Det fångas på `:1053`. Catch-blocket
 * skriver ETT `AiMessage` och returnerar; det återställer INTE anspråket och
 * skriver INGEN `AiToolExecution`. Residualtillståndet är alltså identiskt med
 * en krasch så när som på den raden — och prov 4 assertar det explicit i
 * stället för att svepa över det.
 *
 * Den här filen kan inte se att någon kopplar bort själva frågan (att grenen
 * FRÅGAR efter en körning innan den påstår något). Det ägs av
 * `check-ai-journal-source.mjs` (R3). Den kan inte heller se att effektspåret
 * slutar persisteras — det ägs av `check-effect-trace.mjs` och
 * `effect-trace-production-path.db.spec.ts`.
 *
 * ── VERKTYGSVALET ÄR EN MÄTNING, INTE EN BEKVÄMLIGHET ───────────────────────
 *
 * `create_journal_entry` är ett av bara TVÅ verktyg med
 * `traceIntegrity: 'TRANSAKTIONELL'` (`effect-idempotency.ts:429`, `:452`) —
 * effekten och spåret delar transaktion, så antalen är deterministiska och
 * behöver ingen pollning. Det är också det verktyg vars idempotensnyckel
 * (`ai-journal-source.ts`) uttryckligen byggdes FÖR omtaget efter en krasch.
 *
 * Det var också den formen som i #783 visade sig FÖRNEKA sina egna utföranden:
 * `skrivTransaktionelltSpar` vidarebefordrade varken `conversationId` eller
 * `confirmedAt`, så uppspelningsuppslaget kunde aldrig matcha. Lagat i #784 —
 * fälten byggs nu på ETT ställe (`spårIdentitet` i `executeToolWithAudit`) och
 * räknas upp på ETT ställe (`identitetsKolumner` i `ai-audit.service.ts`).
 * Provet som i går pinnade defekten kräver nu det riktiga svaret, och frågan
 * ställs dessutom över SAMTLIGA `ACTION_TOOLS` längst ned i filen — ett fynd om
 * två verktyg är inte ett instrument.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'
import { ConflictException } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { AiAssistantService } from './ai-assistant.service'
import { AiAuditService } from './audit/ai-audit.service'
import { ToolExecutorService } from './tools/tool-executor.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { TenantsService } from '../tenants/tenants.service'
import { aiJournalSourceId } from './tools/ai-journal-source'
import { effectTraceIntegrity } from './tools/effect-idempotency'
import { ACTION_TOOLS } from './tools/ai-tools.definition'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

// FÖRUTSÄTTNINGSKANARIEFÅGELN LIGGER UTANFÖR det hoppbara blocket. Ligger den
// inuti är den grön av att den hoppades över — hela filen kan då försvinna ur
// CI utan att något blir rött.
describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

/**
 * Riggen är SEKVENTIELL — samtidigheten ägs av
 * `pending-action-claim.concurrency.spec.ts`. Poolen sätts ändå EXPLICIT, och
 * skälet är att en osatt pool är en osynlig variabel: `create_journal_entry`
 * kör en `$transaction` medan riggens egna räkningar går på samma klient, och
 * med pool 1 hade en räkning kunnat blockera på transaktionen i stället för att
 * svara. Ett prov som dör på pool-timeout ser ut som ett riktigt fel.
 */
const POOL = 8

function urlMedPool(bas: string, pool: number): string {
  const u = new URL(bas)
  u.searchParams.set('connection_limit', String(pool))
  return u.toString()
}

const TOOL = 'create_journal_entry'

medDb('G0 · krasch mellan anspråk och utförande, omtag och uppspelning', () => {
  let prisma: PrismaService
  let audit: AiAuditService
  let riktigExecutor: ToolExecutorService
  let orgId: string
  let userId: string
  let convId: string
  let tenantId: string

  /** Bygger tjänsten med EN utbytt kollaboratör: sömmen. */
  const tjänstMed = (executeTool: (...a: never[]) => unknown) =>
    new AiAssistantService(
      prisma as never,
      { get: jest.fn().mockReturnValue('') } as never, // configService
      {} as never, // dataContext
      { executeTool } as never, // ← SÖMMEN
      {} as never, // memory
      {} as never, // usage
      {} as never, // quota
      {} as never, // audit
      {} as never, // legalRetrieval
      {
        buildContentBlocks: jest
          .fn()
          .mockResolvedValue({ contentBlocks: [], refBlocks: [], ids: [] }),
        markConsumed: jest.fn().mockResolvedValue(undefined),
        rehydrateHistoryBlocks: jest.fn(),
      } as never,
    )

  /**
   * Ett verifikat på 100 kr — under `requiresDoubleConfirmation`s tak på
   * 100 000 kr (`ai-assistant.service.ts:518`), så bekräftelsevägen går rakt
   * till utförandet i stället för att be om en andra bekräftelse.
   *
   * Beskrivningen är unik per prov: `aiJournalSourceId` härleds ur ÅTGÄRDENS
   * INNEHÅLL, så två prov med samma indata hade delat idempotensnyckel och
   * mätt varandras rader.
   */
  const indata = (märke: string) => ({
    date: '2026-09-01',
    description: `g0 ${märke} ${randomUUID().slice(0, 8)}`,
    lines: [
      { accountNumber: 1930, debit: 100 },
      { accountNumber: 3911, credit: 100 },
    ],
  })

  const nyckelFör = (input: Record<string, unknown>) => aiJournalSourceId(TOOL, input)

  /**
   * Räknas på BESKRIVNINGEN, inte på `sourceId`.
   *
   * Mätt skäl, inte smak: en negativkontroll som tar bort eller randomiserar
   * idempotensnyckeln gör en `sourceId`-filtrerad räkning till NOLL — och då
   * faller provet av att INSTRUMENTET slutade hitta rader, inte av att
   * dubbletten uppstod. De två utfallen ser likadana ut i en röd rad.
   * Beskrivningen är unik per prov och överlever varje injektion i nyckeln.
   */
  const antalVerifikat = (input: Record<string, unknown>) =>
    prisma.journalEntry.count({
      where: { organizationId: orgId, description: input.description as string },
    })

  /**
   * Körningar räknas på ORGANISATIONEN + verktyget, inte på konversationen.
   * Det är inte slarv: den transaktionella spårvägen (`skrivTransaktionelltSpar`
   * → `writeInTransaction`) skickar varken `conversationId` eller `confirmedAt`,
   * så en räkning scopad på konversationen hade svarat noll om rader som finns.
   * Se prov 6.
   */
  const antalKörningar = () =>
    prisma.aiToolExecution.count({ where: { organizationId: orgId, toolName: TOOL } })

  const pendingRader = () =>
    prisma.aiPendingAction.findMany({
      where: { conversationId: convId, toolName: TOOL },
      orderBy: { createdAt: 'asc' },
      select: { id: true, consumedAt: true, toolInputHash: true },
    })

  beforeAll(async () => {
    // PrismaService (inte PrismaClient) — den bär utfallskopplingens extension,
    // och utan den samlas inga AiToolEffect-rader alls.
    const basUrl = process.env.DATABASE_URL as string
    process.env.DATABASE_URL = urlMedPool(basUrl, POOL)
    prisma = new PrismaService()
    process.env.DATABASE_URL = basUrl

    const satt = Number(new URL(urlMedPool(basUrl, POOL)).searchParams.get('connection_limit'))
    if (!(satt > 1)) throw new Error(`POOL: connection_limit=${satt} är inte > 1`)

    audit = new AiAuditService(prisma)
    const verifikationsnummer = new VerifikationsnummerService(prisma)
    // Produktionens metodkropp med produktionens kollaboratörer för just den
    // här vägen. Konstruktorn tar 24 beroenden — samma skäl som i
    // `effect-trace-production-path.db.spec.ts:88`.
    riktigExecutor = Object.create(ToolExecutorService.prototype) as ToolExecutorService
    Object.assign(riktigExecutor, { prisma, audit, verifikationsnummer })

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `g0-${sfx}`,
        email: `g0-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
    })
    orgId = org.id
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `g0-${sfx}@example.se`,
        passwordHash: 'x',
        firstName: 'G',
        lastName: 'Noll',
        role: 'OWNER',
      },
    })
    userId = user.id
    await prisma.account.createMany({
      data: [
        { organizationId: orgId, number: 1930, name: 'Bank', type: 'ASSET' },
        { organizationId: orgId, number: 3911, name: 'Hyresintäkt', type: 'REVENUE' },
        // record_expense konterar mot 1930 (ovan), 2641 (moms) och utgiftskontot.
        { organizationId: orgId, number: 2641, name: 'Ingående moms', type: 'ASSET' },
        { organizationId: orgId, number: 5010, name: 'Lokalhyra', type: 'EXPENSE' },
      ],
    })
    const conv = await prisma.aiConversation.create({ data: { organizationId: orgId, userId } })
    convId = conv.id

    // POSITIVA KONTROLLENS FÖRUTSÄTTNING (se prov 6). `update_tenant` är
    // FÖRE_EFFEKTEN och behöver en riktig hyresgäst.
    const tenant = await prisma.tenant.create({
      data: {
        organizationId: orgId,
        type: 'INDIVIDUAL',
        firstName: 'Hyres',
        lastName: 'Gast',
        email: `g0-t-${sfx}@example.se`,
      },
    })
    tenantId = tenant.id

    // PersonalNumberService är STUBBAD, och bara den. Den ligger inte på vägen
    // som mäts — provet handlar om bekräftelsens livscykel, inte om PII — och
    // den riktiga kräver en nyckel som en testrigg inte ska bära.
    const tenantsService = Object.create(TenantsService.prototype) as TenantsService
    Object.assign(tenantsService, {
      prisma,
      pn: { protect: () => ({}), reveal: () => null },
    })
    Object.assign(riktigExecutor, { tenantsService })
  }, 60_000)

  afterAll(async () => {
    // FK-ORDNING. `AiToolEffect.organization` och `AiToolExecution.organization`
    // är `onDelete: Restrict` (`schema.prisma:3842`), så de måste bort före
    // organisationen. Konversationen kaskaderar till AiPendingAction/AiMessage.
    if (orgId) {
      await prisma.aiToolEffect.deleteMany({ where: { organizationId: orgId } })
      await prisma.aiToolExecution.deleteMany({ where: { organizationId: orgId } })
      await prisma.journalEntryLine.deleteMany({
        where: { journalEntry: { organizationId: orgId } },
      })
      await prisma.journalEntry.deleteMany({ where: { organizationId: orgId } })
      await prisma.journalEntrySequence.deleteMany({ where: { organizationId: orgId } })
      await prisma.account.deleteMany({ where: { organizationId: orgId } })
      await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
      await prisma.aiMessageTenant.deleteMany({
        where: { message: { conversationId: convId } },
      })
      await prisma.aiMessage.deleteMany({ where: { conversationId: convId } })
      await prisma.aiPendingAction.deleteMany({ where: { conversationId: convId } })
      await prisma.aiConversation.deleteMany({ where: { organizationId: orgId } })
      await prisma.user.deleteMany({ where: { organizationId: orgId } })
      await prisma.organization.delete({ where: { id: orgId } })
    }
    await prisma.$disconnect()
  }, 60_000)

  const BEKRÄFTA = (input: Record<string, unknown>) =>
    [TOOL, input, convId, true, orgId, userId, 'OWNER'] as const

  /** Iscensätter EXAKT kraschtillståndet: anspråk committat, inget utfört. */
  async function iscensättKrasch(input: Record<string, unknown>) {
    const tjänst = tjänstMed(jest.fn())
    await tjänst.recordPendingAction(convId, orgId, userId, TOOL, input)
    const kraschande = jest.fn(() => {
      throw new Error('SIMULERAD PROCESSDÖD mellan anspråk och utförande')
    })
    const svar = await tjänstMed(kraschande).confirmAction(...BEKRÄFTA(input))
    return { svar, kraschande }
  }

  /** Ett skarpt, lyckat utförande genom produktionens executeTool. */
  async function utförSkarpt(input: Record<string, unknown>) {
    const tjänst = tjänstMed(riktigExecutor.executeTool.bind(riktigExecutor) as never)
    await tjänst.recordPendingAction(convId, orgId, userId, TOOL, input)
    return { tjänst, svar: await tjänst.confirmAction(...BEKRÄFTA(input)) }
  }

  // ── PROV 4 ────────────────────────────────────────────────────────────────

  describe('prov 4 · krasch efter claim, före execution', () => {
    it('noll spår, noll effekt — och nästa användarsvar säger INTE "redan utförd"', async () => {
      const input = indata('p4')
      const körningarFöre = await antalKörningar()

      const { svar, kraschande } = await iscensättKrasch(input)
      expect(kraschande).toHaveBeenCalledTimes(1)

      // 1. ANSPRÅKET ÄR FÖRBRUKAT — det är vad som gör det till ett kraschläge
      //    och inte till "ingenting hände".
      const rader = await pendingRader()
      expect(rader.length).toBeGreaterThan(0)
      expect(rader.at(-1)!.consumedAt).not.toBeNull()

      // 2. NOLL SPÅR. Mot riktig Postgres, inte mot en attrapp som blev
      //    tillsagd att svara null.
      expect(await antalKörningar()).toBe(körningarFöre)
      expect(körningarFöre).toBe(0)

      // 3. NOLL EFFEKT.
      expect(await antalVerifikat(input)).toBe(0)

      // 4. Det omedelbara svaret är ett misslyckande — inte ett påstående om
      //    utförande.
      expect(svar.reply).toMatch(/Åtgärden misslyckades/)
      expect(svar.reply).not.toMatch(/redan utförd/)

      // 5. NÄSTA ANVÄNDARSVAR — samma bekräftelse igen. Det är HÄR den mätta
      //    defekten satt: svaret sa "Åtgärden är redan utförd" om något som
      //    aldrig skedde.
      await expect(tjänstMed(jest.fn()).confirmAction(...BEKRÄFTA(input))).rejects.toThrow(
        ConflictException,
      )
      await expect(tjänstMed(jest.fn()).confirmAction(...BEKRÄFTA(input))).rejects.toThrow(
        /går INTE att bekräfta/,
      )
      await expect(tjänstMed(jest.fn()).confirmAction(...BEKRÄFTA(input))).rejects.not.toThrow(
        /redan utförd/,
      )

      // 6. Och uppspelningen fick inte köra verktyget.
      expect(await antalKörningar()).toBe(0)
      expect(await antalVerifikat(input)).toBe(0)
    }, 60_000)

    it('catch-blocket rör inte anspråket — det enda spåret är ETT meddelande', async () => {
      // Gränsen mellan "kastat fel" och "processdöd", mätt i stället för
      // antagen: skillnaden är exakt en AiMessage-rad, och ingenting annat.
      const input = indata('p4b')
      const meddelandenFöre = await prisma.aiMessage.count({ where: { conversationId: convId } })
      await iscensättKrasch(input)
      const meddelandenEfter = await prisma.aiMessage.count({ where: { conversationId: convId } })
      expect(meddelandenEfter - meddelandenFöre).toBe(1)

      const rad = (await pendingRader()).at(-1)!
      expect(rad.consumedAt).not.toBeNull()
    }, 60_000)
  })

  // ── PROV 5 ────────────────────────────────────────────────────────────────

  describe('prov 5 · omtag efter kraschen', () => {
    it('anspråket går INTE att ta igen — det är designen, inte en defekt', async () => {
      // Produktionskoden säger det rakt ut (`ai-assistant.service.ts:993`):
      // "Ett anspråk som kan återuppstå är inte ett engångsanspråk". Det är
      // engångsanspråket som gör att 24 samtidiga bekräftelser ger EN körning.
      // Provet fastnaglar beslutet så att en framtida "lagning" blir röd här.
      const input = indata('p5a')
      await iscensättKrasch(input)
      await expect(tjänstMed(jest.fn()).confirmAction(...BEKRÄFTA(input))).rejects.toThrow(
        ConflictException,
      )
    }, 60_000)

    it('omtaget genom en NY bekräftelse lyckas — exakt EN effekt, exakt EN körning', async () => {
      const input = indata('p5b')
      await iscensättKrasch(input)
      expect(await antalVerifikat(input)).toBe(0)
      const körningarFöre = await antalKörningar()

      // Vägen framåt som svaret pekar ut: assistenten föreslår åtgärden igen,
      // vilket ger en NY AiPendingAction med ett NYTT id — och samma innehåll.
      const { svar } = await utförSkarpt(input)

      expect(svar.reply).toMatch(/Verifikat skapat/)
      expect(await antalVerifikat(input)).toBe(1)
      expect((await antalKörningar()) - körningarFöre).toBe(1)
    }, 60_000)

    it('omtaget är en NY rad med SAMMA nyckel — inte det gamla anspråket återuppväckt', async () => {
      // Nyckeln måste överleva ett omtag, och ett omtag har ett NYTT
      // pendingActionId (`ai-journal-source.ts`). Utan den här raden vore
      // "exakt EN effekt" ovan sant av att ingenting varierade.
      const input = indata('p5c')
      await iscensättKrasch(input)
      const efterKrasch = await pendingRader()
      const kraschRad = efterKrasch.at(-1)!
      expect(kraschRad.consumedAt).not.toBeNull()

      await utförSkarpt(input)
      const efterOmtag = await pendingRader()
      const omtagRad = efterOmtag.at(-1)!

      // ANTALET ÄR FEL MÅTT, och det är mätt: `recordPendingAction` gör en
      // opportunistisk `deleteMany` av konsumerade/utgångna rader för
      // konversationen INNAN den skapar den nya (`ai-assistant.service.ts:1195`).
      // Den kraschade raden är alltså borta, och en räkning på längden gav 0
      // nya i stället för 1. Identiteten är måttet som håller.
      expect(omtagRad.id).not.toBe(kraschRad.id)
      expect(efterOmtag.some((r) => r.id === kraschRad.id)).toBe(false)

      // Samma ÅTGÄRD trots ny bekräftelse: hashen är härledd ur innehållet.
      expect(omtagRad.toolInputHash).toBe(kraschRad.toolInputHash)
      expect(await antalVerifikat(input)).toBe(1)
    }, 60_000)
    /**
     * ── DEN ANDRA KRASCHPUNKTEN, och den som kostar pengar ──────────────────
     *
     * Provet ovan utgår från en krasch FÖRE effekten: ingenting var skrivet, så
     * "exakt EN effekt" är sant av att det inte fanns någon att dubbla. Den
     * farliga kraschen är den EFTER commit — transaktionen gick igenom, men
     * svaret nådde aldrig användaren, som ber om åtgärden igen.
     *
     * `ai-journal-source.ts` byggdes uttryckligen för det fallet, och skälet
     * står där: nyckeln får INTE vara `ai:<pendingActionId>`, för omtaget har
     * ett nytt sådant id. Den härleds ur åtgärdens INNEHÅLL, så den överlever.
     */
    it('omtag efter en krasch EFTER commit → fortfarande exakt ETT verifikat', async () => {
      const input = indata('p5d')
      await utförSkarpt(input)
      expect(await antalVerifikat(input)).toBe(1)
      const körningarEfterFörsta = await antalKörningar()

      // Användaren såg aldrig svaret och ber om samma sak igen: NY bekräftelse,
      // nytt pendingActionId, identiskt innehåll.
      const { svar } = await utförSkarpt(input)

      // Effekten är ETT verifikat — spärren är databasens unika index.
      expect(await antalVerifikat(input)).toBe(1)
      // …och den bär den INNEHÅLLSHÄRLEDDA nyckeln. Utan den här raden vore
      // "ett verifikat" förenligt med att något helt annat råkade blockera.
      const verifikat = await prisma.journalEntry.findFirst({
        where: { organizationId: orgId, description: input.description as string },
        select: { sourceId: true, source: true },
      })
      expect(verifikat!.source).toBe('AI')
      expect(verifikat!.sourceId).toBe(nyckelFör(input))
      // …och svaret SÄGER att inget nytt skapades, i stället för att påstå
      // "Verifikat skapat" om något som fanns.
      expect(svar.reply).toMatch(/finns redan/)
      expect(svar.reply).not.toMatch(/Verifikat skapat/)

      // Körningen räknas ändå: verktyget KÖRDE, det skrev bara inget nytt.
      // (Idempotensträffen skriver sitt eget spår, tool-executor.service.ts:4043.)
      expect(await antalKörningar()).toBe(körningarEfterFörsta + 1)
    }, 60_000)
  })

  // ── PROV 6 ────────────────────────────────────────────────────────────────

  describe('prov 6 · uppspelning efter lyckat utförande', () => {
    it('ingen andraeffekt och ingen andra körning', async () => {
      const input = indata('p6')
      const { svar } = await utförSkarpt(input)
      expect(svar.reply).toMatch(/Verifikat skapat/)

      const verifikatFöre = await antalVerifikat(input)
      const körningarFöre = await antalKörningar()
      expect(verifikatFöre).toBe(1)

      await expect(tjänstMed(jest.fn()).confirmAction(...BEKRÄFTA(input))).rejects.toThrow(
        ConflictException,
      )

      expect(await antalVerifikat(input)).toBe(verifikatFöre)
      expect(await antalKörningar()).toBe(körningarFöre)
    }, 60_000)

    /**
     * ── POSITIV KONTROLL ────────────────────────────────────────────────────
     *
     * En sond som aldrig ger "redan utförd" kan inte skilja "meddelandet är fel"
     * från "riggen når aldrig fram till grenen". Det här provet MÅSTE därför ge
     * utslag, och gör det: för ett FÖRE_EFFEKTEN-verktyg svarar uppspelningen
     * precis som planen kräver.
     */
    it('POSITIV KONTROLL · FÖRE_EFFEKTEN-verktyg → uppspelningen säger "redan utförd"', async () => {
      expect(effectTraceIntegrity('update_tenant')).toBe('FÖRE_EFFEKTEN')

      const input = {
        tenantId,
        tenantName: 'Hyres Gast',
        email: `g0-p6-${randomUUID().slice(0, 8)}@example.se`,
      }
      const args = ['update_tenant', input, convId, true, orgId, userId, 'OWNER'] as const

      const tjänst = tjänstMed(riktigExecutor.executeTool.bind(riktigExecutor) as never)
      await tjänst.recordPendingAction(convId, orgId, userId, 'update_tenant', input)
      const svar = await tjänst.confirmAction(...args)
      expect(svar.reply).toMatch(/uppdaterad/)

      const körningarEfter = await prisma.aiToolExecution.count({
        where: { organizationId: orgId, toolName: 'update_tenant' },
      })
      expect(körningarEfter).toBe(1)

      // Uppspelningen: samma bekräftelse igen.
      await expect(tjänstMed(jest.fn()).confirmAction(...args)).rejects.toThrow(/redan utförd/)
      expect(
        await prisma.aiToolExecution.count({
          where: { organizationId: orgId, toolName: 'update_tenant' },
        }),
      ).toBe(körningarEfter)
    }, 60_000)

    /**
     * ── DEN ANDRA SPÅRFORMEN, samma krav ────────────────────────────────────
     *
     * `create_journal_entry` är ett av TVÅ `TRANSAKTIONELL`-verktyg, och det var
     * exakt den formen som förnekade sina egna utföranden före #784: dess spår
     * skrivs av `skrivTransaktionelltSpar`, som inte vidarebefordrade
     * `conversationId`/`confirmedAt`.
     *
     * Uppmätt radform FÖRE lagningen, med båda fälten satta av anroparen:
     *     { conversationId: null, confirmedAt: null, completedAt: <satt> }
     *
     * Uppslaget på `ai-assistant.service.ts:976` lyder
     * `where: { conversationId, toolName, confirmedAt: { not: null } }` och kunde
     * alltså aldrig matcha. Provet nedan är den vändna tripwiren: samma rad som
     * i går krävde den ärliga meningen kräver nu den riktiga.
     */
    it('TRANSAKTIONELL-verktyg → uppspelningen säger "redan utförd"', async () => {
      expect(effectTraceIntegrity(TOOL)).toBe('TRANSAKTIONELL')

      const input = indata('p6b')
      const { svar } = await utförSkarpt(input)
      expect(svar.reply).toMatch(/Verifikat skapat/)
      expect(await antalVerifikat(input)).toBe(1)

      // MEKANISMEN: raden bär nu identiteten. Utan de två fälten kan uppslaget
      // inte matcha, och meningen nedan blir omöjlig — se NK4 i PR-texten.
      const rad = await prisma.aiToolExecution.findFirst({
        where: { organizationId: orgId, toolName: TOOL },
        orderBy: { createdAt: 'desc' },
        select: { conversationId: true, confirmedAt: true, completedAt: true },
      })
      expect(rad!.completedAt).not.toBeNull()
      expect(rad!.conversationId).toBe(convId)
      expect(rad!.confirmedAt).not.toBeNull()

      await expect(tjänstMed(jest.fn()).confirmAction(...BEKRÄFTA(input))).rejects.toThrow(
        /redan utförd/,
      )
      expect(await antalVerifikat(input)).toBe(1)
    }, 60_000)

    /**
     * DET ANDRA TRANSAKTIONELLA VERKTYGET, genom produktionsvägen.
     *
     * `create_journal_entry` ensamt hade varit ett stickprov på en mängd om två.
     * `record_expense` delar `skrivTransaktionelltSpar` men har en egen
     * verktygskropp och egen kontering, så det är den andra medlemmen och inte
     * en upprepning av den första.
     */
    it('record_expense — det ANDRA TRANSAKTIONELLA verktyget — beter sig likadant', async () => {
      expect(effectTraceIntegrity('record_expense')).toBe('TRANSAKTIONELL')

      const input = {
        date: '2026-09-01',
        amount: 250,
        description: `g0 utgift ${randomUUID().slice(0, 8)}`,
        accountNumber: 5010,
      }
      const args = ['record_expense', input, convId, true, orgId, userId, 'OWNER'] as const

      const tjänst = tjänstMed(riktigExecutor.executeTool.bind(riktigExecutor) as never)
      await tjänst.recordPendingAction(convId, orgId, userId, 'record_expense', input)
      const svar = await tjänst.confirmAction(...args)
      expect(svar.reply).not.toMatch(/misslyckades/)

      const rad = await prisma.aiToolExecution.findFirst({
        where: { organizationId: orgId, toolName: 'record_expense' },
        orderBy: { createdAt: 'desc' },
        select: { conversationId: true, confirmedAt: true },
      })
      expect(rad!.conversationId).toBe(convId)
      expect(rad!.confirmedAt).not.toBeNull()

      await expect(tjänstMed(jest.fn()).confirmAction(...args)).rejects.toThrow(/redan utförd/)
    }, 60_000)
  })

  /**
   * ── UPPRÄKNINGEN: ALLA 30 ACTION_TOOLS, INTE DE TVÅ JAG SNUBBLADE PÅ ───────
   *
   * Fyndet i #783 beskrevs först som "två verktyg". Det var sant och för snävt
   * som instrument: en TREDJE väg som glömmer fälten hade uppstått lika tyst som
   * den andra gjorde, och ingenting hade blivit rött.
   *
   * Frågan ställs därför mot HELA mängden. Vilken skrivare ett verktyg använder
   * är inte en gissning utan en HÄRLEDNING ur dess deklarerade spårform:
   *
   *     FÖRE_EFFEKTEN   → beginToolExecution
   *     TRANSAKTIONELL  → writeInTransaction   (via skrivTransaktionelltSpar)
   *     BÄST_MÖJLIGA    → logToolExecution
   *
   * Varje `ACTION_TOOL` körs genom SIN skrivare mot riktig Postgres, och raden
   * måste bära både konversationen och bekräftelsen. En bekräftad åtgärd vars
   * spår saknar dem går inte att spela upp sanningsenligt — det är exakt den
   * defekten, oavsett vilket verktyg som råkar bära den.
   *
   * ── KANARIEFÅGELN ───────────────────────────────────────────────────────────
   *
   * En spårform utan känd skrivare FÄLLER provet i stället för att hoppas över.
   * Utan den raden hade en fjärde form kunnat läggas till och tyst falla ur
   * uppräkningen — en mängd som krymper utan att lämna spår är precis det
   * CLAUDE.md kallar en vakt som slutat mäta.
   *
   * ── VAD DEN HÄR UPPRÄKNINGEN INTE KAN SE ────────────────────────────────────
   *
   * Den mäter att varje SKRIVARE bevarar identiteten. Den kan inte se att en
   * ANROPARE låter bli att skicka den — det var den ursprungliga defekten, och
   * den ägs av de två prov ovan som går hela vägen genom `executeTool` för båda
   * de transaktionella verktygen, plus den positiva kontrollen för
   * FÖRE_EFFEKTEN. Efter #784 finns dessutom bara EN uppräkning av fälten
   * (`identitetsKolumner` i `ai-audit.service.ts`) och EN plats där identiteten
   * byggs (`spårIdentitet` i `executeToolWithAudit`).
   */
  describe('varje ACTION_TOOL:s spår bär identiteten', () => {
    const VERKTYG = [...ACTION_TOOLS] as string[]

    it('MÄNGDKANARIEFÅGEL: uppräkningen är inte tom och har inte krympt tyst', () => {
      expect(VERKTYG.length).toBeGreaterThanOrEqual(30)
    })

    it.each(VERKTYG)(
      '%s — spåret bär conversationId och confirmedAt',
      async (verktyg) => {
        const form = effectTraceIntegrity(verktyg)
        const id = randomUUID()
        const identitet = {
          organizationId: orgId,
          userId,
          conversationId: convId,
          requiredConfirmation: true,
          confirmedAt: new Date(),
        }
        const gemensamt = { id, toolName: verktyg, toolInput: { prov: 'identitet' } }

        if (form === 'FÖRE_EFFEKTEN') {
          await audit.beginToolExecution({ ...identitet, ...gemensamt })
        } else if (form === 'TRANSAKTIONELL') {
          await prisma.$transaction((tx) =>
            audit.writeInTransaction(tx, { ...identitet, ...gemensamt, effects: [] }),
          )
        } else if (form === 'BÄST_MÖJLIGA') {
          await audit.logToolExecution({
            ...identitet,
            ...gemensamt,
            success: true,
            durationMs: 0,
          })
        } else {
          // KANARIEFÅGELN. En ny spårform utan skrivare ska FÄLLA, inte hoppas över.
          throw new Error(
            `${verktyg} har spårformen "${form}", som inte har någon känd skrivare i ` +
              'det här provet. Lägg till skrivaren — annars faller verktyget tyst ur ' +
              'uppräkningen och identiteten blir obevakad för just den formen.',
          )
        }

        const rad = await prisma.aiToolExecution.findUnique({
          where: { id },
          select: { conversationId: true, confirmedAt: true },
        })
        expect(rad).not.toBeNull()
        expect(rad!.conversationId).toBe(convId)
        expect(rad!.confirmedAt).not.toBeNull()
      },
      30_000,
    )
  })
})
