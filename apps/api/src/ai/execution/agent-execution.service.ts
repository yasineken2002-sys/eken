import { Injectable, Logger } from '@nestjs/common'

import { PrismaService } from '../../common/prisma/prisma.service'
import { DelegationService } from '../delegation/delegation.service'
import { ToolExecutorService } from '../tools/tool-executor.service'
import { prövaDuglighet } from '../assignments/assignment-eligibility'
import { kontextFörFörslag } from '../execution-dryrun/dryrun-context'

import type { AiPrincipal } from '../../common/ai-origin/ai-origin.context'

/**
 * SKARPT LÄGE — den första kodvägen i systemet där en maskin skriver i kundens
 * data utan att en människa säger ja just då.
 *
 * ── FYRA GRINDAR, OCH DE SVARAR PÅ FYRA OLIKA FRÅGOR ────────────────────────
 *
 *   1. `agentExecutionEnabled`   har DEN HÄR organisationen sagt ja till att
 *                                agenten utför? (Ett ägarbeslut, per kund.)
 *   2. `executionVerdict`        fällde torrläget domen WOULD_EXECUTE?
 *   3. `prövaDuglighet`          tål VERKTYGET att köras obevakat — alltså kan
 *                                en omkörning ge en ANDRA effekt?
 *   4. `assertDelegated` (om)    håller rätten FORTFARANDE, just nu?
 *
 * Ingen av dem ersätter en annan. Den tredje är den lättaste att missa: en
 * delegation är giltig för åtta verktyg, men bara FEM av dem är `IDEMPOTENT`
 * med ett bärande spår. `create_inspection`, `create_invoice` och
 * `create_maintenance_ticket` är `DEDUPLICERBAR` — en omkörning betyder en
 * ANDRA rad — och de får därför en dom men aldrig en körning. Mängden är
 * HÄRLEDD (`uppdragsdugliga ∩ delegerbara`), aldrig skriven här.
 *
 * ── OMPRÖVNINGEN, OCH VAD DEN INTE ÄR ───────────────────────────────────────
 *
 * Domen fälldes när torrläget svepte; effekten sker senare. Delegationen kan ha
 * återkallats, pausats, gått ut eller slagit i sitt frekvenstak däremellan, och
 * en dom från i går är inte en rätt i dag. `assertDelegated` ställs därför OM,
 * omedelbart före körningen, och ett nej blir `LAPSED` — planens Del 12.
 *
 * **Omprövningen ligger INTE i samma databastransaktion som effekten, och det
 * ska sägas rakt ut.** `ToolExecutorService` äger sina egna transaktioner
 * (`runAsAi` öppnar dem inifrån verktyget), och att tvinga in en yttre
 * transaktion hade betytt att skriva om varenda verktygs transaktionshantering
 * — en långt större och farligare ändring än den här. Fönstret som blir kvar är
 * de millisekunder mellan omprövningen och effekten: återkallas rätten precis
 * där utförs handlingen ändå, EN gång. Det som INTE kan hända är att den utförs
 * två gånger, eller att den utförs på en rätt som var borta när passet började
 * — och de två är de fel som faktiskt inträffar.
 *
 * ── ANSPRÅKET LIGGER I DATABASEN ────────────────────────────────────────────
 *
 * `executionStartedAt` tas med ett villkorat `updateMany` som kräver NULL. Vem
 * som vann avgörs av Postgres, inte av en läsning följd av en skrivning. Ett
 * Redis-lås hade varit ett anspråk MED LIVSLÄNGD, och ett utgånget lås mitt i en
 * körning ger två processer samma rätt utan att någondera vet om det.
 *
 * ── VAD DEN HÄR FILEN INTE GÖR ──────────────────────────────────────────────
 *
 * Den ångrar ingenting. `supportsUndo` pekar ut en namngiven metod per verktyg,
 * och att anropa dem generiskt hade varit en ANDRA utförandeväg — med samma
 * behov av delegation, bevis och spår som den första, byggd i förbifarten.
 * Ångra är en HÄNDELSE (`AiAssignmentEvent`), och läsytan visar den mänskliga
 * vägen.
 */

/** Statusar som betyder att uppdraget är färdigbehandlat. */
const TERMINALA = ['EXECUTED', 'FAILED', 'LAPSED'] as const

/**
 * Hur länge spåruppslaget väntar på en fire-and-forget-skrivning.
 *
 * Ett EGET tal och inte ett lånat: det mäter hur snabbt auditvägen hinner
 * skriva, vilket inte har något att göra med någon annan tidsgräns i systemet.
 */
const SPÅR_DEADLINE_MS = 3_000

export type UtförandeUtfall =
  | { utfall: 'UTFÖRD'; aiToolExecutionId: string | null; delegationId: string }
  | { utfall: 'MISSLYCKADES'; fel: string }
  | { utfall: 'FÖRFALLEN'; skäl: string }
  | { utfall: 'VÄXEL_AV' }
  | { utfall: 'SAKNAS' }
  | { utfall: 'INGEN_DOM' }
  | { utfall: 'REDAN_HANTERAD' }
  | { utfall: 'EJ_UPPDRAGSDUGLIG'; skäl: string }

@Injectable()
export class AiAgentExecutionService {
  private readonly logger = new Logger(AiAgentExecutionService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly delegation: DelegationService,
    private readonly executor: ToolExecutorService,
  ) {}

  /**
   * Utför ETT uppdrag, om alla fyra grindarna släpper igenom det.
   *
   * @returns vad som hände. Varje gren har ett eget värde — ett gemensamt
   *   `false` hade gjort "växeln är av" oskiljbart från "delegationen var borta",
   *   och det är den skillnaden hyresvärden behöver se.
   */
  async utför(
    organizationId: string,
    assignmentId: string,
    nu: Date = new Date(),
  ): Promise<UtförandeUtfall> {
    // ── GRIND 1: ORGANISATIONENS VÄXEL ────────────────────────────────────
    //
    // FÖRST av allt, och i en egen fråga. Läses den tillsammans med uppdraget
    // blir det lätt att av misstag lita på ett fält från en annan organisation.
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { agentExecutionEnabled: true, shadowAgentEnabled: true },
    })
    // BÅDA krävs. `OrganizationsService` upprätthåller redan invarianten, men en
    // grind som förlitar sig på att någon annan höll den är ingen grind.
    if (!org?.agentExecutionEnabled || !org.shadowAgentEnabled) return { utfall: 'VÄXEL_AV' }

    const a = await this.prisma.aiAssignment.findFirst({
      // ORG-AVGRÄNSAT I FRÅGAN. En körning som hittar ett uppdrag i en annan
      // organisation är en läcka mellan kunder, och den ska vara omöjlig att
      // uttrycka — inte upptäckas efteråt.
      where: { id: assignmentId, organizationId },
      select: {
        id: true,
        toolName: true,
        toolInput: true,
        prediction: true,
        propertyId: true,
        unitId: true,
        status: true,
        executionVerdict: true,
        executionStartedAt: true,
      },
    })
    if (!a) return { utfall: 'SAKNAS' }

    // ── GRIND 2: DOMEN ────────────────────────────────────────────────────
    if (a.executionVerdict !== 'WOULD_EXECUTE') return { utfall: 'INGEN_DOM' }
    if ((TERMINALA as readonly string[]).includes(a.status)) return { utfall: 'REDAN_HANTERAD' }

    // ── GRIND 3: TÅL VERKTYGET ATT KÖRAS OBEVAKAT? ────────────────────────
    //
    // Uppdraget lämnas ORÖRT när svaret är nej — ingen status, ingen händelse.
    // Domen `WOULD_EXECUTE` står kvar och är sann: en delegation HADE burit
    // handlingen. Det som saknas är inte rätten utan verktygets egen tålighet,
    // och det är inget hyresvärden kan åtgärda. Att skriva `FAILED` här hade
    // sagt att något gick sönder, och `LAPSED` att en förutsättning föll bort —
    // båda är osanna.
    const duglig = prövaDuglighet(a.toolName)
    if (!duglig.duglig) {
      this.logger.log(
        `[ai-exec] assignment=${a.id} verktyg=${a.toolName} utförs INTE: ${duglig.text}`,
      )
      return { utfall: 'EJ_UPPDRAGSDUGLIG', skäl: duglig.text }
    }

    // ── ANSPRÅKET, FÖRE OMPRÖVNINGEN ──────────────────────────────────────
    //
    // Tas här och inte efter grind 4, därför att en förlorad kapplöpning ska
    // kosta så lite som möjligt: den som förlorar ska inte ha hunnit fråga
    // delegationsgrinden. Villkoret är NULL — inte "inte den här körningen" —
    // så en krasch mitt i lämnar raden anspråkad, och en anspråkad rad utan
    // terminalstatus är läsbar som just det: en körning som dog.
    const anspråk = await this.prisma.aiAssignment.updateMany({
      where: { id: a.id, organizationId, executionStartedAt: null },
      data: { executionStartedAt: nu },
    })
    if (anspråk.count === 0) return { utfall: 'REDAN_HANTERAD' }

    // ── GRIND 4: OMPRÖVNINGEN ─────────────────────────────────────────────
    const svar = await this.delegation.assertDelegated(
      organizationId,
      a.toolName,
      kontextFörFörslag(a),
      nu,
    )
    if (!svar.delegerad) {
      // PLANENS DEL 12, ordagrant i formen: säg vad du SKULLE ha gjort och
      // varför det inte blev av. En tyst uteblivelse är förbjuden.
      const skäl =
        `Skulle ha utfört ${a.toolName} enligt din delegation — men förutsättningarna ` +
        `höll inte längre när det var dags: ${svar.text}`
      await this.prisma.aiAssignment.update({
        where: { id: a.id },
        data: { status: 'LAPSED', statusReason: skäl, decidedAt: nu },
      })
      this.logger.log(`[ai-exec] assignment=${a.id} LAPSED — ${svar.text}`)
      return { utfall: 'FÖRFALLEN', skäl }
    }

    const delegationId = svar.delegationId
    // SYSTEMET, PÅ EN DELEGATION. Slaget bär aldrig ett `id` — se `AiPrincipal`.
    // Ägarens `User.id` här hade fått raden att säga att ägaren gjorde något hen
    // inte gjorde.
    const principal: AiPrincipal = {
      kind: 'SYSTEM',
      organizationId,
      origin: 'delegation',
      delegationId,
    }

    // TIDPUNKTEN FÖRE KÖRNINGEN, för spåruppslaget nedan. Tas här och inte ur
    // `nu`: mellan anspråket och den här raden ligger omprövningen, och ett
    // spår från den tiden hör inte till den här körningen.
    const start = new Date()
    try {
      const r = await this.executor.executeTool(
        a.toolName,
        (a.toolInput ?? {}) as Record<string, unknown>,
        organizationId,
        principal,
        // ROLLEN ÄR OWNER därför att delegationen är ägarens rätt, utlånad.
        // Agenten har ingen egen roll — den utövar den rätt som gavs, och en
        // lägre roll här hade nekat handlingar hyresvärden uttryckligen
        // delegerat.
        'OWNER',
        { actionProof: { delegated: true, delegationId } },
      )
      if (!r.success) {
        // ETT `success: false` ÄR INTE ETT KAST. Verktygen svarar med ett
        // felobjekt för domänfel (validering, en post som inte finns), och det
        // är lika mycket ett misslyckat utförande som ett undantag. Att bara
        // fånga kast hade skrivit EXECUTED på en handling som inte skedde.
        // `ToolResult` bär `message`, inte `error` — fältet heter så för att
        // samma text används vid framgång. Vid `success: false` ÄR den felet.
        const fel = r.message.trim() !== '' ? r.message : 'Okänt verktygsfel.'
        await this.skrivMisslyckande(a.id, fel, nu)
        return { utfall: 'MISSLYCKADES', fel }
      }

      // ── SPÅRET SLÅS UPP, OCH TIDSGRÄNSEN ÄR INTE PYNT ────────────────────
      //
      // `executeTool` returnerar inte sitt `executionId`; raden skrivs
      // fire-and-forget av auditvägen. Uppslaget måste därför leta — och det är
      // precis där det första försöket var FEL.
      //
      // Formen `findFirst({ organizationId, toolName, delegationId }, desc)`
      // ser rätt ut och är det inte: samma organisation kan ha kört samma
      // verktyg på samma delegation tidigare, och när den nya raden ännu inte
      // hunnit skrivas plockar frågan upp en ÄLDRE körnings spår. Uppdraget
      // hade då pekat på fel `AiToolExecution` — ett revisionsspår som pekar på
      // någon annans handling är värre än inget spår. Uppmätt av
      // `agent-execution.db.spec.ts`, som fick tillbaka ett id från provet före.
      //
      // `createdAt: { gte: start }` gör en äldre rad omöjlig att träffa. Kvar
      // blir bara "ännu inte skriven", och det svaret är NULL — vilket är sant.
      const spår = await this.slåUppSpår(organizationId, a.toolName, delegationId, start)
      await this.prisma.aiAssignment.update({
        where: { id: a.id },
        data: {
          status: 'EXECUTED',
          decidedAt: nu,
          aiToolExecutionId: spår?.id ?? null,
          // MED VILKEN RÄTT. Fälten är uppdragets egna och skilda från domens
          // (`verdictDelegationId`) — den ena är ett faktum om något som hänt,
          // den andra ett kontrafaktiskt påstående.
          authorityKind: 'DELEGATION',
          delegationId,
        },
      })
      this.logger.log(
        `[ai-exec] assignment=${a.id} EXECUTED verktyg=${a.toolName} delegation=${delegationId}`,
      )
      return { utfall: 'UTFÖRD', aiToolExecutionId: spår?.id ?? null, delegationId }
    } catch (e) {
      const fel = e instanceof Error ? e.message : String(e)
      await this.skrivMisslyckande(a.id, fel, nu)
      return { utfall: 'MISSLYCKADES', fel }
    }
  }

  /**
   * Spåret för DEN HÄR körningen, aldrig en tidigare.
   *
   * Pollar en kort stund därför att skrivningen är fire-and-forget: utan väntan
   * blir `aiToolExecutionId` null nästan varje gång, och "Gjort" tappar länken
   * till revisionsspåret. Tidsgränsen är kort och utan retur-fel — uppdraget ÄR
   * utfört, och att inte hitta spåret får inte göra det till ett misslyckande.
   */
  private async slåUppSpår(
    organizationId: string,
    toolName: string,
    delegationId: string,
    start: Date,
  ): Promise<{ id: string } | null> {
    const slut = Date.now() + SPÅR_DEADLINE_MS
    for (;;) {
      const rad = await this.prisma.aiToolExecution.findFirst({
        where: { organizationId, toolName, delegationId, createdAt: { gte: start } },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      })
      if (rad) return rad
      if (Date.now() > slut) {
        this.logger.warn(
          `[ai-exec] spåret för ${toolName} hann inte skrivas inom ${SPÅR_DEADLINE_MS} ms — ` +
            'uppdraget markeras EXECUTED utan aiToolExecutionId.',
        )
        return null
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  /**
   * FAILED med felets EGEN text.
   *
   * Ingen omformulering: två uppräkningar av samma skäl glider isär, och den som
   * syns för hyresvärden hade blivit den som ingen prövat. Samma hållning som
   * torrlägets `verdictReason`.
   *
   * DELEGATIONEN RÖRS INTE. Ett verktygsfel säger något om körningen, inte om
   * rätten — att pausa delegationen hade straffat hyresvärden för ett buggigt
   * verktyg, och hen hade fått ge tillbaka en rätt hen aldrig tog tillbaka.
   */
  private async skrivMisslyckande(id: string, fel: string, nu: Date): Promise<void> {
    await this.prisma.aiAssignment.update({
      where: { id },
      data: { status: 'FAILED', statusReason: fel, decidedAt: nu },
    })
    this.logger.warn(`[ai-exec] assignment=${id} FAILED — ${fel}`)
  }
}
