import { Injectable, Logger } from '@nestjs/common'

import { PrismaService } from '../../common/prisma/prisma.service'
import { DelegationService } from '../delegation/delegation.service'
import { kontextFörFörslag } from './dryrun-context'

import type { AiExecutionVerdict } from '@prisma/client'

/** Vad ett pass gjorde. Loggas alltid — se workern. */
export type DryRunUtfall =
  | { utfall: 'DOM'; dom: AiExecutionVerdict; delegationId?: string; skäl?: string }
  | { utfall: 'SAKNAS' }
  | { utfall: 'REDAN_BEDÖMD' }

/**
 * UTFÖRAREN I TORRLÄGE — den fäller en dom, den utför ingenting.
 *
 * ── VAD DEN HÄR FILEN INTE GÖR, OCH VARFÖR DET ÄR HELA POÄNGEN ─────────────
 *
 * Den importerar INTE `ToolExecutorService`, öppnar ingen `runAsAi`, skriver
 * ingen `AiToolExecution` och rör ingen domäntabell. Den enda skrivningen är
 * fyra kolumner på det uppdrag den bedömer. `execution-dryrun.db.spec.ts`
 * räknar `AiToolExecution` och domänrader före och efter ett pass och kräver
 * noll — ett prov som inte kan skiljas från "koden kördes aldrig" om man inte
 * också ser att en dom faktiskt skrevs, vilket samma prov kräver.
 *
 * ── DOMEN ÄR ETT FACIT, INTE EN FÖRUTSÄGELSE ───────────────────────────────
 *
 * Frågan är kontrafaktisk: *hade agenten fått göra det här själv, och enligt
 * vilken delegation?* Svaret läses ur `assertDelegated` — samma grind skarpt
 * läge kommer att anropa. Att skriva en egen kopia av regeln här hade gjort
 * torrläget till ett mått på en annan regel än den som sedan gäller, och den
 * avvikelsen hade varit osynlig ända till den dag växeln slås på.
 *
 * ── VARFÖR DOMEN SKRIVS ÄVEN NÄR SVARET ÄR NEJ ─────────────────────────────
 *
 * `NO_DELEGATION` är ett svar, inte en frånvaro. Skrev vi bara `WOULD_EXECUTE`
 * hade "ingen dom" betytt både "vi hann inte" och "nej" — samma tvetydighet som
 * `authorityKind` finns för att ta bort. Nämnaren i "hur ofta hade agenten fått
 * handla?" är antalet BEDÖMDA förslag, och den går bara att räkna om nejen
 * också står skrivna.
 */
@Injectable()
export class AiExecutionDryRunService {
  private readonly logger = new Logger(AiExecutionDryRunService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly delegation: DelegationService,
  ) {}

  /**
   * Fäll dom över ETT förslag.
   *
   * @param omBedöm sätt `true` för att skriva om en befintlig dom. Standard är
   *   `false`: en dom är färsk mot det tillstånd delegationerna hade när den
   *   fälldes, och en tyst omskrivning hade raderat historiken över vad facit
   *   sa i går utan att någon bett om det.
   */
  async bedöm(
    organizationId: string,
    assignmentId: string,
    omBedöm = false,
    nu: Date = new Date(),
  ): Promise<DryRunUtfall> {
    const a = await this.prisma.aiAssignment.findFirst({
      // ORG-AVGRÄNSAT I FRÅGAN, inte efteråt. En dom som fälls med en annan
      // organisations delegationer är en läcka mellan kunder.
      where: { id: assignmentId, organizationId },
      select: {
        id: true,
        toolName: true,
        prediction: true,
        propertyId: true,
        unitId: true,
        executionVerdict: true,
      },
    })
    if (!a) return { utfall: 'SAKNAS' }
    if (a.executionVerdict !== null && !omBedöm) return { utfall: 'REDAN_BEDÖMD' }

    const svar = await this.delegation.assertDelegated(
      organizationId,
      a.toolName,
      kontextFörFörslag(a),
      nu,
    )

    if (svar.delegerad) {
      await this.skriv(a.id, 'WOULD_EXECUTE', nu, { delegationId: svar.delegationId })
      return { utfall: 'DOM', dom: 'WOULD_EXECUTE', delegationId: svar.delegationId }
    }

    // ── DE TVÅ NEJEN SKILJS ÅT HÄR, OCH BARA HÄR ────────────────────────────
    //
    // `INGEN_DELEGATION` och `VILLKORET_MATCHAR_INTE` betyder båda "du har inte
    // gett agenten den här rätten för det här fallet" — hyresvärden har
    // ingenting att åtgärda, hen har helt enkelt inte delegerat.
    //
    // `EJ_AKTIV`, `FREKVENSEN_ÖVERSKRIDEN` och `EJ_DELEGERBART` betyder att en
    // rätt FINNS eller kunde finnas men inte bar fallet. Det är en annan sak,
    // och det är den enda av de två hyresvärden kan göra något åt.
    const dom: AiExecutionVerdict =
      svar.skäl === 'INGEN_DELEGATION' || svar.skäl === 'VILLKORET_MATCHAR_INTE'
        ? 'NO_DELEGATION'
        : 'BLOCKED'
    // GRINDENS EGEN TEXT, ordagrant. En omformulering här hade blivit en andra
    // uppräkning av samma skäl, och den som syns för hyresvärden hade varit den
    // som ingen prövat.
    await this.skriv(a.id, dom, nu, { skäl: svar.text })
    return { utfall: 'DOM', dom, skäl: svar.text }
  }

  /**
   * Domens FYRA kolumner, skrivna på ETT ställe.
   *
   * `verdictDelegationId` och `verdictReason` nollställs uttryckligen i den gren
   * där de inte gäller. Utan det hade en omdömd rad kunnat bära ett skäl från en
   * tidigare `BLOCKED` bredvid ett nytt `WOULD_EXECUTE` — två påståenden som
   * motsäger varandra, i samma rad.
   */
  private async skriv(
    id: string,
    dom: AiExecutionVerdict,
    nu: Date,
    extra: { delegationId?: string; skäl?: string },
  ): Promise<void> {
    await this.prisma.aiAssignment.update({
      where: { id },
      data: {
        executionVerdict: dom,
        verdictAt: nu,
        verdictDelegationId: extra.delegationId ?? null,
        verdictReason: extra.skäl ?? null,
      },
    })
  }
}
